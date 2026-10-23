/**
 * tmux-hub.ts — The agent tmux hub: existence, windows and the polling cache.
 *
 * Both TUI backends (claude code, codex) keep one hub session per agent flavour
 * and address one window per Mobius session, so this file holds that logic once
 * and each backend binds its own hub name. The cache is per hub on purpose: a
 * factory call owns its own table.
 *
 * Two kinds of query live here and they must never be confused:
 *   - windowExists          live, for control flow (create / terminate / pause)
 *   - listWindowsRowsCached status only, 3s stale, for polling callers
 * Mixing them either kills a window that was just created or freezes the
 * event loop, so each caller documents which one it may use.
 */
import { containerWindowExists, listWindowsRowsFromSandboxes, listWindowsRowsForStatus } from '../services/user-isolation'

const { log, tmux } = require('./tmux-operation-log')

// list-windows result cache (status queries only).
// /status and the syncer poll every 2~5s; one /status calls list-windows several times (isAlive,
// isWorking with its inner isAlive, listSessions, error scan), all spawnSync and blocking Node's
// single event loop. Reusing the parsed rows within LIST_WINDOWS_TTL_MS (3s) cuts that to 0~1
// spawnSync per /status, removing the "one slow tmux → event loop occupied → every request in that
// window queues" avalanche. Control flow still queries live.
const LIST_WINDOWS_TTL_MS = 3 * 1000
const LIST_WINDOWS_FORMAT = '#{window_name}|#{pane_pid}|#{window_index}|#{window_activity}|#{pane_dead}|#{pane_current_command}'

/** Queries bound to one hub session name. */
export interface TmuxHub {
  /** Whether the hub session exists (a normal answer, not an error). */
  hubExists(): boolean
  /** Create the hub and its placeholder window when missing. Idempotent. */
  ensureHub(): void
  /** Live existence check for control flow. */
  windowExists(name: string): boolean
  /** Parsed list-windows rows, 3s stale, for polling callers only. */
  listWindowsRowsCached(): string[][]
  /** Test hook: drop the status cache. */
  resetCaches(): void
}

/**
 * Build the query set for one hub. `logTag` prefixes the create log line so the
 * two backends stay distinguishable.
 */
export function createTmuxHub(hub: string, logTag: string): TmuxHub {
  let listWindowsCache: { ts: number; rows: string[][] } | null = null

  /*
   * Whether the hub session exists. A missing hub is a normal answer, not an
   * error (the first spawn brings it up), so the exit status is used as the
   * boolean directly.
   */
  function hubExists() {
    return tmux(['has-session', '-t', hub]).status === 0
  }

  /*
   * Make sure the hub session that hosts one window per mobius session
   * exists. Idempotent, so every spawn path can call it unconditionally;
   * the hub runs no agent itself, it only holds windows, and the
   * placeholder window created here (name "_root") is never addressed again.
   */
  function ensureHub() {
    if (hubExists()) return
    const r = tmux(['new-session', '-d', '-s', hub, '-n', '_root'])
    // 建不出hub说明tmux有问题，在这里报错最清楚
    // A hub that cannot be created means tmux is broken, fail here
    if (r.status !== 0) throw new Error(`tmux new-session 失败: ${r.stderr}`)
    log(`${logTag} created tmux session ${hub}`)
  }

  /*
   * Whether a window named after the mobius sessionId exists in the hub.
   * A live query, deliberately never the cached rows: control flow (create,
   * terminate, pause, recovery) decides life and death from this answer, and
   * a 3s-stale "exists" could kill a window that was just created.
   *
   * A host tmux miss falls through to the sandbox check rather than
   * answering "absent" on its own: the window may simply live in a container.
   * The caller treats a miss as an absent window (and re-spawns), which also
   * covers the hub being gone.
   */
  function windowExists(name: string) {
    const r = tmux(['list-windows', '-t', hub, '-F', '#{window_name}'])
    // 按整行比对，前缀相同的sessionId不会互相误判
    // Compare whole lines, so ids sharing a prefix never match each other
    if (r.status === 0 && r.stdout.split('\n').includes(name)) return true
    // 宿主查不到不等于不存在: 隔离用户的窗口在沙箱容器的 hub 里
    // A host miss does not mean absent: an isolated user's window lives in a container hub
    // 已知属主只查它自己的容器, 不必每次派发都遍历所有沙箱
    // A registered owner is checked in its own container, not in every sandbox
    const owned = containerWindowExists(name, hub)
    if (owned !== null) return owned
    // 属主未知 (后端重启后的首次控制流调用): 全量扫描, 顺带重建属主表
    // Unknown owner (first control flow after a restart): scan all and rebuild the owner table
    return listWindowsRowsFromSandboxes(hub).some((cols: string[]) => cols[0] === name)
  }

  /*
   * Parsed `list-windows -F` rows for the hub, served from a 3s cache. The
   * columns are window_name, pane_pid, window_index, window_activity,
   * pane_dead and pane_current_command — what isAlive / listSessions / the
   * syncer read back on every poll.
   *
   * Control flow must NOT use this cache: acting on rows up to 3s old could
   * kill a window that was just created. Create / terminate / pause call
   * windowExists instead.
   */
  function listWindowsRowsCached() {
    const now = Date.now()
    if (listWindowsCache && now - listWindowsCache.ts < LIST_WINDOWS_TTL_MS) {
      return listWindowsCache.rows
    }
    const r = tmux(['list-windows', '-t', hub, '-F', LIST_WINDOWS_FORMAT])
    // tmux失败也缓存空表，避免轮询里反复失败
    // A failed tmux caches an empty list, so polls do not repeat the failure
    const rows = r.status === 0
      ? r.stdout.trim().split('\n').filter(Boolean).map((l: string) => l.split('|'))
      : []
    // docker 隔离: 各沙箱容器内的窗口行并入 (状态查询读异步快照, 不走阻塞的同步探测)
    // Docker isolation: merge the sandbox container rows from the async snapshot
    const allRows = [...rows, ...listWindowsRowsForStatus(hub)]
    listWindowsCache = { ts: now, rows: allRows }
    return allRows
  }

  function resetCaches() {
    listWindowsCache = null
  }

  return { hubExists, ensureHub, windowExists, listWindowsRowsCached, resetCaches }
}
