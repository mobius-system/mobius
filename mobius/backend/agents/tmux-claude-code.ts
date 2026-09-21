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
 */
const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

import { AgentBackend } from './base'
import type { HistorySnapshot, QueryOpts } from './base'
const {
  getHistorySnapshot,
  writeMobiusCoreEntry,
  flushPendingOpeners,
} = require('../services/mobius-agent-history')
import type { MobiusPromptRecord } from '../services/mobius-agent-history'
const { watch: watchJsonlFile } = require('../services/jsonl-watcher')
const {
  timeConsumeWaterfallFromBackend,
  clearTimeConsumeWaterfallForBackend,
} = require('../services/time-consume-waterfall')
const { recordPromptPaste } = require('../services/agent-prompt-events')
const {
  runningFlagPathOf,
  failedFlagPathOf,
  safeWriteRunningFlag,
  safeRemoveRunningFlag,
  safeRemoveFlagDir,
} = require('../utils/session-flags')
const { MOBIUS_DATA_PATH } = require('../config')
const { AGENT_TMUX_SOCKET, log, tmux } = require('./tmux-operation-log')
const { take_tmux_window_text } = require('./tmux_utils')
const { ensureSessionWithProxy } = require('../services/model-access')

// ── Constants ───────────────────────────────────────────
const HUB = 'imac_claude_code_agent_hub'
const HOME = os.homedir()
// Env-var proxy config (formerly proxy_envs.bash): prefer the new name, fall back to the old file.
const PROXY_ENVS_FILE = path.join(HOME, 'proxy_envs.conf')
const PROXY_ENVS_FILE_LEGACY = path.join(HOME, 'proxy_envs.bash')
/*
 * Resolve which proxy env-var file counts as configured: the new
 * proxy_envs.conf when present, otherwise the legacy proxy_envs.bash.
 *
 * Only the prereq check asks this; the spawn command tries both names
 * itself, so a host set up before the rename keeps working with no
 * migration.
 */
function resolveProxyEnvsFile() {
  return fs.existsSync(PROXY_ENVS_FILE) ? PROXY_ENVS_FILE : PROXY_ENVS_FILE_LEGACY
}
// Model proxychains config (formerly proxy_claude.conf); the legacy file is reused while it exists.
const PROXY_CONF = path.join(HOME, 'proxychains_config_for_llm_models.conf')
const RUNTIME_FILE = path.join(MOBIUS_DATA_PATH, 'hub-runtime.json')
// archive: one row per session ever started (sessionId → jsonlPath/agentSessionId/cwd...), kept past
// terminate, so getHistory still resolves a jsonl after an admin closes the window or a cleaner reaps it.
const ARCHIVE_FILE = path.join(MOBIUS_DATA_PATH, 'hub-archive.json')

// claude TUI ready poll: watch for the footer "bypass permissions on" (present after the splash).
const READY_POLL_MS = 250
const READY_TIMEOUT_MS = 25000
const READY_SENTINEL = 'bypass permissions on'

// First entry into a new directory raises claude's "trust this folder" dialog
// (--dangerously-skip-permissions does not skip it). The cwd is a platform-created workspace, so the
// default "Yes, I trust this folder" is fine; claude persists the trust for that directory.
const TRUST_PROMPT_SENTINELS = [
  'trust this folder',
  'Is this a project you created or one you trust',
  'Do you trust the files',
]
const TRUST_PRESS_INTERVAL_MS = 1500

// One-time first-run onboarding dialogs (text style, welcome screen) block TUI ready: auto-confirm with Enter.
const ONBOARDING_PROMPT_SENTINELS = [
  'Choose the text style',
  'Let\'s get started',
  'Welcome to Claude Code',
]
const ONBOARDING_PRESS_INTERVAL_MS = 1500

// "Detected a custom API key in your environment" dialog: claude sees the ANTHROPIC_API_KEY env var
// and asks whether to use it. Press "1" for Yes (use that key) to dismiss the dialog.
const API_KEY_PROMPT_SENTINELS = [
  'Detected a custom API key in your environment',
  'Do you want to use this API key',
]
const API_KEY_PRESS_INTERVAL_MS = 1500

// "WARNING: Claude Code running in Bypass Permissions mode" dialog: newer claude shows this one-time
// confirmation under --dangerously-skip-permissions. The default is "1. No, exit", so it takes
// "2" + Enter to accept and reach the normal TUI.
const BYPASS_WARN_SENTINELS = [
  'WARNING: Claude Code running in Bypass Permissions mode',
  'Yes, I accept',
]
const BYPASS_WARN_INTERVAL_MS = 1500

// User-level claude config; projects[absPath] holds the directory trust flag.
const CLAUDE_CONFIG = path.join(HOME, '.claude.json')

/*
 * Pre-mark the project directory as trusted in this service user's
 * ~/.claude.json, so claude's first-run "Do you trust the files in this
 * folder?" dialog never appears in the TUI. Done this way because no
 * official CLI sets that flag (`claude project` only purges) and
 * --dangerously-skip-permissions does not skip the trust dialog either;
 * -p/--bare is incompatible with the interactive TUI.
 *
 * Idempotent: an entry already marked trusted is left untouched, and the
 * key is only ADDed for an entry that is missing or untrusted — an
 * existing entry belongs to the claude processes running there, so
 * overwriting it could drop their state. tmp file + atomic rename keeps
 * the shared config readable at all times.
 *
 * Returns false on any failure and never throws: startup must not be
 * blocked by this, because the ready poll's screenshot auto-confirm with
 * Enter is the fallback (belt and braces).
 */
