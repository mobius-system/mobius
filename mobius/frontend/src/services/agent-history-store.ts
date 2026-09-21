/**
 * agent-history-store.ts — 前端 group 存储 (历史协议 ①②③ 的唯一消费方).
 *
 * 数据模型: 组元数据 (① 全量一次给全) + 按需加载的组条目 (② 整组全量) + SSE 增量 (③).
 *
 * 并发法则 (唯一): 水位线 — 只应用 version > 本地 的事件/快照, ≤ 一律丢弃;
 * uuid 去重作双保险. 无 live 特判: 正在跑的轮只是 version 蹦得快的普通组.
 *
 * 缓存 (两条规则, 无特例):
 *   读时协商: 打开会话先渲染缓存 (内存层 → IndexedDB 层), 同时 ① 协商;
 *             version 对上的已加载组零请求, 对不上的整组重拉 ②.
 *   写时穿透: SSE 到货 → 内存 store 与 IndexedDB 同步更新 (合批 1s 落盘).
 *
 * 事件早到 (本地还没有该组, ① 尚未完成): 先缓冲; negotiate 完成后按水位线对账.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react'

// 同源部署: 与 EventSource 一样走相对路径.
const API = ''

export interface HistoryGroupMeta {
  id: string
  seq: number
  opener_ts: string | null
  user_summary: string
  version: number
  entry_count: number
  essential_dict?: {
    opener: any | null
    final: any | null
  }
}

// 挂起中的开轮卡 (pending_round_openers): 前端当作「特殊的最后一个组」渲染.
export interface PendingOpenerMeta {
  id: string
  opener_ts: string | null
  user_summary: string
}

// ── 组状态机 (展开与加载合一; 展开即背负加载义务) ────────────────────────────
//
//   closed --用户展开 or 自动展开--> open-unloaded --自动加载--> open-loading
//   open-loading --② http / 内存驻留--> open-loaded --用户关闭--> closed
//
//   closed       : 折叠. 条目可仍驻留内存 (折叠不清内存, LRU 才逐出).
//   open-unloaded: 已展开, 数据未驻留. 只存活一瞬 (自动加载立即接手) 或加载失败后停留.
//   open-loading : 首次加载在途 (② http).
//   open-loaded  : 至少加载过一次; SSE 增量持续追加.
//
//   sticky: 用户手动开/合过 → 自动规则 (末两轮自动展开) 永不再接管.
//   数据驻留以 entriesByGroup 是否含该组为准, 与开合状态正交.
export type GroupState = 'closed' | 'open-unloaded' | 'open-loading' | 'open-loaded'

export interface GroupRuntime {
  state: GroupState
  sticky: boolean
  lastError: string | null
}

export interface HistorySnapshot {
  rev: number
  sessionVersion: number
  jsonlPath: string | null
  groups: HistoryGroupMeta[]
  pending: PendingOpenerMeta[]
  entriesByGroup: ReadonlyMap<string, any[]>
  groupRuntime: ReadonlyMap<string, GroupRuntime>
  error: string | null
  negotiated: boolean
}

// ── IndexedDB 缓存层 (best-effort: 不可用时读写静默跳过) ───────────────────

const CACHE_DB_NAME = 'mobius-agent-history'
const CACHE_DB_VERSION = 1
const CACHE_STORE = 'sessions'
// LRU 上限: 最多缓存 24 个会话; 单会话条目字节预算 8MB (超预算时从最旧的已加载组开始丢弃, 元数据永留).
const MAX_CACHED_SESSIONS = 24
const MAX_SESSION_CACHE_BYTES = 8 * 1024 * 1024

interface CacheRecord {
  sid: string
  sessionVersion: number
  updatedAt: number
  jsonlPath: string | null
  groups: HistoryGroupMeta[]
  groupsData: Array<{ gid: string; version: number; entries: any[] }>
  // 用户手动开/合过的组 (sticky), 跨刷新保留展开偏好.
  stickies?: Record<string, boolean>
}

function openCacheDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(CACHE_STORE)) {
          db.createObjectStore(CACHE_STORE, { keyPath: 'sid' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function cacheRead(sid: string): Promise<CacheRecord | null> {
  const db = await openCacheDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(CACHE_STORE, 'readonly')
      const req = tx.objectStore(CACHE_STORE).get(sid)
      req.onsuccess = () => resolve((req.result as CacheRecord) || null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function cacheWrite(record: CacheRecord): Promise<void> {
  const db = await openCacheDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(CACHE_STORE, 'readwrite')
      const store = tx.objectStore(CACHE_STORE)
      store.put(record)
      // LRU: 超上限时淘汰最久未更新的会话.
      const all = store.getAll()
      all.onsuccess = () => {
        const rows = (all.result as CacheRecord[]) || []
        if (rows.length > MAX_CACHED_SESSIONS) {
          rows.sort((a, b) => a.updatedAt - b.updatedAt)
          for (const row of rows.slice(0, rows.length - MAX_CACHED_SESSIONS)) {
            store.delete(row.sid)
          }
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
}

// ── 协议请求 ─────────────────────────────────────────────────────────────

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = localStorage.getItem('cc-token')
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }
}

/** ① GET groups. 304 → notModified (缓存全可信). */
async function fetchGroups(sid: string, etag: string | null, withEssential = false): Promise<{ notModified?: boolean; session_version?: number; jsonl_path?: string | null; groups?: HistoryGroupMeta[]; pending?: PendingOpenerMeta[] }> {
  const query = withEssential ? '?with_essential=1' : ''
  const res = await fetch(`${API}/api/sessions/${encodeURIComponent(sid)}/groups${query}`, {
    // Essential data is an optional projection; never let a prior ETag hide it with 304.
    headers: authHeaders(withEssential ? {} : (etag ? { 'If-None-Match': etag } : {})),
  })
  if (res.status === 304) return { notModified: true }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

/** ② GET 某组全部条目 (全量, 无分页). */
async function fetchGroupEntries(sid: string, gid: string): Promise<{ version: number; entries: any[] }> {
  const res = await fetch(`${API}/api/sessions/${encodeURIComponent(sid)}/groups/${encodeURIComponent(gid)}/entries`, {
    headers: authHeaders(),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return { version: Number(data?.version) || 0, entries: Array.isArray(data?.entries) ? data.entries : [] }
}

// ── Store ────────────────────────────────────────────────────────────────

const EMPTY_SNAPSHOT: HistorySnapshot = {
  rev: 0, sessionVersion: 0, jsonlPath: null, groups: [], pending: [], entriesByGroup: new Map(),
  groupRuntime: new Map(), error: null, negotiated: false,
}

// SSE 新鲜度标记: ③ 事件追加的条目进 WeakSet, 卡片首次挂载时消费 (查后即删).
// 用途: 入场动画只播给"数据新到达"的卡 — ② 加载的历史卡与滚动复挂 (虚拟列表卸载重挂)
// 都查不到标记, 静默出现. 打在数据对象上而非组件状态上, 复挂天然不重播.
const sseFreshEntries = new WeakSet<object>()

/** 卡片挂载时调用一次: 是 SSE 新到的条目则返回 true (并消费掉, 之后复挂不再算新). */
export function consumeFreshEntry(entry: any): boolean {
  if (!entry || typeof entry !== 'object') return false
  if (sseFreshEntries.has(entry)) {
    sseFreshEntries.delete(entry)
    return true
  }
  return false
}

export class SessionHistoryStore {
  readonly sid: string
  private rev = 0
  private listeners = new Set<() => void>()
  private snapshotCache: HistorySnapshot | null = null
  private flatCache: { rev: number; entries: any[] } | null = null
  private uuidIndex: Set<string> | null = null
  private hydrated = false
  private negotiating = false
  private writeThroughTimer: ReturnType<typeof setTimeout> | null = null

  groups: HistoryGroupMeta[] = []
  pending: PendingOpenerMeta[] = []
  sessionVersion = 0
  jsonlPath: string | null = null
  negotiated = false
  error: string | null = null
  entriesByGroup = new Map<string, any[]>()
  groupRuntime = new Map<string, GroupRuntime>()
  groupVersions = new Map<string, number>()
  // 在途 ② 请求去重 (开合状态不再承担"在途"语义).
  private inflight = new Set<string>()
  // ① 完成前到达的 SSE 事件缓冲 (订阅先于协商的生命周期).
  private pendingEvents: Array<() => void> = []
  private essentialsLoading = false

  constructor(sid: string) {
    this.sid = sid
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  getSnapshot = (): HistorySnapshot => {
    if (!this.snapshotCache || this.snapshotCache.rev !== this.rev) {
      this.snapshotCache = {
        rev: this.rev,
        sessionVersion: this.sessionVersion,
        jsonlPath: this.jsonlPath,
        groups: this.groups,
        pending: this.pending,
        entriesByGroup: this.entriesByGroup,
        groupRuntime: this.groupRuntime,
        error: this.error,
        negotiated: this.negotiated,
      }
    }
    return this.snapshotCache
  }

  private emit() {
    this.rev += 1
    for (const fn of this.listeners) {
      try { fn() } catch {}
    }
  }

  private uuids(): Set<string> {
    if (!this.uuidIndex) {
      this.uuidIndex = new Set<string>()
      for (const entries of this.entriesByGroup.values()) {
        for (const e of entries) {
          if (typeof e?.uuid === 'string') this.uuidIndex.add(e.uuid)
        }
      }
    }
    return this.uuidIndex
  }

  private resetUuidIndex() { this.uuidIndex = null }

  /** 已加载条目按全局顺序摊平 (简易视图 / 次要过滤 / live 时间戳等派生消费). */
  flattenEntries(): any[] {
    if (this.flatCache && this.flatCache.rev === this.rev) return this.flatCache.entries
    const out: any[] = []
    for (const g of this.groups) {
      const entries = this.entriesByGroup.get(g.id)
      if (entries) out.push(...entries)
    }
    this.flatCache = { rev: this.rev, entries: out }
    return out
  }

  stats(): { loadedCount: number; totalCount: number } {
    let loaded = 0
    for (const entries of this.entriesByGroup.values()) loaded += entries.length
    let total = 0
    for (const g of this.groups) total += g.entry_count || 0
    return { loadedCount: loaded, totalCount: total }
  }

  // ── 组状态机: 开合与加载 ────────────────────────────────────────────────

  private runtimeOf(gid: string): GroupRuntime {
    let rt = this.groupRuntime.get(gid)
    if (!rt) {
      rt = { state: 'closed', sticky: false, lastError: null }
      this.groupRuntime.set(gid, rt)
    }
    return rt
  }

  /** 展开 (用户/自动). closed → open-unloaded, 随即自动加载: 驻留即开, 否则发 ②. */
  openGroup(gid: string, origin: 'user' | 'auto' = 'user'): void {
    const rt = this.runtimeOf(gid)
    if (origin === 'user') rt.sticky = true
    if (rt.state === 'closed') {
      rt.state = 'open-unloaded'
      this.emit()
      this.loadOpenGroup(gid)
    } else if (rt.state === 'open-unloaded') {
      // 加载失败后的重试也走这里.
      this.loadOpenGroup(gid)
    }
  }

  /** 关闭 (用户/自动). 条目保持驻留 (折叠不清内存). */
  closeGroup(gid: string, origin: 'user' | 'auto' = 'user'): void {
    const rt = this.runtimeOf(gid)
    if (origin === 'user') rt.sticky = true
    if (rt.state !== 'closed') {
      rt.state = 'closed'
      this.emit()
      this.persistSoon()
    }
  }

  toggleGroup(gid: string): void {
    const rt = this.runtimeOf(gid)
    if (rt.state === 'closed') this.openGroup(gid, 'user')
    else this.closeGroup(gid, 'user')
  }

  /** 失败重试: 只对停留在 open-unloaded 的组重新发起加载. */
  retryGroup(gid: string): void {
    const rt = this.runtimeOf(gid)
    if (rt.state === 'open-unloaded') this.loadOpenGroup(gid)
  }

  private loadOpenGroup(gid: string): void {
    const rt = this.runtimeOf(gid)
    // 内存驻留 → 即开 (cache 命中路径).
    if (this.entriesByGroup.has(gid)) {
      rt.state = 'open-loaded'
      rt.lastError = null
      this.emit()
      return
    }
    if (rt.state === 'open-loading' || this.inflight.has(gid)) return
    rt.state = 'open-loading'
    rt.lastError = null
    this.emit()
    void this.ensureGroupEntries(gid)
  }

  // ── 缓存水合 (打开会话秒显) ────────────────────────────────────────────

  async hydrateFromCache(): Promise<void> {
    if (this.hydrated) return
    this.hydrated = true
    try {
      const record = await cacheRead(this.sid)
      if (!record || !Array.isArray(record.groups) || record.groups.length === 0) return
      // 缓存比内存还旧 (理论上不会) 或内存已协商 → 不覆盖.
      if (this.negotiated) return
      this.groups = [...record.groups].sort((a, b) => a.seq - b.seq)
      this.sessionVersion = Number(record.sessionVersion) || 0
      this.jsonlPath = record.jsonlPath || null
      for (const gd of record.groupsData || []) {
        if (!Array.isArray(gd.entries) || gd.entries.length === 0) continue
        this.entriesByGroup.set(String(gd.gid), gd.entries)
        this.groupVersions.set(String(gd.gid), Number(gd.version) || gd.entries.length)
      }
      // 展开偏好恢复: sticky 保留, 开合一律从 closed 起步 (末两轮由自动规则重新展开).
      for (const g of this.groups) {
        const sticky = !!(record.stickies && record.stickies[g.id])
        this.groupRuntime.set(g.id, { state: 'closed', sticky, lastError: null })
      }
      this.emit()
    } catch { /* best-effort */ }
  }

  // ── ① 协商 ────────────────────────────────────────────────────────────

  async negotiate(): Promise<void> {
    if (this.negotiating) return
    this.negotiating = true
    try {
      const etag = this.sessionVersion > 0 ? String(this.sessionVersion) : null
      const data = await fetchGroups(this.sid, etag)
      if (!data.notModified) {
        const serverGroups = (data.groups || []).slice().sort((a, b) => a.seq - b.seq)
        const serverById = new Map(serverGroups.map((g) => [String(g.id), g]))
        // 元数据除 version 外不可变 → 直接采信服务端数组; 本地已加载组的条目按水位线校验.
        const staleLoaded: string[] = []
        for (const [gid, entries] of this.entriesByGroup) {
          const meta = serverById.get(gid)
          const localVersion = this.groupVersions.get(gid) || 0
          if (!meta || (Number(meta.version) || 0) > localVersion) staleLoaded.push(gid)
          void entries
        }
        // 缓存里已被服务端删除的组 → 丢弃本地条目.
        for (const gid of [...this.entriesByGroup.keys()]) {
          if (!serverById.has(gid)) {
            this.entriesByGroup.delete(gid)
            this.groupRuntime.delete(gid)
            this.groupVersions.delete(gid)
          }
        }
        this.groups = serverGroups
        this.pending = Array.isArray(data.pending) ? data.pending : []
        this.sessionVersion = Number(data.session_version) || 0
        if (typeof data.jsonl_path === 'string') this.jsonlPath = data.jsonl_path
        this.error = null
        this.negotiated = true
        this.emit()
        this.persistSoon()
        // version 变了的已加载组 → 整组重拉 (读时协商规则).
        for (const gid of staleLoaded) this.ensureGroupEntries(gid, { force: true })
      } else {
        this.negotiated = true
        this.emit()
      }
      // 视口轮: 自动加载末尾几组 (新消息/继续对话的主场; 兼顾简易视图的轮次列表).
      this.ensureLastGroups(5)
      // ① 完成 → 释放缓冲事件, 按水位线对账.
      const buffered = this.pendingEvents
      this.pendingEvents = []
      for (const apply of buffered) apply()
    } catch (e: any) {
      this.error = e?.message || String(e)
      this.negotiated = true
      this.emit()
    } finally {
      this.negotiating = false
    }
  }

  /** Load the optional opener/final projection used by easy mode without touching full entries. */
  async ensureEssentialGroups(): Promise<void> {
    if (this.essentialsLoading || this.groups.length === 0) return
    this.essentialsLoading = true
    try {
      const data = await fetchGroups(this.sid, null, true)
      if (data.notModified || !Array.isArray(data.groups)) return
      const essentialById = new Map(data.groups.map((group) => [String(group.id), group.essential_dict]))
      let changed = false
      this.groups = this.groups.map((group) => {
        const essential = essentialById.get(group.id)
        if (!essential) return group
        changed = true
        return { ...group, essential_dict: essential }
      })
      if (changed) {
        this.emit()
        this.persistSoon()
      }
    } catch {
      // Essential projection is a best-effort enhancement; full group loading remains usable.
    } finally {
      this.essentialsLoading = false
    }
  }

  // ── ② 按需整组加载 ────────────────────────────────────────────────────

  /**
   * 背景整组加载 (negotiate 预热 / 搜索定位 / openGroup 的自动加载共用).
   * 只负责数据驻留, 不改开合状态; open-loading 的组成功后升为 open-loaded,
   * 失败退回 open-unloaded (never-tried 与 failed 由 lastError 区分).
   */
  async ensureGroupEntries(gid: string, opts: { force?: boolean } = {}): Promise<void> {
    const key = String(gid)
    if (!opts.force && (this.entriesByGroup.has(key) || this.inflight.has(key))) return
    if (this.inflight.has(key)) return
    this.inflight.add(key)
    const meta = this.groups.find((g) => g.id === key)
    try {
      const data = await fetchGroupEntries(this.sid, key)
      const merged = this.mergeEntries(key, data.entries)
      this.entriesByGroup.set(key, merged)
      this.groupVersions.set(key, Math.max(this.groupVersions.get(key) || 0, data.version || merged.length))
      const rt = this.runtimeOf(key)
      if (rt.state === 'open-loading') rt.state = 'open-loaded'
      rt.lastError = null
      if (meta) {
        meta.version = Math.max(meta.version || 0, data.version || merged.length)
        meta.entry_count = Math.max(meta.entry_count || 0, merged.length)
      }
      this.emit()
      this.persistSoon()
    } catch (e: any) {
      const rt = this.runtimeOf(key)
      if (rt.state === 'open-loading') rt.state = 'open-unloaded'
      rt.lastError = e?.message || String(e)
      this.error = rt.lastError
      this.emit()
    } finally {
      this.inflight.delete(key)
    }
  }

  ensureLastGroups(count: number): void {
    const tail = this.groups.slice(-count)
    for (const g of tail) this.ensureGroupEntries(g.id)
  }

  /** uuid 去重合并 (保险丝: ② 与 SSE 双路到达同一条时只留一份). */
  private mergeEntries(gid: string, incoming: any[]): any[] {
    const existing = this.entriesByGroup.get(gid) || []
    const known = new Set<string>()
    for (const e of existing) {
      if (typeof e?.uuid === 'string') known.add(e.uuid)
    }
    const out = [...existing]
    for (const e of incoming) {
      const uuid = typeof e?.uuid === 'string' ? e.uuid : null
      if (uuid) {
        if (known.has(uuid)) continue
        known.add(uuid)
      }
      out.push(e)
    }
    this.resetUuidIndex()
    return out
  }

  // ── ③ SSE 事件应用 ────────────────────────────────────────────────────

  applySseEvent(msg: any): void {
    if (!msg || typeof msg !== 'object') return
    if (msg.session_id && msg.session_id !== this.sid) return
    if (msg.event === 'group_created') {
      this.applyOrBuffer(() => this.applyGroupCreated(msg.group))
    } else if (msg.event === 'entries') {
      this.applyOrBuffer(() => this.applyEntriesEvent(msg))
    } else if (msg.event === 'pending_opener') {
      this.applyOrBuffer(() => this.applyPendingOpener(msg.entry))
    }
  }

  private applyOrBuffer(apply: () => void): void {
    if (!this.negotiated) {
      this.pendingEvents.push(apply)
      return
    }
    apply()
  }

  private applyGroupCreated(group: any): void {
    if (!group || typeof group !== 'object') return
    const id = String(group.id)
    if (this.groups.some((g) => g.id === id)) return  // 元数据不可变, 已知即忽略
    const meta: HistoryGroupMeta = {
      id,
      seq: Number(group.seq) || (this.groups.length + 1),
      opener_ts: group.opener_ts || null,
      user_summary: group.user_summary || '',
      version: Number(group.version) || 1,
      entry_count: Number(group.entry_count) || 1,
    }
    this.groups.push(meta)
    this.groups.sort((a, b) => a.seq - b.seq)
    // 出队 = 所有 pending 一次性开成该组 → 清空伪组.
    this.pending = []
    this.emit()
    this.persistSoon()
  }

  private applyPendingOpener(entry: any): void {
    if (!entry || typeof entry !== 'object') return
    const id = String(entry.id || '')
    if (!id) return
    if (this.pending.some((p) => p.id === id)) return
    this.pending.push({
      id,
      opener_ts: entry.opener_ts || null,
      user_summary: entry.user_summary || '',
    })
    this.emit()
  }

  private applyEntriesEvent(msg: any): void {
    const gid = String(msg.group_id ?? '')
    if (!gid) return
    const version = Number(msg.group_id_version) || 0
    const meta = this.groups.find((g) => g.id === gid)
    if (!meta) {
      // 事件早到且 ① 也没带上它 (罕见): 重新协商拿元数据, 再整组拉取.
      this.negotiate().then(() => this.ensureGroupEntries(gid, { force: true })).catch(() => {})
      return
    }
    const localVersion = this.groupVersions.get(gid) || 0
    if (version <= localVersion) return  // 水位线: 唯一并发法则
    const incoming = Array.isArray(msg.entries) ? msg.entries : []
    // 入场动画新鲜度: 只标 ③ SSE 追加的条目 (② 历史加载不标, 见 consumeFreshEntry).
    for (const e of incoming) { if (e && typeof e === 'object') sseFreshEntries.add(e) }
    if (this.entriesByGroup.has(gid)) {
      // 数据驻留 (无论开合): 追加 (uuid 去重), 写时穿透.
      this.entriesByGroup.set(gid, this.mergeEntries(gid, incoming))
    }
    // 未驻留: 只更新条数, 条目等展开 (自动加载) 或背景预热时 ② 整组取.
    this.groupVersions.set(gid, version)
    meta.version = Math.max(meta.version || 0, version)
    meta.entry_count = Math.max(meta.entry_count || 0, version)
    this.emit()
    this.persistSoon()
  }

  // ── 写时穿透 (合批 1s 落 IndexedDB) ────────────────────────────────────

  persistSoon(): void {
    if (this.writeThroughTimer) return
    this.writeThroughTimer = setTimeout(() => {
      this.writeThroughTimer = null
      this.persistNow()
    }, 1000)
  }

  persistNow(): void {
    const groupsData: CacheRecord['groupsData'] = []
    let bytes = 0
    // 字节预算: 从最旧的组开始丢条目 (元数据永留), 保住最近的展开轮.
    for (let i = this.groups.length - 1; i >= 0; i--) {
      const g = this.groups[i]
      const entries = this.entriesByGroup.get(g.id)
      if (!entries || entries.length === 0) continue
      let groupBytes = 0
      try { groupBytes = JSON.stringify(entries).length } catch { groupBytes = entries.length * 2048 }
      if (bytes + groupBytes > MAX_SESSION_CACHE_BYTES) break
      bytes += groupBytes
      groupsData.unshift({ gid: g.id, version: this.groupVersions.get(g.id) || 0, entries })
    }
    const stickies: Record<string, boolean> = {}
    for (const [gid, rt] of this.groupRuntime) {
      if (rt.sticky) stickies[gid] = true
    }
    void cacheWrite({
      sid: this.sid,
      sessionVersion: this.sessionVersion,
      updatedAt: Date.now(),
      jsonlPath: this.jsonlPath,
      groups: this.groups,
      groupsData,
      stickies,
    })
  }
}

// ── 实例注册表 (内存层 LRU: 切回会话秒开) ────────────────────────────────

const MAX_LIVE_STORES = 8
const storeRegistry = new Map<string, SessionHistoryStore>()

export function getHistoryStore(sid: string): SessionHistoryStore {
  let store = storeRegistry.get(sid)
  if (!store) {
    store = new SessionHistoryStore(sid)
    storeRegistry.set(sid, store)
    while (storeRegistry.size > MAX_LIVE_STORES) {
      const oldest = storeRegistry.keys().next().value
      if (oldest === undefined) break
      const evicted = storeRegistry.get(oldest)
      try { evicted?.persistNow() } catch {}
      storeRegistry.delete(oldest)
    }
  } else {
    // LRU 触碰.
    storeRegistry.delete(sid)
    storeRegistry.set(sid, store)
  }
  return store
}

// ── React 绑定 ───────────────────────────────────────────────────────────

function noopSubscribe() { return () => {} }
function emptySnapshot() { return EMPTY_SNAPSHOT }

/**
 * 持有 store + 生命周期 (缓存水合 → ① 协商), 但不订阅快照 —
 * 调用组件不随每条数据到达而重渲染 (订阅下沉到真正消费数据的子组件).
 */
export function useAgentHistoryStore(sid: string): SessionHistoryStore | null {
  const store = useMemo(() => (sid ? getHistoryStore(sid) : null), [sid])
  useEffect(() => {
    if (!store) return
    let cancelled = false
    // 生命周期: 先水合缓存秒显 → ① 协商 (缓冲的 SSE 事件在协商后对账).
    store.hydrateFromCache().then(() => {
      if (!cancelled) store.negotiate()
    }).catch(() => {})
    return () => { cancelled = true }
  }, [store])
  return store
}

/** 订阅快照 (生命周期由 useAgentHistoryStore 负责; 本钩子纯订阅, 供面板等子组件用). */
export function useHistorySnapshotOf(store: SessionHistoryStore | null): HistorySnapshot {
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : emptySnapshot,
  )
}

/** primitive selector: 已加载条目数 (原样计数, 含被展示层过滤隐藏的). 返回值变化才重渲染. */
export function useLoadedEntryCount(store: SessionHistoryStore | null): number {
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? () => {
      let n = 0
      for (const g of store.groups) n += store.entriesByGroup.get(g.id)?.length || 0
      return n
    } : () => 0,
  )
}

/** primitive selector: 全部条目数 (组元数据 entry_count 之和). */
export function useTotalEntryCount(store: SessionHistoryStore | null): number {
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? () => store.groups.reduce((n, g) => n + (g.entry_count || 0), 0) : () => 0,
  )
}

/** primitive selector: 会话 jsonl 文件绝对路径 (原始 JSONL 弹窗标题展示用). 返回值变化才重渲染. */
export function useSessionJsonlPath(store: SessionHistoryStore | null): string | null {
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? () => store.jsonlPath : () => null,
  )
}

/** 兼容旧名: 订阅 + 生命周期一体 (会让调用组件随每条数据重渲染, 新代码请用上面两个). */
export function useAgentHistory(sid: string): SessionHistoryStore | null {
  const store = useAgentHistoryStore(sid)
  void useHistorySnapshotOf(store)
  return store
}
