/**
 * tmux-claude-code.ts — TmuxClaudeCodeBackend.
 *
 * One tmux window per MOBIUS session_id in the fixed `imac_claude_code_agent_hub` session of a
 * dedicated tmux server, window name = session_id. Each window runs `proxychains -q -f
 * ~/proxychains_config_for_llm_models.conf claude --dangerously-skip-permissions ...` (interactive TUI).
 *
 * Write:     tmux load-buffer + paste-buffer -p (bracketed) + send-keys Enter×3
 * Read:      tail of ~/.claude/projects/<cwd-enc>/<uuid>.jsonl
 * Interrupt: tmux send-keys C-c × 3 (the TUI swallows the 1st; 3 measured reliable)
 * Terminate: tmux kill-window
 *
 * Cross-process restart: runtime persists to MOBIUS_DATA_PATH/hub-runtime.json. On backend reload the
 * tmux windows are still alive, so we just reload the (sessionId → agentSessionId, jsonlPath) map and
 * never kill a running claude.
 *
 * Implements the 5 AgentBackend methods plus isAlive / isWorking / listSessions / getHistory /
 * isJobGoalAccomplished.
 *
 * Task running flag: every prompt submission drops <cwd>/.imac/flags/<sessionId>/running.flag, which
 * the agent removes on completion (success or failure — see the context injected by session-context.js).
 * isJobGoalAccomplished reads that file's presence.
 *
 * Layout: this file owns the backend surface and the session lifecycle (create / queue / pause /
 * terminate). Everything reusable lives under ./claude-code-utils:
 *   constants.ts        fixed names, paths, sentinels and timing knobs
 *   types.ts            runtime entry + dispatch contract
 *   proxy.ts            proxy tier normalization and prerequisite checks
 *   session-paths.ts    transcript path, shell quoting, project trust, aimux binary
 *   jsonl-tail.ts       transcript tail reads, turn state, pending queue requests
 *   pane-status.ts      pure pane/transcript parsers (status line, danger box, compact receipt)
 *   tmux-window.ts      hub, windows and the polling caches over them
 *   prompt.ts           paste + Enter delivery, initial-context warm-up
 *   tui-ready.ts        readiness poll that auto-confirms startup dialogs
 *   launch-command.ts   settings / MCP / proxy / env assembly into the bash -lc chain
 */
const { spawnSync } = require('child_process')
const fs = require('fs')

import { AgentBackend } from './base'
import type { HistorySnapshot, QueryOpts } from './base'
import type { ClaudeDispatchOpts, ClaudeRuntimeEntry } from './claude-code-utils/types'
import type { MobiusPromptRecord } from '../services/mobius-agent-history'

import {
  ARCHIVE_FILE,
  CLAUDE_BG_AGENTS_WAITING_RE,
  DANGER_HEAL_COOLDOWN_MS,
  HUB,
  RUNTIME_FILE,
} from './claude-code-utils/constants'
import { ensureHub, capturePaneTail, invalidatePaneTail, windowExists, listWindowsRowsCached, claudePaneStillBusy } from './claude-code-utils/tmux-window'
import { detectDangerPermission, findClaudeRealTimeInfo, isCompactCompletionUserEvent } from './claude-code-utils/pane-status'
import { readJsonlTail, parsePendingRequests, turnRunningFromTail } from './claude-code-utils/jsonl-tail'
import { encodeCwd, ensureProjectTrusted, jsonlPathOf } from './claude-code-utils/session-paths'
import { resolveClaudeProxyMode, normalizeUseProxy, proxyPrereqMissing, unpackLaunch } from './claude-code-utils/proxy'
import { sendMaybeInitialContextPrompt, sleep } from './claude-code-utils/prompt'
import { waitForTuiReady } from './claude-code-utils/tui-ready'
import { buildClaudeLaunch } from './claude-code-utils/launch-command'

const {
  getHistorySnapshot,
  writeMobiusCoreEntry,
  flushPendingOpeners,
} = require('../services/mobius-agent-history')
const { watch: watchJsonlFile } = require('../services/jsonl-watcher')
const {
  timeConsumeWaterfallFromBackend,
  clearTimeConsumeWaterfallForBackend,
} = require('../services/time-consume-waterfall')
const {
  runningFlagPathOf,
  failedFlagPathOf,
  safeWriteRunningFlag,
  safeRemoveRunningFlag,
  safeRemoveFlagDir,
} = require('../utils/session-flags')
const { AGENT_TMUX_SOCKET, log, tmux } = require('./tmux-operation-log')
import { sandboxCommand } from '../services/agent-sandbox'
// 用户隔离 (docker 模式): spawn 前确保沙箱容器 + tmux server, HOME/路径按用户重定向
const {
  prepareSpawn,
  clearWindowOwner,
  sandboxPolicyFor,
} = require('../services/user-isolation')
const { resolveDispatchIdentity } = require('../services/session-dispatch-identity')

// 危险确认框自愈的限流状态 (每个会话一条)
// Throttle state for the danger-box self-heal, one record per session
const dangerHealState = new Map<string, { healing: boolean; lastWarning: string; lastTs: number }>()

/*
 * Drop (and refresh) the session's running flag,
 * <root>/.imac/flags/<sessionId>/running.flag: the out-of-process signal
 * that a task is in flight. The agent removes it when the task ends,
 * success or failure, per the session-context hint, and
 * isJobGoalAccomplished reads its presence.
 *
 * root is flagRoot, the project repo root (bind_path): the same as cwd
 * outside a worktree, but the repo root rather than cwd inside one, so the
 * agent's first step of cleaning / rebuilding the worktree cannot delete
 * the flag by mistake.
 *
 * safeWriteRunningFlag swallows fs errors: a flag that cannot be written
 * must not fail the prompt dispatch.
 */
function markRunning(root: string | null | undefined, sessionId: string) {
  return safeWriteRunningFlag(root, sessionId, {}, 'tmux-claude-code')
}

