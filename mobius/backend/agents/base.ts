/**
 * base.ts — AgentBackend skeleton.
 *
 * Per-session async locking, event subscription, and runtime persistence to
 * data/agents-<name>.json, so mappings survive a backend reload.
 *
 * Subclasses must implement createNewSession, pauseCurrentAndResumeFromSession,
 * noPauseCurrentAndQueueQueryAtSession, terminateSession, isAlive, isWorking and
 * listSessions. Every other method here is an optional hook defaulting to a no-op.
 */
const fs = require('fs')
const path = require('path')
const EventEmitter = require('events')
const { emitAgentRawEntry } = require('./events')

// A session's events plus a read bookmark: `sentinel` is how many bytes of the native jsonl
// have been consumed. total*/truncated are kept for older callers.
interface HistorySnapshot {
  entries: unknown[]
  total?: number
  totalApproximate?: boolean
  truncated?: boolean
  sentinel: number | string | null
}

// Options shared by the read-side queries (getHistory, waterfall, raw stream).
//   tailCount    — read only the last N entries (SSE lazy loading)
//   maxLines     — per-side read cap, so a huge file cannot exhaust memory
//   fromSentinel — resume from this byte offset without re-emitting (history + live stitching)
//   nowMs        — time anchor for waterfall math, injected by tests
// Unrecognized fields pass through to the underlying reader.
interface QueryOpts {
  tailCount?: number
  maxLines?: number
  fromSentinel?: number | string | null
  nowMs?: number
  [key: string]: unknown
}

// The raw ai-title event Claude Code writes, one jsonl line; the field name has varied across
// versions (aiTitle / ai_title). Its sessionId is the agent's own UUID, not a usable guard.
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
  // The path and watcher already scope this event to one Mobius session, so the agent UUID in
  // entry.sessionId is not a usable reject guard.
  return normalizeAgentSessionTitle(obj.aiTitle || obj.ai_title || obj.title)
}

class AgentBackend {
  // Declared up front: TS requires it for properties assigned bare in the constructor (TS2339).
  name: string
  runtimeFile: string
  archiveFile: string | null
  locks: Map<string, Promise<unknown>>
  emitter: InstanceType<typeof EventEmitter>
  persisted: Record<string, any>
  archive: Record<string, any>
  runtime: any // Map<string, entry> per subclass; the entry shape differs per backend

  /**
   * @param {string} opts.name           backend name: 'claude-code' / 'tmux-claude-code' / 'opencode'
   * @param {string} opts.runtimeFile    mapping of live sessions; rows are dropped on terminate
   * @param {string} [opts.archiveFile]  mapping of every session ever started, kept past terminate
   *                                     so getHistory can still resolve a jsonlPath.
   *                                     Omit to disable archiving.
   */
  constructor({ name, runtimeFile, archiveFile }: { name: string; runtimeFile: string; archiveFile?: string | null }) {
    this.name = name
    this.runtimeFile = runtimeFile
    this.archiveFile = archiveFile || null
    this.locks = new Map()    // sessionId → Promise (tail of the op chain)
    this.emitter = new EventEmitter()
    this.emitter.setMaxListeners(0)
    this.persisted = this._loadJson(this.runtimeFile)
    this.archive = this.archiveFile ? this._loadJson(this.archiveFile) : {}
    // One-time catch-up: copy the rows live has but archive lacks, so sessions started before
    // archiving shipped still resolve a jsonlPath once they are terminated.
    if (this.archiveFile) {
      let dirty = false
      for (const [sid, p] of Object.entries(this.persisted) as Array<[string, any]>) {
        if (!this.archive[sid]) { this.archive[sid] = { ...p }; dirty = true }
      }
      if (dirty) this._saveArchive()
    }
  }

