/**
 * claude-code-utils/tmux-window.ts — Panes of the claude hub.
 *
 * The hub session itself (existence, create, window lookup, the polling
 * cache) is shared with the codex backend and lives in ../tmux-hub.ts; this
 * module binds it to the claude hub and adds the pane-level reads only the
 * claude TUI needs.
 */
import {
  ANSI_ESCAPE_RE,
  CLAUDE_BG_AGENTS_WAITING_RE,
  CLAUDE_STATUS_LINE_RE,
  HUB,
  PANE_TAIL_TTL_MS,
} from './constants'
import { createTmuxHub } from '../tmux-hub'
const { tmux } = require('../tmux-operation-log')

// 本会话 hub 的查询集: 存在性/建 hub/窗口存在/状态缓存 都在共享实现里
// This backend's hub queries; the shared implementation owns the cache
const hub = createTmuxHub(HUB, '[tmux-claude-code]')

/** Whether the claude hub session exists. */
export const hubExists = hub.hubExists
/** Create the claude hub when missing. Idempotent. */
export const ensureHub = hub.ensureHub
/** Live window check for control flow (never the 3s cache). */
export const windowExists = hub.windowExists
/** Parsed window rows from the 3s cache, for polling callers only. */
export const listWindowsRowsCached = hub.listWindowsRowsCached

// sessionId → { ts, text } for the plain-text pane tail.
const paneTailCache = new Map<string, { ts: number; text: string }>()

/*
 * Plain-text tail of a session's pane: last 25 lines, ANSI stripped.
 * Shared by isWorking's background-agent fallback and realTimeInfo.
 *
 * The 5s TTL cache exists because capture-pane is a blocking spawnSync.
 * /status polls every 2s and both callers used to spawn their own, so one
 * entry per session caps it at one spawn per 5s.
 *
 * The tmux call carries `-t HUB:<id>`, so the isolation router sends it
 * into the sandbox container when the window belongs to a sandboxed user.
 *
 * Never throws: a failed or empty capture is cached as "" like any other
 * blank screen.
 */
export function capturePaneTail(sessionId: string) {
  const now = Date.now()
  const cached = paneTailCache.get(sessionId)
  // 命中缓存直接返回，空串也算命中，失败不重复截屏
  // Serve a cache hit at once, "" included, so failures are not re-captured
  if (cached && now - cached.ts < PANE_TAIL_TTL_MS) return cached.text
  let text = ''
  try {
    // -p在此指打印到标准输出，-S -25只截尾部
    // -p is print-to-stdout here, -S -25 keeps only the tail
    const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-S', '-25'])
    if (pane.status === 0 && pane.stdout) {
      // 去掉ANSI转义，调用方只做纯文本匹配
      // Strip ANSI escapes, callers only match plain text
      text = pane.stdout.replace(ANSI_ESCAPE_RE, '')
    }
  } catch { /* best-effort: a failure returns "" */ }
  paneTailCache.set(sessionId, { ts: now, text })
  return text
}

/*
 * Drop the pane cache for one session, so the next read sees the screen as
 * it is now. Used after a key press changed the TUI (Esc on the danger box,
 * the /stop C-c burst) where a cached frame would hide the result.
 */
export function invalidatePaneTail(sessionId: string) {
  paneTailCache.delete(sessionId)
}

/*
 * Hard-kill probe for /stop: reads the pane's newest text directly,
 * bypassing the 5s cache, so it shows the state after the C-c burst and
 * whether a turn is still running.
 *
 * Two busy anchors count: the elapsed-time status line, and "Waiting for N
 * background agents to finish", the one state the jsonl cannot express.
 *
 * This only reports whether a pane appears busy; callers decide how to react.
 * before killing, so a hit alone never kills anything; a failed or empty
 * capture returns false (no escalation), so a normally soft-stopped window
 * is never killed.
 */
export function claudePaneStillBusy(sessionId: string) {
  let text = ''
  try {
    const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-S', '-25'])
    if (pane.status === 0 && pane.stdout) {
      text = pane.stdout.replace(ANSI_ESCAPE_RE, '')
    }
  } catch { /* best-effort: a failure means not busy, no escalation */ }
  if (!text) return false
  // 任一忙锚点命中即仍在跑，都不命中说明已空闲
  // Either anchor hit means running, neither means back to idle
  return CLAUDE_STATUS_LINE_RE.test(text) || CLAUDE_BG_AGENTS_WAITING_RE.test(text)
}

/** Test hook: forget every cache, so a case sees fresh tmux output. */
export function resetWindowCaches() {
  hub.resetCaches()
  paneTailCache.clear()
}
