/**
 * claude-code-utils/tmux-window.ts — The hub session, its windows and the
 * cached reads over them.
 *
 * Two kinds of query live here and they must never be confused:
 *   - windowExists          live, for control flow (create / terminate / pause)
 *   - listWindowsRowsCached status only, 3s stale, for polling callers
 * Mixing them either kills a window that was just created or freezes the
 * event loop, so each caller documents which one it may use.
 */
import {
  ANSI_ESCAPE_RE,
  CLAUDE_BG_AGENTS_WAITING_RE,
  CLAUDE_STATUS_LINE_RE,
  HUB,
  LIST_WINDOWS_TTL_MS,
  PANE_TAIL_TTL_MS,
} from './constants'
import { containerWindowExists, listWindowsRowsFromSandboxes, listWindowsRowsForStatus } from '../../services/user-isolation'
const { log, tmux } = require('../tmux-operation-log')

const LIST_WINDOWS_FORMAT = '#{window_name}|#{pane_pid}|#{window_index}|#{window_activity}|#{pane_dead}|#{pane_current_command}'

// Status-query cache: sessionId-free, one table for the whole hub.
let listWindowsCache: { ts: number; rows: string[][] } | null = null
// sessionId → { ts, text } for the plain-text pane tail.
const paneTailCache = new Map<string, { ts: number; text: string }>()

/*
 * Whether the shared tmux hub session exists. A missing hub is a normal
 * answer, not an error (the first createNewSession brings it up), so the
 * exit status is used as the boolean directly.
 * Only for callers that just want to know; anything that needs the hub to
 * be there uses ensureHub.
 */
export function hubExists() {
  return tmux(['has-session', '-t', HUB]).status === 0
}

/*
 * Make sure the hub session that hosts one window per mobius session
 * exists. Idempotent, so every spawn path can call it unconditionally;
 * the hub runs no agent itself, it only holds windows, and the
 * placeholder window created here (name "_root") is never addressed again.
 */
export function ensureHub() {
  if (hubExists()) return
  const r = tmux(['new-session', '-d', '-s', HUB, '-n', '_root'])
  // 建不出hub说明tmux有问题，在这里报错最清楚
  // A hub that cannot be created means tmux is broken, fail here
  if (r.status !== 0) throw new Error(`tmux new-session 失败: ${r.stderr}`)
  log(`[tmux-claude-code] created tmux session ${HUB}`)
}

/*
 * Whether a window named after the mobius sessionId exists in the hub.
 * A live query, deliberately never the cached rows: control flow (create,
 * terminate, pause, recovery) decides life and death from this answer, and
 * a 3s-stale "exists" could kill a window that was just created.
 * A host tmux failure falls through to the sandbox check rather than
 * answering "absent" on its own: the window may simply live in a container.
 * The caller treats a miss as an absent window (and re-spawns), which also
 * covers the hub being gone.
 */
export function windowExists(name: string) {
  const r = tmux(['list-windows', '-t', HUB, '-F', '#{window_name}'])
  // 按整行比对，前缀相同的sessionId不会互相误判
  // Compare whole lines, so ids sharing a prefix never match each other
  if (r.status === 0 && r.stdout.split('\n').includes(name)) return true
  // 宿主查不到不等于不存在: 隔离用户的窗口在沙箱容器的 hub 里
  // A host miss does not mean absent: an isolated user's window lives in a container hub
  // 已知属主只查它自己的容器, 不必每次派发都遍历所有沙箱
  // A registered owner is checked in its own container, not in every sandbox
  const owned = containerWindowExists(name, HUB)
  if (owned !== null) return owned
  // 属主未知 (后端重启后的首次控制流调用): 全量扫描, 顺带重建属主表
  // Unknown owner (first control flow after a restart): scan all and rebuild the owner table
  return listWindowsRowsFromSandboxes(HUB).some((cols: string[]) => cols[0] === name)
}

/*
 * Parsed `list-windows -F` rows for the hub, served from a 3s cache. The
 * columns are window_name, pane_pid, window_index, window_activity,
 * pane_dead and pane_current_command — what isAlive / listSessions / the
 * syncer read back on every poll.
 *
 * Status queries poll every 2~5s, and one /status used to spawn
 * list-windows three times over (isAlive, isWorking's inner isAlive,
 * listSessions), each one a blocking spawnSync; a single slow tmux then
 * stalled the event loop and queued every request behind it.
 *
 * Control flow must NOT use this cache: acting on rows up to 3s old could
 * kill a window that was just created. Create / terminate / pause call
 * windowExists instead.
 */
export function listWindowsRowsCached() {
  const now = Date.now()
  if (listWindowsCache && now - listWindowsCache.ts < LIST_WINDOWS_TTL_MS) {
    return listWindowsCache.rows
  }
  const r = tmux(['list-windows', '-t', HUB, '-F', LIST_WINDOWS_FORMAT])
  // tmux失败也缓存空表，避免轮询里反复失败
  // A failed tmux caches an empty list, so polls do not repeat the failure
  const rows = r.status === 0
    ? r.stdout.trim().split('\n').filter(Boolean).map((l: string) => l.split('|'))
    : []
  // docker 隔离: 各沙箱容器内的窗口行并入 (状态查询读异步快照, 不走阻塞的同步探测)
  const allRows = [...rows, ...listWindowsRowsForStatus(HUB)]
  listWindowsCache = { ts: now, rows: allRows }
  return allRows
}

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
 * This only escalates a stop that already failed. _pauseImpl asks twice
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

/** Test hook: forget both caches, so a case sees fresh tmux output. */
export function resetWindowCaches() {
  listWindowsCache = null
  paneTailCache.clear()
}