  // ── Async lock ──────────────────────────────────────────
  // Chain onto this session's tail promise so ops run one at a time. fn runs on both settle
  // paths, so one rejected op does not poison the chain.
  _withLock(sessionId: string, fn: () => any): Promise<any> {
    const prev = this.locks.get(sessionId) || Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(sessionId, next)
    next.finally(() => {
      if (this.locks.get(sessionId) === next) this.locks.delete(sessionId)
    }).catch(() => {})
    return next
  }

  // ── Event subscription ─────────────────────────────────
  // Each JSON.parsed object from the agent's stdout or jsonl, passed through as-is.
  // opts.fromSentinel marks where to resume without re-emitting.
  getAgentRawThoughtStream(sessionId: string, listener: (raw: unknown) => void, _opts: QueryOpts = {}) {
    const ch = `raw:${sessionId}`
    this.emitter.on(ch, listener)
    return () => this.emitter.off(ch, listener)
  }

  // Fan out to local subscribers and the global raw-entry bus.
  _emitRaw(sessionId: string, raw: unknown) {
    this.emitter.emit(`raw:${sessionId}`, raw)
    emitAgentRawEntry({
      backend: this.name,
      sessionId,
      entry: raw,
    })
  }

  // Every raw event persisted for this session, plus a sentinel to resume from: pair it with
  // getAgentRawThoughtStream(sid, fn, {fromSentinel: sentinel}) to stitch history and live.
  getHistory(_sessionId: string, _opts: QueryOpts = {}): HistorySnapshot {
    return { entries: [], sentinel: null }
  }

  // How long the agent spent per step, derived from the jsonl and cached beside it.
  get_time_consume_waterfall(_sessionId: string, _opts: QueryOpts = {}) {
    return null
  }

  // Drop that cached waterfall, forcing the next read to recompute.
  clear_time_consume_waterfall(_sessionId: string, _opts: QueryOpts = {}) {
    return null
  }

  // Best-effort scan of history for an agent title event; automatic titles use raw_entry instead.
  // Subclasses with a better source override this:
  //   - tmux-codex: the title Codex generated for the thread, from state_5.sqlite → threads.name.
  getSessionTitle(sessionId: string, opts: QueryOpts = {}) {
    const hist = this.getHistory(sessionId, opts) || {}
    const entries = Array.isArray(hist.entries) ? hist.entries : []
    for (let i = entries.length - 1; i >= 0; i--) {
      const title = extractAgentSessionTitleFromEntry(entries[i])
      if (title) return title
    }
    return null
  }

  // ── Persistence ────────────────────────────────────────
  // Two mappings: `persisted` for live sessions (rows dropped on terminate) and `archive` for
  // every session ever started (never dropped, so a closed window still resolves a jsonlPath).
  // Archive is never pruned — a row costs a few hundred bytes and the recycle bin is retired,
  // so there is no other "truly forget" path and no _purgeArchive.
  _loadJson(file: string): Record<string, any> {
    try {
      if (!fs.existsSync(file)) return {}
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      console.warn(`[agents/${this.name}] load ${path.basename(file)} failed: ${e.message}`)
      return {}
    }
  }

  // Best-effort write; failures are logged, never thrown.
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

  // Re-read both mappings from disk, picking up writes from other processes.
  _reloadPersisted() {
    this.persisted = this._loadJson(this.runtimeFile)
    if (this.archiveFile) this.archive = this._loadJson(this.archiveFile)
  }

  // Reload from disk on a miss, so a row written elsewhere still resolves.
  _lookupPersistedEntry(sessionId: string): any {
    if (!this.persisted?.[sessionId]) this._reloadPersisted()
    return this.persisted?.[sessionId] || null
  }

  _lookupPersistedJsonlPath(sessionId: string): string | null {
    return this._lookupPersistedEntry(sessionId)?.jsonlPath || null
  }

