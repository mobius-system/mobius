/**
 * claude-code-utils/constants.ts — Fixed names, paths and timing knobs for the
 * Claude Code tmux backend.
 *
 * Everything here is a literal or a path derived once at load time. Anything
 * that needs a decision (which proxy file is in use, which dialogs to accept)
 * lives in the module that makes that decision.
 */
import os from 'os'
import path from 'path'

const { MOBIUS_DATA_PATH } = require('../../config')

// ── tmux hub + persisted state ──────────────────────────
export const HUB = 'imac_claude_code_agent_hub'
export const HOME = os.homedir()
// Env-var proxy config (formerly proxy_envs.bash): prefer the new name, fall back to the old file.
export const PROXY_ENVS_FILE = path.join(HOME, 'proxy_envs.conf')
export const PROXY_ENVS_FILE_LEGACY = path.join(HOME, 'proxy_envs.bash')
// Model proxychains config (formerly proxy_claude.conf); the legacy file is reused while it exists.
export const PROXY_CONF = path.join(HOME, 'proxychains_config_for_llm_models.conf')
export const RUNTIME_FILE = path.join(MOBIUS_DATA_PATH, 'hub-runtime.json')
// archive: one row per session ever started (sessionId → jsonlPath/agentSessionId/cwd...), kept past
// terminate, so getHistory still resolves a jsonl after an admin closes the window or a cleaner reaps it.
export const ARCHIVE_FILE = path.join(MOBIUS_DATA_PATH, 'hub-archive.json')
// User-level claude config; projects[absPath] holds the directory trust flag.
export const CLAUDE_CONFIG = path.join(HOME, '.claude.json')

// ── TUI startup ─────────────────────────────────────────
// claude TUI ready poll: watch for the footer "bypass permissions on" (present after the splash).
export const READY_POLL_MS = 250
export const READY_TIMEOUT_MS = 25000
export const READY_SENTINEL = 'bypass permissions on'

// First entry into a new directory raises claude's "trust this folder" dialog
// (--dangerously-skip-permissions does not skip it). The cwd is a platform-created workspace, so
// trusting it is fine; claude persists the trust for that directory. 2.1.296 flipped the default
// highlight to "No, exit", so the handler moves the cursor down when that option is highlighted.
export const TRUST_PROMPT_SENTINELS = [
  'trust this folder',
  'Is this a project you created or one you trust',
  'Do you trust the files',
]
export const TRUST_PRESS_INTERVAL_MS = 1500

// One-time first-run onboarding dialogs (text style, welcome screen) block TUI ready: auto-confirm with Enter.
export const ONBOARDING_PROMPT_SENTINELS = [
  'Choose the text style',
  'Let\'s get started',
  'Welcome to Claude Code',
]
export const ONBOARDING_PRESS_INTERVAL_MS = 1500

// "Detected a custom API key in your environment" dialog: claude sees the ANTHROPIC_API_KEY env var
// and asks whether to use it. Press "1" for Yes (use that key) to dismiss the dialog.
export const API_KEY_PROMPT_SENTINELS = [
  'Detected a custom API key in your environment',
  'Do you want to use this API key',
]
export const API_KEY_PRESS_INTERVAL_MS = 1500

// "WARNING: Claude Code running in Bypass Permissions mode" dialog: newer claude shows this one-time
// confirmation under --dangerously-skip-permissions. The highlighted option is "No, exit" (2.1.296
// dropped the numeric shortcuts too), so Down + Enter moves to "Yes, I accept" and accepts.
export const BYPASS_WARN_SENTINELS = [
  'WARNING: Claude Code running in Bypass Permissions mode',
  'Yes, I accept',
]
export const BYPASS_WARN_INTERVAL_MS = 1500

// "Try the new fullscreen renderer?" upsell (2.1.296): a one-time blocking prompt with
// "1. Yes, try it" / "2. Not now". Down + Enter picks "Not now" so the pane keeps the classic
// renderer that this agent's status-line and dialog parsing was built against.
export const FULLSCREEN_UPSELL_SENTINELS = [
  'Try the new fullscreen renderer',
]
export const FULLSCREEN_UPSELL_INTERVAL_MS = 1500

// ── Prompt delivery ─────────────────────────────────────
export const PASTE_PROBE_INTERVAL_MS = 200
export const PASTE_SLEEP_MAX_MS = 5000
// A paste past the TUI's collapse threshold is replaced on screen by a placeholder, so the prompt
// text never reaches the pane and the tail probe can never match. Claude Code renders
// "[Pasted text #2 +22 lines]"; codex renders "[Pasted Content N chars]" above its 1000-char
// threshold. Either form proves the paste landed, so the wait below accepts a placeholder hit.
export const PASTE_PLACEHOLDER_RE = /\[Pasted (?:Content \d+ chars|text\b[^\]]*)\]/
// Submit-Enter retry: the TUI's input-mode switch after bracketed paste (-p) occasionally swallows
// the first Enter. Re-send N times idempotently (paste is atomic so extra Enters never split the
// message; once submitted the box is empty and Enter is a no-op).
export const SUBMIT_ENTER_ATTEMPTS = 3
export const SUBMIT_ENTER_INTERVAL_MS = 500
export const INITIAL_CONTEXT_DELAY_MS = 5000
export const INITIAL_CONTEXT_GREETING_CHOICES = ['hello', 'greeting', 'are you there', 'good day']

