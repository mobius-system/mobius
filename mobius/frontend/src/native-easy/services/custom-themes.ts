// =====================================================================
// 自定义主题（用户调色盘）服务
// ---------------------------------------------------------------------
// 现有前端主题（dark/light/purple/ocean/...）用 :root 下的 CSS 类注入变量；
// 自定义主题在这一层之上叠加 :root.style 上的 CSS 变量覆写。
//
// 存储：所有自定义主题存在 localStorage 一个 JSON map 中；"当前激活的
// 自定义主题" 用一个独立 key 标记。两者不耦合到现有 theme（ThemeName）系统，
// 只在 App 启动 / theme 切换时根据 base 重新应用覆写即可。
// =====================================================================

import { THEME_OPTIONS, type ThemeName } from '../theme'

export const CUSTOM_THEMES_STORAGE_KEY = 'cc-theme-custom-themes'
export const ACTIVE_CUSTOM_THEME_STORAGE_KEY = 'cc-theme-custom-active'

// 用户可在调色盘里调节的"基础"颜色变量。每项都对应 CSS 中已存在、可被
// :root 覆写的颜色变量 — 不暴露复杂渐变 / rgba 阴影, 它们跟随 base 主题.
export type PaletteVariable = {
  key: string            // CSS 变量名, 例如 '--bg-primary'
  label: string          // 调色盘里显示的中文名
  description: string    // 一句话解释该变量控制什么
}

export const PALETTE_VARIABLES: PaletteVariable[] = [
  { key: '--bg-primary',        label: '主背景',     description: '页面最底层背景色 (最常看到的色块)' },
  { key: '--bg-secondary',      label: '面板背景',   description: '弹层 / 模态框 / 顶栏等次级背景' },
  { key: '--bg-tertiary',       label: '卡片背景',   description: '卡片、列表项等三级背景' },
  { key: '--accent-primary',    label: '主强调色',   description: '链接、激活态、关键按钮 (蓝/紫/青)' },
  { key: '--accent-secondary',  label: '副强调色',   description: '次级强调 (青/粉/绿)' },
  { key: '--text-primary',      label: '主文本',     description: '正文、标题等主要文字颜色' },
  { key: '--text-secondary',    label: '次文本',     description: '次要说明文字、标签' },
  { key: '--border-color',      label: '边框',       description: '卡片、输入框、菜单等的描边' },
]

export const PALETTE_VARIABLE_KEYS = PALETTE_VARIABLES.map(v => v.key)

export type CustomTheme = {
  id: string
  name: string
  base: ThemeName
  // 覆写的 CSS 变量 -> 颜色值。缺省的 key 表示沿用 base 主题.
  overrides: Record<string, string>
  createdAt: number
  updatedAt: number
}

type CustomThemesMap = Record<string, CustomTheme>

function safeReadJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    return parsed as T
  } catch {
    return fallback
  }
}

export function loadCustomThemes(): CustomThemesMap {
  if (typeof localStorage === 'undefined') return {}
  return safeReadJson<CustomThemesMap>(localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY), {})
}

export function saveCustomThemes(map: CustomThemesMap) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage 可能因隐私模式不可用, 静默失败即可.
  }
}

export function loadActiveCustomThemeId(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(ACTIVE_CUSTOM_THEME_STORAGE_KEY)
}

export function saveActiveCustomThemeId(id: string | null) {
  if (typeof localStorage === 'undefined') return
  try {
    if (id) localStorage.setItem(ACTIVE_CUSTOM_THEME_STORAGE_KEY, id)
    else localStorage.removeItem(ACTIVE_CUSTOM_THEME_STORAGE_KEY)
  } catch {
    // 隐私模式下 localStorage 可能不可用, 静默失败即可.
  }
}

export function generateCustomThemeId(): string {
  return `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function getBaseOption(base: ThemeName) {
  return THEME_OPTIONS.find(o => o.name === base) || THEME_OPTIONS[0]
}

// 给一组 overrides 计算用于主题选择器里展示的两个色块
// (背景 + 强调色). 缺省时回退到 base 主题的 swatches.
export function customThemeSwatches(theme: CustomTheme): [string, string] {
  const base = getBaseOption(theme.base)
  const swatches = base.swatches as readonly string[]
  const bg = theme.overrides['--bg-primary'] || swatches[0] || '#000000'
  const accent = theme.overrides['--accent-primary'] || swatches[1] || '#ffffff'
  return [bg, accent]
}

// 把当前激活的自定义主题的 overrides 套到 documentElement.style 上.
// base 主题的类 (如 .dark) 已经在外层设置, 这里只追加更高优先级的覆写.
// 传入 null 表示清除所有自定义覆写.
export function applyCustomThemeToRoot(theme: CustomTheme | null) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (!theme) {
    for (const key of PALETTE_VARIABLE_KEYS) root.style.removeProperty(key)
    return
  }
  // 先清掉所有已注册过的覆写, 再按当前主题重新设, 避免旧的 override 残留.
  for (const key of PALETTE_VARIABLE_KEYS) {
    if (theme.overrides[key]) {
      root.style.setProperty(key, theme.overrides[key])
    } else {
      root.style.removeProperty(key)
    }
  }
}