  // Merge fields into the live row and, when archiving, its archive copy.
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
    // Archive keeps its row — that is what historical jsonlPath lookups rely on.
  }

  // Last resort for a session whose window has closed: runtime and persisted are both empty.
  _lookupArchivedEntry(sessionId: string): any {
    if (!this.archive?.[sessionId] && this.archiveFile) this.archive = this._loadJson(this.archiveFile)
    return this.archive?.[sessionId] || null
  }

  // The archived row's jsonl path alone, for callers that only need to read history.
  _lookupArchivedJsonlPath(sessionId: string): string | null {
    return this._lookupArchivedEntry(sessionId)?.jsonlPath || null
  }

  // Whether this session routes through a proxy; null when never recorded.
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

  // ── Defaults ───────────────────────────────────────────
  // Whether the agent is actively working; the base has no runtime to ask, so false.
  isWorking(_sessionId: string): boolean { return false }

  // The session's running flag is present until the agent removes it on completion. Without a
  // cwd the base cannot check, so it must not assume done. tmux-claude-code overrides.
  isJobGoalAccomplished(_sessionId: string): boolean { return false }

  // A stuck agent deletes running.flag and drops a failed.flag (see the forgotten-flag-scanner
  // copy). Without a cwd the base returns false. tmux-claude-code overrides.
  isFailed(_sessionId: string): boolean { return false }

  // The latest agent error from the TUI screen or jsonl: null, or { message, rawLine, capturedAt }.
  //   - tmux-claude-code: no error channel in the Claude TUI, stays null.
  //   - tmux-codex: scans the Codex ErrorEvent ■ (U+25A0) prefix plus a red ANSI \x1b[31m check.
  getRecentError(_sessionId: string): any { return null }

  // The agent's status line off its TUI, e.g. "✻ Propagating… (7m 44s · ↓ 24.1k tokens)", shown
  // as a nice-to-have hint on the session page's LIVE card. "" when nothing is recognizable.
  //
  // Hot path (/status polls every 2s), so subclasses must cache with a TTL (5s), return ""
  // straight away when not alive or not working, and cache the empty result too.
  realTimeInfo(_sessionId: string): string { return '' }

  // User requests enqueued but not yet consumed, oldest first, as { content, enqueuedAt }.
  //   - tmux-claude-code: scans queue-operation/enqueue and subtracts the consumed ones.
  //   - tmux-codex: the rollout JSONL carries no queue events, so it stays empty.
  getPendingRequests(_sessionId: string): any[] { return [] }

  // Whether a jsonl entry marks a dequeue — the moment the agent picks up human input. A
  // submission only parks its opener in pending_round_openers; scanPrimary opens them as one
  // group on the first true.
  //
  //   entry         the raw jsonl entry, judged by each subclass's own protocol
  //   pendingInputs texts enqueued but not yet consumed, as getPendingRequests returns. Lets a
  //                 subclass be permissive: Claude Code writes no origin when a "/path"-style
  //                 slash command fails to parse, so any pending input makes the next valid
  //                 entry a dequeue. routes/sessions.ts fills this in when omitted.
  //
  // The base ignores both and returns true, the deepseek harness having no dequeue signal.
  //   - tmux-claude-code: operation=='dequeue', origin.kind=='human', compact receipt, or a
  //                       pending slash input.
  //   - tmux-codex: response_item.message.role=='user' or event_msg.task_started.
  containDequeueEvent(_entry: unknown, _pendingInputs: string[] = []): boolean { return true }

  // Interrupt the turn so the agent picks up the next queued instruction, appending no prompt.
  // A no-op here; the deepseek harness has no dequeue semantics.
  //   - tmux-claude-code: press C-c once, as in the expedited pauseCurrentAndResumeFromSession path.
  //   - tmux-codex: press Esc once — Esc interrupts codex, not C-c.
  pauseCurrentToDequeueQuery(_sessionId: string): Promise<void> { return Promise.resolve() }
}

module.exports = { AgentBackend }

export { AgentBackend }
export type { HistorySnapshot, QueryOpts }
