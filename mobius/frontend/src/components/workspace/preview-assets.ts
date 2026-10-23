/*
 * Preview asset inliner.
 *
 * Blueprint / HTML previews are rendered through `srcDoc` inside a
 * `sandbox="allow-scripts"` iframe, so the document has an opaque origin and
 * relative URLs cannot reach the project files on the app origin. This module
 * resolves the relative references that blueprints are allowed to use
 * (`./assets/x.png`, `../shared/y.png`, `/project/root/z.png`), fetches the
 * bytes with the normal bearer token from the trusted parent page, and rewrites
 * them into `data:` URIs purely in memory. The HTML file on disk keeps the
 * readable relative paths; only the preview document carries the inlined bytes.
 */

// 图片读取缓存有效期: 编辑器里反复输入时避免重复拉同一张图
// Cache TTL so re-rendering the preview while typing does not refetch images
const ASSET_CACHE_TTL_MS = 60_000
// 单张图片内联上限, 超过则保持原样(显示为裂图)而不是吃掉几千万字符内存
// Refuse to inline a single asset bigger than this; keep the original ref instead
const MAX_INLINE_BYTES = 24 * 1024 * 1024

const URL_ATTRS: Array<[string, string[]]> = [
  ['img', ['src']],
  ['source', ['src']],
  ['video', ['src', 'poster']],
  ['audio', ['src']],
  ['track', ['src']],
  ['object', ['data']],
]
const SRCSET_TAGS = ['img', 'source']
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
const EXTERNAL_REF_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

const dataUrlCache = new Map<string, { at: number; promise: Promise<string> }>()

/* Return the auth token used by the SPA's normal API calls. */
function authToken(): string {
  try {
    return localStorage.getItem('cc-token') || ''
  } catch {
    return ''
  }
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

/*
 * Fetch one project file as a data URI.
 * Uses the existing authenticated download endpoint, so path traversal and
 * symlink rules stay in one place on the backend.
 */
export function projectFileDataUrl(projectId: string, relPath: string): Promise<string> {
  const key = `${projectId}\u0000${relPath}`
  const hit = dataUrlCache.get(key)
  if (hit && Date.now() - hit.at < ASSET_CACHE_TTL_MS) return hit.promise

  const request = (async () => {
    const url = `/api/projects/${encodeURIComponent(projectId)}/file/download?path=${encodeURIComponent(relPath)}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${authToken()}` } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    if (blob.size > MAX_INLINE_BYTES) throw new Error('asset too large')
    return readBlobAsDataUrl(blob)
  })()

  dataUrlCache.set(key, { at: Date.now(), promise: request })
  request.catch(() => {
    // 失败不缓存, 下次重试
    // Do not cache failures so the next render retries
    const current = dataUrlCache.get(key)
    if (current?.promise === request) dataUrlCache.delete(key)
  })
  return request
}

/* Drop a cached asset so the next preview shows the file as it is on disk now. */
export function invalidatePreviewAsset(projectId: string, relPath: string): void {
  dataUrlCache.delete(`${projectId}\u0000${relPath}`)
}

/*
 * Resolve one reference written inside a blueprint to a project-relative path.
 * Returns null for absolute URLs (http/data/blob/mailto), protocol-relative
 * URLs and pure fragments; those are left untouched.
 */
export function resolvePreviewAssetPath(ref: string, baseDir: string): string | null {
  const raw = (ref || '').trim()
  if (!raw || raw.startsWith('#')) return null
  if (EXTERNAL_REF_RE.test(raw)) return null

  let pathname: string
  if (raw.startsWith('/')) {
    // 应用自身的接口/静态前缀仍按同源 URL 处理, 不当作项目内文件
    // App-owned API/static prefixes stay same-origin URLs, not project files
    if (/^\/(?:api|extension|aimux_bridge|@vite|__vite)/.test(raw)) return null
    // 以 / 开头 = 项目根相对 (后端会在项目根内解析)
    // A leading slash means "relative to the project root"
    pathname = raw.split('#')[0].split('?')[0]
  } else {
    const dir = (baseDir || '/').replace(/\/+$/, '')
    try {
      // 借 URL 解析 ./ ../ 等相对写法, 主机名只是占位
      // Borrow URL resolution for ./ and ../; the host is a placeholder
      pathname = new URL(raw, `http://preview.invalid${dir}/`).pathname
    } catch {
      return null
    }
  }
  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    return null
  }
  return pathname || null
}

function collectSrcsetPaths(value: string, baseDir: string, into: Set<string>): void {
  for (const part of value.split(',')) {
    const candidate = part.trim()
    if (!candidate) continue
    const ref = candidate.split(/\s+/)[0]
    const resolved = resolvePreviewAssetPath(ref, baseDir)
    if (resolved) into.add(resolved)
  }
}

