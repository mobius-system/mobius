const FIRE_AND_FORGET_SESSION_KEY = 'imac:fire-and-forget-sessions'

function readSessionIds(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(FIRE_AND_FORGET_SESSION_KEY)
    const ids = raw ? JSON.parse(raw) : []
    return Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : []
  } catch {
    return []
  }
}

function writeSessionIds(ids: string[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(FIRE_AND_FORGET_SESSION_KEY, JSON.stringify(Array.from(new Set(ids))))
  } catch {}
}

export function markFireAndForgetSession(sessionId?: string | null) {
  if (!sessionId) return
  const ids = readSessionIds()
  if (ids.includes(sessionId)) return
  writeSessionIds(ids.concat(sessionId))
}

export function isFireAndForgetSession(sessionId?: string | null) {
  if (!sessionId) return false
  return readSessionIds().includes(sessionId)
}
