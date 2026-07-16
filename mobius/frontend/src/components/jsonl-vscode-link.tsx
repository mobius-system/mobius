import { createContext, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../store'
import { buildVscodeUrl } from './project-files'

// =====================================================================
// VSCodeOpenContext — supplies projectId-aware "open this absolute path
// in code-server" to whatever markdown is rendered underneath. Lets the
// JSONL renderer reroute clicks on links like [foo](/home/.../file.pdf)
// so they open in VSCode Web instead of 404-ing against the current host.
// Outside the provider, openLocalPath returns null → renderer falls back
// to the default anchor behavior.
//
// Lives in its own file (not next to JsonlCompactMarkdown) so chat.tsx
// can import the provider without dragging react-markdown into the main
// chunk — the markdown renderer stays lazy-loaded.
// =====================================================================
export type VSCodeOpenContextValue = {
  openLocalPath: (absPath: string) => string | null
}

export const VSCodeOpenContext = createContext<VSCodeOpenContextValue | null>(null)

type ProjectMeta = { bind_path?: string; vscode_web_url?: string; vscode_workspace_path?: string }

function normalizeFsPath(value?: string): string {
  const trimmed = (value || '').trim()
  if (!trimmed.startsWith('/')) return ''
  const collapsed = trimmed.replace(/\/+/g, '/')
  return collapsed.replace(/\/+$/g, '') || '/'
}

function dirnameFsPath(absPath: string): string {
  const normalized = normalizeFsPath(absPath)
  if (!normalized || normalized === '/') return ''
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return '/'
  return normalized.slice(0, idx)
}

function isWithinFsPath(rootPath: string, targetPath: string): boolean {
  const root = normalizeFsPath(rootPath)
  const target = normalizeFsPath(targetPath)
  if (!root || !target) return false
  return target === root || target.startsWith(root + '/')
}

function workspaceForLocalPath(meta: ProjectMeta, absPath: string): string {
  const bindPath = normalizeFsPath(meta.bind_path)
  const targetPath = normalizeFsPath(absPath)
  const defaultWorkspace = normalizeFsPath(meta.vscode_workspace_path) || bindPath
  if (!bindPath || !targetPath) return defaultWorkspace
  if (defaultWorkspace && isWithinFsPath(defaultWorkspace, targetPath)) return defaultWorkspace
  const parentPath = dirnameFsPath(bindPath)
  if (parentPath && isWithinFsPath(parentPath, targetPath)) return parentPath
  return defaultWorkspace
}

export function VSCodeOpenProvider({ projectId, children }: { projectId?: string | null; children: ReactNode }) {
  // Cache the project meta + the in-flight fetch promise. The provider can
  // sit above many links; we want exactly one /api/projects/:id/files
  // request per projectId for the lifetime of the provider.
  const metaRef = useRef<ProjectMeta | null>(null)
  const pendingRef = useRef<Promise<ProjectMeta | null> | null>(null)
  const [, forceUpdate] = useState(0)

  const loadMeta = useCallback((): Promise<ProjectMeta | null> => {
    if (!projectId) return Promise.resolve(null)
    if (metaRef.current) return Promise.resolve(metaRef.current)
    if (pendingRef.current) return pendingRef.current
    const p = api(`/api/projects/${projectId}/files?path=/`)
      .then((data: any) => {
        const meta: ProjectMeta = {
          bind_path: data?.bind_path || '',
          vscode_web_url: data?.vscode_web_url || '',
          vscode_workspace_path: data?.vscode_workspace_path || data?.bind_path || '',
        }
        metaRef.current = meta
        pendingRef.current = null
        forceUpdate(n => n + 1)
        return meta
      })
      .catch(() => {
        pendingRef.current = null
        return null
      })
    pendingRef.current = p
    return p
  }, [projectId])

  // Synchronous resolver used by the click handler. If meta is already
  // cached, returns the VSCode URL immediately. Otherwise kicks off the
  // fetch and returns null — link click falls back to default this once;
  // next click on a sibling link benefits from the cache.
  const openLocalPath = useCallback((absPath: string): string | null => {
    if (!projectId) return null
    const meta = metaRef.current
    if (!meta) { loadMeta(); return null }
    if (!meta.bind_path || !meta.vscode_web_url) return null
    return buildVscodeUrl(meta.vscode_web_url, workspaceForLocalPath(meta, absPath), absPath)
  }, [projectId, loadMeta])

  // Warm the cache as soon as the provider mounts with a projectId, so
  // the very first link click resolves synchronously.
  if (projectId && !metaRef.current && !pendingRef.current) loadMeta()

  const value = useMemo(() => ({ openLocalPath }), [openLocalPath])
  return <VSCodeOpenContext.Provider value={value}>{children}</VSCodeOpenContext.Provider>
}

// Absolute filesystem path heuristic. We only intercept paths whose first
// segment is a well-known filesystem root — otherwise legitimate in-app
// links like "/api/..." or "/issues/..." would get hijacked. Extend the
// list cautiously: each prefix is a commitment that real paths under it
// are reachable by the same VSCode Web instance as the project bind path.
const FS_PATH_PREFIXES = ['/home/', '/root/', '/Users/', '/tmp/', '/var/', '/mnt/', '/opt/', '/srv/', '/data/']
export function isLikelyFilesystemPath(href: string): boolean {
  if (!href || href.startsWith('//')) return false
  if (!href.startsWith('/')) return false
  return FS_PATH_PREFIXES.some(p => href.startsWith(p))
}

// 把一个外链 http(s) / 协议相对 // 媒体 URL 改写成走同源后端代理.
// 浏览器直连 <img src="https://外链"> 在图床做防盗链(Referer 校验)/不可达/
// 混合内容拦截/CORS 时普遍 onError, 卡片只剩死占位. 改由后端服务端 fetch
// (带浏览器 UA + 同源 Referer 绕过防盗链, SSRF 防护 + 大小上限, 见
// backend/services/proxy-media.ts) 流式回吐. token 走 query 因为 <img> 不能带
// Authorization 头 — 与 /api/download 同款.
function proxyMediaUrl(src: string): string {
  const token = typeof window !== 'undefined' ? (localStorage.getItem('cc-token') || '') : ''
  return `/api/proxy-media?url=${encodeURIComponent(src)}${token ? `&token=${encodeURIComponent(token)}` : ''}`
}

// Rewrite a media src (markdown <img>, display_images card, ...) into a URL the
// browser can actually render:
//   - 外链 http(s) / 协议相对 // => 走同源后端代理 (proxyMediaUrl), 绕开防盗链/不可达;
//   - 绝对服务器文件路径 => 走 GET /api/download (与 FileManager 同款, downloadAuth
//     鉴权, 只服务用户可读路径). 这让 agent 消息 ![shot](/home/.../x.png) 能渲染 —
//     原始文件路径在 <img src> 里会对 dev/prod host 404;
//   - data: / blob: / 已是 /api 的 URL => 原样透传;
//   - 相对或站内路径 => 不动 (isLikelyFilesystemPath 避免劫持它们).
export function resolveMediaSrc(src: string): string {
  if (!src) return src
  if (/^https?:\/\//i.test(src)) return proxyMediaUrl(src)
  if (src.startsWith('//')) return proxyMediaUrl('https:' + src)
  if (src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('/api/')) return src
  if (!isLikelyFilesystemPath(src)) return src
  const token = typeof window !== 'undefined' ? (localStorage.getItem('cc-token') || '') : ''
  return `/api/download?path=${encodeURIComponent(src)}${token ? `&token=${encodeURIComponent(token)}` : ''}`
}