/*
 * Remove running.flag, i.e. declare the task finished from our side. Only
 * the interrupt-only /stop path calls it (empty prompt: nothing new is
 * queued, so nothing may stay marked as running); on a normal completion
 * the agent removes the flag itself.
 */
function clearRunning(root: string | null | undefined, sessionId: string) {
  return safeRemoveRunningFlag(root, sessionId, 'tmux-claude-code')
}

// ── Startup preflight (once at module load; a missing dep is a hard failure) ──
;(function preflight() {
  const missing: string[] = []
  for (const bin of ['tmux', 'claude']) {
    if (spawnSync('which', [bin]).status !== 0) missing.push(`bin (PATH): ${bin}`)
  }
  if (missing.length) {
    console.error('[tmux-claude-code] ❌ preflight 失败, 拒绝启动:')
    for (const m of missing) console.error('   - ' + m)
    process.exit(1)
  }
  const proxyMissing = proxyPrereqMissing('env_proxychains')
  if (proxyMissing.length) {
    console.warn(`[tmux-claude-code] ⚠️  代理依赖不完整; 直连/纯 env 挡的会话仍可启动: ${proxyMissing.join(', ')}`)
  }
  log(`[tmux-claude-code] ✅ preflight pass (SOCKET=${AGENT_TMUX_SOCKET}, HUB=${HUB})`)
})()

// ── Backend ────────────────────────────────────────────
class TmuxClaudeCodeBackend extends AgentBackend {
  declare runtime: Map<string, ClaudeRuntimeEntry>
  /*
   * Build the backend and adopt whatever the previous process left behind. The runtime map is
   * declared here rather than in the base class because only this backend knows the entry shape, and
   * the restore has to run before anything can ask about a session.
   */
  constructor() {
    super({ name: 'tmux-claude-code', runtimeFile: RUNTIME_FILE, archiveFile: ARCHIVE_FILE })
    // sessionId → 窗口与jsonl状态
    // runtime: sessionId → that session's window and jsonl state
    this.runtime = new Map()
    this._restoreFromPersisted()
  }

  /*
   * Reload the sessionId → agentSessionId / jsonlPath map saved by the previous process. The tmux
   * windows outlive a backend restart, so a reload adopts them instead of spawning duplicates, and
   * only a jsonl watcher is (re)started to tail them.
   *
   * A row whose jsonl is already gone is dropped rather than resurrected: without the transcript the
   * session could never produce history, so it has to look brand new.
   */
  _restoreFromPersisted() {
    let total = 0
    for (const [sid, p] of Object.entries(this.persisted) as Array<[string, any]>) {
      total++
      if (!p?.jsonlPath || !fs.existsSync(p.jsonlPath)) {
        log(`[tmux-claude-code] runtime 条目 ${sid} 被丢弃 (jsonl 缺失: ${p?.jsonlPath})`)
        continue
      }
      this.runtime.set(sid, {
        agentSessionId: p.agentSessionId || null,
        cwd: p.cwd,
        flagRoot: p.flagRoot || p.cwd,
        model: p.model || null,
        useProxy: normalizeUseProxy(p.useProxy, true),
        settingsPath: p.settingsPath || null,
        forceNoProxy: !!p.forceNoProxy,
        displayName: p.displayName || null,
        jsonlPath: p.jsonlPath,
        startedAt: p.startedAt || 0,
        watch: null,
      })
      this._ensureWatcher(sid)
    }
    log(`[tmux-claude-code] runtime 加载 ${this.runtime.size}/${total} 条`)
  }

  /*
   * Attach the jsonl watcher that feeds this session's live output; new lines go to _emitRaw for all
   * subscribers. One watcher per session and never restarted while one is live.
   *
   * It starts at the current end of file on purpose: only the delta is pushed, because the history
   * store already holds the initial content and replaying the whole transcript would duplicate it.
   */
  _ensureWatcher(sessionId: string) {
    const entry = this.runtime.get(sessionId)
    if (!entry?.jsonlPath || entry.watch) return
    // 取不到文件大小时从0开始，宁可重放也不要漏行
    // If the size cannot be read, start at 0 and replay rather than miss lines
    let startOffset = 0
    try { startOffset = fs.existsSync(entry.jsonlPath) ? fs.statSync(entry.jsonlPath).size : 0 } catch {}
    entry.watch = watchJsonlFile({
      path: entry.jsonlPath,
      startOffset,
      onEntry: (raw: any) => this._emitRaw(sessionId, raw),
      onError: (e: unknown) => console.warn(`[tmux-claude-code/watch ${sessionId}] ${(e as Error)?.message || e}`),
    })
  }

