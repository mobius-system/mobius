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
 * Task running flag: every prompt submission drops <cwd>/.imac/flags/<sessionId>/running.flag, which
 * the agent removes on completion (success or failure — see the context injected by session-context.js).
 * isJobGoalAccomplished reads that file's presence.
 *
 * This file is the backend surface only: the public AgentBackend methods plus the status queries.
 * Every other concern lives under ./claude-code-utils, which this class delegates to:
 *   constants.ts        fixed names, paths, sentinels and timing knobs
 *   types.ts            runtime entry, dispatch contract, backend host interface
 *   proxy.ts            proxy tier normalization and prerequisite checks
 *   session-paths.ts    transcript path, shell quoting, project trust, aimux binary
 *   jsonl-tail.ts       transcript tail reads, turn state, pending queue requests
 *   pane-status.ts      pure pane/transcript parsers (status line, danger box, compact receipt)
 *   tmux-window.ts      hub, windows and the polling caches over them
 *   prompt.ts           paste + Enter delivery, initial-context warm-up
 *   tui-ready.ts        readiness poll that auto-confirms startup dialogs
 *   launch-command.ts   settings / MCP / proxy / env assembly into the bash -lc chain
 *   runtime-store.ts    runtime map restore, jsonl watcher, transcript path lookup
 *   danger-heal.ts      dangerous-operation box self-heal
 *   session-lifecycle.ts create / queue / pause / terminate / spawn
 *   running-flags.ts    the out-of-process task flag
 */
const { spawnSync } = require('child_process')
const fs = require('fs')

import { AgentBackend } from './base'
import type { HistorySnapshot, QueryOpts } from './base'
import type { ClaudeDispatchOpts, ClaudeRuntimeEntry } from './claude-code-utils/types'
import type { MobiusPromptRecord } from '../services/mobius-agent-history'

import { ARCHIVE_FILE, CLAUDE_BG_AGENTS_WAITING_RE, HUB, RUNTIME_FILE } from './claude-code-utils/constants'
import { capturePaneTail, listWindowsRowsCached, windowExists } from './claude-code-utils/tmux-window'
import { sleep } from './claude-code-utils/prompt'
import { detectDangerPermission, findClaudeRealTimeInfo, isCompactCompletionUserEvent } from './claude-code-utils/pane-status'
import { readJsonlTail, parsePendingRequests, turnRunningFromTail } from './claude-code-utils/jsonl-tail'
import { encodeCwd, jsonlPathOf } from './claude-code-utils/session-paths'
import { resolveClaudeProxyMode, proxyPrereqMissing } from './claude-code-utils/proxy'
import { maybeHealDangerPermission } from './claude-code-utils/danger-heal'
import { pendingInputTexts, resolveJsonlPath, restoreRuntime } from './claude-code-utils/runtime-store'
import {
  createSession,
  pauseSessionAndNextPrompt,
  pauseSessionAndTerminate,
  queueSession,
  terminateSession as terminateSessionImpl,
  writeMobiusPromptEarly,
} from './claude-code-utils/session-lifecycle'