// ── Status reading ──────────────────────────────────────
// list-windows result cache (status queries only).
// /status and the syncer poll every 2~5s; one /status calls list-windows 3 times (isAlive, isWorking
// with its inner isAlive, listSessions), all spawnSync and blocking Node's single event loop. Reusing
// the parsed rows within LIST_WINDOWS_TTL_MS (3s) cuts that to 0~1 spawnSync per /status, removing
// the "one slow tmux → event loop occupied → every request in that window queues" avalanche.
// Control flow (windowExists in create/terminate/pause/recovery) still queries live.
export const LIST_WINDOWS_TTL_MS = 3 * 1000

// isWorking's tail window over the transcript. Must dwarf a single record: claude-code's injected
// context user entry (🚁🍕 project+memory) and long assistant output reach 30KB+ on one line, so the
// old 16KB window held not even one — the first thinking phase's only user marker fell out, leaving
// metadata only (attachment/mode/permission-mode/ai-title...) → nothing matched → working falsely
// false, stuck "idle" for minutes until the first assistant record landed. 256KB clears the giant
// injection to reach the nearest user/assistant marker; read cost is negligible (plain file read, no tmux).
export const CLAUDE_WORKING_TAIL_BYTES = 256 * 1024

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
export const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

// Max entries getPendingRequests reverse-scans: pending requests always sit at the jsonl tail, so the
// last N entries suffice — the whole tail is never walked. Reverse scanning is truncation-safe (a
// consumption always follows its enqueue, i.e. is seen earlier in reverse → no false pending);
// truncation can only hide deeply buried old pending (best-effort).
export const MAX_PENDING_SCAN_ENTRIES = 20

// realTimeInfo: matches claude TUI's current status line. Core anchor = the parenthesized group that
// starts with elapsed "(<elapsed> · ...)", elapsed being Ns | Mm Ss | Hh Mm Ss. Two shapes:
//   - "(6m 36s · ↓ 20.0k tokens · thinking more)" — with token throughput
//   - "(29s · thinking more)"                     — elapsed + status word only (no tokens yet)
// On a hit the whole line is returned (spinner + task description + group). `\(` followed by a
// digit+time unit excludes output such as "(3 files changed)".
export const CLAUDE_STATUS_LINE_RE = /\(\d+(?:s|m\s+\d+s|h\s+\d+m\s+\d+s)[^()]*\)/u
// claude TUI's auto-retry state after an API connection failure. The line has none of the elapsed
// group a normal status line carries:
//   ✻ Unable to connect to API (ConnectionRefused) · Retrying in 25s · attempt 10/10
// Kept as a separate case beside CLAUDE_STATUS_LINE_RE so it can be dropped alone if it misfires,
// without touching the other rule.
export const CLAUDE_RETRYING_LINE_RE = /·\s*Retrying\s+in\s+\d+s\s*·/i
// claude TUI's "waiting for background agents" status line. After the main agent dispatches
// background sub-agents (Task tool) the round's JSONL often ends on end_turn (Task is
// fire-and-forget) while the TUI shows "✻ Waiting for 3 background agents to finish". The reverse
// JSONL scan then returns false → misread as idle, possibly reaped as idle by inactive-tmux-cleaner.
// The JSONL cannot express this wait state, so isWorking falls back to capture-pane when the JSONL
// looks finished (see the end of isWorking); a hit here (N≥1) still means working.
// Not anchored on the spinner glyph (✻ varies per frame), case-insensitive, and [1-9]\d* excludes
// N=0 (the line disappears once done).
export const CLAUDE_BG_AGENTS_WAITING_RE = /Waiting\s+for\s+[1-9]\d*\s+background\s+agents?\s+to\s+finish/i
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
export const CLAUDE_DANGER_OPERATION_RE = /Dangerous\s+\S[^\n]*?operation\s+on\s+[^:\n]+:[^\n]*/i
// Self-heal throttle: one heal at a time per session, and the same warning text never re-triggers
// inside the cooldown — a dirty Esc plus the 5s pane cache would otherwise have realTimeInfo firing
// repeatedly and turn the agent into a broken record.
export const DANGER_HEAL_COOLDOWN_MS = 30 * 1000
// Plain-text tail cache for capture-pane (5s TTL). isWorking's fallback and realTimeInfo share one
// spawn, capping capture-pane at ≤1/5s/session. ANSI escapes stripped; failure or no hit returns "".
export const PANE_TAIL_TTL_MS = 5 * 1000