  // ── Public methods (wrapped by the base-class lock) ─────
  /*
   * Create path. The user card is written first, outside the lock, so it exists the moment dispatch
   * arrives; the real work then serialises behind the per-session lock, which is what stops two
   * dispatches for one session from spawning two windows.
   */
  createNewSession(opts: ClaudeDispatchOpts) {
    this._writeMobiusPromptEarly(opts)
    return this._withLock(opts?.sessionId, () => this._createImpl(opts))
  }
  /*
   * Pause-and-resume: interrupt the running turn, then hand the new prompt to the queue path. The
   * expedited sibling of noPauseCurrentAndQueueQueryAtSession, which queues without interrupting.
   */
  pauseCurrentAndResumeFromSession(opts: ClaudeDispatchOpts) {
    this._writeMobiusPromptEarly(opts)
    return this._withLock(opts?.sessionId, () => this._pauseImpl(opts))
  }
  /*
   * Queue path: append a prompt to a running session without interrupting it, so the agent picks it
   * up when the current turn ends. Spawns the window when none is alive, which is why chat can send
   * both the first and every follow-up message through here.
   */
  noPauseCurrentAndQueueQueryAtSession(opts: ClaudeDispatchOpts) {
    this._writeMobiusPromptEarly(opts)
    return this._withLock(opts?.sessionId, () => this._queueImpl(opts))
  }
  /*
   * Interrupt the running turn so the agent stops and consumes the next queued instruction. A missing
   * window is a no-op rather than an error: the caller is asking to stop something, and nothing
   * running already satisfies that.
   */
  pauseCurrentToDequeueQuery(sessionId: string) {
    return this._withLock(sessionId, async () => {
      if (!sessionId) throw new Error('需要 sessionId')
      if (!windowExists(sessionId)) return
      // 单次C-c即可打断当前回合，这里只打断不追加提示词
      // One C-c breaks the turn; this only interrupts, appending nothing
      tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'C-c'])
      await sleep(250)
    })
  }

  /*
   * Open the round as early as possible: the user card is written the moment dispatch is entered, not
   * after the spawn. Waiting would let the first sync beat us and file the startup preamble into
   * "round 0" instead of the round this prompt actually belongs to.
   */
  _writeMobiusPromptEarly(opts: ClaudeDispatchOpts) {
    if (!opts?.sessionId || !opts?.mobiusPromptRecord) return
    // 写卡片失败只吞掉，不能因此拖垮这次派发
    // A failed card write is swallowed; it must not break the dispatch
    try { this.harnessWriteMobiusCoreEntry(opts.sessionId, opts.mobiusPromptRecord, opts.cwd) } catch {}
  }
  /*
   * Tear the session down: kill the window, stop the watcher, drop the runtime and persisted rows and
   * clear the flag dir. The archive row deliberately survives, so history still resolves afterwards.
   */
  terminateSession(sessionId: string) {
    return this._withLock(sessionId, async () => {
      const r = await this._terminateImpl(sessionId)
      // 终止兜底：agent崩溃时可能永远不dequeue
      // Termination fallback: a crashed agent may never dequeue
      try { flushPendingOpeners(sessionId) } catch {}
      return r
    })
  }

  // ── Status queries (no lock; safe to run concurrently with writes) ──
  /*
   * Whether the window is still listed in the hub. This is the status path, so it reads the 3s cache;
   * control flow (create / terminate / pause) must call windowExists for a live answer instead, since
   * acting on a stale "exists" could kill a window that was just created.
   */
  isAlive(sessionId: string) {
    // 状态查询走3s缓存，控制流必须实时查
    // Status queries read the 3s cache; control flow must query live
    return listWindowsRowsCached().some((cols: string[]) => cols[0] === sessionId)
  }

  /*
   * Whether the session is mid-turn. The transcript is the arbiter, not the pane: the tail of the
   * jsonl is read backwards for the nearest record that says anything about the turn (see
   * turnRunningFromTail for the whitelist and the /compact trap).
   *
   * A tail with no decisive record means the jsonl looks finished — but the TUI may still be waiting
   * for background agents, a state the jsonl cannot express (a Task is fire-and-forget, so its round
   * ends on end_turn). That is why the pane is consulted as a last resort; without it such a session
   * reads idle and can be reaped by the idle cleaner while it is still running.
   */
  isWorking(sessionId: string) {
    if (!this.isAlive(sessionId)) return false
    const entry = this.runtime.get(sessionId)
    if (!entry?.jsonlPath) return false
    const lines = readJsonlTail(entry.jsonlPath)
    if (!lines) return false
    const running = turnRunningFromTail(lines)
    // jsonl看似结束，但可能仍在等后台子agent
    // The jsonl looks finished, but background agents may still run
    // 故回退看面板的等待提示，命中仍算工作中
    // So fall back to the pane's waiting line, a hit still counts
    if (running !== null) return running
    return CLAUDE_BG_AGENTS_WAITING_RE.test(capturePaneTail(sessionId))
  }

  /*
   * Whether an entry proves the human input actually reached the agent, i.e. the pending round can be
   * opened. The test is a whitelist of dequeue signals; anything else (assistant output, tool
   * activity, ordinary metadata) is not one.
   *
   * In Claude Code the marker is origin.kind=='human', in either on-disk shape: a top-level origin (a
   * hand-typed type:user) or an origin inside attachment (the queued_command injected mid-turn while
   * the agent was busy). A /compact receipt counts too — its opener is kind=compact, so the round
   * opens only once that receipt is written.
   *
   * Last resort: claude sometimes drops origin for a slash-prefixed input that fell through slash
   * command parsing, so while such an input is pending the next valid entry is accepted. That is
   * meant to be permissive: a missed dequeue would leave a round open forever.
   */
  containDequeueEvent(entry: any, pendingInputs: string[] = []): boolean {
    if (!entry || typeof entry !== 'object') return false
    // 显式 dequeue 条目本身就是消费信号
    // An explicit dequeue entry is itself a consumption signal
    if (entry.operation === 'dequeue') return true
    if (entry.origin?.kind === 'human') return true
    if (entry.attachment?.origin?.kind === 'human') return true
    if (entry.message?.content === '<command-name>/compact</command-name>') return true
    if (isCompactCompletionUserEvent(entry)) return true
    // 斜杠输入可能丢掉origin，此时放宽认定
    // A slash input may lose its origin, so stay permissive
    if (pendingInputs.some((input) => typeof input === 'string' && input.trimStart().startsWith('/'))) return true
    return false
  }

  /*
   * Prompts enqueued in Claude Code's in-memory queue that have not been consumed yet, as
   * [{ content, enqueuedAt }] in enqueue order; [] means nothing is queued.
   *
   * The pairing rules and the reverse scan are in parsePendingRequests; this method only resolves
   * which transcript to read. The scan runs on the bounded tail, so a 100MB jsonl costs the same as
   * a small one, and matching is safe from send-mirror pollution because the mobius decoration
   * entries live in .mobius.jsonl, not in this native transcript.
   */
  getPendingRequests(sessionId: string) {
    const jsonlPath = this._resolveJsonlPath(sessionId)
    if (!jsonlPath) return []
    const tail = readJsonlTail(jsonlPath)
    return tail ? parsePendingRequests(tail) : []
  }

  /*
   * The text of every still-queued request, in enqueue order. Shared by getHistory and the round
   * writer so both see the same "open round" evidence.
   */
  _pendingInputTexts(sessionId: string): string[] {
    return this.getPendingRequests(sessionId)
      .map((item: any) => typeof item === 'string' ? item : item?.content)
      .filter((item): item is string => typeof item === 'string')
  }

  /*
   * Whether the task is done, read off the running flag: dispatch drops it and the agent removes it
   * on completion, success or failure, so "no flag" means accomplished. An unknown session returns
   * false because there is no root to look under.
   *
   * The lookup is anchored on flagRoot (the repo root), falling back to cwd for old entries — the
   * repo root rather than cwd is what keeps the flag alive when the agent rebuilds its worktree.
   */
  isJobGoalAccomplished(sessionId: string) {
    const entry = this.runtime.get(sessionId)
    const root = entry?.flagRoot || entry?.cwd
    // 根目录未知就无从判断，按未完成回报更保守
    // With no root there is nothing to check, so report "not accomplished"
    if (!root) return false
    return !fs.existsSync(runningFlagPathOf(root, sessionId))
  }

  /*
   * Whether the task failed: failed.flag is present. The agent writes it when it gives up (via
   * declare_job_failed), which is a different state from "not done yet". Same root anchor as
   * isJobGoalAccomplished, and an unknown session again returns false.
   */
  isFailed(sessionId: string) {
    const entry = this.runtime.get(sessionId)
    const root = entry?.flagRoot || entry?.cwd
    if (!root) return false
    return fs.existsSync(failedFlagPathOf(root, sessionId))
  }

  /*
   * One row per hub window: ids, pid/index, last activity (tmux reports seconds, the row is ms) and
   * pane state. Served from the 3s cache because the syncer polls it every few seconds; a window with
   * no runtime row simply reports a null agentSessionId.
   */
  listSessions() {
    return listWindowsRowsCached().map((cols: string[]) => {
      const [name, pid, idx, activity, paneDead, paneCurrentCommand] = cols
      const entry = this.runtime.get(name)
      const lastActivitySec = Number(activity)
      const lastActivityMs = Number.isFinite(lastActivitySec) && lastActivitySec > 0
        ? lastActivitySec * 1000
        : null
      return {
        sessionId: name,
        agentSessionId: entry?.agentSessionId || null,
        pid: Number(pid),
        index: Number(idx),
        lastActivityMs,
        lastActivityAt: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
        tmuxOpen: true,
        paneDead: paneDead === '1',
        paneCurrentCommand: paneCurrentCommand || null,
      }
    })
  }

  /*
   * Live status line for the session page's LIVE card: the claude TUI's own status line picked out of
   * the pane tail, "" when the session is not alive, not working or nothing matched.
   *
   * It reuses capturePaneTail's 5s cache, so the capture-pane spawn is shared with isWorking's
   * background-agent fallback rather than being paid for twice — /status polls every 2s.
   *
   * This is also the place the dangerous-operation box is noticed (an agent stuck on it makes the
   * session look hung, which is exactly what the card would report) and handed to the fire-and-forget
   * heal, so the poll is never blocked by it.
   *
   * Nice-to-have only: any failure returns "" and is never thrown into /status.
   */
  realTimeInfo(sessionId: string): string {
    // 截屏走5s缓存，与isWorking兜底共用
    // The capture uses the 5s cache shared with isWorking's fallback
    try {
      if (this.isAlive(sessionId) && this.isWorking(sessionId)) {
        const paneText = capturePaneTail(sessionId)
        // 危险确认框bypass下仍会弹，卡住就像挂了
        // The danger box appears even under bypass and looks hung
        // 此时tool_use未结，isWorking为真
        // A pending tool_use keeps isWorking true here, covering it
        const danger = detectDangerPermission(paneText)
        if (danger.pending && danger.warning) this._maybeHealDangerPermission(sessionId, danger.warning)
        const info = findClaudeRealTimeInfo(paneText)
        if (info) return info
      }
    } catch { /* best-effort: a failure returns "" */ }
    return ''
  }

  /*
   * Throttle for the danger-box heal: one heal at a time per session, and the same warning text never
   * re-triggers inside DANGER_HEAL_COOLDOWN_MS. Both gates are needed — a dirty Esc plus the 5s pane
   * cache would otherwise let realTimeInfo fire the heal over and over and turn the agent into a
   * broken record.
   *
   * Called by realTimeInfo on a detectDangerPermission hit. Fire-and-forget: it returns immediately
   * and the promise chain only exists to clear the healing flag again.
   */
  _maybeHealDangerPermission(sessionId: string, warning: string) {
    const st = dangerHealState.get(sessionId) || { healing: false, lastWarning: '', lastTs: 0 }
    const now = Date.now()
    // 已经在自愈中，不重复触发
    // Already healing, do not trigger a second time
    if (st.healing) return
    // 同一条警告在冷却期内也忽略，避免刷屏
    // The same warning stays ignored during the cooldown
    if (warning === st.lastWarning && now - st.lastTs < DANGER_HEAL_COOLDOWN_MS) return
    dangerHealState.set(sessionId, { healing: true, lastWarning: warning, lastTs: now })
    this._healDangerPermission(sessionId, warning)
      .catch((e) => log(`[tmux-claude-code] danger heal 失败 session=${sessionId}: ${e?.message || e}`))
      .finally(() => {
        const cur = dangerHealState.get(sessionId)
        if (cur) dangerHealState.set(sessionId, { ...cur, healing: false })
      })
  }

  /*
   * The heal itself, detached async so it never blocks realTimeInfo or the /status poll:
   *   1) Esc cancels the box — claude goes back to the input state without running the dangerous
   *      command, which is what the dialog's own "Esc to cancel" offers
   *   2) wait 5s for the TUI to settle, so the dialog is really gone before the next prompt lands
   *   3) pauseCurrentAndResumeFromSession sends "$warning, please skip or try commands that are less
   *      aggressive." (it interrupts with C-c×3, then queues the new prompt; an agent still inside its
   *      old turn after the Esc is reset that way)
   *
   * The window is re-checked before step 3: it may have died during the 5s wait.
   */
  async _healDangerPermission(sessionId: string, warning: string) {
    if (!windowExists(sessionId)) return
    tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Escape'])
    // 清掉面板缓存，后续检查才会看到取消后的画面
    // Drop the pane cache so later checks see the screen after the cancel
    invalidatePaneTail(sessionId)
    log(`[tmux-claude-code] danger permission 检测到, 已 Esc 取消 (session=${sessionId}): ${warning}`)
    await sleep(5000)
    if (!windowExists(sessionId)) return
    await this.pauseCurrentAndResumeFromSession({
      sessionId,
      prompt: `${warning}, please skip or try commands that are less aggressive.`,
      urgent: false,
    })
    log(`[tmux-claude-code] danger permission 已 resume 提示 agent 跳过/换温和命令 (session=${sessionId})`)
  }

  /*
   * Three-level lookup for sessionId → jsonl file path:
   *   - runtime   the in-process Map, sessions currently alive
   *   - persisted hub-runtime.json, live rows, cleared on terminate
   *   - archive   hub-archive.json, every session ever started and kept past terminate, which is how
   *               history still resolves after an admin closes the window or a cleaner reaps it
   */
  _resolveJsonlPath(sessionId: string): string | null {
    return this.runtime.get(sessionId)?.jsonlPath
        || this._lookupPersistedJsonlPath(sessionId)
        || this._lookupArchivedJsonlPath(sessionId)
        || null
  }

  /*
   * History snapshot out of the agent-history-store DB; native jsonl deltas are backfilled before the
   * read, and the jsonl path is resolved for sessions whose window is already gone.
   */
  getHistory(sessionId: string, _opts: QueryOpts = {}): HistorySnapshot {
    // 待处理输入一并交出去，未消费回合不算完成
    // Hand the pending inputs over so an open round is not "done"
    return getHistorySnapshot(sessionId, this._resolveJsonlPath(sessionId), this.containDequeueEvent.bind(this), this._pendingInputTexts(sessionId)) as HistorySnapshot
  }

  /*
   * Per-step timings derived from the jsonl, cached beside it (see the time-consume-waterfall
   * service).
   */
  get_time_consume_waterfall(sessionId: string, opts: QueryOpts = {}) {
    return timeConsumeWaterfallFromBackend(this, sessionId, opts)
  }

  /*
   * Drop that cached waterfall, so the next read recomputes it from scratch.
   */
  clear_time_consume_waterfall(sessionId: string, opts: QueryOpts = {}) {
    return clearTimeConsumeWaterfallForBackend(this, sessionId, opts)
  }

  /*
   * The send path writes the user_input / compact card, which is what opens a new round; it goes into
   * the agent-history-store, not into a file.
   *
   * A bound runtime jsonl path is explicitly not required: the call site moved up to the dispatch
   * entry, so a brand-new session has to be able to open its round during spawn, with the path left
   * null for the first sync to claim.
   */
  harnessWriteMobiusCoreEntry(sessionId: string, mobiusPromptRecord: MobiusPromptRecord | null | undefined, cwdHint?: string) {
    if (!mobiusPromptRecord) return false
    const entry = this.runtime.get(sessionId)
    try {
      return writeMobiusCoreEntry({
        sessionId,
        agentSessionId: entry?.agentSessionId || null,
        cwd: entry?.cwd || cwdHint || null,
        backendName: this.name,
        primaryPath: entry?.jsonlPath || null,
        ...mobiusPromptRecord,
        containDequeueEvent: this.containDequeueEvent.bind(this),
        pendingInputs: this._pendingInputTexts(sessionId),
      })
    } catch (e) {
      // 写库失败只告警，返回false让调用方自己决定
      // A failed write only warns; false lets the caller decide what to do
      console.warn(`[tmux-claude-code] mobius core entry failed (${sessionId}): ${(e as Error)?.message || e}`)
      return false
    }
  }

  // ── Internals ──────────────────────────────────────────
  /*
   * Create path: spawn a window when none is live, otherwise adopt the one that is, then deliver the
   * first prompt and drop the running flag.
   *
   * Reuse is the defining tmux-mode trait: windows outlive a backend restart, so a live window is
   * adopted instead of duplicated, matching the old hub.startSession idempotence. That is deliberately
   * unlike the stream-json backend, which always creates fresh.
   *
   * Adopting needs a runtime row, and a window that predates the restart has none. The caller's
   * agentSessionId is the only thing that can rebuild it (it names the jsonl to tail), so without one
   * the else-branch below can do nothing.
   */
  async _createImpl(opts: ClaudeDispatchOpts) {
    const { sessionId, cwd, flagRoot, displayName, initialPrompt, agentSessionId, isInitialContextPrompt = false, aimuxRemoteName, aimuxGuiAuthorized } = opts
    let { userId } = opts
    const { model, useProxy, proxyMode, settingsPath, forceNoProxy, captureStream } = unpackLaunch(opts)
    if (!sessionId || !cwd) throw new Error('createNewSession 需要 sessionId + cwd')
    if (!initialPrompt) throw new Error('createNewSession 需要 initialPrompt')
    if (!fs.existsSync(cwd)) throw new Error(`cwd 不存在: ${cwd}`)
    // 入口兜底: 派发方只转发部分字段时从会话行补齐 userId, 否则隔离用户会按宿主 HOME 记账
    // Entry fallback: fill a missing userId from the session row so an isolated user's
    // transcript/trust paths are the sandbox HOME, not the service user's HOME.
    userId = resolveDispatchIdentity(sessionId, { userId }).userId || userId

    // 窗口还活着就复用，重启后不重复拉起
    // A live window is reused, so a restart never spawns a duplicate
    if (!windowExists(sessionId)) {
      await this._spawnWindow({ sessionId, userId, cwd, flagRoot, model, useProxy, proxyMode, displayName, agentSessionId, settingsPath, captureStream, forceNoProxy, aimuxRemoteName, aimuxGuiAuthorized, sandboxPolicy: (opts as any).sandboxPolicy })
    } else {
      // 重启后窗口还在但runtime可能为空，补建一条
      // The window is live but may have no runtime row; rebuild one
      if (!this.runtime.has(sessionId) && agentSessionId) {
        const jp = jsonlPathOf(cwd, agentSessionId, userId)
        const finalSettingsPath = settingsPath || null
        const resolved = resolveClaudeProxyMode(useProxy, forceNoProxy, false, proxyMode)
        this.runtime.set(sessionId, {
          agentSessionId, cwd, flagRoot: flagRoot || cwd, model: model || null, useProxy: resolved.useProxy,
          settingsPath: finalSettingsPath, forceNoProxy: resolved.forceNoProxy, displayName: displayName || null,
          jsonlPath: jp, startedAt: Date.now(), watch: null,
        })
        this._persistEntry(sessionId, {
          agentSessionId, cwd, flagRoot: flagRoot || cwd, model, useProxy: resolved.useProxy,
          settingsPath: finalSettingsPath, forceNoProxy: resolved.forceNoProxy, displayName,
          jsonlPath: jp, startedAt: Date.now(),
        })
        this._ensureWatcher(sessionId)
      }
    }

    const entry = this.runtime.get(sessionId)
    await sendMaybeInitialContextPrompt(this.name, sessionId, initialPrompt, isInitialContextPrompt)
    // 每条消息都重刷运行标记，agent完成后自己删
    // Every message refreshes the running flag; the agent removes it
    markRunning(flagRoot || entry?.flagRoot || entry?.cwd || cwd, sessionId)
    return {
      sessionId,
      agentSessionId: entry?.agentSessionId || null,
      jsonlPath: entry?.jsonlPath || null,
      startedAt: entry?.startedAt || Date.now(),
    }
  }

  /*
   * Queue path: append a prompt to a live session, or respawn the window first when it is gone. Chat
   * draws no first/follow-up distinction, so every message after create arrives here, and this is also
   * what _pauseImpl calls once it has interrupted the running turn.
   *
   * The respawn has to reconstruct what the original spawn built, hence the "opts first, last
   * persisted row second" chain for every field: a follow-up message carries almost nothing itself,
   * and without that fallback the window would come back on the wrong cwd, model or proxy tier.
   *
   * suppressRunningFlag is for a caller that owns the flag lifecycle itself and does not want this
   * path to touch it.
   */
  async _queueImpl(opts: ClaudeDispatchOpts) {
    const { sessionId, userId, prompt, cwd, flagRoot, displayName, agentSessionId, isInitialContextPrompt = false, suppressRunningFlag = false, aimuxRemoteName, aimuxGuiAuthorized } = opts
    let { model, useProxy, proxyMode: proxyModeArg, settingsPath, forceNoProxy, captureStream } = unpackLaunch(opts)
    if (!sessionId) throw new Error('需要 sessionId')
    if (!prompt) throw new Error('需要 prompt')

    if (!windowExists(sessionId)) {
      // 无活窗口必须重开；字段优先opts，其次持久化行
      // No live window means respawn; opts wins, the persisted row is the fallback
      const persisted = this.runtime.get(sessionId)
      const finalCwd = cwd || persisted?.cwd
      const finalAgentSid = agentSessionId || persisted?.agentSessionId
      const finalSettingsPath = settingsPath || persisted?.settingsPath || null
      const proxyMode = resolveClaudeProxyMode(
        useProxy,
        forceNoProxy || persisted?.forceNoProxy,
        persisted?.useProxy ?? false,
        proxyModeArg ?? persisted?.proxyMode,
      )
      if (!finalCwd) throw new Error(`session ${sessionId} 没活 window 且无 cwd, 无法 spawn`)
      await this._spawnWindow({
        sessionId,
        userId,
        cwd: finalCwd,
        flagRoot: flagRoot || persisted?.flagRoot || finalCwd,
        model: model || persisted?.model,
        useProxy: proxyMode.useProxy,
        proxyMode: proxyMode.proxyMode,
        settingsPath: finalSettingsPath,
        captureStream: captureStream || (persisted?.captureStream ?? false),
        forceNoProxy: proxyMode.forceNoProxy,
        displayName: displayName ?? (persisted?.displayName ?? undefined),
        agentSessionId: finalAgentSid ?? undefined,
        aimuxRemoteName,
        aimuxGuiAuthorized,
        sandboxPolicy: (opts as any).sandboxPolicy || null,
      })
    }
    await sendMaybeInitialContextPrompt(this.name, sessionId, prompt, isInitialContextPrompt)
    const entry = this.runtime.get(sessionId)
    if (!suppressRunningFlag) markRunning(flagRoot || entry?.flagRoot || entry?.cwd || cwd, sessionId)
  }

  /*
   * Pause path for a live window: interrupt the running turn, then either stop for good (no prompt,
   * clear the running flag) or hand the new prompt to the queue path.
   *
   * Two interrupt flavours, both measured on the real TUI: urgent sends a single C-c (enough to break
   * a turn), /stop sends three (a lone C-c is regularly swallowed). Neither may wait with
   * spawnSync('sleep'): that blocks the event loop and freezes the whole backend, so the pauses use
   * await setTimeout.
   *
   * The /stop hard-stop fallback is safe to escalate because a killed window is respawned by
   * _queueImpl on the next message, so the session itself continues.
   *
   * An absent window is not an error: the caller asked to stop something that is already not running.
   */
  async _pauseImpl({ sessionId, prompt, cwd, flagRoot, urgent = false, mobiusPromptRecord = null }: ClaudeDispatchOpts) {
    if (!sessionId) throw new Error('需要 sessionId')
    const persisted = this.runtime.get(sessionId)

    if (windowExists(sessionId)) {
      if (urgent) {
        // 加急只发一次C-c即可打断，实测一次就够
        // Urgent sends one C-c; one press is enough in practice
        // 不要用spawnSync睡眠，会阻塞事件循环
        // Use await setTimeout; spawnSync('sleep') blocks the event loop
        tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'C-c'])
        await sleep(250)
        // 旧输入可能回到输入框，先Alt+Enter分隔
        // Old input can return to the box; Alt+Enter keeps it separate
        tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'M-Enter'])
        await sleep(80)
      } else {
        // /stop连发3次C-c，TUI会吞掉其中一次
        // /stop fires 3 C-c; the TUI swallows one of them
        for (let i = 0; i < 3; i++) {
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'C-c'])
          if (i < 2) await sleep(50)
        }
        // 等TUI消化这次打断
        // Give the TUI a moment to digest the interrupt
        await sleep(300)
        // 停不掉就kill-window硬停，保证生效
        // Escalate to kill-window so /stop always stops the agent
        // 只有空提示词的软停走这里，带新提示词不杀窗口
        // Only the empty-prompt soft stop escalates; a new prompt keeps the window
        // 二次确认加700ms等待，避免误杀已软停的窗口
        // Double confirmation with a 700ms wait avoids killing a soft-stopped window
        if (!prompt) {
          invalidatePaneTail(sessionId)
          if (claudePaneStillBusy(sessionId)) {
            await sleep(700)
            invalidatePaneTail(sessionId)
            if (windowExists(sessionId) && claudePaneStillBusy(sessionId)) {
              tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
              log(`[tmux-claude-code] /stop fallback: C-c×3 未停止, kill-window=${sessionId}`)
            }
          }
        }
      }
    }

    if (!prompt) {
      clearRunning(flagRoot || persisted?.flagRoot || persisted?.cwd || cwd, sessionId)
      // 空提示词=只打断不发送，同时清掉运行标记
      // An empty prompt means interrupt only; clear the running flag
      return
    }

    // 走队列路径，死窗口会在里面重开
    // Hand off to the queue path, which respawns a dead window
    await this._queueImpl({
      sessionId,
      prompt,
      cwd: persisted?.cwd ?? undefined,
      flagRoot: persisted?.flagRoot ?? undefined,
      model: persisted?.model ?? undefined,
      useProxy: persisted?.useProxy,
      displayName: persisted?.displayName ?? undefined,
      agentSessionId: persisted?.agentSessionId ?? undefined,
      // 恢复的提示词不算首次上下文，避免重放开场白
      // A resumed prompt is not initial context, so no greeting replay
      isInitialContextPrompt: false,
      mobiusPromptRecord,
    })
  }

  /*
   * Tear the session down for good: stop the watcher, drop the per-session withproxy file, remove the
   * runtime and persisted rows, kill the window, clear the flag dir.
   *
   * The archive row survives on purpose, so history still resolves after the window is gone.
   *
   * Returns { sessionId, killed, wasWorking } so the caller (the delete route) can raise a notice:
   * killed=true means a live background claude code really was killed; wasWorking=true means it was
   * still in a turn (a running task got forcibly interrupted).
   */
  async _terminateImpl(sessionId: string) {
    const wasAlive = windowExists(sessionId)
    // 内部会再查存活，必须在杀窗口前采样
    // isWorking re-checks aliveness, so sample before the kill
    const wasWorking = wasAlive && this.isWorking(sessionId)
    const entry = this.runtime.get(sessionId)
    if (entry?.watch?.stop) { try { entry.watch.stop() } catch {} }
    // 删掉数字雨用的withproxy临时文件
    // Delete the digital-rain per-session withproxy file
    if (entry?.withProxyPath) { try { fs.unlinkSync(entry.withProxyPath) } catch {} }
    // 项目隐藏目录下的会话配置保留: 终止时不删目录, 便于事后排查
    // Session config under the project hidden folder is kept on terminate for post-mortem.
    this.runtime.delete(sessionId)
    this._forgetPersisted(sessionId)
    if (wasAlive) {
      tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
      log(`[tmux-claude-code] terminate: killed window=${sessionId} (wasWorking=${wasWorking})`)
    }
    // 沙箱窗口属主表同步清掉: 窗口已死, 留着会让后续 tmux 调用被路由进容器
    // Drop the sandbox owner row too: a dead window must not keep routing tmux into a container
    clearWindowOwner(sessionId)
    // 顺手删掉标记目录，避免agent没删而留垃圾
    // Drop the flag dir too, in case the agent never removed it
    const flagRoot = entry?.flagRoot || entry?.cwd
    if (flagRoot) {
      safeRemoveFlagDir(flagRoot, sessionId, 'tmux-claude-code')
    }
    return { sessionId, killed: wasAlive, wasWorking }
  }

  // ── Low-level tmux operations ──────────────────────────
  /*
   * Start a new tmux window that runs the interactive claude TUI and register the session's runtime
   * state in memory and on disk.
   *
   * Everything that decides what the agent runs (settings, MCP, proxy tier, environment) is built by
   * buildClaudeLaunch; what remains here is the process side: sandbox wrapping, the window itself and
   * the readiness wait.
   *
   * Resume is opportunistic: an agentSessionId whose jsonl is not visible under this cwd degrades to
   * a fresh session inside buildClaudeLaunch.
   *
   * new-window returns before the TUI has drawn, so waitForTuiReady polls the pane until the footer
   * sentinel shows, auto-confirming every blocking dialog. A TUI that never becomes ready has its
   * window killed rather than left behind.
   */
  async _spawnWindow({ sessionId, userId, cwd, flagRoot, model, useProxy, proxyMode: proxyModeArg, displayName, agentSessionId, settingsPath, captureStream = false, forceNoProxy = false, aimuxRemoteName, aimuxGuiAuthorized, sandboxPolicy = null }: ClaudeDispatchOpts) {
    // 入参可为null，此处归一为非空，兜底在调用方
    // Nullable args become non-null here; the persisted fallback is the caller's
    if (!sessionId || !cwd) throw new Error('_spawnWindow 需要 sessionId + cwd')
    // 入口兜底: 中断后加急重开只带一部分参数, 缺失的 userId/远端绑定从会话行补齐.
    // 缺 userId 会导致 prepareSpawn 返回 null (失去沙箱)、MCP 不注入、CLI 环境不导出.
    // Entry fallback: interrupt-and-resume respawns forward only a subset of options;
    // fill userId / aimux binding from the session row. A missing userId would drop the
    // sandbox container, the MCP config and the CLI environment.
    const identity = resolveDispatchIdentity(sessionId, { userId, aimuxRemoteName, aimuxGuiAuthorized })
    userId = identity.userId || userId
    aimuxRemoteName = identity.aimuxRemoteName || aimuxRemoteName
    aimuxGuiAuthorized = identity.aimuxGuiAuthorized ?? aimuxGuiAuthorized
    if (!sandboxPolicy && userId && identity.role !== 'admin') {
      sandboxPolicy = sandboxPolicyFor(
        { id: userId, role: identity.role },
        { userId: String(userId), projectId: identity.projectId, workDir: cwd },
      ) || null
    }
    const finalFlagRoot = flagRoot || cwd
    // 确保承载所有agent窗口的hub会话存在
    // Make sure the hub session hosting every agent window exists
    ensureHub()

    // 配置面: settings/钩子/MCP/代理/环境 一起生成, 失败直接抛出不启动
    // Config side: settings, hook, MCP, proxy and env are assembled in one step that fails loudly
    const launch = await buildClaudeLaunch({
      sessionId,
      userId,
      cwd,
      flagRoot: finalFlagRoot,
      model: model || null,
      useProxy: !!useProxy,
      proxyMode: proxyModeArg ?? null,
      settingsPath: settingsPath || null,
      captureStream,
      forceNoProxy,
      agentSessionId: agentSessionId || null,
      displayName: displayName || null,
      aimuxRemoteName,
      aimuxGuiAuthorized,
    })

    // 预先写好目录信任，TUI就不会弹"trust this folder"
    // Pre-set the trust so the trust-folder dialog never shows up
    // 这一步失败由就绪轮询里的截屏自动确认兜底
    // A failure here falls back to the screenshot auto-confirm in the ready poll
    ensureProjectTrusted(cwd, userId)

    // 在hub会话里建后台窗口，在cwd下跑bash -lc cmd
    // Create the background window in the hub, running bash -lc cmd in cwd
    const launchCmd = sandboxCommand(sandboxPolicy || null, launch.cmd)
    // 隔离用户: 先确保沙箱容器与容器内 tmux server 就绪, 窗口归属登记后显式走容器
    // Isolated users: bring the container and its tmux server up first, then target it explicitly
    const sbxContainer = prepareSpawn(userId, sessionId)
    // ✨ 真正拉起 agent 的唯一一步
    // The one step that actually starts the agent ✨
    const r = tmux(['new-window', '-d', '-t', HUB, '-n', sessionId, '-c', cwd, 'bash', '-lc', launchCmd],
      { container: sbxContainer || undefined })
    // 失败时带出stderr，便于定位命令级问题
    // Surface stderr on failure so command-level problems are diagnosable
    if (r.status !== 0) throw new Error(`tmux new-window 失败: ${r.stderr}`)
    log(`[tmux-claude-code] started: window=${sessionId} cwd=${cwd} claude_session=${launch.claudeSessionId} proxy_mode=${launch.proxyMode}${launch.settingsPath ? ` settings=${launch.settingsPath}` : ''}`)

    // 等TUI就绪，超时会杀掉窗口并抛出
    // Wait for the TUI, which kills the window and throws on timeout
    await waitForTuiReady(sessionId, cwd)
    log(`[tmux-claude-code] window=${sessionId} TUI ready`)

    // jsonl路径由cwd和claude会话id推导，不做探测
    // The jsonl path is derived from cwd and the claude session id
    const jp = jsonlPathOf(cwd, launch.claudeSessionId, userId)
    // 在内存里登记这个窗口的运行时状态
    // Register this window's runtime state in memory
    this.runtime.set(sessionId, {
      agentSessionId: launch.claudeSessionId,
      cwd, flagRoot: finalFlagRoot, model: model || null, useProxy: launch.useProxy, proxyMode: launch.proxyMode,
      settingsPath: launch.settingsPath, withProxyPath: launch.withProxyPath, captureStream: !!captureStream,
      forceNoProxy: launch.forceNoProxy, displayName: displayName || null,
      jsonlPath: jp, startedAt: Date.now(), watch: null,
    })
    // 同样的核心状态落盘，服务重启后能原样恢复
    // Persist the same core state so a service restart can restore it
    this._persistEntry(sessionId, {
      agentSessionId: launch.claudeSessionId, cwd, flagRoot: finalFlagRoot,
      model: model || null, useProxy: launch.useProxy,
      settingsPath: launch.settingsPath, withProxyPath: launch.withProxyPath, captureStream: !!captureStream,
      forceNoProxy: launch.forceNoProxy, displayName: displayName || null,
      jsonlPath: jp, startedAt: Date.now(),
    })
    // 起jsonl监听，agent输出才能持续推给订阅方
    // Start the jsonl watcher so agent output keeps flowing to subscribers
    this._ensureWatcher(sessionId)

    // 建窗即打标记，每次提交刷新，agent完成后自删
    // Spawn drops the flag, every prompt refreshes it, the agent removes it
    // 标记锚在仓库根而非worktree里的cwd，重建不会误删
    // Rooted at the repo root, not the worktree cwd, so a rebuild cannot delete it
    markRunning(finalFlagRoot, sessionId)
  }
}

module.exports = {
  TmuxClaudeCodeBackend,
  HUB,
  encodeCwd,
  jsonlPathOf,
  runningFlagPathOf,
  failedFlagPathOf,
  findClaudeRealTimeInfo,
  detectDangerPermission,
  isCompactCompletionUserEvent,
  resolveClaudeProxyMode,
}

// marker: make this file a module (top-level declarations file-private) for tsc
export {}
