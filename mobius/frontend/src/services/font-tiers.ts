/*
 * Font tier metadata + persistence — the TS twin of font-tiers.css.
 * Keeps the seven global font tiers in sync between the CSS defaults and
 * the appearance-menu editor (localStorage overrides applied to :root).
 */

export type FontTierKey = '--fs-2xs' | '--fs-xs' | '--fs-sm' | '--fs-md' | '--fs-lg' | '--fs-xl' | '--fs-2xl'

export type FontTier = {
  key: FontTierKey
  label: string
  defaultPx: number
}

// 与 font-tiers.css 的 :root 默认值保持一致 (单一事实来源的 TS 镜像)
export const FONT_TIERS: FontTier[] = [
  { key: '--fs-2xs', label: '极小', defaultPx: 9 },
  { key: '--fs-xs', label: '小', defaultPx: 10 },
  { key: '--fs-sm', label: '较小', defaultPx: 11 },
  { key: '--fs-md', label: '中', defaultPx: 12 },
  { key: '--fs-lg', label: '较大', defaultPx: 13 },
  { key: '--fs-xl', label: '大', defaultPx: 14 },
  { key: '--fs-2xl', label: '超大', defaultPx: 15 },
]

export type FontTierValues = Record<FontTierKey, number>

const STORAGE_KEY = 'mobius-font-tiers-v1'
// 弹窗可调范围: 允许超出 9~15 但仍在人眼可读、布局可承受的区间内
export const FONT_TIER_MIN_PX = 6
export const FONT_TIER_MAX_PX = 28

export function clampFontTierPx(px: number): number {
  if (!Number.isFinite(px)) return px
  return Math.min(FONT_TIER_MAX_PX, Math.max(FONT_TIER_MIN_PX, px))
}

export function defaultFontTierValues(): FontTierValues {
  const out = {} as FontTierValues
  for (const t of FONT_TIERS) out[t.key] = t.defaultPx
  return out
}

/*
 * Read the localStorage overrides (partial map, only keys the user touched).
 * Returns {} when nothing stored or the payload is malformed.
 */
export function loadFontTierOverrides(): Partial<FontTierValues> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Partial<FontTierValues> = {}
    for (const t of FONT_TIERS) {
      const v = Number((parsed as Record<string, unknown>)[t.key])
      if (Number.isFinite(v) && v > 0) out[t.key] = clampFontTierPx(v)
    }
    return out
  } catch {
    return {}
  }
}

// Defaults merged with stored overrides — what the UI should currently show.
export function effectiveFontTierValues(): FontTierValues {
  return { ...defaultFontTierValues(), ...loadFontTierOverrides() }
}

export function saveFontTierOverrides(values: FontTierValues) {
  const defaults = defaultFontTierValues()
  // 只持久化偏离默认值的档位, 保持 payload 精简
  const delta: Partial<FontTierValues> = {}
  for (const t of FONT_TIERS) {
    if (values[t.key] !== defaults[t.key]) delta[t.key] = values[t.key]
  }
  if (Object.keys(delta).length === 0) localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, JSON.stringify(delta))
}

/*
 * Push values onto :root as inline style overrides (beats font-tiers.css).
 * Call with the effective map at startup and on every slider move for
 * live preview.
 */
export function applyFontTierValues(values: FontTierValues) {
  if (typeof document === 'undefined') return
  for (const t of FONT_TIERS) {
    document.documentElement.style.setProperty(t.key, `${clampFontTierPx(values[t.key])}px`)
  }
}

// Drop localStorage overrides and restore the CSS-file defaults everywhere.
export function resetFontTierOverrides() {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* 忽略存储异常 */ }
  if (typeof document === 'undefined') return
  for (const t of FONT_TIERS) {
    document.documentElement.style.removeProperty(t.key)
  }
}

/*
 * Resolve a tier to a concrete number (for JS-only font consumers like
 * xterm, which demand a number instead of a CSS var string).
 */
export function readFontTierPx(key: FontTierKey): number {
  if (typeof document !== 'undefined') {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(key))
    if (Number.isFinite(v) && v > 0) return v
  }
  const t = FONT_TIERS.find(t => t.key === key)
  return t ? t.defaultPx : 12
}
