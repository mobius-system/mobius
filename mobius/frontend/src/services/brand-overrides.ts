import { useSyncExternalStore } from 'react'

// 浏览器本地品牌覆盖: 用户上传的自定义 Logo + 自定义系统名称.
// 全部**只留在当前浏览器** (localStorage), 绝不上传服务器, 因此每个浏览器各自独立。
// 基底是服务端下发的 branding (window.__BRANDING__, 来自 .env), 这里只做叠加覆盖。

// ── 自定义 Logo ──
export const CUSTOM_LOGO_STORAGE_KEY = 'mobius:custom-logo'
export const CUSTOM_LOGO_CHANGE_EVENT = 'mobius:custom-logo-changed'

// 原始文件上限: 超过这个体积先尝试等比缩放, 仍拿不到小图才报错。
export const CUSTOM_LOGO_MAX_FILE_BYTES = 4 * 1024 * 1024
// 存进 localStorage 的 data URL 字符上限。小图 (含 SVG / 带透明 PNG) 原样保存不重编码,
// 避免画布转码带来的透明通道丢失或矢量失真。
export const CUSTOM_LOGO_INLINE_MAX_CHARS = 1_400_000
// 需要缩图时的最长边 (logo 最大也只渲染到 72px, 512 足够清晰且能压到几十 KB)。
const CUSTOM_LOGO_MAX_EDGE = 512

// ── 自定义系统名称 ──
export const CUSTOM_BRAND_NAME_STORAGE_KEY = 'mobius:custom-brand-name'
export const CUSTOM_BRAND_NAME_CHANGE_EVENT = 'mobius:custom-brand-name-changed'

export type BrandNameOverride = { zh: string; en: string }

const EMPTY_BRAND_NAME: BrandNameOverride = { zh: '', en: '' }

export function readCustomLogo(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(CUSTOM_LOGO_STORAGE_KEY)
    return value && value.startsWith('data:image/') ? value : null
  } catch {
    return null
  }
}

export function writeCustomLogo(dataUrl: string | null): string | null {
  if (typeof window === 'undefined') return null
  if (!dataUrl) {
    window.localStorage.removeItem(CUSTOM_LOGO_STORAGE_KEY)
    window.dispatchEvent(new CustomEvent(CUSTOM_LOGO_CHANGE_EVENT))
    return null
  }
  try {
    window.localStorage.setItem(CUSTOM_LOGO_STORAGE_KEY, dataUrl)
  } catch {
    throw new Error('浏览器存储空间不足，请换一张更小的图片')
  }
  window.dispatchEvent(new CustomEvent(CUSTOM_LOGO_CHANGE_EVENT, { detail: dataUrl }))
  return dataUrl
}

function subscribeCustomLogo(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_LOGO_STORAGE_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(CUSTOM_LOGO_CHANGE_EVENT, listener)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(CUSTOM_LOGO_CHANGE_EVENT, listener)
  }
}

// 所有渲染 MobiusLogo 的地方都走这个 hook, 上传后无需刷新即时生效。
export function useCustomLogo(): string | null {
  return useSyncExternalStore(subscribeCustomLogo, readCustomLogo, () => null)
}

// ── 浏览器标签页图标 (favicon) ──
// index.html 里有 3 条默认 <link rel="icon">, 直接再加一条会变成"多条竞争", 浏览器不保证选中我们这条。
// 因此自定义时先把默认的 rel 停用 (浏览器不认的 rel 值), 只注入一条自己的; 恢复默认时原样还原。
// 选择器必须同时命中"已停用"的那批 (它们的 rel 已被改成 mobius-disabled-icon, 不再匹配 [rel~="icon"]),
// 否则恢复默认时找不到它们, 页面会变成没有任何图标.
const FAVICON_SELECTOR = 'link[rel~="icon"], link[data-mobius-original-rel]'
const CUSTOM_FAVICON_ID = 'mobius-custom-favicon'
const ORIGINAL_FAVICON_REL_ATTR = 'data-mobius-original-rel'

export function applyCustomFavicon(customLogo: string | null) {
  if (typeof document === 'undefined') return
  document.getElementById(CUSTOM_FAVICON_ID)?.remove()
  document.querySelectorAll(FAVICON_SELECTOR).forEach((link) => {
    if (customLogo) {
      if (!link.hasAttribute(ORIGINAL_FAVICON_REL_ATTR)) {
        link.setAttribute(ORIGINAL_FAVICON_REL_ATTR, link.getAttribute('rel') || 'icon')
      }
      link.setAttribute('rel', 'mobius-disabled-icon')
      return
    }
    const originalRel = link.getAttribute(ORIGINAL_FAVICON_REL_ATTR)
    if (originalRel) {
      link.setAttribute('rel', originalRel)
      link.removeAttribute(ORIGINAL_FAVICON_REL_ATTR)
    }
  })
  if (!customLogo) return
  const link = document.createElement('link')
  link.id = CUSTOM_FAVICON_ID
  link.rel = 'icon'
  link.href = customLogo
  document.head.appendChild(link)
}

