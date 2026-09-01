/**
 * base.js — AgentBackend 基类骨架.
 *
 * 提供:
 *   - per-session 异步锁 (写操作的并发保护)
 *   - 事件订阅 (EventEmitter, 一个 sessionId 多个 listener) + sentinel 支持
 *   - runtime 持久化到 data/agents-<name>.json (后端 reload 不丢映射)
 *
 * 子类必须实现:
 *   createNewSession(opts) → Promise<SessionHandle>
 *   pauseCurrentAndResumeFromSession(opts) → Promise<void>
 *   noPauseCurrentAndQueueQueryAtSession(opts) → Promise<void>
 *   terminateSession(sessionId) → Promise<void>
 *   isAlive(sessionId) → boolean
 *   isWorking(sessionId) → boolean
 *   listSessions() → Array<{sessionId, agentSessionId, pid|null}>
 *
 * 可选 (默认空实现, 子类按需 override):
 *   getHistory(sessionId) → { entries, sentinel }
 *   get_time_consume_waterfall(sessionId, opts) → any
 *   clear_time_consume_waterfall(sessionId, opts) → any
 *   getSessionTitle(sessionId, opts) → string|null
 *   getAgentRawThoughtStream(sessionId, listener, opts) → Unsubscribe
 *   isJobGoalAccomplished(sessionId) → boolean
 *   isFailed(sessionId) → boolean
 *   getRecentError(sessionId) → false | { message, rawLine, capturedAt }
 *   getPendingRequests(sessionId) → Array<{ content, enqueuedAt }>
 */
const fs = require('fs')
const path = require('path')
const EventEmitter = require('events')
const { emitAgentRawEntry } = require('./events')

// 历史快照: entries = 落盘原始事件 (协议透传, 后端各异), sentinel = 续接 live 流的字节
// offset; total*/truncated 为大文件截断统计 (见 services/mobius-jsonl readMergedJsonlHistory).
interface HistorySnapshot {
  entries: unknown[]
  total?: number
  totalApproximate?: boolean
  truncated?: boolean
  sentinel: number | string | null
}

// 后端读类查询 (getHistory / waterfall / raw 流订阅) 的统一选项:
//   tailCount     — 只读尾部 N 条 (SSE 历史懒加载)
//   maxLines      — 单侧文件读取上限 (防大文件打爆内存)
//   fromSentinel  — 从该字节 offset 续接, 不重复发 (history + live 拼接)
//   nowMs         — waterfall 计算的时间锚点 (测试注入)
// 其余字段透传给底层 reader/watcher.
interface QueryOpts {
  tailCount?: number
  maxLines?: number
  fromSentinel?: number | string | null
  nowMs?: number
  [key: string]: unknown
}

// Claude Code 落盘的 ai-title 原始事件 (jsonl 一行). 字段名跨版本有过 aiTitle/ai_title,
// 均为可选; sessionId 是 agent 自身 UUID, 与 Mobius session_id 无关 (不做 reject guard).
interface AgentTitleEntry {
  type?: unknown
  aiTitle?: unknown
  ai_title?: unknown
  title?: unknown
}

function normalizeAgentSessionTitle(value: unknown): string | null {
  if (value == null) return null
  const title = String(value).replace(/\0/g, '').replace(/\s+/g, ' ').trim()
  return title || null
}

function extractAgentSessionTitleFromEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null
  const obj = entry as AgentTitleEntry
  if (obj.type !== 'ai-title') return null
  // Claude Code writes its own agent UUID in entry.sessionId, not Mobius'
  // short sessions_v2.session_id. The JSONL path / watcher already scopes the
  // event to one Mobius session, so this field must not be used as a reject guard.
  return normalizeAgentSessionTitle(obj.aiTitle || obj.ai_title || obj.title)
}

class AgentBackend {
  // 类字段声明: constructor 裸赋值的属性在 TS 里必须先声明 (TS2339).
  name: string
  runtimeFile: string
  archiveFile: string | null
  locks: Map<string, Promise<unknown>>
  emitter: InstanceType<typeof EventEmitter>
  persisted: Record<string, any>
  archive: Record<string, any>
  runtime: any // 子类各自 Map<string, entry>; entry 结构后端各异, 保持动态

