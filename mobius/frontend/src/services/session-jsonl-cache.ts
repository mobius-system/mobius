/**
 * session-jsonl-cache.ts — 浏览器侧 JSONL 尾部缓存.
 *
 * 目的: 快速在 session 之间切换时, 立刻展示该 session 上一次的 JSONL 尾部 (stale-while-revalidate),
 *       不必等 SSE /api/sessions/:id/events 的 jsonl_meta + jsonl_history 回灌, 消除切换卡顿.
 *
 * 两层结构:
 *   - 内存层 (Map): 同一次页面加载内, 在已访问过的 session 间反复横跳 → 同步命中, 零延迟.
 *   - IndexedDB 层: 跨刷新/重开浏览器后仍可秒开; LRU 上限 128 个 session, 超出淘汰最久未写.
 *
 * 缓存只存尾部 (最多 MAX_ENTRIES_PER_SESSION 条), 与后端 DEFAULT_HISTORY_TAIL 及
 * JsonlView 显示窗口一致. 用户点 "加载全部" 拉到的头部不进入缓存 (离开时只取尾部).
 *
 * 全部 best-effort: IndexedDB 不可用 (隐私模式 / 老浏览器) 时读返回 null, 写静默跳过, 不抛错.
 */

const DB_NAME = 'mobius-jsonl-cache'
const DB_VERSION = 1
const STORE_NAME = 'sessions'
const INDEX_UPDATED_AT = 'updatedAt'

// LRU 上限: 最多缓存 128 个 session.
export const MAX_CACHED_SESSIONS = 128
// 每个 session 缓存的尾部条目数上限 (与后端 tail / 前端显示窗口对齐).
export const MAX_ENTRIES_PER_SESSION = 80

export type JsonlSnapshot = {
  entries: any[]
  total: number
  path: string | null
  updatedAt: number
}

// ── 内存层 (Map 保持插入顺序 → 天然 LRU: 命中/写入时 delete+re-insert 提到最新) ──
const memoryCache = new Map<string, JsonlSnapshot>()

function cloneSnapshot(snap: JsonlSnapshot): JsonlSnapshot {
  return { entries: snap.entries, total: snap.total, path: snap.path, updatedAt: snap.updatedAt }
}

function rememberInMemory(sessionId: string, snap: JsonlSnapshot) {
  memoryCache.delete(sessionId)
  memoryCache.set(sessionId, snap)
  while (memoryCache.size > MAX_CACHED_SESSIONS) {
    const oldestKey = memoryCache.keys().next().value
    if (oldestKey === undefined) break
    memoryCache.delete(oldestKey)
  }
}

/** 同步读内存层. 命中返回快照副本 (调用方可安全改), 未命中返回 null. */
export function readJsonlCacheSync(sessionId: string): JsonlSnapshot | null {
  if (!sessionId) return null
  const snap = memoryCache.get(sessionId)
  if (!snap) return null
  // LRU 提前: 读也算访问, 重新插入到 Map 末尾.
  memoryCache.delete(sessionId)
  memoryCache.set(sessionId, snap)
  return cloneSnapshot(snap)
}

// ── IndexedDB 层 ────────────────────────────────────────────────────────────
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' })
          store.createIndex(INDEX_UPDATED_AT, INDEX_UPDATED_AT, { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** 异步读 IndexedDB. 命中时回填内存层, 返回快照副本; 未命中 / 不可用返回 null. */
export async function readJsonlCacheFromIdb(sessionId: string): Promise<JsonlSnapshot | null> {
  if (!sessionId) return null
  const db = await openDb()
  if (!db) return null
  try {
    const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME)
    const rec = await requestToPromise<any>(store.get(sessionId))
    if (!rec) return null
    const snap: JsonlSnapshot = {
      entries: Array.isArray(rec.entries) ? rec.entries : [],
      total: typeof rec.total === 'number' ? rec.total : 0,
      path: typeof rec.path === 'string' ? rec.path : null,
      updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : 0,
    }
    // 内存层没有更新的值时回填 (避免用 IDB 旧值覆盖内存更新值).
    const existing = memoryCache.get(sessionId)
    if (!existing || existing.updatedAt < snap.updatedAt) {
      rememberInMemory(sessionId, snap)
    }
    return cloneSnapshot(snap)
  } catch {
    return null
  }
}

// 超过 MAX_CACHED_SESSIONS 时, 按 updatedAt 升序淘汰最旧的若干条.
// 全程在同一事务内, 用 "先 count 再 openKeyCursor 边走边 delete" 的安全模式
// (每个回调里同步排队 delete + continue, 事务不会因回到事件循环而提前提交).
function evictExcess(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    let store: IDBObjectStore
    try {
      store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME)
    } catch { resolve(); return }
    const countReq = store.count()
    countReq.onsuccess = () => {
      const count = countReq.result
      if (count <= MAX_CACHED_SESSIONS) { resolve(); return }
      const excess = count - MAX_CACHED_SESSIONS
      let evicted = 0
      const idx = store.index(INDEX_UPDATED_AT)
      const curReq = idx.openKeyCursor()
      curReq.onsuccess = () => {
        const cursor = curReq.result
        if (!cursor || evicted >= excess) { resolve(); return }
        try { store.delete(cursor.primaryKey) } catch { /* ignore */ }
        evicted += 1
        cursor.continue()
      }
      curReq.onerror = () => resolve()
    }
    countReq.onerror = () => resolve()
  })
}

/**
 * 写入缓存 (内存层同步 + IndexedDB 层异步). entries 超过尾部上限时只保留最后 N 条.
 * 同步更新内存层 (切换走时立刻生效), IndexedDB 写 + 淘汰在后台 fire-and-forget.
 */
export function writeJsonlCache(
  sessionId: string,
  entries: any[],
  total: number,
  path: string | null,
): void {
  if (!sessionId) return
  const source = Array.isArray(entries) ? entries : []
  const tail = source.length > MAX_ENTRIES_PER_SESSION
    ? source.slice(-MAX_ENTRIES_PER_SESSION)
    : source
  if (tail.length === 0) return
  const snap: JsonlSnapshot = { entries: tail, total, path, updatedAt: Date.now() }
  rememberInMemory(sessionId, snap)
  // IndexedDB 写 + LRU 淘汰: 不阻塞调用方.
  void persistToIdb(sessionId, snap)
}

async function persistToIdb(sessionId: string, snap: JsonlSnapshot): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME)
    await requestToPromise(store.put({ sessionId, ...snap }))
    await evictExcess(db)
  } catch {
    /* ignore */
  }
}

/** 清空全部缓存 (内存 + IndexedDB). 预留给登出/清理场景. */
export async function clearJsonlCache(): Promise<void> {
  memoryCache.clear()
  const db = await openDb()
  if (!db) return
  try {
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME)
    await requestToPromise(store.clear())
  } catch {
    /* ignore */
  }
}