// 启动时同步一次 favicon, 之后跟随自定义 logo 变化 (含其他标签页改动)。
export function startBrandOverridesRuntime(): () => void {
  const sync = () => applyCustomFavicon(readCustomLogo())
  sync()
  return subscribeCustomLogo(sync)
}

// 空字符串表示"这一项不覆盖", 回落到服务端下发的值。
export function readBrandNameOverride(): BrandNameOverride {
  if (typeof window === 'undefined') return EMPTY_BRAND_NAME
  try {
    const raw = window.localStorage.getItem(CUSTOM_BRAND_NAME_STORAGE_KEY)
    if (!raw) return EMPTY_BRAND_NAME
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return EMPTY_BRAND_NAME
    return {
      zh: typeof parsed.zh === 'string' ? parsed.zh.trim() : '',
      en: typeof parsed.en === 'string' ? parsed.en.trim() : '',
    }
  } catch {
    return EMPTY_BRAND_NAME
  }
}

// 两项都为空视为"取消自定义", 直接删掉存储键, 避免留下空壳。
export function writeBrandNameOverride(next: { zh?: string; en?: string }): BrandNameOverride {
  const normalized: BrandNameOverride = {
    zh: (next.zh || '').trim(),
    en: (next.en || '').trim(),
  }
  if (!normalized.zh && !normalized.en) {
    window.localStorage.removeItem(CUSTOM_BRAND_NAME_STORAGE_KEY)
  } else {
    window.localStorage.setItem(CUSTOM_BRAND_NAME_STORAGE_KEY, JSON.stringify(normalized))
  }
  window.dispatchEvent(new CustomEvent(CUSTOM_BRAND_NAME_CHANGE_EVENT, { detail: normalized }))
  return normalized
}

export function subscribeBrandName(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CUSTOM_BRAND_NAME_STORAGE_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(CUSTOM_BRAND_NAME_CHANGE_EVENT, listener)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(CUSTOM_BRAND_NAME_CHANGE_EVENT, listener)
  }
}

export function useBrandNameOverride(): BrandNameOverride {
  // readBrandNameOverride 每次返回新对象, 直接交给 useSyncExternalStore 会每帧都判定为变化,
  // 因此快照取 JSON 字符串 (原始值, 稳定), 再解析回对象。
  const serialized = useSyncExternalStore(
    subscribeBrandName,
    () => serializeBrandName(readBrandNameOverride()),
    () => '',
  )
  return deserializeBrandName(serialized)
}

function serializeBrandName(value: BrandNameOverride): string {
  return value.zh || value.en ? JSON.stringify(value) : ''
}

function deserializeBrandName(serialized: string): BrandNameOverride {
  if (!serialized) return EMPTY_BRAND_NAME
  try {
    const parsed = JSON.parse(serialized)
    return { zh: String(parsed?.zh || ''), en: String(parsed?.en || '') }
  } catch {
    return EMPTY_BRAND_NAME
  }
}

// 把本地覆盖叠加到服务端下发的 branding 上: 单项为空则保留原值。
// 泛型只为让调用方拿回自己那个 branding 类型 (含 hiddenFolderName/appDir 等额外字段)。
export function applyBrandNameOverride<T extends { systemNameZh: string; systemNameEn: string }>(branding: T): T {
  const override = readBrandNameOverride()
  if (!override.zh && !override.en) return branding
  return {
    ...branding,
    systemNameZh: override.zh || branding.systemNameZh,
    systemNameEn: override.en || branding.systemNameEn,
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('图片读取失败，请换一个文件再试'))
    reader.readAsDataURL(file)
  })
}

// 等比缩小到 CUSTOM_LOGO_MAX_EDGE 以内, 统一输出 PNG (保留透明通道)。
async function downscaleImageFile(file: File): Promise<string> {
  const objectUrl = window.URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('图片解析失败，请换一张图片'))
      element.src = objectUrl
    })
    const naturalWidth = image.naturalWidth || CUSTOM_LOGO_MAX_EDGE
    const naturalHeight = image.naturalHeight || CUSTOM_LOGO_MAX_EDGE
    const scale = Math.min(1, CUSTOM_LOGO_MAX_EDGE / Math.max(naturalWidth, naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前浏览器无法处理图片，请换一张更小的图片')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } finally {
    window.URL.revokeObjectURL(objectUrl)
  }
}

// 校验 + 读取: 小图直接用原始 data URL, 大图先缩放再存, 保证不撑爆 localStorage。
export async function importCustomLogoFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('请选择图片文件（PNG / JPG / SVG / WebP 等）')
  }
  if (file.size > CUSTOM_LOGO_MAX_FILE_BYTES) {
    throw new Error(`图片不能超过 ${Math.round(CUSTOM_LOGO_MAX_FILE_BYTES / 1024 / 1024)}MB，请先压缩再上传`)
  }
  const dataUrl = await readFileAsDataUrl(file)
  if (dataUrl.length <= CUSTOM_LOGO_INLINE_MAX_CHARS) return dataUrl
  const resized = await downscaleImageFile(file)
  if (resized.length > CUSTOM_LOGO_INLINE_MAX_CHARS) {
    throw new Error('图片过大且压缩后仍超出浏览器存储上限，请换一张更小的图片')
  }
  return resized
}