  /**
   * @param {object} opts
   * @param {string} opts.name              backend 名 'claude-code' / 'tmux-claude-code' / 'opencode'
   * @param {string} opts.runtimeFile       live 映射文件路径: 仅当前活的 session, terminate 时删
   * @param {string} [opts.archiveFile]     all-time 映射文件路径: 任何启动过的 session 都留一条
   *                                        (主要给 getHistory 在 terminate 后兜底查 jsonlPath 用).
   *                                        缺省 = 不启用 archive.
   */
  constructor({ name, runtimeFile, archiveFile }: { name: string; runtimeFile: string; archiveFile?: string | null }) {
    this.name = name
    this.runtimeFile = runtimeFile
    this.archiveFile = archiveFile || null
    this.locks = new Map()    // sessionId → Promise (操作链尾部)
    this.emitter = new EventEmitter()
    this.emitter.setMaxListeners(0)
    this.persisted = this._loadJson(this.runtimeFile)
    this.archive = this.archiveFile ? this._loadJson(this.archiveFile) : {}
    // 启动一次性 catch-up: 把 live 里有、archive 没有的条目复制过去. 这样部署 archive
    // 机制之前已经在跑的 session, 被 terminate 后 archive 里仍有 jsonlPath 可查.
    if (this.archiveFile) {
      let dirty = false
      for (const [sid, p] of Object.entries(this.persisted) as Array<[string, any]>) {
        if (!this.archive[sid]) { this.archive[sid] = { ...p }; dirty = true }
      }
      if (dirty) this._saveArchive()
    }
  }

  // ── 异步锁 ──────────────────────────────────────────────
  _withLock(sessionId: string, fn: () => any): Promise<any> {
    const prev = this.locks.get(sessionId) || Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(sessionId, next)
    next.finally(() => {
      if (this.locks.get(sessionId) === next) this.locks.delete(sessionId)
    }).catch(() => {})
    return next
  }

  // ── 事件订阅 ───────────────────────────────────────────
  // Agent 子进程 stdout / 落盘 jsonl 的每条 JSON.parse 后对象, 协议透传不归一.
  // opts.fromSentinel — 子类可用作"从这个点开始 tail, 不重复发"的标记 (tmux: 字节
  // offset; stream-json: stream-json 也写 jsonl, 同样字节 offset). 不传 = 从此刻起.
  getAgentRawThoughtStream(sessionId: string, listener: (raw: unknown) => void, _opts: QueryOpts = {}) {
    const ch = `raw:${sessionId}`
    this.emitter.on(ch, listener)
    return () => this.emitter.off(ch, listener)
  }

  _emitRaw(sessionId: string, raw: unknown) {
    this.emitter.emit(`raw:${sessionId}`, raw)
    emitAgentRawEntry({
      backend: this.name,
      sessionId,
      entry: raw,
    })
  }

  /**
   * 历史快照: 返回该 session 已落盘的所有原始事件, 配套 sentinel.
   * 上层用法: 先 getHistory() 拿 entries + sentinel, 再
   * getAgentRawThoughtStream(sid, listener, {fromSentinel: sentinel}) 续接.
   * 这样 history + live 无缝拼接, 不重复不漏行.
   *
   * 默认: 空快照. 子类按需 override (基于自家 jsonl / log 文件).
   */
  getHistory(_sessionId: string, _opts: QueryOpts = {}): HistorySnapshot {
    return { entries: [], sentinel: null }
  }

  get_time_consume_waterfall(_sessionId: string, _opts: QueryOpts = {}) {
    return null
  }

  clear_time_consume_waterfall(_sessionId: string, _opts: QueryOpts = {}) {
    return null
  }

  // Best-effort utility: scan known history entries for an explicit agent title event.
  // Automatic Mobius title updates do not call this on hot paths; they subscribe to
  // raw_entry events from the shared watcher instead.
  getSessionTitle(sessionId: string, opts: QueryOpts = {}) {
    const hist = this.getHistory(sessionId, opts) || {}
    const entries = Array.isArray(hist.entries) ? hist.entries : []
    for (let i = entries.length - 1; i >= 0; i--) {
      const title = extractAgentSessionTitleFromEntry(entries[i])
      if (title) return title
    }
    return null
  }

  // ── 持久化 ─────────────────────────────────────────────
  // 两份映射:
  //   persisted (runtimeFile) — live, terminate 时 _forgetPersisted 会删
  //   archive   (archiveFile) — all-time, terminate 不删, 仅用于 getHistory 等
  //                              历史查询场景兜底 (admin 关 window 后仍能找到 jsonlPath).
  //   完全不做 archive 清理: 一条 entry 几百字节, 量级可控. 回收站机制已下线,
  //   也没有别的"真正遗忘"入口, 故没有 _purgeArchive.
  _loadJson(file: string): Record<string, any> {
    try {
      if (!fs.existsSync(file)) return {}
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      console.warn(`[agents/${this.name}] load ${path.basename(file)} failed: ${e.message}`)
      return {}
    }
  }