const {
  getHistorySnapshot,
  writeMobiusCoreEntry,
  flushPendingOpeners,
} = require('../services/mobius-agent-history')
const {
  timeConsumeWaterfallFromBackend,
  clearTimeConsumeWaterfallForBackend,
} = require('../services/time-consume-waterfall')
const {
  runningFlagPathOf,
  failedFlagPathOf,
} = require('../utils/session-flags')
const { AGENT_TMUX_SOCKET, log, tmux } = require('./tmux-operation-log')

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
    restoreRuntime(this)
  }

  // ── Public methods (wrapped by the base-class lock) ─────
  /*
   * Create path. The user card is written first, outside the lock, so it exists the moment dispatch
   * arrives; the real work then serialises behind the per-session lock, which is what stops two
   * dispatches for one session from spawning two windows.
   */
  createNewSession(opts: ClaudeDispatchOpts) {
    writeMobiusPromptEarly(this, opts)
    return this._withLock(opts?.sessionId, () => createSession(this, opts))
  }
  /*
   * Pause-and-resume: interrupt the running turn, then hand the new prompt to the queue path. The
   * expedited sibling of noPauseCurrentAndQueueQueryAtSession, which queues without interrupting.
   */
  pauseCurrentAndResumeFromSession(opts: ClaudeDispatchOpts) {
    writeMobiusPromptEarly(this, opts)
    return this._withLock(opts?.sessionId, () => pauseSessionAndNextPrompt(this, opts))
  }
  /*
   * Hard-stop the current TUI while preserving enough runtime metadata for the next message to
   * respawn and resume it. The lock is held until the old tmux window is confirmed absent.
   */
  pauseCurrentAndTerminateSession(opts: ClaudeDispatchOpts) {
    return this._withLock(opts?.sessionId, () => pauseSessionAndTerminate(this, opts))
  }
  /*
   * Queue path: append a prompt to a running session without interrupting it, so the agent picks it
   * up when the current turn ends. Spawns the window when none is alive, which is why chat can send
   * both the first and every follow-up message through here.
   */
  noPauseCurrentAndQueueQueryAtSession(opts: ClaudeDispatchOpts) {
    writeMobiusPromptEarly(this, opts)
    return this._withLock(opts?.sessionId, () => queueSession(this, opts))
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
   * Tear the session down: kill the window, stop the watcher, drop the runtime and persisted rows and
   * clear the flag dir. The archive row deliberately survives, so history still resolves afterwards.
   */
  terminateSession(sessionId: string) {
    return this._withLock(sessionId, async () => {
      const r = await terminateSessionImpl(this, sessionId)
      // 终止兜底：agent崩溃时可能永远不dequeue
      // Termination fallback: a crashed agent may never dequeue
      try { flushPendingOpeners(sessionId) } catch {}
      return r
    })
  }

  // ── Status queries (no lock; safe to run concurrently with writes) ──
  /*
   * Whether the window is still listed in the hub. This is the status path, so it reads the 3s cache;
   * control flow (create / terminate / pause) must query live instead, since acting on a stale
   * "exists" could kill a window that was just created.
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
    const jsonlPath = resolveJsonlPath(this, sessionId)
    if (!jsonlPath) return []
    const tail = readJsonlTail(jsonlPath)
    return tail ? parsePendingRequests(tail) : []
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
        if (danger.pending && danger.warning) maybeHealDangerPermission(this, sessionId, danger.warning)
        const info = findClaudeRealTimeInfo(paneText)
        if (info) return info
      }
    } catch { /* best-effort: a failure returns "" */ }
    return ''
  }

  /*
   * Transcript path of this session, three levels deep: the live runtime row,
   * then the persisted hub-runtime row, then the archive row kept past
   * terminate.
   *
   * Public because the history sync, search, mention context and timing
   * waterfall all duck-type this lookup across backends; it used to be a
   * private method and every caller probed that private name.
   */
  resolveJsonlPath(sessionId: string): string | null {
    return resolveJsonlPath(this, sessionId)
  }

  /*
   * History snapshot out of the agent-history-store DB; native jsonl deltas are backfilled before the
   * read, and the jsonl path is resolved for sessions whose window is already gone.
   */
  getHistory(sessionId: string, _opts: QueryOpts = {}): HistorySnapshot {
    // 待处理输入一并交出去，未消费回合不算完成
    // Hand the pending inputs over so an open round is not "done"
    return getHistorySnapshot(sessionId, resolveJsonlPath(this, sessionId), this.containDequeueEvent.bind(this), pendingInputTexts(this, sessionId)) as HistorySnapshot
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
        pendingInputs: pendingInputTexts(this, sessionId),
      })
    } catch (e) {
      // 写库失败只告警，返回false让调用方自己决定
      // A failed write only warns; false lets the caller decide what to do
      console.warn(`[tmux-claude-code] mobius core entry failed (${sessionId}): ${(e as Error)?.message || e}`)
      return false
    }
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