function rewriteSrcset(value: string, baseDir: string, resolved: Map<string, string>): string {
  return value
    .split(',')
    .map(part => {
      const candidate = part.trim()
      if (!candidate) return ''
      const [ref, ...descriptor] = candidate.split(/\s+/)
      const path = resolvePreviewAssetPath(ref, baseDir)
      const data = path ? resolved.get(path) : undefined
      if (!data) return candidate
      return [data, ...descriptor].join(' ')
    })
    .filter(Boolean)
    .join(', ')
}

/*
 * Rewrite every relative asset reference in an HTML string into a data URI.
 * Returns the original string unchanged when there is nothing to inline, so
 * plain documents pay only the parse cost.
 */
export async function inlinePreviewAssets(
  html: string,
  options: { projectId: string; baseDir: string }
): Promise<string> {
  if (!html || typeof DOMParser === 'undefined') return html

  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return html
  }

  const { projectId, baseDir } = options
  const wanted = new Set<string>()
  const elementAttrs: Array<{ el: Element; attr: string; path: string }> = []
  const srcsets: Array<{ el: Element; attr: string }> = []
  const cssTargets: Array<{ get: () => string; set: (value: string) => void }> = []
  const svgRefs: Array<{ el: Element; attr: string; ns: string | null; path: string }> = []

  for (const [tag, attrs] of URL_ATTRS) {
    doc.querySelectorAll(tag).forEach(el => {
      for (const attr of attrs) {
        const value = el.getAttribute(attr)
        if (!value) continue
        const path = resolvePreviewAssetPath(value, baseDir)
        if (!path) continue
        elementAttrs.push({ el, attr, path })
        wanted.add(path)
      }
    })
  }

  for (const tag of SRCSET_TAGS) {
    doc.querySelectorAll(`${tag}[srcset]`).forEach(el => {
      const value = el.getAttribute('srcset') || ''
      srcsets.push({ el, attr: 'srcset' })
      collectSrcsetPaths(value, baseDir, wanted)
    })
  }

  // SVG <image> 用 href/xlink:href 而不是 src
  // SVG <image> carries href / xlink:href instead of src
  doc.querySelectorAll('image, feImage').forEach(el => {
    const plain = el.getAttribute('href')
    if (plain) {
      const path = resolvePreviewAssetPath(plain, baseDir)
      if (path) { svgRefs.push({ el, attr: 'href', ns: null, path }); wanted.add(path) }
    }
    const xlink = el.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
    if (xlink) {
      const path = resolvePreviewAssetPath(xlink, baseDir)
      if (path) { svgRefs.push({ el, attr: 'href', ns: 'http://www.w3.org/1999/xlink', path }); wanted.add(path) }
    }
  })

  doc.querySelectorAll('style').forEach(el => {
    const text = el.textContent || ''
    cssTargets.push({ get: () => el.textContent || '', set: value => { el.textContent = value } })
    for (const match of text.matchAll(CSS_URL_RE)) {
      const path = resolvePreviewAssetPath(match[2], baseDir)
      if (path) wanted.add(path)
    }
  })

  doc.querySelectorAll('[style]').forEach(el => {
    const value = el.getAttribute('style') || ''
    cssTargets.push({ get: () => el.getAttribute('style') || '', set: next => el.setAttribute('style', next) })
    for (const match of value.matchAll(CSS_URL_RE)) {
      const path = resolvePreviewAssetPath(match[2], baseDir)
      if (path) wanted.add(path)
    }
  })

  if (wanted.size === 0) return html

  // ✨ 并发取回全部图片字节, 失败的单张保持原引用(裂图可见, 不阻断整篇预览)
  // ✨ Fetch all assets in parallel; a failed one keeps its original ref
  const resolved = new Map<string, string>()
  await Promise.all(
    [...wanted].map(async path => {
      try {
        resolved.set(path, await projectFileDataUrl(projectId, path))
      } catch (e) {
        console.warn('[blueprint] 预览图片加载失败', path, e)
      }
    })
  )
  if (resolved.size === 0) return html

  for (const { el, attr, path } of elementAttrs) {
    const data = resolved.get(path)
    if (data) el.setAttribute(attr, data)
  }
  for (const { el, attr } of srcsets) {
    const next = rewriteSrcset(el.getAttribute(attr) || '', baseDir, resolved)
    el.setAttribute(attr, next)
  }
  for (const { el, attr, ns, path } of svgRefs) {
    const data = resolved.get(path)
    if (!data) continue
    if (ns) el.setAttributeNS(ns, attr, data)
    else el.setAttribute(attr, data)
  }
  for (const target of cssTargets) {
    const next = target.get().replace(CSS_URL_RE, (whole, quote, ref) => {
      const path = resolvePreviewAssetPath(String(ref), baseDir)
      const data = path ? resolved.get(path) : undefined
      return data ? `url(${quote}${data}${quote})` : whole
    })
    target.set(next)
  }

  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
}