  _saveJson(file: string, obj: unknown) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(obj, null, 2))
    } catch (e) {
      console.warn(`[agents/${this.name}] save ${path.basename(file)} failed: ${e.message}`)
    }
  }

  _savePersisted() { this._saveJson(this.runtimeFile, this.persisted) }
  _saveArchive()  { if (this.archiveFile) this._saveJson(this.archiveFile, this.archive) }

  _reloadPersisted() {
    this.persisted = this._loadJson(this.runtimeFile)
    if (this.archiveFile) this.archive = this._loadJson(this.archiveFile)
  }

  _lookupPersistedEntry(sessionId: string): any {
    if (!this.persisted?.[sessionId]) this._reloadPersisted()
    return this.persisted?.[sessionId] || null
  }

  _lookupPersistedJsonlPath(sessionId: string): string | null {
    return this._lookupPersistedEntry(sessionId)?.jsonlPath || null
  }

  _persistEntry(sessionId: string, partial: Record<string, any>) {
    this.persisted[sessionId] = { ...(this.persisted[sessionId] || {}), ...partial }
    this._savePersisted()
    if (this.archiveFile) {
      this.archive[sessionId] = { ...(this.archive[sessionId] || {}), ...partial }
      this._saveArchive()
    }
  }

  _forgetPersisted(sessionId: string) {
    delete this.persisted[sessionId]
    this._savePersisted()
    // archive 不动: 留作历史 jsonl 映射查询用.
  }

  // archive 里 sessionId → jsonlPath 的兜底查询. 子类 getHistory 在 runtime / persisted
  // 都没条目时调它 (典型: admin 关了 window, _forgetPersisted 清掉了 live, 但 jsonl 文件还在).
  _lookupArchivedJsonlPath(sessionId: string): string | null {
    if (!this.archive?.[sessionId] && this.archiveFile) this.archive = this._loadJson(this.archiveFile)
    return this.archive?.[sessionId]?.jsonlPath || null
  }

  getSessionUseProxy(sessionId: string): boolean | null {
    const runtimeEntry = this.runtime && typeof this.runtime.get === 'function'
      ? this.runtime.get(sessionId)
      : null
    const entry = runtimeEntry || this._lookupPersistedEntry(sessionId)
    const value = entry?.useProxy
    if (value === true || value === 1 || value === '1' || value === 'true') return true
    if (value === false || value === 0 || value === '0' || value === 'false') return false
    return null
  }

  // ── 默认/兜底 ─────────────────────────────────────────
  isWorking(_sessionId: string): boolean { return false }

  // 任务是否结束: 约定 session 启动时落 running flag, agent 收工 (成功/失败) 自删,
  // 据"flag 是否还在"判断. 基类无 cwd 上下文, 默认未知 → false (不假设已完成).
  // 子类 (如 tmux-claude-code) 按需 override 成基于 flag 文件的真实判断.
  isJobGoalAccomplished(_sessionId: string): boolean { return false }

  // 任务是否失败: 约定 agent 无法完成时删 running.flag 并落 failed.flag (见
  // forgotten-flag-scanner 自动提醒文案的第 (1) 条). 据"failed.flag 是否存在"
  // 判断. 基类无 cwd 上下文, 默认 false. tmux-claude-code 按 flag 文件 override.
  isFailed(_sessionId: string): boolean { return false }

  // 近期错误: 扫 TUI 屏幕 / jsonl 找最近一条 agent 报错.
  // 返回 null = 无错误; 返回 { message, rawLine, capturedAt } = 命中错误.
  // 基类无 UI / jsonl 上下文, 默认 null.
  // 子类按需 override:
  //   - tmux-claude-code: Claude TUI 不暴露错误通道, 沿用 null.
  //   - tmux-codex: tmux capture-pane 扫 Codex ErrorEvent 的 ■ (U+25A0) 前缀,
  //                 辅以 ANSI \x1b[31m 红色判定 (见 tmux-codex.js).
  getRecentError(_sessionId: string): any { return null }

  // 实时状态行: 解析 agent TUI 屏幕里当前的状态行, 如 claude code 的
  // "✻ Propagating… (7m 44s · ↓ 24.1k tokens · still thinking)". 给 session 页 LIVE 卡片
  // 当作 "agent 正在干嘛" 的实时提示 (锦上添花). 返回字符串, 无状态行可识别 → "".
  //
  // 效率红线 (这是高频调用路径, /status 每 2s 轮询):
  //   - 子类实现必须加 TTL 缓存 (建议 5s), 防止每次调用都 spawn tmux / 读屏幕.
  //   - 非 alive 或非 working 时必须返回 "" (用户没在跑 → 没必要 capture).
  //   - 空 "" 同样要进缓存 (空结果 5s 内也复用, 不重复 capture).
  // 基类默认 "" (codex 等暂不实现的 backend 直接继承空实现).
  realTimeInfo(_sessionId: string): string { return '' }

  // 待处理(已入队、尚未被消费)的用户请求.
  // 返回数组, 每项 { content, enqueuedAt }, 顺序 = 入队先后; 空数组 = 无排队中的请求.
  // 状态查询 (同 isWorking/isAlive, 不上锁).
  //   - tmux-claude-code: 扫 session JSONL 的 queue-operation/enqueue, 减去已被消费
  //     (后续出现 type:user 或 attachment.type:queued_command 携带同内容) 的 (见其实现).
  //   - tmux-codex: codex 不在 rollout JSONL 暴露排队事件 → 恒空 (显式 override).
  getPendingRequests(_sessionId: string): any[] { return [] }
}

module.exports = { AgentBackend }

export { AgentBackend }
export type { HistorySnapshot, QueryOpts }
