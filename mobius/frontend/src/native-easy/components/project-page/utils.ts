// 前端 forgotten-flag 默认值的单一真相源 (前端侧). 必须与后端
// mobius/backend/config.js 的 DEFAULT_FORGOTTEN_FLAG_* 保持同步.
// 任何默认值调整需同时改这里 + 后端 config.js, 不要在其它前端文件再开硬编码副本.
export const DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES = 10
export const DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES = 30
export const DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF = 2
export const DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF = 5
export const DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE = 3
export const DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE = 5
export const FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX = 7 * 24 * 60
export const FORGOTTEN_FLAG_BACKOFF_MIN = 1
export const FORGOTTEN_FLAG_BACKOFF_MAX = 100
export const FORGOTTEN_FLAG_PATIENCE_MAX = 1000

export function intervalInputValue(value: any, fallback: number) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? String(n) : String(fallback)
}

export function numberInputValue(value: any, fallback: number) {
  const n = Number(value)
  return Number.isFinite(n) ? String(n) : String(fallback)
}

export function parseIntervalInput(value: string, label: string, min: number) {
  const n = Number(value)
  if (!Number.isInteger(n)) throw new Error(`${label}必须是整数分钟`)
  if (n < min) throw new Error(`${label}不能小于 ${min} 分钟`)
  if (n > FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX) throw new Error(`${label}不能超过 ${FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX} 分钟`)
  return n
}

export function parseBackoffInput(value: string, label: string) {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${label}必须是数字`)
  if (n < FORGOTTEN_FLAG_BACKOFF_MIN) throw new Error(`${label}不能小于 ${FORGOTTEN_FLAG_BACKOFF_MIN}`)
  if (n > FORGOTTEN_FLAG_BACKOFF_MAX) throw new Error(`${label}不能超过 ${FORGOTTEN_FLAG_BACKOFF_MAX}`)
  return n
}

export function parsePatienceInput(value: string, label: string) {
  const n = Number(value)
  if (!Number.isInteger(n)) throw new Error(`${label}必须是整数`)
  if (n < 1) throw new Error(`${label}不能小于 1`)
  if (n > FORGOTTEN_FLAG_PATIENCE_MAX) throw new Error(`${label}不能超过 ${FORGOTTEN_FLAG_PATIENCE_MAX}`)
  return n
}
