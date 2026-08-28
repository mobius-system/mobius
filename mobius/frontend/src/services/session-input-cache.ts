/**
 * Session 输入回放缓存：内存加 localStorage 持久化。
 *
 * 输入历史通常来自项目文件和数据库的合并结果；首次 ArrowUp 若临时请求会明显滞后。
 * 这里保留最近访问的 session，并合并同一 session 的远程历史、本地历史和并发请求。
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
const MAX_PERSISTED_ENTRIES = 200
const LOCAL_STORAGE_PREFIX = 'mobius:session-input-history:'
const memoryCache = new Map<string, SessionInputEntry[]>()
const inFlightRequests = new Map<string, Promise<SessionInputEntry[]>>()

function entryKey(entry: SessionInputEntry): string {
  if (entry.request_id) return `request:${entry.request_id}`
  if (entry.id) return `id:${entry.id}`
  return `fallback:${entry.created_at || ''}:${(entry.input_text || entry.content || '').trim()}`
}

function mergeEntries(...groups: SessionInputEntry[][]): SessionInputEntry[] {
  const merged = new Map<string, SessionInputEntry>()
  for (const group of groups) {
    for (const entry of group) {
      if (!entry || typeof entry !== 'object') continue
      const key = entryKey(entry)
      const previous = merged.get(key)
      // Prefer the server entry when it fills in turn/request metadata for an
      // optimistic local entry with the same request id.
      merged.set(key, previous ? { ...previous, ...entry } : entry)
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
}

function localStorageKey(sessionId: string) {
  return `${LOCAL_STORAGE_PREFIX}${sessionId}`
}

function readPersisted(sessionId: string): SessionInputEntry[] {
  if (!sessionId || typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(localStorageKey(sessionId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(Boolean) as SessionInputEntry[] : []
  } catch {
    return []
  }
}

function persist(sessionId: string, entries: SessionInputEntry[]) {
  if (!sessionId || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(localStorageKey(sessionId), JSON.stringify(entries.slice(0, MAX_PERSISTED_ENTRIES)))
  } catch {
    // Quota/private-mode failures must never affect sending or recall.
  }
}

function remember(sessionId: string, entries: SessionInputEntry[], merge = true) {
  const previous = memoryCache.get(sessionId) || []
  const persisted = readPersisted(sessionId)
  const next = merge
    ? mergeEntries(persisted, previous, entries)
    : mergeEntries(entries)
  memoryCache.delete(sessionId)
  memoryCache.set(sessionId, next)
  persist(sessionId, next)
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
  if (!entries) {
    const persisted = readPersisted(sessionId)
    if (persisted.length === 0) return null
    remember(sessionId, persisted, false)
    return persisted.slice()
  }
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
      return (memoryCache.get(sessionId) || entries).slice()
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

/** 发送尝试时立刻补入缓存，下一次 ArrowUp 无须等待输入历史文件再被读取。 */
export function prependSessionInputCache(sessionId: string, inputText: string, requestId?: string): void {
  const text = inputText.trim()
  if (!sessionId || !text) return
  const current = memoryCache.get(sessionId) || []
  const entry: SessionInputEntry = {
    id: requestId ? `optimistic-input-${requestId}` : `optimistic-input-${Date.now()}`,
    session_id: sessionId,
    input_text: inputText,
    content: inputText,
    created_at: new Date().toISOString(),
    request_id: requestId || null,
  }
  remember(sessionId, [entry, ...current])
}
