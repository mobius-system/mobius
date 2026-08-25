/**
 * Session 输入回放的短生命周期缓存。
 *
 * 输入历史通常来自项目文件和数据库的合并结果；首次 ArrowUp 若临时请求会明显滞后。
 * 这里保留当前页面生命周期内最近访问的 session，并合并同一 session 的并发请求。
 */
import { api } from '../store'

export type SessionInputEntry = {
  id: string
  session_id?: string
  input_text?: string
  content?: string
  created_at?: string
  request_id?: string | null
  turn_number?: number | null
}

const MAX_CACHED_SESSIONS = 128
const memoryCache = new Map<string, SessionInputEntry[]>()
const inFlightRequests = new Map<string, Promise<SessionInputEntry[]>>()

function remember(sessionId: string, entries: SessionInputEntry[]) {
  memoryCache.delete(sessionId)
  memoryCache.set(sessionId, entries)
  while (memoryCache.size > MAX_CACHED_SESSIONS) {
    const oldestSessionId = memoryCache.keys().next().value
    if (!oldestSessionId) break
    memoryCache.delete(oldestSessionId)
  }
}

/** 同步读缓存。返回新的数组，调用方不能改变共享的缓存顺序。 */
export function readSessionInputCache(sessionId: string): SessionInputEntry[] | null {
  if (!sessionId) return null
  const entries = memoryCache.get(sessionId)
  if (!entries) return null
  remember(sessionId, entries)
  return entries.slice()
}

/** 发起或复用该 session 唯一的输入历史请求。 */
export function refreshSessionInputCache(sessionId: string): Promise<SessionInputEntry[]> {
  if (!sessionId) return Promise.resolve([])
  const pending = inFlightRequests.get(sessionId)
  if (pending) return pending

  const request = api(`/api/sessions/${sessionId}/inputs`)
    .then((data: any) => {
      const entries = Array.isArray(data?.entries) ? data.entries as SessionInputEntry[] : []
      remember(sessionId, entries)
      return entries.slice()
    })
    .finally(() => {
      inFlightRequests.delete(sessionId)
    })
  inFlightRequests.set(sessionId, request)
  return request
}

/** 进入 session 时预取；调用方不需要等待，也不会造成重复请求。 */
export function preloadSessionInputCache(sessionId: string): void {
  void refreshSessionInputCache(sessionId).catch(() => {})
}

/** POST 成功后立刻补入缓存，下一次 ArrowUp 无须等待输入历史文件再被读取。 */
export function prependSessionInputCache(sessionId: string, inputText: string): void {
  const text = inputText.trim()
  if (!sessionId || !text) return
  const current = memoryCache.get(sessionId) || []
  if (current.some((entry) => (entry.input_text || entry.content || '').trim() === text)) return
  remember(sessionId, [{
    id: `optimistic-input-${Date.now()}`,
    session_id: sessionId,
    input_text: inputText,
    content: inputText,
    created_at: new Date().toISOString(),
  }, ...current])
}
