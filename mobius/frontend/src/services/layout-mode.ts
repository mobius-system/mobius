export const LAYOUT_MODE_STORAGE_KEY = 'layout_mode'

export type LayoutMode = 'easy_mode' | 'normal_mode'

// P1 只保留对旧浏览器偏好的只读兼容。这个值不再参与页面渲染或导航，
// 也不会被删除，避免破坏仍需读取同一 localStorage 的旧版本客户端。
export function readLayoutMode(): LayoutMode | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(LAYOUT_MODE_STORAGE_KEY)
    return value === 'easy_mode' || value === 'normal_mode' ? value : null
  } catch {
    return null
  }
}
