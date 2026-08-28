export const SESSION_UNAVAILABLE_MESSAGE = '未找到这个 Session，或你没有访问权限'

export type SearchInputIntent =
  | { kind: 'session'; query: string; sessionId: string }
  | { kind: 'keyword'; query: string }

// Mobius 当前由后端生成 8 位 UUID 前缀；显式 session= / Session ID: 也兼容
// 安全的历史 ID。这里只识别“值得精确查询”的输入，最终是否为真实且可读的
// Session 仍完全由 GET /api/tasks/:id 决定。
export function searchInputIntent(rawValue: string): SearchInputIntent {
  const query = String(rawValue || '').trim()
  const tagged = query.match(/^session(?:[\s_-]*id)?\s*[:=]\s*([a-z0-9][a-z0-9._~-]{0,127})$/i)
  const shortId = query.match(/^([0-9a-f]{8})$/i)
  const uuid = query.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i)
  const sessionId = tagged?.[1] || shortId?.[1]?.toLowerCase() || uuid?.[1]?.toLowerCase() || ''
  return sessionId
    ? { kind: 'session', query, sessionId }
    : { kind: 'keyword', query }
}

export function resolvedSessionId(candidate: string, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as { session_id?: unknown }).session_id
  if (typeof value !== 'string' || !value.trim()) return null
  return value.toLowerCase() === candidate.toLowerCase() ? value : null
}

export function sessionLookupErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message.trim() : String(reason || '').trim()
  if (!message || /(?:未找到|not\s*found|无权|无权限|forbidden|\b40[34]\b)/i.test(message)) {
    return SESSION_UNAVAILABLE_MESSAGE
  }
  return `查询 Session 失败：${message}`
}
