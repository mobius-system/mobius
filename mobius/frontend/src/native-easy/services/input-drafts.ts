export const DRAFT_PREFIX = 'cc-draft:'
export const DRAFT_MIN_CHARS = 8

type DraftSaveOptions = {
  minChars?: number
}

function draftContentLength(value: any): number {
  if (value == null) return 0
  if (typeof value === 'string') return value.trim().length
  if (typeof value === 'number' || typeof value === 'boolean') return 0
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + draftContentLength(item), 0)
  if (typeof value === 'object') {
    return Object.values(value).reduce<number>((sum, item) => sum + draftContentLength(item), 0)
  }
  return 0
}

function storageKey(key: string) {
  return DRAFT_PREFIX + key
}

export function draftLoad<T = Record<string, any>>(key: string): T | null {
  if (!key || typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(storageKey(key))
    return raw ? JSON.parse(raw) as T : null
  } catch { return null }
}

export function draftSave(key: string, fields: Record<string, any>, options: DraftSaveOptions = {}) {
  if (!key || typeof localStorage === 'undefined') return
  try {
    const minChars = options.minChars ?? DRAFT_MIN_CHARS
    const totalLen = draftContentLength(fields)
    if (totalLen >= minChars) {
      localStorage.setItem(storageKey(key), JSON.stringify(fields))
    } else {
      localStorage.removeItem(storageKey(key))
    }
  } catch {}
}

export function draftClear(key: string) {
  if (!key || typeof localStorage === 'undefined') return
  try { localStorage.removeItem(storageKey(key)) } catch {}
}
