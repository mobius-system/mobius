export const ROUND_HEADER_PALETTE_STORAGE_KEY = 'mobius:jsonl:round-header-palette'

export type RoundHeaderPalette = {
  id: string
  name: string
  background: string
  backgroundSize: string
  border: string
  borderHover: string
  accent: string
}

// 轮次标题的两档低饱和微纹理。透明度刻意保持克制，正文颜色仍由全局主题变量负责，
// 因而 dark / light / 自定义主题下都可读。
export const ROUND_HEADER_PALETTES: readonly RoundHeaderPalette[] = [
  {
    id: 'deep-space-blue',
    name: '星尘蓝',
    background: 'radial-gradient(circle at 2px 4px, rgba(219, 234, 254, 0.5) 0 0.32px, transparent 0.68px), radial-gradient(circle at 11px 8px, rgba(125, 211, 252, 0.34) 0 0.42px, transparent 0.78px), radial-gradient(circle at 19px 3px, rgba(191, 219, 254, 0.27) 0 0.28px, transparent 0.62px), linear-gradient(100deg, rgba(37, 99, 235, 0.2) 0%, rgba(14, 165, 233, 0.07) 100%)',
    backgroundSize: '29px 23px, 37px 31px, 43px 29px, auto',
    border: 'rgba(96, 165, 250, 0.28)',
    borderHover: 'rgba(96, 165, 250, 0.48)',
    accent: '#60a5fa',
  },
  {
    id: 'moon-rock',
    name: '月岩',
    background: 'radial-gradient(circle at 3px 5px, transparent 0 0.42px, rgba(226, 232, 240, 0.2) 0.58px 0.82px, transparent 1px), radial-gradient(circle at 9px 2px, rgba(15, 23, 42, 0.22) 0 0.48px, transparent 0.78px), radial-gradient(circle at 13px 8px, rgba(203, 213, 225, 0.12) 0 0.36px, transparent 0.66px), radial-gradient(circle at 18px 4px, rgba(15, 23, 42, 0.17) 0 0.56px, transparent 0.86px), linear-gradient(100deg, rgba(71, 85, 105, 0.23) 0%, rgba(82, 82, 91, 0.08) 100%)',
    backgroundSize: '19px 13px, 17px 11px, 23px 17px, 29px 19px, auto',
    border: 'rgba(148, 163, 184, 0.28)',
    borderHover: 'rgba(148, 163, 184, 0.48)',
    accent: '#94a3b8',
  },
]

export function normalizeRoundHeaderPaletteIndex(value: unknown): number {
  const index = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(index) && index >= 0 && index < ROUND_HEADER_PALETTES.length ? index : 0
}

export function readRoundHeaderPaletteIndex(): number {
  if (typeof localStorage === 'undefined') return 0
  try {
    return normalizeRoundHeaderPaletteIndex(localStorage.getItem(ROUND_HEADER_PALETTE_STORAGE_KEY))
  } catch {
    return 0
  }
}

export function saveRoundHeaderPaletteIndex(index: number): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(ROUND_HEADER_PALETTE_STORAGE_KEY, String(normalizeRoundHeaderPaletteIndex(index)))
  } catch {
    // 隐私模式或存储额度限制下，保留当前页面内的切换结果即可。
  }
}
