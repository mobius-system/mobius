/**
 * Session 输入回放缓存：内存加 localStorage 持久化。
 *
 * 输入历史通常来自项目文件和数据库的合并结果；首次 ArrowUp 若临时请求会明显滞后。
 * 这里保留最近访问的 session，并合并同一 session 的远程历史、本地历史和并发请求。
 */
import { api } from '../store'
import { safeSetCacheItem } from './storage-budget'

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
// 单 session 持久化上限 (字符数): 输入历史是可重建缓存, 不能挤占同源 code-server 的配额.
const MAX_PERSISTED_CHARS = 80_000
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
    // 新格式 { ts, entries }; 兼容老格式裸数组 (下一次写入会自动升级).
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.entries)) {
      return parsed.entries.filter(Boolean) as SessionInputEntry[]
    }
    return Array.isArray(parsed) ? parsed.filter(Boolean) as SessionInputEntry[] : []
  } catch {
    return []
  }
}

function persist(sessionId: string, entries: SessionInputEntry[]) {
  if (!sessionId || typeof localStorage === 'undefined') return
  // 从最新往旧收, 超过字符上限即截断; 载荷带 ts, storage-budget 按它做 LRU 淘汰.
  const capped: SessionInputEntry[] = []
  let chars = 0
  for (const entry of entries.slice(0, MAX_PERSISTED_ENTRIES)) {
    const size = JSON.stringify(entry).length
    if (chars + size > MAX_PERSISTED_CHARS) break
    capped.push(entry)
    chars += size
  }
  // Quota/private-mode failures must never affect sending or recall.
  safeSetCacheItem(localStorageKey(sessionId), JSON.stringify({ ts: Date.now(), entries: capped }))
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