function ensureProjectTrusted(cwd: string) {
  try {
    // 信任按绝对路径记账，先归一化再查表
    // Trust is keyed by absolute path, normalize before looking it up
    const abs = path.resolve(cwd)
    // 配置文件还没生成，交给截屏兜底，不凭空造一个
    // No config yet, leave it to the screenshot fallback, do not invent one
    if (!fs.existsSync(CLAUDE_CONFIG)) return false
    const j = JSON.parse(fs.readFileSync(CLAUDE_CONFIG, 'utf8'))
    if (!j.projects || typeof j.projects !== 'object') j.projects = {}
    const cur = j.projects[abs]
    // 已经信任过就直接返回，不动别人的状态
    // Already trusted, return without touching anyone else's state
    if (cur && cur.hasTrustDialogAccepted === true) return true
    // 保留原字段只置信任位，整条覆盖会丢状态
    // Keep existing keys, set only the trust bit; a full overwrite loses state
    j.projects[abs] = { ...(cur || {}), hasTrustDialogAccepted: true }
    // 先写临时文件再原子改名，配置不会被读到一半
    // Write tmp then rename atomically, the config is never read half-written
    const tmp = `${CLAUDE_CONFIG}.imac-tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2))
    fs.renameSync(tmp, CLAUDE_CONFIG)
    log(`[tmux-claude-code] 预置目录信任: ${abs} → ~/.claude.json`)
    return true
  } catch (e) {
    // 失败只告警不抛出，启动照常走截屏自动确认
    // Warn instead of throwing, startup still has the screenshot auto-confirm
    console.warn(`[tmux-claude-code] 预置目录信任失败 (走截屏兜底): ${e.message}`)
    return false
  }
}

// Paste landing probe + fallback
const PASTE_PROBE_INTERVAL_MS = 200
const PASTE_SLEEP_MAX_MS = 5000
// A paste past the TUI's collapse threshold is replaced on screen by a placeholder, so the prompt
// text never reaches the pane and the tail probe can never match. Claude Code renders
// "[Pasted text #2 +22 lines]"; codex renders "[Pasted Content N chars]" above its 1000-char
// threshold. Either form proves the paste landed, so the wait below accepts a placeholder hit.
const PASTE_PLACEHOLDER_RE = /\[Pasted (?:Content \d+ chars|text\b[^\]]*)\]/
// Submit-Enter retry: the TUI's input-mode switch after bracketed paste (-p) occasionally swallows
// the first Enter. Re-send N times idempotently (paste is atomic so extra Enters never split the
// message; once submitted the box is empty and Enter is a no-op).
const SUBMIT_ENTER_ATTEMPTS = 3
const SUBMIT_ENTER_INTERVAL_MS = 500
const INITIAL_CONTEXT_DELAY_MS = 5000
const INITIAL_CONTEXT_GREETING_CHOICES = ['hello', 'greeting', 'are you there', 'good day']

// ── Module-level helpers (stateless) ────────────────────
/*
 * Whether the shared tmux hub session exists. A missing hub is a normal
 * answer, not an error (the first createNewSession brings it up), so the
 * exit status is used as the boolean directly.
 * Only for callers that just want to know; anything that needs the hub to
 * be there uses ensureHub.
 */
function hubExists() {
  return tmux(['has-session', '-t', HUB]).status === 0
}

/*
 * Make sure the hub session that hosts one window per mobius session
 * exists. Idempotent, so every spawn path can call it unconditionally;
 * the hub runs no agent itself, it only holds windows, and the
 * placeholder window created here (name "_root") is never addressed again.
 */
function ensureHub() {
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
 * A tmux failure is reported as "does not exist": the caller then treats
 * it as an absent window (and re-spawns), which also covers the hub being
 * gone.
 */
function windowExists(name: string) {
  const r = tmux(['list-windows', '-t', HUB, '-F', '#{window_name}'])
  // 查询失败当作不存在，调用方会按没有窗口处理
  // A failed query counts as absent, callers then treat it as no window
  if (r.status !== 0) return false
  // 按整行比对，前缀相同的sessionId不会互相误判
  // Compare whole lines, so ids sharing a prefix never match each other
  return r.stdout.split('\n').includes(name)
}

// list-windows result cache (status queries only).
// /status and the syncer poll every 2~5s; one /status calls list-windows 3 times (isAlive, isWorking
// with its inner isAlive, listSessions), all spawnSync and blocking Node's single event loop. Reusing
// the parsed rows within LIST_WINDOWS_TTL_MS (3s) cuts that to 0~1 spawnSync per /status, removing
// the "one slow tmux → event loop occupied → every request in that window queues" avalanche.
// Control flow (windowExists in create/terminate/pause/recovery) still queries live.
const LIST_WINDOWS_TTL_MS = 3 * 1000
let _listWindowsCache: { ts: number; rows: string[][] } | null = null // { ts: number, rows: string[][] }

// isWorking's tail window over the transcript. Must dwarf a single record: claude-code's injected
// context user entry (🚁🍕 project+memory) and long assistant output reach 30KB+ on one line, so the
// old 16KB window held not even one — the first thinking phase's only user marker fell out, leaving
// metadata only (attachment/mode/permission-mode/ai-title...) → nothing matched → working falsely
// false, stuck "idle" for minutes until the first assistant record landed. 256KB clears the giant
// injection to reach the nearest user/assistant marker; read cost is negligible (plain file read, no tmux).
const CLAUDE_WORKING_TAIL_BYTES = 256 * 1024

// Claude Code writes /compact as synthetic `type:user` records: a continuation summary, the local
// command itself, and finally a local-command stdout record such as
// `<local-command-stdout>Compacted ...</local-command-stdout>`. The latter is a completion marker,
// not a new user turn. Keep this narrow so an in-flight compact stays working until its completion
// acknowledgement is written.
//
// Claude Code 2.1.x embeds ANSI dim codes inside the receipt:
//   <local-command-stdout>\x1b[2mCompacted (...)\x1b[22m</local-command-stdout>
// Strip ANSI escapes before matching, otherwise the dim code between the tag and the word keeps the
// idle TUI stuck in `working` forever.
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g
/*
 * Whether a jsonl user entry is the completion receipt of a /compact, the
 * "<local-command-stdout>Compacted ...</local-command-stdout>" record.
 * Claude Code encodes the whole compact bookkeeping as synthetic
 * type:user records, so without this check a finished compact looks like
 * a fresh user turn and an idle TUI stays "working" forever; this receipt
 * is what proves the compact is over, and isWorking / containDequeueEvent
 * both rely on that reading.
 * Deliberately narrow: only this receipt matches, so a compact still in
 * flight keeps reading as working until its acknowledgement is written.
 */
function isCompactCompletionUserEvent(entry: any) {
  if (!entry || entry.type !== 'user') return false
  // content可能是字符串或文本块数组，先统一取纯文本
  // content is a string or text blocks, reduce it to plain text first
  const content = entry.message?.content
  const text = Array.isArray(content)
    ? content
      .filter((block) => block && typeof block === 'object' && block.type === 'text')
      .map((block) => block.text || '')
      .join('\n')
    : content
  // 先剥掉ANSI转义再匹配，暗色码会夹在标签和单词之间
  // Strip ANSI before matching, the dim code sits between tag and word
  return typeof text === 'string'
    && /<local-command-stdout>\s*Compacted\b/i.test(String(text).replace(ANSI_ESCAPE_RE, ''))
}

// Max entries getPendingRequests reverse-scans: pending requests always sit at the jsonl tail, so the
// last N entries suffice — the whole tail is never walked. Reverse scanning is truncation-safe (a
// consumption always follows its enqueue, i.e. is seen earlier in reverse → no false pending);
// truncation can only hide deeply buried old pending (best-effort).
const MAX_PENDING_SCAN_ENTRIES = 20

// realTimeInfo: matches claude TUI's current status line. Core anchor = the parenthesized group that
// starts with elapsed "(<elapsed> · ...)", elapsed being Ns | Mm Ss | Hh Mm Ss. Two shapes:
//   - "(6m 36s · ↓ 20.0k tokens · thinking more)" — with token throughput
//   - "(29s · thinking more)"                     — elapsed + status word only (no tokens yet)
// On a hit the whole line is returned (spinner + task description + group). `\(` followed by a
// digit+time unit excludes output such as "(3 files changed)".
const CLAUDE_STATUS_LINE_RE = /\(\d+(?:s|m\s+\d+s|h\s+\d+m\s+\d+s)[^()]*\)/u
// claude TUI's auto-retry state after an API connection failure. The line has none of the elapsed
// group a normal status line carries:
//   ✻ Unable to connect to API (ConnectionRefused) · Retrying in 25s · attempt 10/10
// Kept as a separate case beside CLAUDE_STATUS_LINE_RE so it can be dropped alone if it misfires,
// without touching the other rule.
const CLAUDE_RETRYING_LINE_RE = /·\s*Retrying\s+in\s+\d+s\s*·/i

/*
 * Pick claude's current status line out of a captured pane, or "" when
 * there is none. Scan from the bottom: the TUI renders only the newest
 * status, so the first match is the live one and the older scrollback
 * lines that also match are ignored.
 * Either shape counts, the elapsed-time status group or the API-retry line
 * (see the two regexes above). The whole line is returned on purpose, so
 * the UI keeps the spinner, the task description and the token counters
 * that surround the matched group.
 */
function findClaudeRealTimeInfo(paneText: string) {
  const lines = String(paneText || '').split('\n')
  // 自下往上扫，最近的一行才是当前状态
  // Scan bottom-up, the nearest line is the current state
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line && (CLAUDE_STATUS_LINE_RE.test(line) || CLAUDE_RETRYING_LINE_RE.test(line))) {
      return line.trim()
    }
  }
  return ''
}
// claude TUI's "waiting for background agents" status line. After the main agent dispatches
// background sub-agents (Task tool) the round's JSONL often ends on end_turn (Task is
// fire-and-forget) while the TUI shows "✻ Waiting for 3 background agents to finish". The reverse
// JSONL scan then returns false → misread as idle, possibly reaped as idle by inactive-tmux-cleaner.
// The JSONL cannot express this wait state, so isWorking falls back to capture-pane when the JSONL
// looks finished (see the end of isWorking); a hit here (N≥1) still means working.
// Not anchored on the spinner glyph (✻ varies per frame), case-insensitive, and [1-9]\d* excludes
// N=0 (the line disappears once done).
const CLAUDE_BG_AGENTS_WAITING_RE = /Waiting\s+for\s+[1-9]\d*\s+background\s+agents?\s+to\s+finish/i

// claude TUI "dangerous operation permission box". Even under --dangerously-skip-permissions /
// "bypass permissions on" in the footer, claude still raises a one-time confirmation for some
// dangerous operations. At least two known texts:
//   Dangerous rm operation on working directory or its ancestor: /home/.../verify-overflow
//   Dangerous rm operation on possibly-empty variable path: "$BASE/$f"
//   Do you want to proceed?   1. Yes   ❯ 2. No   Esc to cancel · Tab to amend · ctrl+e to explain
// The agent then sits on the box waiting for input, the TUI stops advancing, and the session looks
// idle/hung. realTimeInfo detects the box → pulls the full danger_warning line → fire-and-forget
// self-heal (Esc to cancel → wait 5s → resume telling the agent to skip or use a gentler command),
// without blocking the /status poll. Matches the whole "Dangerous <kind> operation on <reason>:
// <target>" line; <reason> is not restricted to specific wording, so new check kinds Claude adds stay
// compatible. The heal still requires the proceed + Esc dialog traits on screen together, so plain
// "Dangerous" text in ordinary output never triggers it.
const CLAUDE_DANGER_OPERATION_RE = /Dangerous\s+\S[^\n]*?operation\s+on\s+[^:\n]+:[^\n]*/i
// Self-heal throttle: one heal at a time per session, and the same warning text never re-triggers
// inside the cooldown — a dirty Esc plus the 5s pane cache would otherwise have realTimeInfo firing
// repeatedly and turn the agent into a broken record.
const DANGER_HEAL_COOLDOWN_MS = 30 * 1000
const _dangerHealState = new Map() // sessionId → { healing: boolean, lastWarning: string, lastTs: number }

// Plain-text tail cache for capture-pane (5s TTL). isWorking's fallback and realTimeInfo share one
// spawn, capping capture-pane at ≤1/5s/session. ANSI escapes stripped; failure or no hit returns "".
const PANE_TAIL_TTL_MS = 5 * 1000
const _paneTailCache = new Map() // sessionId → { ts: number, text: string }
/*
 * Plain-text tail of a session's pane: last 25 lines, ANSI stripped.
 * Shared by isWorking's background-agent fallback and realTimeInfo.
 *
 * The 5s TTL cache exists because capture-pane is a blocking spawnSync.
 * /status polls every 2s and both callers used to spawn their own, so one
 * entry per session caps it at one spawn per 5s.
 *
 * Never throws: a failed or empty capture is cached as "" like any other
 * blank screen.
 */
function capturePaneTail(sessionId: string) {
  const now = Date.now()
  const cached = _paneTailCache.get(sessionId)
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
      text = pane.stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    }
  } catch { /* best-effort: a failure returns "" */ }
  _paneTailCache.set(sessionId, { ts: now, text })
  return text
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
function claudePaneStillBusy(sessionId: string) {
  let text = ''
  try {
    const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-S', '-25'])
    if (pane.status === 0 && pane.stdout) {
      text = pane.stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    }
  } catch { /* best-effort: a failure means not busy, no escalation */ }
  if (!text) return false
  // 任一忙锚点命中即仍在跑，都不命中说明已空闲
  // Either anchor hit means running, neither means back to idle
  return CLAUDE_STATUS_LINE_RE.test(text) || CLAUDE_BG_AGENTS_WAITING_RE.test(text)
}

/*
 * Whether the claude TUI is stuck on the dangerous-operation permission
 * box, and which command it warns about: { pending, warning }, warning
 * being the full "Dangerous <kind> operation on <reason>: <target>" line,
 * or null.
 *
 * All three traits must be on screen at once (the danger line, "Do you
 * want to proceed?" and "Esc to cancel"), so a stale danger sentence left
 * in the scrollback, or printed by ordinary output, cannot fake a dialog.
 */
function detectDangerPermission(text: string) {
  if (!text) return { pending: false, warning: null }
  const m = text.match(CLAUDE_DANGER_OPERATION_RE)
  // 没有危险命令行就不是这个框
  // No danger line means this is not that dialog
  if (!m) return { pending: false, warning: null }
  // 三个特征必须同时在屏，缺一个就不认
  // All three traits must be on screen at once, one missing means no dialog
  if (!/Do you want to proceed\?/.test(text) || !/Esc to cancel/.test(text)) {
    return { pending: false, warning: null }
  }
  // 返回整行警告，自愈提示词要原样引用它
  // Return the whole warning line, the heal quotes it back verbatim
  return { pending: true, warning: m[0].trim() }
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
function listWindowsRowsCached() {
  const now = Date.now()
  if (_listWindowsCache && now - _listWindowsCache.ts < LIST_WINDOWS_TTL_MS) {
    return _listWindowsCache.rows
  }
  const r = tmux(['list-windows', '-t', HUB, '-F', '#{window_name}|#{pane_pid}|#{window_index}|#{window_activity}|#{pane_dead}|#{pane_current_command}'])
  // tmux失败也缓存空表，避免轮询里反复失败
  // A failed tmux caches an empty list, so polls do not repeat the failure
  const rows = r.status === 0
    ? r.stdout.trim().split('\n').filter(Boolean).map((l: string) => l.split('|'))
    : []
  _listWindowsCache = { ts: now, rows }
  return rows
}

/*
 * Map a cwd to the directory name claude uses under ~/.claude/projects/:
 * every character outside [a-zA-Z0-9] becomes '-', so the mapping is lossy
 * and the name cannot be turned back into a path.
 * e.g. /home/u/cc-workspace/foo_bar → -home-u-cc-workspace-foo-bar
 */
function encodeCwd(cwd: string) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/*
 * Absolute path of the transcript claude writes for one session:
 * ~/.claude/projects/<encoded cwd>/<claude session uuid>.jsonl.
 * Derived, never probed: callers run fs.existsSync themselves when they
 * must know whether the file is there (a resume whose jsonl is missing
 * degrades to a fresh session, see _spawnWindow).
 */
function jsonlPathOf(cwd: string, claudeSessionId: string) {
  return path.join(HOME, '.claude', 'projects', encodeCwd(cwd), `${claudeSessionId}.jsonl`)
}

/*
 * Quote one value for the bash -lc command line, escaping embedded single
 * quotes the '\'' way (close quote, escaped quote, reopen).
 * Needed because the claude arguments are joined into a single shell
 * string: a model id or a path with a space would otherwise split into two
 * arguments.
 */
function shellQuote(s: string) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/*
 * Normalize the legacy per-session useProxy flag, which arrives from json:
 * a boolean, 0/1, or the strings "0" / "1" / "false" / "true".
 * Anything unrecognized (null, undefined, a stray object) takes the
 * caller's fallback rather than false: in that older data an absent field
 * meant "not configured", not "off".
 */
function normalizeUseProxy(value: unknown, fallback = true) {
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  return !!fallback
}

/*
 * Normalize the four proxy modes to 'direct' | 'env' | 'proxychains' |
 * 'env_proxychains'.
 *
 * The legacy booleans of rows written before modes existed keep their old
 * meaning: true → 'env_proxychains' (the old env + proxychains double
 * track), false/null → 'direct'. Anything unmapped takes the fallback, so
 * a bad value in a persisted row cannot silently select a proxy path.
 */
function normalizeProxyMode4(value: unknown, fallback = 'direct') {
  if (value === 'env' || value === 'proxychains' || value === 'env_proxychains') return value
  if (value === 'direct') return 'direct'
  if (value === true || value === 1 || value === '1' || value === 'true') return 'env_proxychains'
  if (value === false || value === 0 || value === '0' || value === 'false') return 'direct'
  return fallback
}

/*
 * The single decision point for a session's proxy settings: both dispatch
 * and spawn call it, which is what keeps forceNoProxy / useProxy /
 * proxyMode from ever contradicting each other within one session.
 *
 * forceNoProxy wins outright (mode 'direct'); otherwise the explicit
 * 4-value mode is used, and only a null mode falls back to the legacy
 * useProxy boolean (true → 'env_proxychains', false → 'direct').
 *
 * The returned useProxy is derived from the mode ('direct' ⇔ false) rather
 * than copied from the argument, and fallbackUseProxy supplies the legacy
 * value for an old persisted row that carries neither a mode nor a usable
 * flag.
 */
function resolveClaudeProxyMode(useProxy: boolean, forceNoProxy: boolean = false, fallbackUseProxy: boolean = false, proxyMode: string | null = null) {
  const forced = !!forceNoProxy
  // 强制直连时不再看任何模式，一律判为direct
  // A forced direct ignores every mode and resolves to 'direct'
  const mode = forced
    ? 'direct'
    : normalizeProxyMode4(proxyMode, normalizeUseProxy(useProxy, fallbackUseProxy) ? 'env_proxychains' : 'direct')
  return {
    forceNoProxy: forced,
    useProxy: mode !== 'direct',
    proxyMode: mode,
  }
}

/*
 * Which proxy dependencies the given mode is missing, as display strings
 * ("file: ...", "bin (PATH): ..."; [] when complete). env modes need the
 * env-var file, proxychains modes need the proxychains config (new name,
 * legacy proxy_claude.conf accepted) plus the binary on PATH.
 *
 * Returned rather than thrown so both callers can pick their own severity:
 * preflight warns (sessions on other modes still start),
 * assertProxyAvailable fails the spawn.
 */
function proxyPrereqMissing(mode = 'env_proxychains') {
  const missing: string[] = []
  // 只查该模式用到的依赖，没用到的不算缺失
  // Check only what the mode uses, unused deps are not missing
  const needEnv = mode === 'env' || mode === 'env_proxychains'
  const needChains = mode === 'proxychains' || mode === 'env_proxychains'
  if (needEnv && !fs.existsSync(resolveProxyEnvsFile())) missing.push(`file: ${resolveProxyEnvsFile()}`)
  if (needChains) {
    // 旧名配置仍算数，有一个在就算齐
    // The legacy conf name still counts, either file satisfies it
    if (!fs.existsSync(PROXY_CONF) && !fs.existsSync(path.join(HOME, 'proxy_claude.conf'))) missing.push(`file: ${PROXY_CONF}`)
    if (spawnSync('which', ['proxychains']).status !== 0) missing.push('bin (PATH): proxychains')
  }
  return missing
}

/*
 * Throwing wrapper around proxyPrereqMissing for the spawn path: a session
 * configured to go through a proxy must never quietly start up direct,
 * since that would leak the traffic the operator wanted routed, so a
 * missing dependency fails the spawn with the full list.
 * The message names the mode, so it stays clear which one was attempted.
 */
function assertProxyAvailable(mode = 'env_proxychains') {
  const missing = proxyPrereqMissing(mode)
  if (missing.length) throw new Error(`代理依赖缺失 (${mode}): ${missing.join(', ')}`)
}

/*
 * Read the launch fields this backend needs out of a dispatch: model,
 * settingsPath and the proxy trio, plus captureStream. The flat legacy
 * fields (opts.model, opts.useProxy, ...) are only a compatibility
 * fallback for callers that never went through the model registry;
 * modelLaunchOptions wins when it is present.
 *
 * Absent values stay null / false / 'direct' rather than being invented,
 * so the callers, which prefer their persisted runtime row, can tell "not
 * given" from "given as X". Keep useProxy and proxyMode in step: a forced
 * direct pins both.
 */
function unpackLaunch(opts: ClaudeDispatchOpts): { model: string | null; settingsPath: string | null; useProxy: boolean; proxyMode: string; forceNoProxy: boolean; captureStream: boolean } {
  const launch = (opts?.modelLaunchOptions || {}) as Record<string, any>
  // 布尔字段要求严格为true，字符串不算
  // The booleans need a strict true, a string "true" does not count
  return {
    model: launch.model || opts.model || null,
    settingsPath: launch.settingsPath || opts.settingsPath || null,
    useProxy: launch.forceNoProxy ? false : (launch.useProxy === true || opts.useProxy === true),
    proxyMode: launch.forceNoProxy ? 'direct' : (launch.proxyMode || opts.proxyMode || 'direct'),
    forceNoProxy: launch.forceNoProxy === true || opts.forceNoProxy === true,
    captureStream: launch.captureStream === true,
  }
}

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

/*
 * Last 10 chars of the prompt once all whitespace is stripped, or null when
 * nothing is left.
 *
 * Taking the tail of the *whitespace-stripped* text rather than the literal
 * tail is what makes the probe survive the TUI's own line wrapping: the pane
 * is stripped the same way before comparing, so a marker split across two
 * screen rows still matches. It also means a CJK tail works, which the
 * earlier printable-ASCII-only version could not handle at all.
 */
function findPasteMarker(text: string) {
  // 去掉所有空白再取尾部，面板侧也会同样处理
  // Strip all whitespace first, the pane side is stripped the same way
  const compact = String(text ?? '').replace(/\s+/g, '')
  // 全空白的提示词没有可比对的探针，返回null
  // An all-whitespace prompt leaves nothing to match, return null
  return compact ? compact.slice(-10) : null
}

/*
 * Promise-based pause, the only sleep idiom this backend uses: the async
 * paths (ready poll, paste probe, submit-echo gaps) must not block node's
 * event loop the way a spawnSync('sleep') would — every session shares
 * that loop with the HTTP server, so a blocking sleep freezes them all.
 */
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/*
 * Pick how the very first context prompt is delivered into a freshly spawned Claude Code TUI:
 * a greeting first, straight in, or after a settle delay. A TUI that is still starting up can
 * drop input that arrives before it is ready to accept it, so the two warm-up variants buy it
 * time — and something harmless to render — before the real context lands. Which variant is
 * actually needed was never pinned down, so sessions are split evenly across all three and the
 * log line records the one that ran.
 */
function pickInitialContextPlan() {
  const roll = Math.random()
  // 两个阈值把随机数均分成三档，不是随手取的分数
  // The two thresholds split the roll into equal thirds, not arbitrary fractions
  if (roll < 1 / 3) return 'greeting_then_context'
  if (roll < 2 / 3) return 'direct_context'
  return 'delay_then_context'
}

/*
 * Pick one of the fixed short greetings used by the greeting_then_context plan. The greeting is
 * only a warm-up nudge that gets the TUI to render and accept input before the real context
 * lands, so a tiny pool is enough — the text itself carries no meaning.
 */
function pickInitialContextGreeting() {
  const index = Math.floor(Math.random() * INITIAL_CONTEXT_GREETING_CHOICES.length)
  return INITIAL_CONTEXT_GREETING_CHOICES[index]
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
// ── getPendingRequests helpers: parse "enqueued but unconsumed" requests out of Claude
// Code's in-memory queue ───────────────────────────────────
// Guide (issue_knowledge/d1600424): enqueue = enqueued; the same request later appearing as
// type:user (consumed directly while idle) or attachment.type:queued_command (injected mid-turn
// while busy) = consumed, no longer pending. dequeue/remove carry no content and cannot serve as a
// "delivered" ACK, so they never decide it.

/*
 * Normalize request text into a comparison-stable form: collapse every whitespace run to a single
 * space and trim the ends. Claude Code rewrites a prompt when it persists it to the jsonl
 * transcript (re-wrapping lines, adding indentation), so the text read back never matches the
 * bytes we sent — comparing the normalized forms is what makes "same request" decidable at all.
 */
function normalizeRequestText(value: unknown) {
  // 非字符串一律当空，防止畸形条目抛出
  // Anything that is not a string becomes empty, so malformed entries cannot throw
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/*
 * Pull the request text out of a jsonl entry that proves a queued request was consumed, so it can
 * be matched against the queue. Only two entry shapes carry the text: type:user (the request was
 * typed while the agent sat idle) and attachment.type:queued_command (it was injected mid-turn
 * while the agent was busy). Everything else returns '' and is read as "no evidence".
 */
function consumedRequestSignature(entry: any) {
  // 非法输入没有内容可提取
  // A non-object entry has no content to extract
  if (!entry || typeof entry !== 'object') return ''
  if (entry.type === 'user') {
    const c = entry.message?.content
    if (typeof c === 'string') return normalizeRequestText(c)
    if (Array.isArray(c)) {
      // 内容块数组里只有 text 块含请求文本，其余块类型忽略
      // Only text blocks carry the request; other block types are ignored
      const text = c
        .filter((b) => b && typeof b === 'object' && b.type === 'text')
        .map((b) => b.text || '')
        .join('\n')
      return normalizeRequestText(text)
    }
    // 是 user 条目但没有可用 content，同样不算证据
    // A user entry with no usable content proves nothing either
    return ''
  }
  if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
    const a = entry.attachment
    // 三种字段名任一存在即可，兼容不同的写入形状
    // Any one of the three field names may appear; tolerate all write shapes
    return normalizeRequestText(a.content || a.text || a.command || '')
  }
  return ''
}

/*
 * Decide whether a queued request and a consumed entry are the same request: identical full
 * signatures, or one signature fully containing the other (an agent may wrap the prompt it
 * echoes back). Matching on full text instead of a prefix fingerprint is deliberate — many mobius
 * prompts open with the same boilerplate, so prefix matching would collapse distinct tasks into
 * one another and drop live requests.
 */
function isSameQueuedRequest(sigA: string, sigB: string) {
  // 空签名表示"无证据"，不参与相等判断
  // An empty signature means "no evidence" and never counts as a match
  if (!sigA || !sigB) return false
  if (sigA === sigB) return true
  // 包含关系在短签名上极易误判，容器一侧必须够长
  // Containment is unreliable on short signatures; the container side must be long enough
  if (sigA.length >= 40 && sigB.includes(sigA)) return true
  if (sigB.length >= 40 && sigA.includes(sigB)) return true
  return false
}

/*
 * Resolve the aimux binary that gets spawned as a stdio MCP server for desktop/TUI sessions which
 * opted into add_remote_aimux_mcp: an explicit AIMUX_BIN wins, then the user-local install, then
 * the repo's own .venv-aimux, and finally the bare name so PATH gets a chance. Mirrors the sibling
 * tmux-codex.ts and backend/services/aimux-remote.ts AIMUX_BIN_CANDIDATES list, kept inline rather
 * than imported to avoid crossing the .js/.ts boundary from this CommonJS backend. The probe only
 * checks existence, so a stale non-executable file at a preferred location still shadows a working
 * binary further down the list.
 */
function resolveAimuxBin() {
  const candidates = [
    process.env.AIMUX_BIN,
    path.join(os.homedir(), '.local', 'bin', 'aimux'),
    path.join(__dirname, '..', '..', '.venv-aimux', 'bin', 'aimux'),
  ]
  // 取第一个存在的候选，都没有则退回裸名字
  // Take the first existing candidate, else fall back to the bare name
  for (const c of candidates) { if (c && fs.existsSync(c)) return c }
  return 'aimux'
}

/*
 * Build the guling live-trading MCP (HTTP / streamable-http) server entry from env, so the Xiaomo
 * assistant session can read funds/positions (mcp__guling__position / balance) directly without
 * going through Hermes. The bearer token is a credential and must live in .env
 * (MOBIUS_GULING_MCP_URL / MOBIUS_GULING_MCP_TOKEN), never in source. The returned
 * { type:'http', url, headers } object drops straight into the per-session --mcp-config
 * mcpServers; null makes the caller's injection a no-op.
 */
function resolveGulingMcp() {
  // 先补空串再 trim，纯空白的环境变量也算未配置
  // Default to empty before trimming, so a whitespace-only value counts as unset
  const url = (process.env.MOBIUS_GULING_MCP_URL || '').trim()
  const token = (process.env.MOBIUS_GULING_MCP_TOKEN || '').trim()
  // URL 和 token 缺一不可，不做半配置调用
  // Both halves are required — no anonymous or half-configured call
  if (!url || !token) return null
  return { type: 'http', url, headers: { Authorization: `Bearer ${token}` } }
}


// Runtime entry: the live state of one tmux window + claude TUI per mobius session.
interface ClaudeRuntimeEntry {
  agentSessionId: string
  cwd: string
  flagRoot: string
  model: string | null
  useProxy: boolean
  proxyMode?: string
  settingsPath: string | null
  withProxyPath?: string | null
  captureStream?: boolean
  forceNoProxy: boolean
  displayName: string | null
  jsonlPath: string
  startedAt: number
  watch: { stop?: () => void } | null
}

// dispatch contract: the arg shape shared by createNewSession / queue / pause (whole
// modelLaunchOptions plus the legacy flat fields).
interface ClaudeDispatchOpts {
  sessionId: string
  prompt?: string
  initialPrompt?: string
  cwd?: string
  flagRoot?: string
  displayName?: string
  agentSessionId?: string | null
  isInitialContextPrompt?: boolean
  mobiusPromptRecord?: MobiusPromptRecord | null
  suppressRunningFlag?: boolean
  urgent?: boolean
  aimuxRemoteName?: string
  enableGulingMcp?: boolean
  modelLaunchOptions?: Record<string, unknown>
  model?: string | null
  useProxy?: boolean
  proxyMode?: string
  settingsPath?: string | null
  forceNoProxy?: boolean
  [key: string]: unknown
}

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
      await new Promise((r) => setTimeout(r, 250))
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
   * jsonl is scanned backwards for the nearest record that says anything about the turn.
   *
   * The scan is a whitelist, deliberately not "skip the types we know are noise": only
   *   - assistant — no stop_reason or 'tool_use' still running; end_turn / max_tokens /
   *     stop_sequence done
   *   - user — a human turn arrived and has not been answered yet
   *   - system — only init / hook_started / hook_response, i.e. a turn is starting
   * decide the state, and every other type (attachment, last-prompt, custom-title, permission-mode,
   * file-history-snapshot, queue-operation, plus whatever metadata the TUI or gateway adds later) is
   * ignored, so a new metadata type can no longer break the check.
   *
   * One trap inside the user case: /compact is bookkeeping written as synthetic user records, so its
   * completion receipt must be read as an end_turn (see isCompactCompletionUserEvent) or an idle TUI
   * stays "working" forever.
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
    let lines
    try {
      if (!fs.existsSync(entry.jsonlPath)) return false
      const stat = fs.statSync(entry.jsonlPath)
      if (stat.size === 0) return false
      // 只读尾部256KB，首行被截断就靠解析跳过
      // Only the tail 256KB; a cut first line is skipped by the parse
      const len = Math.min(stat.size, CLAUDE_WORKING_TAIL_BYTES)
      const buf = Buffer.alloc(len)
      const fd = fs.openSync(entry.jsonlPath, 'r')
      try { fs.readSync(fd, buf, 0, len, stat.size - len) } finally { fs.closeSync(fd) }
      lines = buf.toString('utf8').split('\n').filter(Boolean)
    } catch { return false }

    // 自下往上扫，最近的一条白名单记录才代表当前状态
    // Scan bottom-up, the nearest whitelisted record is the current state
    for (let i = lines.length - 1; i >= 0; i--) {
      let e
      try { e = JSON.parse(lines[i]) } catch { continue }
      if (e.type === 'assistant') {
        // 缺stop_reason或tool_use即未结束
        // Missing stop_reason or tool_use means still running
        const sr = e.message?.stop_reason
        return !sr || sr === 'tool_use'
      }
      if (e.type === 'user') {
        // compact完成回执要当作结束
        // The compact completion receipt counts as an end
        if (isCompactCompletionUserEvent(e)) return false
        return true
      }
      if (e.type === 'system') {
        const sub = e.subtype
        // 只认这三个子类型，其余一律跳过
        // Only these three subtypes count, every other is skipped
        if (sub === 'init' || sub === 'hook_started' || sub === 'hook_response') return true
      }
    }
    // jsonl看似结束，但可能仍在等后台子agent
    // The jsonl looks finished, but background agents may still run
    // 故回退看面板的等待提示，命中仍算工作中
    // So fall back to the pane's waiting line, a hit still counts
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
   * The judgement is a pairing: an enqueue is pending unless an entry that carries the same text
   * later in the file proves consumption — type:user (typed while the agent sat idle) or
   * attachment.type:queued_command (injected mid-turn). dequeue / remove entries carry no text, so
   * they cannot serve as a delivered-ACK and never decide it. Text is compared whitespace-normalized,
   * because claude rewrites a prompt when it persists it and the bytes we sent never come back
   * verbatim.
   *
   * Performance: read only the trailing CLAUDE_WORKING_TAIL_BYTES and parse only the nearest
   * MAX_PENDING_SCAN_ENTRIES entries, so a 100MB jsonl costs the same as a small one. The scan runs
   * backwards because pending requests sit at the tail and a consumption always follows its enqueue:
   * an in-window consumption is therefore already recorded before its enqueue is examined, and a
   * consumed request can never be misread as pending. Truncation can at worst hide a deeply buried
   * pending one, which is accepted as best-effort.
   *
   * Matching is safe from send-mirror pollution: the mobius decoration entries live in
   * .mobius.jsonl, not in this native transcript.
   */
  getPendingRequests(sessionId: string) {
    const jsonlPath = this._resolveJsonlPath(sessionId)
    if (!jsonlPath) return []
    let tailLines
    try {
      if (!fs.existsSync(jsonlPath)) return []
      const stat = fs.statSync(jsonlPath)
      if (stat.size === 0) return []
      const len = Math.min(stat.size, CLAUDE_WORKING_TAIL_BYTES)
      const buf = Buffer.alloc(len)
      const fd = fs.openSync(jsonlPath, 'r')
      try { fs.readSync(fd, buf, 0, len, stat.size - len) } finally { fs.closeSync(fd) }
      tailLines = buf.toString('utf8').split('\n').filter(Boolean)
    } catch { return [] }

    const recent = tailLines.slice(-MAX_PENDING_SCAN_ENTRIES)
    const consumedSigs: any[] = []
    const pending: any[] = []
    for (let i = recent.length - 1; i >= 0; i--) {
      let e
      try { e = JSON.parse(recent[i]) } catch { continue }
      if (!e || typeof e !== 'object') continue

      // 先收消费证据，倒序里它排在对应enqueue之前
      // Collect consumption first: it precedes its enqueue in reverse
      const consumedSig = consumedRequestSignature(e)
      if (consumedSig) { consumedSigs.push(consumedSig); continue }

      if (e.type === 'queue-operation' && e.operation === 'enqueue') {
        const content = typeof e.content === 'string' ? e.content : null
        if (!content) continue
        const sig = normalizeRequestText(content)
        if (!consumedSigs.some((cs) => isSameQueuedRequest(sig, cs))) {
          pending.push({ content, enqueuedAt: e.timestamp || null })
        }
      }
    }
    // 倒序收集，翻回入队顺序（最早排队的在前）
    // Collected in reverse, flip back to enqueue order (oldest pending first)
    pending.reverse()
    return pending
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
    const st = _dangerHealState.get(sessionId) || { healing: false, lastWarning: '', lastTs: 0 }
    const now = Date.now()
    // 已经在自愈中，不重复触发
    // Already healing, do not trigger a second time
    if (st.healing) return
    // 同一条警告在冷却期内也忽略，避免刷屏
    // The same warning stays ignored during the cooldown
    if (warning === st.lastWarning && now - st.lastTs < DANGER_HEAL_COOLDOWN_MS) return
    _dangerHealState.set(sessionId, { healing: true, lastWarning: warning, lastTs: now })
    this._healDangerPermission(sessionId, warning)
      .catch((e) => log(`[tmux-claude-code] danger heal 失败 session=${sessionId}: ${e?.message || e}`))
      .finally(() => {
        const cur = _dangerHealState.get(sessionId)
        if (cur) _dangerHealState.set(sessionId, { ...cur, healing: false })
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
    _paneTailCache.delete(sessionId)
    log(`[tmux-claude-code] danger permission 检测到, 已 Esc 取消 (session=${sessionId}): ${warning}`)
    await new Promise((r) => setTimeout(r, 5000))
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
    const pendingInputs = this.getPendingRequests(sessionId).map((item: any) => typeof item === 'string' ? item : item?.content).filter((item): item is string => typeof item === 'string')
    return getHistorySnapshot(sessionId, this._resolveJsonlPath(sessionId), this.containDequeueEvent.bind(this), pendingInputs) as HistorySnapshot
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
   * Subscribe to the raw stream: the base EventEmitter fed by this backend's watcher.
   * Backfill is the history store's job now, so there is no fromSentinel resume semantics any
   * more; this override only forwards to the base.
   */
  getAgentRawThoughtStream(sessionId: string, listener: (raw: unknown) => void, opts: QueryOpts = {}) {
    // 直接转发给基类，行为与基类完全一致
    // Forward straight to the base, the behavior is identical
    return super.getAgentRawThoughtStream(sessionId, listener, opts)
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
        pendingInputs: this.getPendingRequests(sessionId).map((item: any) => typeof item === 'string' ? item : item?.content).filter((item): item is string => typeof item === 'string'),
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
    const { sessionId, cwd, flagRoot, displayName, initialPrompt, agentSessionId, isInitialContextPrompt = false, aimuxRemoteName, enableGulingMcp = false } = opts
    const { model, useProxy, proxyMode, settingsPath, forceNoProxy, captureStream } = unpackLaunch(opts)
    if (!sessionId || !cwd) throw new Error('createNewSession 需要 sessionId + cwd')
    if (!initialPrompt) throw new Error('createNewSession 需要 initialPrompt')
    if (!fs.existsSync(cwd)) throw new Error(`cwd 不存在: ${cwd}`)

    // 窗口还活着就复用，重启后不重复拉起
    // A live window is reused, so a restart never spawns a duplicate
    if (!windowExists(sessionId)) {
      await this._spawnWindow({ sessionId, cwd, flagRoot, model, useProxy, proxyMode, displayName, agentSessionId, settingsPath, captureStream, forceNoProxy, aimuxRemoteName, enableGulingMcp })
    } else {
      // 重启后窗口还在但runtime可能为空，补建一条
      // The window is live but may have no runtime row; rebuild one
      if (!this.runtime.has(sessionId) && agentSessionId) {
        const jp = jsonlPathOf(cwd, agentSessionId)
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
    await this._sendMaybeInitialContextPrompt(sessionId, initialPrompt, isInitialContextPrompt)
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
    const { sessionId, prompt, cwd, flagRoot, displayName, agentSessionId, isInitialContextPrompt = false, mobiusPromptRecord = null, suppressRunningFlag = false, aimuxRemoteName, enableGulingMcp = false } = opts
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
        enableGulingMcp,
      })
    }
    await this._sendMaybeInitialContextPrompt(sessionId, prompt, isInitialContextPrompt)
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
        await new Promise(r => setTimeout(r, 250))
        // 旧输入可能回到输入框，先Alt+Enter分隔
        // Old input can return to the box; Alt+Enter keeps it separate
        tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'M-Enter'])
        await new Promise(r => setTimeout(r, 80))
      } else {
        // /stop连发3次C-c，TUI会吞掉其中一次
        // /stop fires 3 C-c; the TUI swallows one of them
        for (let i = 0; i < 3; i++) {
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'C-c'])
          if (i < 2) await new Promise(r => setTimeout(r, 50))
        }
        // 等TUI消化这次打断
        // Give the TUI a moment to digest the interrupt
        await new Promise(r => setTimeout(r, 300))
        // 停不掉就kill-window硬停，保证生效
        // Escalate to kill-window so /stop always stops the agent
        // 只有空提示词的软停走这里，带新提示词不杀窗口
        // Only the empty-prompt soft stop escalates; a new prompt keeps the window
        // 二次确认加700ms等待，避免误杀已软停的窗口
        // Double confirmation with a 700ms wait avoids killing a soft-stopped window
        if (!prompt) {
          _paneTailCache.delete(sessionId)
          if (claudePaneStillBusy(sessionId)) {
            await new Promise(r => setTimeout(r, 700))
            _paneTailCache.delete(sessionId)
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
    this.runtime.delete(sessionId)
    this._forgetPersisted(sessionId)
    if (wasAlive) {
      tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
      log(`[tmux-claude-code] terminate: killed window=${sessionId} (wasWorking=${wasWorking})`)
    }
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
   * The launch command is a bash -lc chain of fragments joined with &&, so a failing step stops the
   * exec. The optional env-proxy sourcing comes first, then the always-on bits (clear the VS Code IPC
   * env so the CLI cannot attach to a host IDE, IS_SANDBOX, CLAUDE_CODE_EAGER_FLUSH so the transcript
   * flushes at turn checkpoints), then the exec itself. The proxy tier picks the exec shape: direct /
   * env exec claude bare, proxychains / env_proxychains wrap it in proxychains. --settings is passed
   * in both branches on purpose — the proxied one once omitted it, silently dropping a session's
   * settings file (channel/key/permissions/withproxy.json) back to the global default.
   *
   * Resume is opportunistic: an agentSessionId whose jsonl is not visible under this cwd is warned
   * about and degraded to a fresh session, because an old SDK-chain transcript may live elsewhere.
   * Otherwise --resume reuses that id, while a new session binds a fresh uuid via --session-id.
   *
   * new-window returns before the TUI has drawn, so the spawn then polls the pane until the ready
   * sentinel (the footer "bypass permissions on") shows. While waiting it auto-confirms every dialog
   * that would otherwise block startup forever: the folder-trust box, the first-run onboarding pages,
   * the custom-API-key question and the bypass-permissions warning. Each keeps its own sentinel set
   * and rate-limited key press, because send-keys is occasionally swallowed and the same dialog may
   * need a second press. A TUI that never becomes ready has its window killed rather than left
   * behind, and the timeout is thrown with the cwd.
   */
  async _spawnWindow({ sessionId, cwd, flagRoot, model, useProxy, proxyMode: proxyModeArg, displayName, agentSessionId, settingsPath, captureStream = false, forceNoProxy = false, aimuxRemoteName, enableGulingMcp = false }: ClaudeDispatchOpts) {
    // 入参可为null，此处归一为非空，兜底在调用方
    // Nullable args become non-null here; the persisted fallback is the caller's
    if (!sessionId || !cwd) throw new Error('_spawnWindow 需要 sessionId + cwd')
    const finalDisplayName = displayName || null
    const finalAgentSid = agentSessionId || null
    const finalFlagRoot = flagRoot || cwd
    // 确保承载所有agent窗口的hub会话存在
    // Make sure the hub session hosting every agent window exists
    ensureHub()
    // 运行标记默认落在cwd，调用方给的flagRoot(仓库根)优先
    // The flag defaults to cwd; a caller-given flagRoot (repo root) wins
    const effFlagRoot = finalFlagRoot
    // settingsPath转成绝对路径，后面的bash命令不受cwd影响
    // Resolve settingsPath absolute so later bash commands stay cwd-independent
    let finalSettingsPath = settingsPath ? path.resolve(settingsPath) : null
    // 数字雨模式在启动时就生成带sessionId/agent的withproxy文件
    // Digital-rain mode writes the per-session withproxy file right at spawn
    let withProxyPath: string | null = null
    if (captureStream && finalSettingsPath) {
      try {
        withProxyPath = ensureSessionWithProxy(finalSettingsPath, { sessionId, agent: finalDisplayName })
        finalSettingsPath = withProxyPath
      } catch (e: any) {
        // 生成失败只告警，回落原settings，别拦下整个启动
        // A failed withproxy only warns and falls back, it must not block the spawn
        console.warn(`[tmux-claude-code] per-session withproxy 生成失败, 回落原 settings (${sessionId}): ${e?.message || e}`)
        withProxyPath = null
      }
    }
    // settings文件缺失直接报错，避免悄悄用默认配置启动
    // A missing settings file is fatal, never silently start on the default config
    if (finalSettingsPath && !fs.existsSync(finalSettingsPath)) {
      throw new Error(`Claude Code settings 文件不存在: ${finalSettingsPath}`)
    }
    // 代理档位与settings互相独立，代理分支一样要传--settings
    // Proxy tier and settings are independent; the proxy branch passes settings too
    const proxyMode = resolveClaudeProxyMode(!!useProxy, !!forceNoProxy, false, proxyModeArg ?? null)
    const finalForceNoProxy = proxyMode.forceNoProxy
    const finalUseProxy = proxyMode.useProxy
    const finalProxyMode = proxyMode.proxyMode
    // 走代理先查该档依赖，缺依赖直接失败不静默直连
    // A proxied spawn checks its tier's deps and fails, never goes direct
    if (finalUseProxy) assertProxyAvailable(finalProxyMode)

    // 有agentSessionId说明调用方要恢复旧会话
    // A non-null agentSessionId means the caller wants to resume an old session
    let useResume = !!finalAgentSid
    // 旧SDK链路的jsonl可能不在本cwd下，恢复前先核实
    // An old SDK-chain jsonl may sit outside this cwd, so verify before resuming
    if (useResume && finalAgentSid && !fs.existsSync(jsonlPathOf(cwd, finalAgentSid))) {
      // jsonl不在就告警降级为新会话，恢复不可信
      // A missing jsonl warns and degrades to a new session, resume is untrustworthy
      console.warn(`[tmux-claude-code] resume target jsonl 不存在 (${agentSessionId}), fallback 为新 session`)
      // 关掉恢复分支，下面会生成新的claude会话id
      // Turn resume off; a fresh claude session id is generated below
      useResume = false
    }
    // 恢复沿用旧id，新会话生成新uuid
    // Resume reuses the old id, a new session gets a fresh uuid
    const claudeSessionId = useResume ? finalAgentSid! : crypto.randomUUID()

    // 常禁这三个工具，agent才不会停下来等人或卡在plan模式
    // Always ban these three so the agent never waits on a human or plan mode
    const disallowedTools = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']

    // 注入的MCP按会话各写一个配置文件，不加--strict-mcp-config
    // MCP servers are injected via one config file per session, not strict mode
    // 这样传入的server算已信任，不会再弹.mcp.json信任框
    // Servers passed this way count as trusted, so no .mcp.json dialog appears
    const mcpServers: Record<string, any> = {}
    // 给TUI会话注入aimux远程MCP，让claude驱动远端机器
    // TUI sessions get the aimux remote MCP server injected
    if (aimuxRemoteName) {
      mcpServers.aimux = { command: resolveAimuxBin(), args: ['mcp', 'serve', '--remote', aimuxRemoteName] }
    }
    // 小莫会话注入guling实盘MCP，直接读资金和持仓
    // Xiaomo sessions get the guling trading MCP to read funds and positions
    // token只从env取，没配就返回null跳过注入
    // The token comes from env only; unset means no injection
    if (enableGulingMcp) {
      const guling = resolveGulingMcp()
      if (guling) {
        mcpServers.guling = guling
        // 只禁实盘下单工具，读类查询保留，AI无法真下单
        // Only the order-placing tools are banned, so the AI cannot trade for real
        disallowedTools.push('mcp__guling__buy', 'mcp__guling__sell', 'mcp__guling__cancel', 'mcp__guling__switch_account')
      }
    }

    // 拼接交给claude CLI的参数表
    // Assemble the argument list handed to the claude CLI
    const claudeArgs = [
      // 跳过权限询问，后台agent才能自主干活
      // Skip permission prompts so the background agent can act on its own
      `--dangerously-skip-permissions`,
      `--disallowedTools ${disallowedTools.join(',')}`,
      // 恢复用--resume，新会话用--session-id绑一个固定id
      // --resume for a resume, --session-id to bind a fresh session
      useResume ? `--resume ${claudeSessionId}` : `--session-id ${claudeSessionId}`,
    ]
    // 调用方指定了model才追加--model，值做shell转义
    // Append a shell-quoted --model only when the caller pinned one
    if (model) claudeArgs.push(`--model ${shellQuote(model)}`)
    // 有MCP要注入就写会话级配置文件，再用--mcp-config传进去
    // With MCP servers to inject, write the per-session config and pass it in
    if (Object.keys(mcpServers).length > 0) {
      const mcpConfigPath = path.join(os.tmpdir(), `mobius-mcp-${sessionId}-${crypto.randomUUID().slice(0, 8)}.json`)
      fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }))
      claudeArgs.push(`--mcp-config ${shellQuote(mcpConfigPath)}`)
    }
    // 优先调用方给的settings文件，否则用Mobius默认settings
    // Prefer the caller's settings file, else the Mobius default settings
    const settingsArg = finalSettingsPath
      ? `--settings ${shellQuote(finalSettingsPath)}`
      : `--settings "$HOME/.claude/mobiusdefault.settings.json"`

    // bash -lc链的片段，null项在下面被过滤掉
    // Fragments of the bash -lc chain; null entries are filtered out below
    const cmd = [
      // env档位才加载环境变量代理，新文件名优先旧.bash兜底
      // Only the env tiers source the env proxy; new name first, legacy .bash second
      (finalProxyMode === 'env' || finalProxyMode === 'env_proxychains')
        ? `set -a && (source "$HOME/proxy_envs.conf" 2>/dev/null || source "$HOME/proxy_envs.bash") && set +a`
        : null,
      // 清掉VS Code的IPC环境变量，避免CLI误连宿主机IDE
      // Clear the VS Code IPC env so the CLI cannot attach to a host IDE
      `unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN`,
      // 标记进程跑在受控沙箱里
      // Mark the process as running in a controlled sandbox
      `export IS_SANDBOX=1`,
      // 每轮检查点就刷转录，原来是异步攒批约100ms
      // Flush the transcript at turn checkpoints instead of async batching
      `export CLAUDE_CODE_EAGER_FLUSH=1`,
      // 直连档直接exec，代理档套一层proxychains
      // direct/env exec bare, the proxychains tiers wrap the exec
      // 两分支都必带settingsArg，代理档曾漏传会静默回落全局配置
      // Both branches must pass settingsArg; the proxied one once dropped it
      (finalProxyMode === 'proxychains' || finalProxyMode === 'env_proxychains')
        ? `exec proxychains -q -f "$HOME/proxychains_config_for_llm_models.conf" claude ${settingsArg} ${claudeArgs.join(' ')}`
        : `exec claude ${settingsArg} ${claudeArgs.join(' ')}`,
      // 丢掉空片段后用&&串联，任一步失败即中断整条链
      // Drop empty fragments and join with &&, so a failed step stops the chain
    ].filter(Boolean).join(' && ')

    // 预先写好目录信任，TUI就不会弹"trust this folder"
    // Pre-set the trust so the trust-folder dialog never shows up
    // 这一步失败由就绪轮询里的截屏自动确认兜底
    // A failure here falls back to the screenshot auto-confirm in the ready poll
    ensureProjectTrusted(cwd)

    // 在hub会话里建后台窗口，在cwd下跑bash -lc cmd
    // Create the background window in the hub, running bash -lc cmd in cwd
    const r = tmux(['new-window', '-d', '-t', HUB, '-n', sessionId, '-c', cwd, 'bash', '-lc', cmd])
    // 失败时带出stderr，便于定位命令级问题
    // Surface stderr on failure so command-level problems are diagnosable
    if (r.status !== 0) throw new Error(`tmux new-window 失败: ${r.stderr}`)
    log(`[tmux-claude-code] started: window=${sessionId} cwd=${cwd} claude_session=${claudeSessionId} proxy_mode=${finalProxyMode}${finalSettingsPath ? ` settings=${finalSettingsPath}` : ''}`)

    // 等TUI就绪：页脚出现"bypass permissions on"才算可用
    // Wait for TUI ready: the footer "bypass permissions on" must appear
    const deadline = Date.now() + READY_TIMEOUT_MS
    let ready = false
    // 四个时间戳分别给四类自动确认限流，避免刷屏
    // Four timestamps rate-limit the four auto-confirms so the TUI is not flooded
    let lastTrustPress = 0
    let lastOnboardingPress = 0
    let lastApiKeyPress = 0
    let lastBypassPress = 0
    const target = `${HUB}:${sessionId}`
    // 轮询面板到截止时间，每轮先查就绪再处理弹窗
    // Poll the pane until the deadline: readiness first, then the dialogs
    while (Date.now() < deadline) {
      // 截屏失败按空屏处理，下一轮重试
      // A failed capture counts as an empty screen, the next round retries
      const { text: screen } = take_tmux_window_text(target, 100)
      // 出现就绪锚点即结束等待
      // The ready sentinel ends the wait
      if (screen.includes(READY_SENTINEL)) { ready = true; break }
      // 信任框默认已选中"1. Yes"，直接回车即可确认
      // The trust box already highlights "1. Yes", so Enter confirms it
      if (TRUST_PROMPT_SENTINELS.some(s => screen.includes(s))) {
        const now = Date.now()
        // 限流重发，TUI偶尔吞掉send-keys，直到弹窗消失
        // Rate-limited re-send covers a swallowed send-keys until the box goes
        if (now - lastTrustPress > TRUST_PRESS_INTERVAL_MS) {
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
          lastTrustPress = now
          log(`[tmux-claude-code] window=${sessionId} 检测到目录信任对话框, 已自动确认信任 (cwd=${cwd})`)
        }
      }
      // 首次启动的引导页(选文本样式/欢迎屏)也按回车确认
      // First-run onboarding pages are confirmed with Enter too
      if (ONBOARDING_PROMPT_SENTINELS.some(s => screen.includes(s))) {
        const now = Date.now()
        if (now - lastOnboardingPress > ONBOARDING_PRESS_INTERVAL_MS) {
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
          lastOnboardingPress = now
          log(`[tmux-claude-code] window=${sessionId} 检测到首次启动引导对话框, 已自动确认`)
        }
      }
      // 自定义API Key弹窗按1选环境变量的key
      // The custom-API-key dialog: press 1 to use the env key
      if (API_KEY_PROMPT_SENTINELS.some(s => screen.includes(s))) {
        const now = Date.now()
        if (now - lastApiKeyPress > API_KEY_PRESS_INTERVAL_MS) {
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, '1'])
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
          lastApiKeyPress = now
          log(`[tmux-claude-code] window=${sessionId} 检测到 API Key 对话框, 已自动选择使用环境变量 Key`)
        }
      }
      // bypass警告默认1是退出，要按2再回车才接受
      // The bypass warning defaults to 1 = exit, so 2 + Enter accepts
      if (BYPASS_WARN_SENTINELS.some(s => screen.includes(s))) {
        const now = Date.now()
        if (now - lastBypassPress > BYPASS_WARN_INTERVAL_MS) {
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, '2'])
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
          lastBypassPress = now
          log(`[tmux-claude-code] window=${sessionId} 检测到 Bypass Permissions 警告, 已自动确认接受`)
        }
      }
      // 歇一个轮询间隔再看屏
      // Wait one poll interval, then look at the screen again
      await new Promise(r => setTimeout(r, READY_POLL_MS))
    }
    // 超时没就绪就杀掉刚建的窗口再抛出，不留废窗口
    // Not ready in time: kill the window just created and throw
    if (!ready) {
      tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
      throw new Error(`claude TUI 未在 ${READY_TIMEOUT_MS}ms 内 ready (cwd=${cwd}).`)
    }
    // TUI已可用
    // The TUI is usable
    log(`[tmux-claude-code] window=${sessionId} TUI ready`)

    // jsonl路径由cwd和claude会话id推导，不做探测
    // The jsonl path is derived from cwd and the claude session id
    const jp = jsonlPathOf(cwd, claudeSessionId)
    // 在内存里登记这个窗口的运行时状态
    // Register this window's runtime state in memory
    this.runtime.set(sessionId, {
      agentSessionId: claudeSessionId,
      cwd, flagRoot: effFlagRoot, model: model || null, useProxy: finalUseProxy, proxyMode: finalProxyMode,
      settingsPath: finalSettingsPath, withProxyPath, captureStream: !!captureStream, forceNoProxy: finalForceNoProxy, displayName: displayName || null,
      jsonlPath: jp, startedAt: Date.now(), watch: null,
    })
    // 同样的核心状态落盘，服务重启后能原样恢复
    // Persist the same core state so a service restart can restore it
    this._persistEntry(sessionId, {
      agentSessionId: claudeSessionId, cwd, flagRoot: effFlagRoot,
      model: model || null, useProxy: finalUseProxy,
      settingsPath: finalSettingsPath, withProxyPath, captureStream: !!captureStream, forceNoProxy: finalForceNoProxy, displayName: displayName || null,
      jsonlPath: jp, startedAt: Date.now(),
    })
    // 起jsonl监听，agent输出才能持续推给订阅方
    // Start the jsonl watcher so agent output keeps flowing to subscribers
    this._ensureWatcher(sessionId)

    // 建窗即打标记，每次提交刷新，agent完成后自删
    // Spawn drops the flag, every prompt refreshes it, the agent removes it
    // 标记锚在仓库根而非worktree里的cwd，重建不会误删
    // Rooted at the repo root, not the worktree cwd, so a rebuild cannot delete it
    markRunning(effFlagRoot, sessionId)
  }

  /*
   * Deliver a freshly spawned session's very first prompt. Only the initial context goes through the
   * warm-up split; every other call is a plain pass-through to _sendPromptToWindow.
   *
   * The split exists because a TUI that is still starting up can drop input that arrives before it
   * is ready to accept it, so two of the three plans buy it time — or give it something harmless to
   * render — before the real context lands: greeting first, context straight in, or context after the
   * settle delay. Which variant is actually needed was never pinned down, so sessions take one at
   * random and the chosen plan is logged.
   */
  async _sendMaybeInitialContextPrompt(sessionId: string, text: string, isInitialContextPrompt?: boolean) {
    // 不是首次上下文就直接发，不走预热分支
    // A non-initial prompt is sent straight, no warm-up branch
    if (!isInitialContextPrompt) {
      await this._sendPromptToWindow(sessionId, text)
      return
    }

    const plan = pickInitialContextPlan()
    if (plan === 'greeting_then_context') {
      const greeting = pickInitialContextGreeting()
      log(`[tmux-claude-code] initial context plan=${plan} greeting=${JSON.stringify(greeting)} delay_ms=${INITIAL_CONTEXT_DELAY_MS}`)
      // 先甩一句问候让TUI渲染起来并接受输入
      // Throw a greeting first so the TUI renders and accepts input
      await this._sendPromptToWindow(sessionId, greeting)
      // 等TUI稳定后再发真正的上下文
      // Give the TUI time to settle before the real context lands
      await sleep(INITIAL_CONTEXT_DELAY_MS)
      await this._sendPromptToWindow(sessionId, text)
      return
    }

    if (plan === 'delay_then_context') {
      log(`[tmux-claude-code] initial context plan=${plan} delay_ms=${INITIAL_CONTEXT_DELAY_MS}`)
      // 先干等一段让TUI起来，再发上下文
      // Wait out the startup before sending the context
      await sleep(INITIAL_CONTEXT_DELAY_MS)
      await this._sendPromptToWindow(sessionId, text)
      return
    }

    // 剩下的direct_context档不做预热，直接发
    // The remaining direct_context plan sends straight, no warm-up
    log(`[tmux-claude-code] initial context plan=${plan}`)
    await this._sendPromptToWindow(sessionId, text)
  }

  /*
   * Deliver a prompt into an already-running claude TUI window: stage the text in a tmux buffer,
   * paste it as one bracketed block, wait until the pane proves it landed, then press Enter.
   * Shared by the initial-context dispatch and the normal queue path; both call it only after
   * ensuring the window exists.
   *
   * The prompt never goes through argv (load-buffer reads stdin), so a long prompt cannot hit
   * ARG_MAX and its text never shows up in ps.
   *
   * Bracketed paste (-p) is mandatory: without it a \n inside the text is read as Return, so a
   * multi-line message submits early at the first newline and the rest plus the explicit Enter
   * become a second message (the root cause of multi-line splits). -p was removed historically
   * because the Enter after it was occasionally swallowed — the confirm-style re-send below is the
   * fix, which is why both stay.
   *
   * Note the two meanings of -p: bracketed paste for paste-buffer, print-to-stdout for capture-pane.
   *
   * The landing check accepts either the tail probe (findPasteMarker) or a collapsed-paste
   * placeholder: a big paste is rendered as "[Pasted text N lines]" instead of its own text, so
   * the probe could never match and the wait would always burn its full budget.
   */
  async _sendPromptToWindow(sessionId: string, text: string) {
    // 检查tmux窗口是否存在，不存在抛出错误
    // Check tmux window exist, if not, throw error
    if (!windowExists(sessionId)) {
      throw new Error(`window ${sessionId} 不存在`)
    }

    // 取提示词去掉空白后的最后10个字符作为探针，取不到为null
    // Take the last 10 whitespace-stripped chars of the prompt as probe, null if none
    const marker = findPasteMarker(text)
    // 记录窗口、长度和探针，探针可能含中文，加引号便于辨认
    // Log window, length and probe; quotes make a CJK probe easier to read
    log(`[tmux-claude-code] sendPrompt window=${sessionId} len=${text.length} marker=${marker ? JSON.stringify(marker) : '(none)'}`)

    // tmux buffer全局共享，用进程号加毫秒命名避免并发互撞
    // tmux buffers are server-global, name by pid and ms to avoid clashes
    const bufName = `imac_${process.pid}_${Date.now()}`
    // 末尾的-表示从stdin读，提示词不进命令行，避免超长和泄漏
    // Trailing - reads stdin, keeps the prompt out of argv and ps
    const r1 = tmux(['load-buffer', '-b', bufName, '-'], { input: text })
    // 装载buffer失败直接抛出
    // Throw when loading the buffer fails
    if (r1.status !== 0) throw new Error(`tmux load-buffer 失败: ${r1.stderr}`)

    // -p括号粘贴，-d粘贴成功后删buffer，-t指定目标窗口
    // -p bracketed paste, -d drops the buffer on success, -t targets the window
    const r2 = tmux(['paste-buffer', '-p', '-d', '-b', bufName, '-t', `${HUB}:${sessionId}`])
    if (r2.status !== 0) {
      // -d只在成功时生效，失败要手动清掉buffer
      // -d only fires on success, so clean the buffer by hand here
      tmux(['delete-buffer', '-b', bufName])
      throw new Error(`tmux paste-buffer 失败: ${r2.stderr}`)
    }

    // 记录等待起点，命中日志里要算耗时
    // Record the wait start, the hit log reports elapsed time
    const pasteWaitStartedAt = Date.now()

    // 轮询面板直到探针或折叠占位符出现，说明文字已渲染或已被折叠接收
    // Poll the pane until the probe or the collapsed-paste placeholder shows
    const deadline = pasteWaitStartedAt + PASTE_SLEEP_MAX_MS
    let saw = false
    let attempt = 0
    while (Date.now() < deadline) {
      // 每200ms截屏一次
      // Capture the pane every 200ms
      await new Promise(r => setTimeout(r, PASTE_PROBE_INTERVAL_MS))
      attempt += 1
      // 只截最后80行，够覆盖输入框且开销小
      // Only the last 80 lines, enough for the input box and cheap
      const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-S', '-80'])
      // 截屏失败也要记一笔，排查时能区分没粘上还是没截到
      // Log a failed capture too, so a miss can be told apart from a blank screen
      if (pane.status !== 0) {
        log(`[tmux-claude-code] paste poll window=${sessionId} attempt=${attempt} capture=failed`)
        continue
      }
      // 比对前去掉面板里的空格和换行，避免TUI折行导致匹配不上
      // Strip the pane's whitespace before comparing, so TUI wrapping cannot break the match
      const compactPane = pane.stdout.replace(/\s+/g, '')
      const hitMarker = !!marker && compactPane.includes(marker)
      const hitPlaceholder = PASTE_PLACEHOLDER_RE.test(pane.stdout)
      // 每次轮询都记录结果，命中与否都要能看到
      // Log every poll, hit or miss, so the whole match stays visible when debugging
      log(`[tmux-claude-code] paste poll window=${sessionId} attempt=${attempt} marker=${hitMarker} placeholder=${hitPlaceholder} elapsed=${Date.now() - pasteWaitStartedAt}ms`)
      if (hitMarker || hitPlaceholder) {
        saw = true
        break
      }
    }
    // 超时也照样发回车，不能把这一轮卡死
    // Send Enter anyway on timeout, do not strand the turn
    if (!saw) console.warn(`[tmux-claude-code] paste marker/placeholder did not appear within ${PASTE_SLEEP_MAX_MS}ms (attempts=${attempt}), Enter 仍发送`)

    // 提交回车：括号粘贴是原子的，多发几次不会拆开消息
    // Submit Enter: bracketed paste is atomic, extra sends never split it
    // 而TUI切换输入模式时会吞掉第一次，故重发N次幂等
    // The TUI's input-mode switch swallows the first one, so re-send N times
    for (let i = 0; i < SUBMIT_ENTER_ATTEMPTS; i++) {
      // 发送回车提交提示词
      // Send Enter to submit the prompt
      const r = tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
      // 回车都发不出去说明窗口有问题，直接抛出
      // A window that cannot take Enter will not recover, throw
      if (r.status !== 0) throw new Error(`tmux send-keys Enter 失败: ${r.stderr}`)
      // 最后一次不用再等
      // No wait after the last attempt
      if (i < SUBMIT_ENTER_ATTEMPTS - 1) await new Promise(r => setTimeout(r, SUBMIT_ENTER_INTERVAL_MS))
    }

    // 记录一次提示词投递，内部吞异常不影响投递
    // Record one prompt delivery, it swallows its own failures
    recordPromptPaste({ backendName: this.name, sessionId, contentLength: text.length })
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
