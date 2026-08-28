export const THEME_OPTIONS = [
  {
    name: 'dark',
    label: '深色',
    description: '冷静蓝黑',
    swatches: ['#0a0e16', '#38bdf8'],
  },
  {
    name: 'light',
    label: '浅色',
    description: '清爽白底',
    swatches: ['#f8fafc', '#2563eb'],
  },
  {
    name: 'purple',
    label: '紫夜',
    description: '柔和紫调',
    swatches: ['#1a0f2e', '#c4b5fd'],
  },
  {
    name: 'ocean',
    label: '海岸',
    description: '深海青蓝',
    swatches: ['#061923', '#2dd4bf'],
  },
  {
    name: 'forest',
    label: '松林',
    description: '暗绿青苔',
    swatches: ['#07170f', '#86efac'],
  },
  {
    name: 'sunset',
    label: '暮色',
    description: '玫瑰暖光',
    swatches: ['#17111c', '#fb7185'],
  },
  {
    name: 'mono',
    label: '石墨',
    description: '中性灰阶',
    swatches: ['#0f1115', '#a1a1aa'],
  },
  {
    name: 'autumn',
    label: '秋色',
    description: '层林尽染',
    swatches: ['#1c1009', '#f59e0b'],
  },
] as const

export type ThemeName = typeof THEME_OPTIONS[number]['name']

export const THEME_NAMES = THEME_OPTIONS.map(option => option.name) as ThemeName[]

const THEME_NAME_SET = new Set<string>(THEME_NAMES)

export function isThemeName(theme: string | null | undefined): theme is ThemeName {
  return !!theme && THEME_NAME_SET.has(theme)
}

export function normalizeTheme(theme: string | null | undefined): ThemeName {
  return isThemeName(theme) ? theme : 'dark'
}

export function nextThemeName(theme: ThemeName): ThemeName {
  const idx = THEME_NAMES.indexOf(theme)
  return THEME_NAMES[(idx + 1) % THEME_NAMES.length] || 'dark'
}

export function getThemeOption(theme: ThemeName) {
  return THEME_OPTIONS.find(option => option.name === theme) || THEME_OPTIONS[0]
}
