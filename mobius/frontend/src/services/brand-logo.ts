import { useSyncExternalStore } from 'react'

// 自定义品牌 Logo: 用户上传一张图片替换莫比乌斯默认 logo.
// 图片**只留在当前浏览器** (localStorage data URL), 绝不上传服务器, 因此每个浏览器各自独立。
export const CUSTOM_LOGO_STORAGE_KEY = 'mobius:custom-logo'
export const CUSTOM_LOGO_CHANGE_EVENT = 'mobius:custom-logo-changed'

// 原始文件上限: 超过这个体积先尝试等比缩放, 仍拿不到小图才报错。
export const CUSTOM_LOGO_MAX_FILE_BYTES = 4 * 1024 * 1024
// 存进 localStorage 的 data URL 字符上限。小图 (含 SVG / 带透明 PNG) 原样保存不重编码,
// 避免画布转码带来的透明通道丢失或矢量失真。
export const CUSTOM_LOGO_INLINE_MAX_CHARS = 1_400_000
// 需要缩图时的最长边 (logo 最大也只渲染到 72px, 512 足够清晰且能压到几十 KB)。
const CUSTOM_LOGO_MAX_EDGE = 512

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
