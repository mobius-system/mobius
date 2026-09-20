/**
 * tmux-codex.ts — TmuxCodexBackend.
 *
 * One tmux window per Mobius session_id inside Mobius's own tmux server; the window runs the
 * interactive Codex TUI. Implements the same AgentBackend contract as tmux-claude-code:
 *   - input:     tmux load-buffer + paste-buffer -p + Enter
 *   - read:      tail of $CODEX_HOME/sessions/YYYY/MM/DD/rollout-...<thread-id>.jsonl
 *   - title:     $CODEX_HOME/state_5.sqlite → threads.name (Codex 0.154+ titles its own threads;
 *                older rollouts fall back to the base jsonl scan)
 *   - interrupt: tmux send-keys C-c x 3
 *   - terminate: tmux kill-window
 *   - completion: shares the .imac/flags/<sessionId> flag convention with the Claude backend
 */
const { spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

// Resolve the aimux binary to spawn as a stdio MCP server (for TUI sessions). Mirrors
// backend/services/aimux-remote.ts AIMUX_BIN_CANDIDATES; kept inline to avoid crossing the
// .js/.ts boundary from this CommonJS backend.
function resolveAimuxBin() {
  const candidates = [
    process.env.AIMUX_BIN,
    path.join(os.homedir(), '.local', 'bin', 'aimux'),
    path.join(__dirname, '..', '..', '.venv-aimux', 'bin', 'aimux'),
  ]
  for (const c of candidates) { if (c && fs.existsSync(c)) return c }
  return 'aimux'
}

import { AgentBackend } from './base'
import type { HistorySnapshot, QueryOpts } from './base'
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
const { recordPromptPaste } = require('../services/agent-prompt-events')
const { resolveSecretCandidate } = require('../utils/secret-placeholder')
const {
  runningFlagPathOf,
  failedFlagPathOf,
  safeWriteRunningFlag,
  safeRemoveRunningFlag,
  safeRemoveFlagDir,
} = require('../utils/session-flags')
const { MOBIUS_DATA_PATH, TOKEN_PROXY_BASE_URL } = require('../config')
const { AGENT_TMUX_SOCKET, log, tmux } = require('./tmux-operation-log')
const { take_tmux_window_text } = require('./tmux_utils')
const { encodeProxyToken } = require('../token-proxy/encoding')

let Database: any = null
try { Database = require('better-sqlite3') } catch {}

const HUB = 'imac_codex_agent_hub'
const HOME = os.homedir()
// Env-var proxy config (once named proxy_envs.bash): read the new name first, legacy file as fallback.
const PROXY_ENVS_FILE = path.join(HOME, 'proxy_envs.conf')
const PROXY_ENVS_FILE_LEGACY = path.join(HOME, 'proxy_envs.bash')
function resolveProxyEnvsFile() {
  return fs.existsSync(PROXY_ENVS_FILE) ? PROXY_ENVS_FILE : PROXY_ENVS_FILE_LEGACY
}
// Model proxychains config (once named proxy_claude.conf); the legacy file is honored while it exists.
const PROXY_CONF = path.join(HOME, 'proxychains_config_for_llm_models.conf')
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex')
const CODEX_CONFIG = path.join(CODEX_HOME, 'config.toml')
const CODEX_STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite')
// Each channel TOML declares env_key; this backend exports the matching env var when the window starts.
const RUNTIME_FILE = path.join(MOBIUS_DATA_PATH, 'codex-hub-runtime.json')
// archive: one row per session ever started (sessionId → jsonlPath/agentSessionId/cwd...), never
// dropped on terminate, so getHistory still finds the jsonl after an admin window close or cleaner run.
const ARCHIVE_FILE = path.join(MOBIUS_DATA_PATH, 'codex-hub-archive.json')
// Defensive fallback for an empty model in an old codex-hub-runtime.json (new data all comes from the
// registry, so this should not happen): flows pass codexModel via model-registry.launchOptionsForSession.
const DEFAULT_MODEL = 'gpt-5.5'
const CODEX_CHANNEL_RE = /^[A-Za-z]+$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
// Codex TUI error scan reads only the last N lines: the status endpoint calls getRecentError
// repeatedly and capturing the whole scrollback is far too heavy.
const CODEX_ERROR_SCAN_TAIL_LINES = 50
// rollout "freshness" window for _readWorkingFromJsonl: when the tail window carries no explicit
// marker (usually dense streaming agent_message/token_count, or entry.working invalidated by a
// backend restart) and the file was written inside this window, codex is still producing → working.
//
// Why 60s (was 20s): this branch is only reached when the tail window has no marker at all, and
// task_complete always ends a turn → a truly finished session hits its task_complete inside the
// tail window first, returns false, and never gets here. So freshness only covers an in-flight turn
// with a temporary write gap (long thinking / slow LLM / long commands can leave the rollout silent
// for tens of seconds). 20s was too short: such gaps often exceed it, expiry falls back to
// entry.working, and after a backend restart that is false (the watcher starts at the file end and
// misses this turn's task_started) → intermittent false "not working". 60s covers most thinking
// gaps without making a finished session look working (a finish returns early on task_complete).
const CODEX_WORKING_FRESH_MS = 60000

// realTimeInfo: recognize the Codex TUI status line (rendered by status_indicator_widget.rs).
// Line shape: "[•◦] <header> (<elapsed> • esc to interrupt)[ · <inline_message>]"
//   - spinner: • (U+2022) / ◦ (U+25E6) animation frames; absent when reduced-motion hiding is on
//   - header: Working / Thinking / Idle / Reviewing ... (variable, so not matched on)
//   - elapsed (fmt_elapsed_compact): Ns | Mm SSs | Hh MMm SSs
//   - "esc to interrupt": present when show_interrupt_hint=true (almost always on in production)
// Layered regex to cut false positives:
//   ① main anchor "(<elapsed> • esc to interrupt)" — codex-only string, zero false positives,
//      covers the common production state
//   ② fallback "^[•◦] <header> (<elapsed>)" — when the interrupt hint is off; the spinner is
//      TUI-only, which rules out prose like "(5s)"
const CODEX_STATUS_LINE_RE = /\(\d+(?:s|m\s+\d{2}s|h\s+\d{2}m\s+\d{2}s)\s*•\s*esc to interrupt\s*\)|^[•◦]\s+\S[^\n()]*?\(\d+(?:s|m\s+\d{2}s|h\s+\d{2}m\s+\d{2}s)\s*\)/u
// 5s TTL cache: /status polls every 2s, so caching holds capture-pane to ≤1/5s. The empty "" is cached too.
const REALTIME_INFO_TTL_MS = 5 * 1000
const _realTimeInfoCache = new Map<string, any>() // sessionId → { ts: number, value: string }

// getPendingRequests: codex buffers input submitted while busy in the TUI's InputQueueState
// (queued_user_messages / pending_steers, see tui/src/chatwidget/input_flow.rs
// queue_user_message_with_options — when busy it only queues locally, it does not submit to core)
// and renders it as a preview block in the bottom pane (source
// tui/src/bottom_pane/pending_input_preview.rs). Three headers, every item starts a line with
// "  ↳ " (↳ = U+21B3):
//   - Queued follow-up inputs                        (ordinary queued messages)
//   - Messages to be submitted after next tool call  (pending steer)
//   - Messages to be submitted at end of turn        (pending steer)
const CODEX_PENDING_HEADER_RE = /Queued follow-up|Messages to be submitted/
const CODEX_PENDING_ITEM_RE = /^\s*↳\s+(.*)$/

// Codex renders a user-triggered interruption with the same black-square prefix used by
// ErrorEvent notices. It is a normal control action, not an agent failure. Keep the match
// anchored to the notice prefix so ordinary conversation text mentioning the phrase is not
// suppressed.
const CODEX_USER_INTERRUPT_NOTICE_RE = /^■\s*Conversation interrupted\b/i
const CODEX_FALLBACK_MODEL_METADATA_NOTICE_RE =
  /^⚠\s*Model metadata for `[^`]+` not found\. Defaulting to fallback metadata;/
// MCP servers failing to boot is common in sandboxed/offline agent environments and does not
// stop the turn itself — codex still answers with its built-in tools. TUI renders both
// finish_mcp_startup warnings as "⚠ MCP startup incomplete (failed: ...)" /
// "⚠ MCP startup interrupted. The following servers were not initialized: ..." (tui/src/
// chatwidget/mcp_startup.rs). Treat them as ignorable, same as the fallback metadata banner.
const CODEX_MCP_STARTUP_NOTICE_RE = /^⚠\s*MCP startup (?:incomplete|interrupted)\b/i

// Newest error/warning notice in a captured pane, or null. See getRecentError for the signal design.
function findCodexRecentErrorInPane(paneText: string) {
  const ANSI_RE = /\x1b\[[0-9;]*m/g
  const lines = String(paneText || '').split('\n')
  // Reverse scan so the newest Codex notice wins. If that newest notice is the normal
  // user-interrupt or fallback metadata banner, stop immediately instead of falling through to an
  // older stale error.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const cleaned = line.replace(ANSI_RE, '').trimStart()
    if (!cleaned.startsWith('■') && !cleaned.startsWith('⚠')) continue
    if (CODEX_USER_INTERRUPT_NOTICE_RE.test(cleaned)) return null
    if (CODEX_FALLBACK_MODEL_METADATA_NOTICE_RE.test(cleaned)) return null
    if (CODEX_MCP_STARTUP_NOTICE_RE.test(cleaned)) return null
    // The same error text can legitimately occur in separate turns. Use the
    // nearest non-empty line before the notice as its stable occurrence
    // fingerprint, stripping terminal styling that changes between captures.
    let contextFingerprint = ''
    for (let j = i - 1; j >= 0; j--) {
      const preceding = lines[j].replace(ANSI_RE, '').trim()
      if (!preceding) continue
      contextFingerprint = preceding
      break
    }
    return {
      message: cleaned.trim(),
      rawLine: line,
      contextFingerprint,
    }
  }
  return null
}

// Hard-kill safety net for /stop: capture the newest pane text (bypassing the 5s cache so it shows
// the real post-C-c state) and decide whether the codex TUI is still running a turn. Busy anchor =
// CODEX_STATUS_LINE_RE ("(<elapsed> • esc to interrupt)" etc.).
//   - hit:           C-c×3 did not take, still working
//   - miss/failure:  back to idle, C-c worked
//   - failure/empty: false, so nothing escalates and a window that stopped softly is not killed
function codexPaneStillBusy(sessionId: string) {
  let text = ''
  try {
    const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-J', '-S', '-15'])
    if (pane.status === 0 && pane.stdout) {
      text = pane.stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    }
  } catch { /* best-effort: a failure means not busy, so no escalation */ }
  if (!text) return false
  return text.split('\n').some((l) => CODEX_STATUS_LINE_RE.test(l))
}

const READY_POLL_MS = 250
const READY_TIMEOUT_MS = 25000
const READY_SENTINELS = [
  'OpenAI Codex',
  'permissions: YOLO mode',
  '/model to change',
]
const READY_HISTORY_SIZE_THRESHOLD = 1000
const READY_HISTORY_CONSECUTIVE_POLLS = 2
const TRUST_PROMPT_SENTINELS = [
  'Do you trust the contents of this directory',
  'Trusting the directory allows',
]
const TRUST_PRESS_INTERVAL_MS = 1500
const UPDATE_PROMPT_SENTINELS = [
  'Update available!',
  'Skip until next version',
]
const UPDATE_PRESS_INTERVAL_MS = 1500

const PASTE_PROBE_INTERVAL_MS = 200
const PASTE_SLEEP_MAX_MS = 5000
// Reopening an old session shows "Resuming session…" (U+2026 ellipsis in the installed binary)
// while codex reloads the rollout; Enter is swallowed for that whole window. Matching the bare
// prefix keeps it working whether the TUI renders the ellipsis character or three dots.
const RESUME_SENTINEL = 'Resuming session'
const RESUME_WAIT_MAX_MS = 16000
const RESUME_POLL_MS = 2000
// A paste past the TUI's collapse threshold is replaced on screen by a placeholder, so the prompt
// text never reaches the pane and the tail probe can never match. Codex collapses above 1000
// chars (LARGE_PASTE_CHAR_THRESHOLD in chat_composer.rs) into "[Pasted Content N chars]", with a
// "#2"-style suffix when the same size repeats; Claude Code renders "[Pasted text #2 +22 lines]".
// Either form proves the paste landed, so the wait below accepts a placeholder hit as success.
const PASTE_PLACEHOLDER_RE = /\[Pasted (?:Content \d+ chars|text\b[^\]]*)\]/
const SUBMIT_ENTER_ATTEMPTS = 3
const SUBMIT_ENTER_INTERVAL_MS = 500
// A prompt pasted while the TUI is still booting stays in the composer unsent: the pane keeps the
// collapsed-paste placeholder, no turn starts, so no codex thread is recorded and the bind that
// follows times out. Wait this long (enough for the boot to finish) before the retry Enter.
const SUBMIT_RECHECK_DELAY_MS = 8000
const THREAD_BIND_TIMEOUT_MS = 30000
const THREAD_BIND_POLL_MS = 300
const THREAD_BIND_UPDATED_SKEW_MS = 1000

// True while the collapsed-paste placeholder of an unsent prompt is still on the pane's input line.
// -J joins wrapped lines so a narrow terminal cannot split the placeholder; -S -40 covers the input
// box and the status lines above it. A failed capture reads as "not stuck", so nothing extra fires.
function codexComposerHoldsPastedText(sessionId: string) {
  try {
    const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-J', '-S', '-40'])
    if (pane.status !== 0 || !pane.stdout) return false
    return PASTE_PLACEHOLDER_RE.test(pane.stdout)
  } catch { /* best-effort: a failure means not stuck */ return false }
}

// Whether the hub tmux session that hosts every agent window exists.
function hubExists() {
  return tmux(['has-session', '-t', HUB]).status === 0
}

function ensureHub() {
  if (hubExists()) return
  const r = tmux(['new-session', '-d', '-s', HUB, '-n', '_root'])
  if (r.status !== 0) throw new Error(`tmux new-session failed: ${r.stderr}`)
  log(`[tmux-codex] created tmux session ${HUB}`)
}

function windowExists(name: string) {
  const r = tmux(['list-windows', '-t', HUB, '-F', '#{window_name}'])
  if (r.status !== 0) return false
  return r.stdout.split('\n').includes(name)
}

// list-windows result cache (status queries only).
// /status and the syncer poll every 2~5s; within one /status, isAlive + isWorking (which calls
// isAlive itself) + listSessions + getRecentError's isAlive repeat list-windows up to 5 times, all
// via spawnSync, which blocks Node's single event loop. Reusing the parsed rows within
// LIST_WINDOWS_TTL_MS (3s) drops that to 0~1 spawnSync per /status and removes the "one slow tmux
// call occupies the event loop and every request behind it queues up" avalanche.
// Control flow (windowExists inside create/terminate/pause/recovery) still queries live, unaffected by the TTL.
const LIST_WINDOWS_TTL_MS = 3 * 1000
let _listWindowsCache: { ts: number; rows: string[][] } | null = null // { ts: number, rows: string[][] }

function listWindowsRowsCached() {
  const now = Date.now()
  if (_listWindowsCache && now - _listWindowsCache.ts < LIST_WINDOWS_TTL_MS) {
    return _listWindowsCache.rows
  }
  const r = tmux(['list-windows', '-t', HUB, '-F', '#{window_name}|#{pane_pid}|#{window_index}|#{window_activity}|#{pane_dead}|#{pane_current_command}'])
  const rows = r.status === 0
    ? r.stdout.trim().split('\n').filter(Boolean).map((l: string) => l.split('|'))
    : []
  _listWindowsCache = { ts: now, rows }
  return rows
}

function shellQuote(s: string) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

// Dispatch contract: the caller passes modelLaunchOptions (the whole output of
// model-registry.modelLaunchOptionsFor). This backend unpacks the fields it needs here
// (model/settingsPath/codex*/proxy tier), with the old flat fields as a compatibility fallback.
function unpackLaunch(opts: CodexDispatchOpts): { model: string | null; settingsPath: string | null; useProxy: boolean; proxyMode: string; codexProfileKey: string | null; codexChannel: string | null; codexConfigPath: string | null; codexSecretEnvKey: string | null; codexSecretValue: string | null; captureStream: boolean } {
  const launch = (opts?.modelLaunchOptions || {}) as Record<string, any>
  return {
    model: launch.model || opts.model,
    settingsPath: launch.settingsPath || launch.codexConfigPath || opts.settingsPath || opts.codexConfigPath || null,
    useProxy: launch.forceNoProxy ? false : (launch.useProxy === true || opts.useProxy === true),
    proxyMode: launch.forceNoProxy ? 'direct' : (launch.proxyMode || opts.proxyMode || 'direct'),
    codexProfileKey: launch.codexProfileKey || launch.codexChannel || opts.codexProfileKey || opts.codexChannel || null,
    codexChannel: launch.codexChannel || launch.codexProfileKey || opts.codexChannel || opts.codexProfileKey || null,
    codexConfigPath: launch.codexConfigPath || opts.codexConfigPath || null,
    codexSecretEnvKey: launch.codexSecretEnvKey || opts.codexSecretEnvKey || null,
    codexSecretValue: launch.codexSecretValue || opts.codexSecretValue || null,
    captureStream: launch.captureStream === true,
  }
}

// Digital-rain codex per-session withproxy: base_url→token-proxy, api_key→mpx1 token (wire=openai).
function codexWithProxyPathFor(profileKey: string, sessionId: string): string {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(CODEX_HOME, `${profileKey}.withproxy.${safe}.config.toml`)
}

// Copy the profile TOML with base_url/api_key rewritten to the token proxy; throws when either key is absent.
function writeCodexWithProxy(srcPath: string, profileKey: string, sessionId: string, upstream: any): string {
  const raw = fs.readFileSync(srcPath, 'utf8')
  const proxyToken = encodeProxyToken(upstream)
  const outPath = codexWithProxyPathFor(profileKey, sessionId)
  const lines = raw.split(/\r?\n/)
  let baseUrlHit = false
  let apiKeyHit = false
  const outLines = lines.map((line: string) => {
    if (/^\s*base_url\s*=/.test(line)) { baseUrlHit = true; return `base_url = "${TOKEN_PROXY_BASE_URL}"` }
    if (/^\s*api_key\s*=/.test(line)) { apiKeyHit = true; return `api_key = "${proxyToken}"` }
    return line
  })
  if (!baseUrlHit || !apiKeyHit) {
    throw new Error(`codex config 缺 base_url/api_key (base_url=${baseUrlHit}, api_key=${apiKeyHit})`)
  }
  let next = outLines.join('\n')
  if (!next.endsWith('\n')) next += '\n'
  fs.writeFileSync(outPath, next, { mode: 0o600 })
  return outPath
}

// Codex --profile accepts letters only; a missing or malformed channel is a hard error.
function normalizeCodexChannel(value: unknown) {
  const channel = String(value || '').trim()
  if (!channel) throw new Error('tmux-codex requires codex channel (--profile)')
  if (!CODEX_CHANNEL_RE.test(channel)) {
    throw new Error(`invalid codex channel '${channel}': channel must contain letters only`)
  }
  return channel
}

// Secret env var names must be export-safe.
function normalizeSecretEnvKey(value: unknown) {
  const key = String(value || '').trim()
  if (!key) throw new Error('tmux-codex requires codex secret env key')
  if (!ENV_KEY_RE.test(key)) throw new Error(`invalid codex secret env key '${key}'`)
  return key
}

// Explicit value wins; otherwise the process environment; an empty result is an error.
function resolveSecretValue(secretEnvKey: string, secretValue: string | null | undefined) {
  const explicit = secretValue == null ? '' : String(secretValue)
  const value = explicit || process.env[secretEnvKey] || ''
  if (!value) throw new Error(`missing value for codex secret env key ${secretEnvKey}`)
  return value
}

// Quoted string value of a top-level TOML key, or "" when absent.
function tomlStringValue(tomlText: string, key: string) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = String(tomlText || '').match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*=\\s*(['"])([^'"]+)\\1`))
  return match ? match[2].trim() : ''
}

// api_key from the profile TOML, but a placeholder (e.g. <API_KEY>) defers to the fallback value.
function resolveCodexConfigSecretValue(configText: string, fallbackValue: string | null | undefined) {
  const configured = tomlStringValue(configText, 'api_key')
  return resolveSecretCandidate(configured, fallbackValue)
}

// Booleans and their 0/1 and "true"/"false" string forms; anything else falls back.
function normalizeUseProxy(value: unknown, fallback = false) {
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  return !!fallback
}

// Normalize the four proxy tiers: direct | env | proxychains | env_proxychains.
// Legacy booleans: true→env_proxychains, false/null→direct.
function normalizeProxyMode4(value: unknown, fallback = 'direct') {
  if (value === 'env' || value === 'proxychains' || value === 'env_proxychains') return value
  if (value === 'direct') return 'direct'
  if (value === true || value === 1 || value === '1' || value === 'true') return 'env_proxychains'
  if (value === false || value === 0 || value === '0' || value === 'false') return 'direct'
  return fallback
}

// Per-tier dependency check: the env tier needs the proxy_envs file; proxychains needs conf + bin.
function proxyPrereqMissing(mode = 'env_proxychains') {
  const missing: string[] = []
  const needEnv = mode === 'env' || mode === 'env_proxychains'
  const needChains = mode === 'proxychains' || mode === 'env_proxychains'
  if (needEnv && !fs.existsSync(resolveProxyEnvsFile())) missing.push(`file: ${resolveProxyEnvsFile()}`)
  if (needChains) {
    if (!fs.existsSync(PROXY_CONF) && !fs.existsSync(path.join(HOME, 'proxy_claude.conf'))) missing.push(`file: ${PROXY_CONF}`)
    if (spawnSync('which', ['proxychains']).status !== 0) missing.push('bin (PATH): proxychains')
  }
  return missing
}

function assertProxyAvailable(mode = 'env_proxychains') {
  const missing = proxyPrereqMissing(mode)
  if (missing.length) throw new Error(`代理依赖缺失 (${mode}): ${missing.join(', ')}`)
}

function tomlBasicString(s: string) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function codexProjectHeader(cwd: string) {
  return `[projects.${tomlBasicString(path.resolve(cwd))}]`
}

// Pre-write trust_level = "trusted" for [projects.<cwd>] in config.toml so the TUI skips the trust
// prompt. Writes through a temp file + rename; a failure leaves the on-screen fallback to handle it.
function ensureProjectTrusted(cwd: string) {
  try {
    fs.mkdirSync(CODEX_HOME, { recursive: true })
    const header = codexProjectHeader(cwd)
    let text = fs.existsSync(CODEX_CONFIG) ? fs.readFileSync(CODEX_CONFIG, 'utf8') : ''
    const lines = text.split(/\r?\n/)
    let start = lines.findIndex((line: string) => line.trim() === header)
    if (start < 0) {
      if (text && !text.endsWith('\n')) text += '\n'
      fs.writeFileSync(CODEX_CONFIG, `${text}\n${header}\ntrust_level = "trusted"\n`)
      log(`[tmux-codex] trusted project in ${CODEX_CONFIG}: ${path.resolve(cwd)}`)
      return true
    }

    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*\[.*\]\s*$/.test(lines[i])) { end = i; break }
    }
    const trustIdx = lines.slice(start + 1, end).findIndex((line: string) => /^\s*trust_level\s*=/.test(line))
    if (trustIdx >= 0) {
      const idx = start + 1 + trustIdx
      if (/^\s*trust_level\s*=\s*"trusted"\s*$/.test(lines[idx])) return true
      lines[idx] = 'trust_level = "trusted"'
    } else {
      lines.splice(start + 1, 0, 'trust_level = "trusted"')
    }
    const tmp = `${CODEX_CONFIG}.imac-tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, lines.join('\n'))
    fs.renameSync(tmp, CODEX_CONFIG)
    log(`[tmux-codex] trusted project in ${CODEX_CONFIG}: ${path.resolve(cwd)}`)
    return true
  } catch (e) {
    console.warn(`[tmux-codex] failed to pre-trust project; screen fallback will handle it: ${e.message}`)
    return false
  }
}

// Last 16 non-empty trimmed lines, capped at 2000 chars, for a timeout message.
function summarizeScreen(screen: string) {
  return String(screen || '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-16)
    .join('\n')
    .slice(0, 2000)
}

function markRunning(root: string | null | undefined, sessionId: string) {
  return safeWriteRunningFlag(root, sessionId, { backend: 'tmux-codex' }, 'tmux-codex')
}

function clearRunning(root: string | null | undefined, sessionId: string) {
  return safeRemoveRunningFlag(root, sessionId, 'tmux-codex')
}

// Last 10 chars of the prompt once all whitespace is stripped, or null when nothing is left.
// The pane is stripped the same way before comparing, so the TUI wrapping or re-spacing the
// pasted text across lines cannot break the match.
function findPasteMarker(text: string) {
  const compact = String(text ?? '').replace(/\s+/g, '')
  return compact ? compact.slice(-10) : null
}

// ── Startup preflight (once at module load; a miss degrades to a warning) ────
;(function preflight() {
  const missing: string[] = []
  for (const bin of ['tmux', 'codex']) {
    if (spawnSync('which', [bin]).status !== 0) missing.push(`bin (PATH): ${bin}`)
  }
  if (!Database) missing.push('node module: better-sqlite3')
  if (missing.length) {
    console.warn('[tmux-codex] ⚠️  preflight 依赖不完整, codex 会话不可用 (不影响 claude-code):')
    for (const m of missing) console.warn('   - ' + m)
    return
  }
  const proxyMissing = proxyPrereqMissing()
  if (proxyMissing.length) {
    console.warn(`[tmux-codex] ⚠️  proxychains 依赖不完整; use_proxy=false 的会话仍可直连启动: ${proxyMissing.join(', ')}`)
  }
  log(`[tmux-codex] ✅ preflight pass (SOCKET=${AGENT_TMUX_SOCKET}, HUB=${HUB}, CODEX_HOME=${CODEX_HOME})`)
})()

// Read-only handle on codex's state_5.sqlite; null when better-sqlite3 or the file is missing.
function openStateDb() {
  if (!Database || !fs.existsSync(CODEX_STATE_DB)) return null
  try { return new Database(CODEX_STATE_DB, { readonly: true, fileMustExist: true }) }
  catch (e) {
    console.warn(`[tmux-codex] failed to open state db: ${e.message}`)
    return null
  }
}

// Every thread id already recorded for this cwd; empty when the state db is unreadable.
function snapshotThreadIds(cwd: string | null | undefined) {
  const db = openStateDb()
  if (!db) return new Set()
  try {
    const rows = db.prepare('SELECT id FROM threads WHERE cwd = ?').all(path.resolve(cwd))
    return new Set(rows.map((r: any) => r.id))
  } catch {
    return new Set()
  } finally {
    try { db.close() } catch {}
  }
}

// One thread row by id (rollout_path/cwd/model and ms-normalized timestamps), or null.
function codexThreadById(threadId: string) {
  if (!threadId) return null
  const db = openStateDb()
  if (!db) return null
  try {
    return db.prepare(`
      SELECT id, rollout_path, cwd, model,
             COALESCE(created_at_ms, created_at * 1000) AS created_ms,
             COALESCE(updated_at_ms, updated_at * 1000) AS updated_ms
      FROM threads
      WHERE id = ?
    `).get(threadId) || null
  } catch (e) {
    console.warn(`[tmux-codex] failed to read thread ${threadId}: ${e.message}`)
    return null
  } finally {
    try { db.close() } catch {}
  }
}

// Collapse a raw title into one line; "" becomes null so callers can treat it as absent.
function normalizeCodexTitle(value: unknown): string | null {
  if (value == null) return null
  const title = String(value).replace(/\0/g, '').replace(/\s+/g, ' ').trim()
  return title || null
}

// The title Codex generated for this thread, from threads.name of the state db; null when the
// thread is unknown or Codex has not titled it yet. Codex 0.154+ writes its own concise session
// title there (tui/src/app/thread_title.rs) and no longer puts a title event in the rollout jsonl.
// Older state dbs have no `name` column at all: that SELECT throws, and the caller falls back.
function codexThreadTitleById(threadId: string | null): string | null {
  if (!threadId) return null
  const db = openStateDb()
  if (!db) return null
  try {
    const row: any = db.prepare('SELECT name FROM threads WHERE id = ?').get(threadId)
    return normalizeCodexTitle(row?.name)
  } catch {
    return null
  } finally {
    try { db.close() } catch {}
  }
}

// rollout-<ts>-<threadId>.jsonl → threadId, for a rollout bound before agentSessionId was recorded.
function codexThreadIdFromRolloutPath(jsonlPath: string | null | undefined): string | null {
  if (!jsonlPath) return null
  const m = path.basename(jsonlPath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
  return m ? m[1] : null
}

// rollout_path from the state db, else a recursive walk of $CODEX_HOME/sessions for <threadId>.jsonl.
function findRolloutPathByThreadId(threadId: string) {
  const row = codexThreadById(threadId)
  if (row?.rollout_path) return row.rollout_path

  const root = path.join(CODEX_HOME, 'sessions')
  if (!threadId || !fs.existsSync(root)) return null
  const suffix = `${threadId}.jsonl`
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let items: any[] = []
    try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const it of items) {
      const p = path.join(dir, it.name)
      if (it.isDirectory()) stack.push(p)
      else if (it.isFile() && it.name.endsWith(suffix)) return p
    }
  }
  return null
}

// Newest thread created in this cwd at/after sinceMs, among the latest 20 rows, skipping excludeIds
// and any model mismatch. A model of "" or null matches anything.
function findNewestThread({ cwd, model, sinceMs, excludeIds }: { cwd: string; model: string; sinceMs: number; excludeIds?: Set<string> | null }) {
  const db = openStateDb()
  if (!db) return null
  try {
    const rows = db.prepare(`
      SELECT id, rollout_path, cwd, model,
             COALESCE(created_at_ms, created_at * 1000) AS created_ms,
             COALESCE(updated_at_ms, updated_at * 1000) AS updated_ms,
             first_user_message
      FROM threads
      WHERE cwd = ?
        AND COALESCE(created_at_ms, created_at * 1000) >= ?
      ORDER BY COALESCE(created_at_ms, created_at * 1000) DESC
      LIMIT 20
    `).all(path.resolve(cwd), sinceMs)
    return rows.find((r: any) => {
      if (excludeIds?.has(r.id)) return false
      if (model && r.model && r.model !== model) return false
      return true
    }) || null
  } catch (e) {
    console.warn(`[tmux-codex] failed to find newest thread: ${e.message}`)
    return null
  } finally {
    try { db.close() } catch {}
  }
}

// Newest thread updated in this cwd at/after sinceMs, among the latest 20 rows, model-checked.
// Fallback for a pre-existing window whose thread was created before the dispatch.
function findRecentlyUpdatedThread({ cwd, model, sinceMs }: { cwd: string; model: string; sinceMs: number }) {
  const db = openStateDb()
  if (!db) return null
  try {
    const rows = db.prepare(`
      SELECT id, rollout_path, cwd, model,
             COALESCE(created_at_ms, created_at * 1000) AS created_ms,
             COALESCE(updated_at_ms, updated_at * 1000) AS updated_ms,
             first_user_message
      FROM threads
      WHERE cwd = ?
        AND COALESCE(updated_at_ms, updated_at * 1000) >= ?
      ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
      LIMIT 20
    `).all(path.resolve(cwd), sinceMs)
    return rows.find((r: any) => {
      if (model && r.model && r.model !== model) return false
      return true
    }) || null
  } catch (e) {
    console.warn(`[tmux-codex] failed to find recently updated thread: ${e.message}`)
    return null
  } finally {
    try { db.close() } catch {}
  }
}

function codexRolloutPathOf(threadId: string) {
  return findRolloutPathByThreadId(threadId)
}

function isCodexTaskComplete(entry: any) {
  return entry?.type === 'event_msg' && entry?.payload?.type === 'task_complete'
}

function isCodexTaskStart(entry: any) {
  return entry?.type === 'event_msg' && ['task_started', 'user_message'].includes(entry?.payload?.type)
}


// Runtime entry: one tmux window + codex TUI state per Mobius session.
interface CodexRuntimeEntry {
  agentSessionId: string | null // null while restore has not bound the thread yet
  cwd: string
  flagRoot: string
  model: string
  codexProfileKey: string | null
  codexConfigPath: string | null
  codexSecretEnvKey: string | null
  withProxyPath?: string | null
  captureStream?: boolean
  useProxy: boolean
  proxyMode: string
  displayName: string | null
  jsonlPath: string | null // as above, unknown until bound
  startedAt: number
  working?: boolean
  watch: { stop?: () => void } | null
  [key: string]: unknown
}

// Dispatch contract shared by createNewSession / queue / pause: the whole modelLaunchOptions
// bundle plus the flat legacy fields.
interface CodexDispatchOpts {
  sessionId: string
  prompt?: string
  initialPrompt?: string
  cwd?: string
  flagRoot?: string
  displayName?: string | null
  agentSessionId?: string | null
  isInitialContextPrompt?: boolean
  mobiusPromptRecord?: Record<string, unknown> | null
  suppressRunningFlag?: boolean
  urgent?: boolean
  aimuxRemoteName?: string
  modelLaunchOptions?: Record<string, unknown>
  model?: string | null
  useProxy?: boolean
  proxyMode?: string
  codexProfileKey?: string | null
  codexChannel?: string | null
  codexConfigPath?: string | null
  codexSecretEnvKey?: string | null
  codexSecretValue?: string | null
  [key: string]: unknown
}

class TmuxCodexBackend extends AgentBackend {
  declare runtime: Map<string, CodexRuntimeEntry>
  constructor() {
    super({ name: 'tmux-codex', runtimeFile: RUNTIME_FILE, archiveFile: ARCHIVE_FILE })
    this.runtime = new Map()
    this._restoreFromPersisted()
  }

  // Rebuild the in-memory runtime from codex-hub-runtime.json: recover a still-open window's
  // thread, keep a pending entry that has no thread yet, and drop rows whose rollout jsonl is gone.
  _restoreFromPersisted() {
    let total = 0
    for (const [sid, p] of Object.entries(this.persisted) as Array<[string, any]>) {
      total++
      if (!p?.agentSessionId) {
        if (!p?.cwd || !windowExists(sid)) continue
        const recovered = findNewestThread({
          cwd: p.cwd,
          model: p.model || DEFAULT_MODEL,
          sinceMs: Math.max(0, (p.startedAt || 0) - THREAD_BIND_UPDATED_SKEW_MS),
          excludeIds: null,
        })
        const recoveredJsonl = recovered?.id ? (recovered.rollout_path || codexRolloutPathOf(recovered.id)) : null
        if (recovered?.id && recoveredJsonl && fs.existsSync(recoveredJsonl)) {
          const entry = {
            agentSessionId: recovered.id,
            cwd: p.cwd,
            flagRoot: p.flagRoot || p.cwd,
            model: recovered.model || p.model || DEFAULT_MODEL,
            codexProfileKey: p.codexProfileKey || null,
            codexConfigPath: p.codexConfigPath || null,
            codexSecretEnvKey: p.codexSecretEnvKey || null,
            useProxy: normalizeUseProxy(p.useProxy, false),
            proxyMode: normalizeProxyMode4(p?.proxyMode, 'direct'),
            displayName: p.displayName || null,
            jsonlPath: recoveredJsonl,
            startedAt: recovered.created_ms || p.startedAt || 0,
            working: true,
            watch: null,
          }
          this.runtime.set(sid, entry)
          this._persistEntry(sid, {
            agentSessionId: entry.agentSessionId,
            cwd: entry.cwd,
            flagRoot: entry.flagRoot,
            model: entry.model,
            codexProfileKey: entry.codexProfileKey,
            codexConfigPath: entry.codexConfigPath,
            codexSecretEnvKey: entry.codexSecretEnvKey,
            useProxy: entry.useProxy,
            proxyMode: entry.proxyMode,
            displayName: entry.displayName,
            jsonlPath: entry.jsonlPath,
            startedAt: entry.startedAt,
            pendingBind: false,
          })
          this._ensureWatcher(sid)
          log(`[tmux-codex] recovered pending runtime ${sid} to codex_thread=${entry.agentSessionId}`)
          continue
        }
        this.runtime.set(sid, {
          agentSessionId: null,
          cwd: p.cwd,
          flagRoot: p.flagRoot || p.cwd,
          model: p.model || DEFAULT_MODEL,
          codexProfileKey: p.codexProfileKey || null,
          codexConfigPath: p.codexConfigPath || null,
          codexSecretEnvKey: p.codexSecretEnvKey || null,
          useProxy: normalizeUseProxy(p.useProxy, false),
        proxyMode: normalizeProxyMode4(p?.proxyMode, 'direct'),
          displayName: p.displayName || null,
          jsonlPath: null,
          startedAt: p.startedAt || 0,
          working: true,
          watch: null,
        })
        log(`[tmux-codex] restored pending runtime ${sid}; waiting for codex thread bind`)
        continue
      }
      const jsonlPath = p.jsonlPath || codexRolloutPathOf(p.agentSessionId)
      if (!jsonlPath || !fs.existsSync(jsonlPath)) {
        log(`[tmux-codex] dropping runtime ${sid}; rollout jsonl missing: ${jsonlPath}`)
        continue
      }
      this.runtime.set(sid, {
        agentSessionId: p.agentSessionId,
        cwd: p.cwd,
        flagRoot: p.flagRoot || p.cwd,
        model: p.model || DEFAULT_MODEL,
        codexProfileKey: p.codexProfileKey || null,
        codexConfigPath: p.codexConfigPath || null,
        codexSecretEnvKey: p.codexSecretEnvKey || null,
        useProxy: normalizeUseProxy(p.useProxy, false),
        proxyMode: normalizeProxyMode4(p?.proxyMode, 'direct'),
        displayName: p.displayName || null,
        jsonlPath,
        startedAt: p.startedAt || 0,
        working: false,
        watch: null,
      })
      this._ensureWatcher(sid)
    }
    log(`[tmux-codex] runtime loaded ${this.runtime.size}/${total}`)
  }

  // Attach the jsonl watcher once a path is known; a second call is a no-op. Entries are emitted
  // raw and folded into entry.working.
  _ensureWatcher(sessionId: string, startOffset: any = null) {
    const entry = this.runtime.get(sessionId)
    if (!entry?.jsonlPath || entry.watch) return
    // startOffset: null = from the current end of file (incremental only); 0 = from the beginning
    // (used to rebuild working state).
    let from = Math.max(0, Math.floor(Number(startOffset) || 0))
    if (startOffset == null) {
      try { from = fs.existsSync(entry.jsonlPath) ? fs.statSync(entry.jsonlPath).size : 0 } catch { from = 0 }
    }
    entry.watch = watchJsonlFile({
      path: entry.jsonlPath,
      startOffset: from,
      onEntry: (raw: any) => {
        this._emitRaw(sessionId, raw)
        this._updateWorkingFromEntry(entry, raw)
      },
      onError: (e: unknown) => console.warn(`[tmux-codex/watch ${sessionId}] ${(e as Error)?.message || e}`),
    })
  }

  createNewSession(opts: CodexDispatchOpts) {
    this._writeMobiusPromptEarly(opts)
    return this._withLock(opts?.sessionId, () => this._createImpl(opts))
  }
  pauseCurrentAndResumeFromSession(opts: CodexDispatchOpts) {
    this._writeMobiusPromptEarly(opts)
    return this._withLock(opts?.sessionId, () => this._pauseImpl(opts))
  }
  noPauseCurrentAndQueueQueryAtSession(opts: CodexDispatchOpts) {
    this._writeMobiusPromptEarly(opts)
    return this._withLock(opts?.sessionId, () => this._queueImpl(opts))
  }
  // Interrupt the running turn so codex consumes the next queued instruction.
  pauseCurrentToDequeueQuery(sessionId: string) {
    return this._withLock(sessionId, async () => {
      if (!sessionId) throw new Error('sessionId required')
      if (!windowExists(sessionId)) return
      // Codex's interrupt key is Esc, not C-c. A single Esc breaks the current turn so the agent
      // stops to consume the next queued instruction. No new prompt is appended and no M-Enter is
      // sent — this only interrupts.
      tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Escape'])
      await new Promise((r) => setTimeout(r, 250))
    })
  }

  // Open the round early: the moment dispatch is entered (before the lock and the CLI start) the
  // user card is written to the store. Waiting for the spawn+bind path (~10s) lets the first sync
  // file the startup preamble into "round 0" instead.
  _writeMobiusPromptEarly(opts: CodexDispatchOpts) {
    if (!opts?.sessionId || !opts?.mobiusPromptRecord) return
    try { this.harnessWriteMobiusCoreEntry(opts.sessionId, opts.mobiusPromptRecord, opts.cwd) } catch {}
  }
  terminateSession(sessionId: string) {
    return this._withLock(sessionId, async () => {
      const r = await this._terminateImpl(sessionId)
      // Terminate safety net: flush pending_round_openers immediately, in case the agent crashed
      // and no dequeue will ever arrive.
      try { flushPendingOpeners(sessionId) } catch {}
      return r
    })
  }

  // Window still listed in the hub. Status path, so it reads the cache; control flow must use
  // windowExists instead.
  isAlive(sessionId: string) {
    // Status queries go through the cache (3s TTL); control flow (create/terminate etc.) must call
    // windowExists for a live answer.
    return listWindowsRowsCached().some((cols: string[]) => cols[0] === sessionId)
  }

  // The rollout jsonl decides when it can; entry.working is the fallback, and a session with a
  // known working flag but no jsonl path yet (spawn in flight) is working.
  isWorking(sessionId: string) {
    if (!this.isAlive(sessionId)) return false
    const entry = this.runtime.get(sessionId)
    if (entry?.working && !entry?.jsonlPath) return true
    const fromJsonl = this._readWorkingFromJsonl(entry?.jsonlPath || null)
    return fromJsonl == null ? !!entry?.working : fromJsonl
  }

  // Working state from the rollout tail: true/false on a definite marker, null when the tail window
  // has none and the file is cold (caller then falls back to entry.working).
  _readWorkingFromJsonl(jsonlPath: string | null): boolean | null {
    if (!jsonlPath || !fs.existsSync(jsonlPath)) return null
    let stat
    let lines
    try {
      stat = fs.statSync(jsonlPath)
      if (stat.size === 0) return null
      // 128KB: far larger than a single rollout record (a huge function_call_output / long
      // agent_message can reach tens of KB), so this turn's task_started is not pushed out of the
      // window by dense streaming events. Larger buys nothing: the scan stops at the first marker,
      // a bigger window only parses a few more lines in the rare no-marker branch, and freshness
      // already covers that case.
      const len = Math.min(stat.size, 128 * 1024)
      const buf = Buffer.alloc(len)
      const fd = fs.openSync(jsonlPath, 'r')
      try { fs.readSync(fd, buf, 0, len, stat.size - len) } finally { fs.closeSync(fd) }
      lines = buf.toString('utf8').split('\n').filter(Boolean)
    } catch { return null }

    for (let i = lines.length - 1; i >= 0; i--) {
      let e
      try { e = JSON.parse(lines[i]) } catch { continue }
      if (isCodexTaskComplete(e)) return false
      if (isCodexTaskStart(e)) return true
      if (e.type === 'response_item') {
        const pt = e.payload?.type
        if (['function_call', 'function_call_output', 'reasoning', 'message', 'custom_tool_call', 'custom_tool_call_output'].includes(pt)) return true
      }
      if (e.type === 'turn_context') return true
    }
    // No explicit marker in the tail window: usually dense streaming agent_message/token_count
    // pushed it out, or entry.working went stale after a backend restart. If the rollout is still
    // being written (very fresh mtime) codex is producing → working; only a cold file falls back to
    // entry.working (handled inside isWorking).
    if (stat && Date.now() - stat.mtimeMs < CODEX_WORKING_FRESH_MS) return true
    return null
  }

  // Done when the session's running flag is gone (the agent removes it on completion).
  isJobGoalAccomplished(sessionId: string) {
    const entry = this.runtime.get(sessionId)
    const root = entry?.flagRoot || entry?.cwd
    if (!root) return false
    return !fs.existsSync(runningFlagPathOf(root, sessionId))
  }

  // A stuck agent leaves failed.flag behind (see the forgotten-flag-scanner copy).
  isFailed(sessionId: string) {
    const entry = this.runtime.get(sessionId)
    const root = entry?.flagRoot || entry?.cwd
    if (!root) return false
    return fs.existsSync(failedFlagPathOf(root, sessionId))
  }

  // Live status line for the session page's LIVE card: capture the last 15 tmux pane lines and find
  // the Codex TUI status line ("• Working (4s • esc to interrupt)" etc.). "" when not alive or not
  // working; a 5s TTL cache (empty result included) holds capture-pane to ≤1/5s. Nice-to-have only:
  // failures stay silent and never throw into the /status poll.
  realTimeInfo(sessionId: string) {
    const now = Date.now()
    const cached = _realTimeInfoCache.get(sessionId)
    if (cached && now - cached.ts < REALTIME_INFO_TTL_MS) return cached.value
    let value = ''
    try {
      if (this.isAlive(sessionId) && this.isWorking(sessionId)) {
        // -S -15: last 15 lines; -p: plain text (ANSI stripped); -J: join wrapped lines (restores a
        // status line wrapped by a narrow terminal).
        const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-J', '-S', '-15'])
        if (pane.status === 0 && pane.stdout) {
          const lines = pane.stdout.split('\n')
          // The status line sits in the bottom pane; walk up from the end for the newest one.
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i]
            if (line && CODEX_STATUS_LINE_RE.test(line)) {
              // "esc to interrupt" invites users to press Esc and break normal work → replace with "working".
              value = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/esc to interrupt/gi, 'working').trim()
              break
            }
          }
        }
      }
    } catch { /* best-effort: a failure yields "" */ }
    _realTimeInfoCache.set(sessionId, { ts: now, value })
    return value
  }

  // Pending requests: input submitted while codex is busy never enters the rollout JSONL — it is
  // buffered in the TUI's InputQueueState and rendered as a preview block in the bottom pane (see
  // the CODEX_PENDING_HEADER_RE note above), so parsing that block off the tmux pane is enough.
  // Same source as getRecentError/realTimeInfo: both capture the TUI screen.
  //   - vs claude-code: claude-code reads queue-operation/enqueue from the JSONL with full content
  //     and a timestamp; codex gets only a truncated preview and no timestamp (the TUI does not
  //     expose one) → enqueuedAt is always null. Scanned only while alive, silent [] on failure.
  //   - capture-pane -J joins wrapped lines, so a multi-line pending entry is still one ↳ line;
  //     collect every ↳ line after the first header.
  getPendingRequests(sessionId: string) {
    if (!this.isAlive(sessionId)) return []
    let text = ''
    try {
      // -S -30: the preview block sits in the bottom pane above the status line, a few lines more
      // than realTimeInfo (-15) so the header is always caught.
      const cap = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-J', '-S', '-30'])
      if (cap.status === 0 && cap.stdout) text = cap.stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    } catch { return [] }
    if (!text) return []
    const pending: any[] = []
    let inBlock = false
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '')
      if (CODEX_PENDING_HEADER_RE.test(line)) { inBlock = true; continue }
      if (!inBlock) continue
      const m = line.match(CODEX_PENDING_ITEM_RE)
      if (m) pending.push({ content: m[1].trim(), enqueuedAt: null })
      // Other lines (wrap continuations / "press esc" / "edit last queued" / blanks) are ignored;
      // inBlock stays set until the capture ends.
    }
    return pending
  }

  // Newest error/warning notice off the Codex TUI screen, as { message, rawLine, contextFingerprint,
  // capturedAt }, or null.
  // Signal design (source-verified: codex-rs/tui/src/history_cell/notices.rs, openai/codex):
  //   - ■ (U+25A0) line prefix → new_error_event, fatal errors (the source marks them red, e.g. a
  //     403 insufficient balance / image banned)
  //   - ⚠ (U+26A0) line prefix → new_warning_event (yellow) / DeprecationNotice (bold red), warnings
  //     (e.g. model at capacity)
  //   Other glyphs are not scanned: • info (dim) / ✨ update (cyan) / ⓘ safety (cyan) are not errors.
  // Verdict = "line starts with ■ or ⚠" after ANSI stripping; the colour is irrelevant. Why (this is
  // the key "colour" fix):
  //   ① warnings use ⚠, not ■, so the old "must contain ■" rule missed every warning;
  //   ② a real recent-codex ⚠ notice (Selected model is at capacity...) can carry no ANSI colour at
  //      all (hexdump confirms nothing after the e2 9a a0 prefix, no \x1b), so "must hit a red ANSI
  //      code" missed those too;
  //   ③ depending on a specific red code is fragile anyway (the colored crate picks 31/38;5;1/38;2;255
  //      from terminfo, which differs across versions and terminals).
  //   ■/⚠ are used by codex only for notice rendering, so a line prefix means a notice and the false
  //   positive rate is very low (agent prose never starts a line with a bare ■/⚠).
  // Special case: "■ Conversation interrupted ..." is a normal user-triggered interruption, not an
  // error, and when it is the newest notice we return null instead of reaching further back for a
  // stale error.
  // Gotcha: the Codex TUI uses the alt screen, so its content is destroyed when the process exits;
  // hence the scan only runs while alive and a historical session sees nothing. A caller that needs
  // it must run its own background capture loop to disk.
  getRecentError(sessionId: string) {
    if (!this.isAlive(sessionId)) return null
    // -p: stdout; -e: keep ANSI; -S -N: tail N lines only (avoids a full scrollback scan);
    // -J: join wrapped lines so an error is not split across lines.
    const cap = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-e', '-S', `-${CODEX_ERROR_SCAN_TAIL_LINES}`, '-J'])
    if (cap.status !== 0) return null
    const found = findCodexRecentErrorInPane(cap.stdout)
    return found ? { ...found, capturedAt: new Date().toISOString() } : null
  }

  // One row per hub window: ids, pid/index, last activity (tmux reports seconds → ms), and pane state.
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

  // Three-level sessionId → jsonl path lookup, symmetric with tmux-claude-code:
  //   runtime (in-process Map) > persisted (codex-hub-runtime.json, live) > archive (codex-hub-archive.json, all-time)
  _resolveJsonlPath(sessionId: string) {
    return this.runtime.get(sessionId)?.jsonlPath
        || this._lookupPersistedJsonlPath(sessionId)
        || this._lookupArchivedJsonlPath(sessionId)
        || null
  }

  // Codex thread id for a Mobius session, same three-level lookup as the jsonl path (a row that
  // predates agentSessionId still resolves it from the rollout file name).
  _resolveAgentSessionId(sessionId: string): string | null {
    return this.runtime.get(sessionId)?.agentSessionId
        || this._lookupPersistedEntry(sessionId)?.agentSessionId
        || this._lookupArchivedEntry(sessionId)?.agentSessionId
        || codexThreadIdFromRolloutPath(this._resolveJsonlPath(sessionId))
        || null
  }

  // Dequeue detection: codex records "human input actually consumed by the agent" in two shapes,
  // either of which counts as a dequeue:
  //   ① response_item.message.role=='user' — human input written into the rollout as a user message
  //      (input_text content).
  //   ② event_msg.task_started — a new turn begins (task_started carries the matching turn_id).
  // Anything else (assistant/tool/function_call) is not a dequeue signal.
  containDequeueEvent(entry: any, _pendingInputs: string[] = []): boolean {
    if (!entry || typeof entry !== 'object') return false
    if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload?.role === 'user') return true
    if (entry.type === 'event_msg' && entry.payload?.type === 'task_started') return true
    return false
  }

  // History snapshot from the agent-history-store DB (native jsonl increments are backfilled before the read).
  getHistory(sessionId: string, _opts: QueryOpts = {}): HistorySnapshot {
    return getHistorySnapshot(sessionId, this._resolveJsonlPath(sessionId), this.containDequeueEvent.bind(this), []) as HistorySnapshot
  }

  // The title Codex itself generated for this session, read from the state db (threads.name).
  // New Codex (0.154+) writes it there and nothing title-shaped into the rollout jsonl, so the
  // base jsonl scan finds nothing; the rollouts of older Codex keep going through that scan.
  getSessionTitle(sessionId: string, opts: QueryOpts = {}): string | null {
    return codexThreadTitleById(this._resolveAgentSessionId(sessionId))
        || super.getSessionTitle(sessionId, opts)
  }

  // Per-step timings derived from the jsonl, cached beside it (see time-consume-waterfall).
  get_time_consume_waterfall(sessionId: string, opts: any = {}) {
    return timeConsumeWaterfallFromBackend(this, sessionId, opts)
  }

  // Drop that cached waterfall, forcing the next read to recompute.
  clear_time_consume_waterfall(sessionId: string, opts: any = {}) {
    return clearTimeConsumeWaterfallForBackend(this, sessionId, opts)
  }

  // Subscribe to the raw stream: the base EventEmitter carries the live stream emitted by the
  // shared watcher. Backfilling is the agent-history-store's job, so fromSentinel resume semantics
  // no longer exist.
  getAgentRawThoughtStream(sessionId: string, listener: (raw: unknown) => void, opts: QueryOpts = {}) {
    return super.getAgentRawThoughtStream(sessionId, listener, opts)
  }

  // A send-path user_input/compact card opens a new round (written into the agent-history-store, no
  // file involved). The runtime need not have a bound jsonl path: the call site moved up to the
  // dispatch entry, so a round must open during a new session's spawn even with an unknown path;
  // the path stays null and the first sync claims it.
  harnessWriteMobiusCoreEntry(sessionId: string, mobiusPromptRecord: Record<string, unknown> | null | undefined, cwdHint?: string) {
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
        pendingInputs: [],
      })
    } catch (e) {
      console.warn(`[tmux-codex] mobius core entry failed (${sessionId}): ${e.message}`)
      return false
    }
  }

  // Create path: reuse a live window (binding its existing thread) or spawn one, send the initial
  // prompt, then bind the codex thread that the new rollout created.
  async _createImpl(opts: CodexDispatchOpts) {
    const { sessionId, cwd, flagRoot, displayName, initialPrompt, agentSessionId, aimuxRemoteName } = opts
    const { model, useProxy, proxyMode, codexProfileKey, codexChannel, codexConfigPath, codexSecretEnvKey, codexSecretValue } = unpackLaunch(opts)
    if (!sessionId || !cwd) throw new Error('createNewSession requires sessionId + cwd')
    if (!initialPrompt) throw new Error('createNewSession requires initialPrompt')
    if (!fs.existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`)

    let spawnInfo: any = null
    let allowUpdatedThreadFallback = false
    if (!windowExists(sessionId)) {
      spawnInfo = await this._spawnWindow({ sessionId, cwd, flagRoot, model, useProxy, proxyMode, codexProfileKey, codexChannel, codexConfigPath, codexSecretEnvKey, codexSecretValue, displayName, agentSessionId, aimuxRemoteName })
    } else {
      await this._ensureRuntimeFromKnownThread({ sessionId, cwd, flagRoot, model, useProxy, proxyMode, codexProfileKey: codexChannel || codexProfileKey, codexConfigPath, codexSecretEnvKey, displayName, agentSessionId })
      allowUpdatedThreadFallback = true
    }

    const bindKnownThreadIds = spawnInfo?.knownThreadIds || snapshotThreadIds(cwd)
    const bindSinceMs = spawnInfo?.startedAt || Date.now()
    await this._sendPromptToWindow(sessionId, initialPrompt)
    let entry = this.runtime.get(sessionId)
    markRunning(flagRoot || entry?.flagRoot || entry?.cwd || cwd, sessionId)
    if (!this.runtime.get(sessionId)?.agentSessionId) {
      await this._bindRuntimeAfterPrompt({
        sessionId,
        cwd,
        flagRoot: flagRoot || cwd,
        model: model || DEFAULT_MODEL,
        useProxy: normalizeUseProxy(useProxy, false),
        proxyMode: normalizeProxyMode4(proxyMode, normalizeUseProxy(useProxy, false) ? 'env_proxychains' : 'direct'),
        codexProfileKey: codexChannel || codexProfileKey,
        codexConfigPath,
        codexSecretEnvKey,
        displayName,
        sinceMs: bindSinceMs,
        knownThreadIds: bindKnownThreadIds,
        allowUpdatedThreadFallback,
      })
    }

    entry = this.runtime.get(sessionId)
    return {
      sessionId,
      agentSessionId: entry?.agentSessionId || null,
      jsonlPath: entry?.jsonlPath || null,
      startedAt: entry?.startedAt || Date.now(),
    }
  }

  // Queue path: respawn the window when it is gone (falling back to the last persisted cwd/model/
  // proxy/thread), otherwise reuse it; then send the prompt and bind if still unbound.
  async _queueImpl(opts: CodexDispatchOpts) {
    const { sessionId, prompt, agentSessionId, mobiusPromptRecord = null, suppressRunningFlag = false, aimuxRemoteName } = opts
    let { cwd, flagRoot, displayName } = opts
    let { model, useProxy, proxyMode, codexProfileKey, codexChannel, codexConfigPath: codexConfigPath0, codexSecretEnvKey, codexSecretValue } = unpackLaunch(opts)
    let codexConfigPath = codexConfigPath0
    if (!sessionId) throw new Error('sessionId required')
    if (!prompt) throw new Error('prompt required')

    let spawnInfo: any = null
    let allowUpdatedThreadFallback = false
    if (!windowExists(sessionId)) {
      const persisted = this.runtime.get(sessionId)
      const finalCwd = cwd || persisted?.cwd
      const finalAgentSid = agentSessionId || persisted?.agentSessionId
      const finalProxyMode = normalizeProxyMode4(proxyMode ?? persisted?.proxyMode, normalizeUseProxy(useProxy, persisted?.useProxy ?? false) ? 'env_proxychains' : 'direct')
      const finalUseProxy = finalProxyMode !== 'direct'
      const finalProfileKey = codexChannel || codexProfileKey || persisted?.codexProfileKey
      const finalConfigPath = codexConfigPath || persisted?.codexConfigPath
      const finalSecretEnvKey = codexSecretEnvKey || persisted?.codexSecretEnvKey
      if (!finalCwd) throw new Error(`session ${sessionId} has no live window and no cwd`)
      spawnInfo = await this._spawnWindow({
        sessionId,
        cwd: finalCwd,
        flagRoot: flagRoot || persisted?.flagRoot || finalCwd,
        model: model || persisted?.model || DEFAULT_MODEL,
        useProxy: finalUseProxy,
        proxyMode: finalProxyMode,
        codexProfileKey: finalProfileKey,
        codexConfigPath: finalConfigPath,
        codexSecretEnvKey: finalSecretEnvKey,
        codexSecretValue,
        displayName: displayName || persisted?.displayName,
        agentSessionId: finalAgentSid,
        aimuxRemoteName,
      })
      cwd = finalCwd
      flagRoot = flagRoot || persisted?.flagRoot || finalCwd
      model = model || persisted?.model || DEFAULT_MODEL
      useProxy = finalUseProxy
      proxyMode = finalProxyMode
      codexProfileKey = finalProfileKey ?? null
      codexConfigPath = finalConfigPath ?? null
      codexSecretEnvKey = finalSecretEnvKey ?? null
      displayName = displayName || (persisted?.displayName ?? null)
    } else {
      await this._ensureRuntimeFromKnownThread({ sessionId, cwd, flagRoot, model, useProxy, proxyMode, codexProfileKey: codexChannel || codexProfileKey, codexConfigPath, codexSecretEnvKey, displayName, agentSessionId })
      allowUpdatedThreadFallback = true
    }

    const bindKnownThreadIds = spawnInfo?.knownThreadIds || snapshotThreadIds(cwd)
    const bindSinceMs = spawnInfo?.startedAt || Date.now()
    const entry = this.runtime.get(sessionId)
    if (entry) entry.working = true
    await this._sendPromptToWindow(sessionId, prompt)
    if (!suppressRunningFlag) markRunning(flagRoot || entry?.flagRoot || entry?.cwd || cwd, sessionId)
    if (!this.runtime.get(sessionId)?.agentSessionId) {
      await this._bindRuntimeAfterPrompt({
        sessionId,
        cwd,
        flagRoot: flagRoot || cwd,
        model: model || DEFAULT_MODEL,
        useProxy: normalizeUseProxy(useProxy, false),
        proxyMode: normalizeProxyMode4(proxyMode, normalizeUseProxy(useProxy, false) ? 'env_proxychains' : 'direct'),
        codexProfileKey: codexChannel || codexProfileKey,
        codexConfigPath,
        codexSecretEnvKey,
        displayName,
        sinceMs: bindSinceMs,
        knownThreadIds: bindKnownThreadIds,
        allowUpdatedThreadFallback,
      })
    }
  }

  // Pause path for a live window: two flavours of interrupt, then either stop for good (no prompt,
  // clears the running flag) or queue the new prompt through _queueImpl.
  async _pauseImpl({ sessionId, prompt, cwd, flagRoot, urgent = false, mobiusPromptRecord = null }: CodexDispatchOpts) {
    if (!sessionId) throw new Error('sessionId required')
    const persisted = this.runtime.get(sessionId)

    if (windowExists(sessionId)) {
      if (urgent) {
        // Urgent: a single C-c interrupts the current turn (measured: one is enough). Spacing uses
        // await setTimeout; spawnSync('sleep') would block the event loop and freeze the node process.
        tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'C-c'])
        await new Promise((r) => setTimeout(r, 250))
        // After the interrupt the old input may return to the input area: Alt+Enter first to
        // separate it, otherwise it fuses with the new prompt
        tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'M-Enter'])
        await new Promise((r) => setTimeout(r, 80))
      } else {
        // /stop: three C-c presses interrupt the current turn without killing the window (measured:
        // the TUI swallows a single one).
        for (let i = 0; i < 3; i++) {
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'C-c'])
          if (i < 2) await new Promise((r) => setTimeout(r, 50))
        }
        if (persisted) persisted.working = false
        await new Promise((r) => setTimeout(r, 300))
        // Safety net: C-c×3 is occasionally swallowed by the TUI and the turn keeps running. For a
        // soft stop with an empty prompt (/stop) escalate to tmux kill-window as a hard stop, so
        // /stop always stops the background agent (a dead window respawns on the next message, so
        // the session still continues). The urgent + new-prompt path must keep the window for new
        // input and never hard-kills. Double confirmation (capture busy → wait 700ms for the TUI to
        // settle → still busy) avoids killing a window that stopped softly but still shows a stale
        // status line.
        if (!prompt) {
          _realTimeInfoCache.delete(sessionId)
          if (codexPaneStillBusy(sessionId)) {
            await new Promise((r) => setTimeout(r, 700))
            _realTimeInfoCache.delete(sessionId)
            if (windowExists(sessionId) && codexPaneStillBusy(sessionId)) {
              tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
              log(`[tmux-codex] /stop fallback: C-c×3 未停止, kill-window=${sessionId}`)
            }
          }
        }
      }
    }

    if (!prompt) {
      clearRunning(flagRoot || persisted?.flagRoot || persisted?.cwd || cwd, sessionId)
      return
    }
    await this._queueImpl({
      sessionId,
      prompt,
      cwd: persisted?.cwd,
      flagRoot: persisted?.flagRoot,
      model: persisted?.model,
      useProxy: persisted?.useProxy,
      codexProfileKey: persisted?.codexProfileKey,
      codexConfigPath: persisted?.codexConfigPath,
      codexSecretEnvKey: persisted?.codexSecretEnvKey,
      displayName: persisted?.displayName,
      agentSessionId: persisted?.agentSessionId,
      mobiusPromptRecord,
    })
  }

  // Stop the watcher, remove the per-session withproxy file, drop the runtime + persisted rows,
  // kill the window and clear the session's flag dir. Archive keeps its row.
  async _terminateImpl(sessionId: string) {
    const wasAlive = windowExists(sessionId)
    const wasWorking = wasAlive && this.isWorking(sessionId)
    const entry = this.runtime.get(sessionId)
    if (entry?.watch?.stop) { try { entry.watch.stop() } catch {} }
    // Clean up the per-session withproxy file (digital-rain token).
    if (entry?.withProxyPath) { try { fs.unlinkSync(entry.withProxyPath) } catch {} }
    this.runtime.delete(sessionId)
    this._forgetPersisted(sessionId)
    if (wasAlive) {
      tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
      log(`[tmux-codex] terminate: killed window=${sessionId} (wasWorking=${wasWorking})`)
    }
    const flagRoot = entry?.flagRoot || entry?.cwd
    if (flagRoot) {
      safeRemoveFlagDir(flagRoot, sessionId, 'tmux-codex')
    }
    return { sessionId, killed: wasAlive, wasWorking }
  }

  // Register the runtime entry for an already-known thread, for a window that is still open.
  async _ensureRuntimeFromKnownThread({ sessionId, cwd, flagRoot, model, useProxy, proxyMode, codexProfileKey, codexConfigPath, codexSecretEnvKey, displayName, agentSessionId }: CodexDispatchOpts) {
    if (!sessionId || !cwd) return null
    if (this.runtime.has(sessionId)) return this.runtime.get(sessionId)
    if (!agentSessionId) return null
    const jsonlPath = codexRolloutPathOf(agentSessionId!)
    if (!jsonlPath) return null
    const entry = {
      agentSessionId,
      cwd,
      flagRoot: flagRoot || cwd,
      model: model || DEFAULT_MODEL,
      codexProfileKey: codexProfileKey || null,
      codexConfigPath: codexConfigPath || null,
      codexSecretEnvKey: codexSecretEnvKey || null,
      useProxy: normalizeUseProxy(useProxy, false),
      proxyMode: normalizeProxyMode4(proxyMode, normalizeUseProxy(useProxy, false) ? 'env_proxychains' : 'direct'),
      displayName: displayName || null,
      jsonlPath,
      startedAt: Date.now(),
      working: false,
      watch: null,
    }
    this.runtime.set(sessionId, entry)
    this._persistEntry(sessionId, {
      agentSessionId,
      cwd,
      flagRoot: flagRoot || cwd,
      model: model || DEFAULT_MODEL,
      codexProfileKey: entry.codexProfileKey,
      codexConfigPath: entry.codexConfigPath,
      codexSecretEnvKey: entry.codexSecretEnvKey,
      useProxy: normalizeUseProxy(useProxy, false),
      proxyMode: normalizeProxyMode4(proxyMode, normalizeUseProxy(useProxy, false) ? 'env_proxychains' : 'direct'),
      displayName: displayName || null,
      jsonlPath,
      startedAt: entry.startedAt,
      pendingBind: false,
    })
    this._ensureWatcher(sessionId)
    return entry
  }

  // Poll the sqlite thread table until the thread this dispatch created shows up (excluding the
  // pre-spawn snapshot), with an "updated" fallback for a reused window. Times out after
  // THREAD_BIND_TIMEOUT_MS; the jsonl watcher then starts from byte 0.
  async _bindRuntimeAfterPrompt({ sessionId, cwd, flagRoot, model, useProxy, proxyMode, codexProfileKey, codexConfigPath, codexSecretEnvKey, displayName, sinceMs, knownThreadIds, allowUpdatedThreadFallback }: CodexDispatchOpts) {
    if (!sessionId || !cwd) throw new Error('_bindRuntimeAfterPrompt requires sessionId + cwd')
    const deadline = Date.now() + THREAD_BIND_TIMEOUT_MS
    let found: any = null
    let foundBy = 'created'
    while (Date.now() < deadline) {
      found = findNewestThread({
        cwd: cwd || '',
        model: model || DEFAULT_MODEL,
        sinceMs: Number(sinceMs) || Date.now() - 10000,
        excludeIds: (knownThreadIds as Set<string> | null | undefined) || new Set<string>(),
      })
      if (found?.id) {
        foundBy = 'created'
        break
      }
      if (allowUpdatedThreadFallback) {
        found = findRecentlyUpdatedThread({
          cwd: cwd || '',
          model: model || DEFAULT_MODEL,
          sinceMs: Math.max(0, (Number(sinceMs) || Date.now()) - THREAD_BIND_UPDATED_SKEW_MS),
        })
        if (found?.id) {
          foundBy = 'updated'
          break
        }
      }
      await new Promise((r) => setTimeout(r, THREAD_BIND_POLL_MS))
    }
    if (!found?.id) throw new Error(`Codex thread was not recorded within ${THREAD_BIND_TIMEOUT_MS}ms (cwd=${cwd})`)

    const jsonlPath = found.rollout_path || codexRolloutPathOf(found.id)
    if (!jsonlPath) throw new Error(`Codex thread ${found.id} has no rollout_path`)
    const entry = {
      agentSessionId: found.id,
      cwd,
      flagRoot: flagRoot || cwd,
      model: found.model || model || DEFAULT_MODEL,
      codexProfileKey: codexProfileKey || null,
      codexConfigPath: codexConfigPath || null,
      codexSecretEnvKey: codexSecretEnvKey || null,
      useProxy: normalizeUseProxy(useProxy, false),
      proxyMode: normalizeProxyMode4(proxyMode, normalizeUseProxy(useProxy, false) ? 'env_proxychains' : 'direct'),
      displayName: displayName || null,
      jsonlPath,
      startedAt: found.created_ms || Date.now(),
      working: true,
      watch: null,
    }
    this.runtime.set(sessionId, entry)
    this._persistEntry(sessionId, {
      agentSessionId: found.id,
      cwd,
      flagRoot: flagRoot || cwd,
      model: entry.model,
      codexProfileKey: entry.codexProfileKey,
      codexConfigPath: entry.codexConfigPath,
      codexSecretEnvKey: entry.codexSecretEnvKey,
      useProxy: entry.useProxy,
      proxyMode: entry.proxyMode,
      displayName: displayName || null,
      jsonlPath,
      startedAt: entry.startedAt,
      pendingBind: false,
    })
    // First stream subscribers attach before Codex has a rollout path; emit from byte 0.
    this._ensureWatcher(sessionId, 0)
    log(`[tmux-codex] bound window=${sessionId} to codex_thread=${found.id} via ${foundBy} jsonl=${jsonlPath}`)
    return entry
  }

  // Fold one rollout entry into entry.working: task_complete ends it, task_started or any real
  // agent activity (function call/output, reasoning, message, custom tool call) keeps it working.
  _updateWorkingFromEntry(entry: any, raw: any) {
    if (!entry) return
    if (isCodexTaskComplete(raw)) entry.working = false
    else if (isCodexTaskStart(raw)) entry.working = true
    else if (raw?.type === 'response_item') {
      const pt = raw.payload?.type
      if (['function_call', 'function_call_output', 'reasoning', 'message', 'custom_tool_call', 'custom_tool_call_output'].includes(pt)) entry.working = true
    }
  }

  // Start a new Codex tmux window and return the launch info used to bind its rollout later.
  async _spawnWindow({ sessionId, cwd, flagRoot, model, useProxy, proxyMode, codexProfileKey, codexChannel, codexConfigPath, codexSecretEnvKey, codexSecretValue, displayName, agentSessionId, captureStream = false, aimuxRemoteName }: CodexDispatchOpts) {
    if (!sessionId || !cwd) throw new Error('_spawnWindow requires sessionId + cwd')
    // Make sure the tmux hub session that hosts agent windows exists.
    ensureHub()
    // Launch time, later written into runtime and persisted state.
    const startedAt = Date.now()
    // Snapshot existing Codex threads for this cwd so a new session can spot the added rollout later.
    const knownThreadIds = snapshotThreadIds(cwd)
    // Running flags default to cwd; a caller-supplied flagRoot wins as the stable root.
    const effFlagRoot = flagRoot || cwd
    // Fall back to the backend's default model when none is given.
    const finalModel = model || DEFAULT_MODEL
    // codexChannel first, legacy codexProfileKey second, normalized either way.
    const profileKey = normalizeCodexChannel(codexChannel || codexProfileKey)
    // A Codex profile maps to $CODEX_HOME/<profile>.config.toml.
    const expectedConfigPath = path.join(CODEX_HOME, `${profileKey}.config.toml`)
    // The profile config must exist before launch.
    if (!fs.existsSync(expectedConfigPath)) {
      // Fail hard on a missing config so Codex never starts on the wrong profile.
      throw new Error(`codex channel config missing: ${expectedConfigPath}`)
    }
    // Read the profile config to resolve env_key and any embedded api_key.
    const configText = fs.readFileSync(expectedConfigPath, 'utf8')
    // Secret env var name from the TOML.
    const configEnvKey = tomlStringValue(configText, 'env_key')
    // Normalize the name so no illegal or blank value reaches the export command.
    const secretEnvKey = configEnvKey ? normalizeSecretEnvKey(configEnvKey) : null
    // With an env_key, resolve the secret value injected into the tmux command.
    const secretValue = secretEnvKey
      // A real api_key in the TOML wins; an <API_KEY> placeholder or a missing one defers to the server-stored value.
      ? resolveSecretValue(secretEnvKey, resolveCodexConfigSecretValue(configText, codexSecretValue))
      // No env_key means no exported secret.
      : ''
    // Digital-rain captureStream: per-session codex withproxy toml (base_url→token-proxy, api_key→mpx1 token).
    let finalProfileKey = profileKey
    let withProxyPath: string | null = null
    if (captureStream) {
      try {
        const baseUrl = tomlStringValue(configText, 'base_url')
        const authToken = secretValue || resolveCodexConfigSecretValue(configText, codexSecretValue)
        if (!baseUrl || !authToken) throw new Error(`codex 缺 base_url/api_key (base_url=${!!baseUrl}, authToken=${!!authToken})`)
        const upstream = { wire: 'openai', baseUrl, authToken, model: finalModel, sessionId, agent: displayName || null }
        withProxyPath = writeCodexWithProxy(expectedConfigPath, profileKey, sessionId, upstream)
        finalProfileKey = `${profileKey}.withproxy.${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_')}`
      } catch (e: any) {
        console.warn(`[tmux-codex] per-session withproxy 生成失败, 回落原 profile (${sessionId}): ${e?.message || e}`)
        withProxyPath = null
      }
    }
    // useProxy is fully decoupled from the profile: it only picks the network tier.
    // Four tiers: direct | env | proxychains | env_proxychains (legacy booleans accepted).
    const finalProxyMode = normalizeProxyMode4(proxyMode, normalizeUseProxy(useProxy, false) ? 'env_proxychains' : 'direct')
    const finalUseProxy = finalProxyMode !== 'direct'
    // With a proxy, check that tier's dependencies (env checks only the env file, proxychains only conf+bin).
    if (finalUseProxy) assertProxyAvailable(finalProxyMode)

    // A present agentSessionId means an existing Codex thread should be resumed.
    let useResume = !!agentSessionId
    // rolloutPath points at the existing Codex rollout jsonl once resume succeeds.
    let rolloutPath = null
    // Only resume needs an old rollout lookup.
    if (useResume) {
      // Locate the rollout file for this Codex thread id.
      rolloutPath = codexRolloutPathOf(agentSessionId!)
      // Without a rollout, the resume cannot be trusted.
      if (!rolloutPath) {
        // Warn and degrade to a fresh thread.
        console.warn(`[tmux-codex] resume target rollout not found (${agentSessionId}), starting a new thread`)
        // Turn off the resume path; the code below treats it as a new session.
        useResume = false
      }
    }

    // System calls force codex through --profile: load $CODEX_HOME/<channel>.config.toml and export
    // the secret env var named by the TOML env_key inside the tmux command.
    // Assemble the Codex CLI args: model, cwd, and the approval/sandbox bypass.
    const codexArgs = ['-m', finalModel, '-C', cwd, '--dangerously-bypass-approvals-and-sandbox']
    // TUI/Electron sessions (add_remote_aimux_mcp + aimux_id): inject the aimux stdio MCP server so
    // codex drives the remote workstation through its MCP tools
    // (remote_execute/read_file/write_file/ping/apply_patch).
    // codex parses `-c key=value` values as TOML, so the args use an inline array.
    if (aimuxRemoteName) {
      const aimuxBinPath = resolveAimuxBin()
      // enable_mcp_apps is codex's feature gate for loading mcp_servers (false in the profile by
      // default; end-to-end test: without it mcp_servers never load and the MCP tools are
      // unavailable). It also suppresses the under-development warning.
      codexArgs.push('-c', 'features.enable_mcp_apps=true')
      codexArgs.push('-c', 'suppress_unstable_features_warning=true')
      codexArgs.push('-c', `mcp_servers.aimux.command=${aimuxBinPath}`)
      codexArgs.push('-c', `mcp_servers.aimux.args=["mcp","serve","--remote","${aimuxRemoteName}"]`)
    }
    // In resume mode the thread id is appended to the codex resume subcommand.
    if (useResume && agentSessionId) codexArgs.push(agentSessionId)
    // A new Codex session needs no subcommand; resume needs the "resume " prefix.
    const subcommand = useResume ? 'resume ' : ''
    // Shell-quote every Codex arg and join them into the command string.
    const argStr = codexArgs.filter((a: unknown): a is string => typeof a === 'string').map(shellQuote).join(' ')
    // The profile arg always points at the normalized channel/profile.
    const profileArg = `--profile ${shellQuote(finalProfileKey)}`

    // Build the bash -lc command line by line, joined with && at the end.
    const cmdLines = [
      // Drop VS Code IPC env vars so the CLI cannot attach to a host IDE.
      'unset VSCODE_IPC_HOOK_CLI VSCODE_GIT_IPC_HANDLE VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN',
      // Mark this process as running in a controlled sandbox.
      'export IS_SANDBOX=1',
    ]
    // Split by tier: env loads env-var proxies; proxychains wraps chains; env_proxychains does both;
    // direct starts bare.
    if (finalProxyMode === 'env' || finalProxyMode === 'env_proxychains') {
      // Load the proxy env vars (new name first, legacy .bash as fallback). set -a lets bare
      // assignments in the sourced file (legacy conf with no export prefix) reach the environment
      // and be inherited by child processes; set +a reverts it afterwards.
      cmdLines.push(`set -a && source ${shellQuote(resolveProxyEnvsFile())} && set +a`)
    }
    if (finalProxyMode === 'proxychains' || finalProxyMode === 'env_proxychains') {
      // Start Codex through proxychains, passing the profile, subcommand and args.
      cmdLines.push(`exec proxychains -q -f ${shellQuote(PROXY_CONF)} codex ${profileArg} ${subcommand}${argStr}`)
    } else {
      // direct / env start Codex directly.
      cmdLines.push(`exec codex ${profileArg} ${subcommand}${argStr}`)
    }
    // Join with && so a failing earlier step prevents the exec.
    const cmd = cmdLines.join(' && ')

    // Pre-write project trust to cut the TUI's startup prompts.
    ensureProjectTrusted(cwd)

    // The channel secret rides only on this window's environment: never embedded in the shell
    // command, never written to the backend runtime file.
    const windowEnvEntries = secretEnvKey ? [[secretEnvKey, secretValue]] : []
    const runtimeArgs = windowEnvEntries.flatMap(([key, value]) => ['-e', `${key}=${value}`])
    // Create the background tmux window under the hub session and run bash -lc cmd in cwd.
    const r = tmux(
      ['new-window', '-d', ...runtimeArgs, '-t', HUB, '-n', sessionId, '-c', cwd, 'bash', '-lc', cmd],
      { redactEnvironmentKeys: windowEnvEntries.map(([key]) => key) },
    )
    // Surface stderr on failure so command-level problems are diagnosable.
    if (r.status !== 0) throw new Error(`tmux new-window failed: ${r.stderr}`)
    // Log the launch parameters: model, proxy, profile, secret env key and resume info.
    log(`[tmux-codex] started: window=${sessionId} cwd=${cwd} model=${finalModel} use_proxy=${finalUseProxy ? 1 : 0} profile-v2=${profileKey} secret_env=${secretEnvKey} config=${codexConfigPath || expectedConfigPath}${useResume ? ` resume=${agentSessionId}` : ''}`)

    // Deadline for the TUI to become ready.
    const deadline = Date.now() + READY_TIMEOUT_MS
    // ready flips true once every Codex ready sentinel is on screen.
    let ready = false
    let readyReason = ''
    let historyReadyPolls = 0
    // Last auto trust-confirm press, for rate limiting.
    let lastTrustPress = 0
    // Last auto skip-update press, for rate limiting.
    let lastUpdatePress = 0
    // Last non-empty screen, shown to the caller on timeout.
    let lastScreen = ''
    const target = `${HUB}:${sessionId}`
    // Poll the tmux pane contents until the deadline.
    while (Date.now() < deadline) {
      // A failed capture counts as an empty screen; the next poll retries.
      const { text: screen, historySize } = take_tmux_window_text(target, 100)
      // Keep the newest non-empty screen as the snapshot.
      lastScreen = screen || lastScreen
      const hasUpdatePrompt = UPDATE_PROMPT_SENTINELS.every((s) => screen.includes(s))
      const hasTrustPrompt = TRUST_PROMPT_SENTINELS.some((s) => screen.includes(s))
      // Done when every ready sentinel is visible, or when a restored long session keeps its tmux
      // history above the size threshold.
      if (READY_SENTINELS.every((s) => screen.includes(s))) {
        ready = true
        readyReason = 'sentinels'
        break
      }
      historyReadyPolls = historySize > READY_HISTORY_SIZE_THRESHOLD && !hasUpdatePrompt && !hasTrustPrompt
        ? historyReadyPolls + 1
        : 0
      if (historyReadyPolls >= READY_HISTORY_CONSECUTIVE_POLLS) {
        ready = true
        readyReason = `history_size=${historySize}>${READY_HISTORY_SIZE_THRESHOLD}`
        break
      }
      // Codex update prompt on screen: pick skip automatically.
      if (hasUpdatePrompt) {
        // Current time, to check the key-press interval.
        const now = Date.now()
        // Rate-limit the skip-update key press.
        if (now - lastUpdatePress > UPDATE_PRESS_INTERVAL_MS) {
          // Send "2" and Enter to pick the skip option in the update prompt.
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, '2', 'Enter'])
          // Record the time of this skip-update press.
          lastUpdatePress = now
          // Log that the Codex update prompt was skipped automatically.
          log(`[tmux-codex] window=${sessionId} skipped Codex update prompt (cwd=${cwd})`)
        }
      }
      // Directory trust prompt on screen: auto-confirm.
      if (hasTrustPrompt) {
        // Current time, to check the key-press interval.
        const now = Date.now()
        // Rate-limit the Enter key press.
        if (now - lastTrustPress > TRUST_PRESS_INTERVAL_MS) {
          // Send Enter to the current tmux window, confirming directory trust.
          tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
          // Record the time of this Enter press.
          lastTrustPress = now
          // Log that the trust prompt was handled automatically.
          log(`[tmux-codex] window=${sessionId} confirmed Codex directory trust (cwd=${cwd})`)
        }
      }
      // Wait one poll interval, then re-check the screen.
      await new Promise((r) => setTimeout(r, READY_POLL_MS))
    }
    // Not ready by the deadline: clean up the freshly created window and throw.
    if (!ready) {
      // Do not leave an unusable background window behind.
      tmux(['kill-window', '-t', `${HUB}:${sessionId}`])
      // Condense the last screen into a shorter error detail.
      const detail = summarizeScreen(lastScreen)
      // Hand the caller the timeout, the cwd and the screen summary.
      throw new Error(`Codex TUI was not ready within ${READY_TIMEOUT_MS}ms (cwd=${cwd})${detail ? `; last screen:\n${detail}` : ''}`)
    }
    // Log that the TUI is usable.
    log(`[tmux-codex] window=${sessionId} TUI ready reason=${readyReason}`)

    // A new session does not know its Codex thread id yet; it binds through the added rollout later.
    if (!useResume) {
      // Build the in-memory runtime entry for the new session; agentSessionId/jsonlPath stay empty.
      const entry = {
        // The Codex thread id is only discovered after startup.
        agentSessionId: null,
        // Working directory.
        cwd,
        // Root the running flag is written under.
        flagRoot: effFlagRoot,
        // Model actually used.
        model: finalModel,
        // Codex profile actually used.
        codexProfileKey: finalProfileKey,
        // Codex config path actually used.
        codexConfigPath: codexConfigPath || expectedConfigPath,
        withProxyPath,
        captureStream: !!captureStream,
        // Secret env var name injected into Codex.
        codexSecretEnvKey: secretEnvKey,
        // Proxy toggle actually used.
        useProxy: finalUseProxy,
        // Proxy tier.
        proxyMode: finalProxyMode,
        // Display name for the UI.
        displayName: displayName || null,
        // No rollout bound yet, so jsonlPath is empty.
        jsonlPath: null,
        // Launch time.
        startedAt,
        // No prompt submitted at launch yet, so not working.
        working: false,
        // The watcher is created once the rollout is bound.
        watch: null,
      }
      // Put the new session's runtime state into memory.
      this.runtime.set(sessionId, entry)
      // Persist the launch parameters and set pendingBind until the rollout binds.
      this._persistEntry(sessionId, {
        // Working directory and running-flag root.
        cwd,
        flagRoot: effFlagRoot,
        // Model, profile, config path and secret env var name.
        model: finalModel,
        codexProfileKey: finalProfileKey,
        codexConfigPath: codexConfigPath || expectedConfigPath,
        withProxyPath,
        captureStream: !!captureStream,
        codexSecretEnvKey: secretEnvKey,
        // Proxy toggle, display name and launch time.
        useProxy: finalUseProxy,
        displayName: displayName || null,
        startedAt,
        // The thread/jsonl bind later from the added rollout.
        pendingBind: true,
      })
    } else {
      // A resume session already knows its thread id and rollout path, so it registers full state now.
      const entry = {
        // Restored Codex thread id (non-null whenever useResume holds).
        agentSessionId: agentSessionId || null,
        // Working directory.
        cwd,
        // Root the running flag is written under.
        flagRoot: effFlagRoot,
        // Model actually used.
        model: finalModel,
        // Codex profile actually used.
        codexProfileKey: finalProfileKey,
        // Codex config path actually used.
        codexConfigPath: codexConfigPath || expectedConfigPath,
        withProxyPath,
        captureStream: !!captureStream,
        // Secret env var name injected into Codex.
        codexSecretEnvKey: secretEnvKey,
        // Proxy toggle actually used.
        useProxy: finalUseProxy,
        // Proxy tier.
        proxyMode: finalProxyMode,
        // Display name for the UI.
        displayName: displayName || null,
        // Codex rollout jsonl path already found.
        jsonlPath: rolloutPath,
        // Launch time.
        startedAt,
        // No new prompt submitted yet after the resume, so not working.
        working: false,
        // Watcher placeholder, created immediately below.
        watch: null,
      }
      // Put the resume session's runtime state into memory.
      this.runtime.set(sessionId, entry)
      // Persist the full resume session state.
      this._persistEntry(sessionId, {
        // Restored Codex thread id.
        agentSessionId,
        // Working directory and running-flag root.
        cwd,
        flagRoot: effFlagRoot,
        // Model, profile, config path and secret env var name.
        model: finalModel,
        codexProfileKey: finalProfileKey,
        codexConfigPath: codexConfigPath || expectedConfigPath,
        withProxyPath,
        captureStream: !!captureStream,
        codexSecretEnvKey: secretEnvKey,
        // Proxy toggle, display name and rollout path.
        useProxy: finalUseProxy,
        displayName: displayName || null,
        jsonlPath: rolloutPath,
        // Launch time.
        startedAt,
        // Already bound to a rollout, so no pendingBind.
        pendingBind: false,
      })
      // jsonlPath already exists, so the watcher starts right away.
      this._ensureWatcher(sessionId)
    }

    // Write the running flag so external logic sees this session as running.
    markRunning(effFlagRoot, sessionId)
    // Return the launch time and the old thread snapshot so the caller can spot the added thread of
    // a new session.
    return { startedAt, knownThreadIds }
  }

  /*
   * Deliver a prompt into an already-running codex TUI window: stage the text in a tmux buffer,
   * paste it as one bracketed block, wait until the pane proves it landed, then press Enter.
   * Shared by the initial-context dispatch and the normal queue path; both call it only after
   * ensuring the window exists.
   *
   * The prompt never goes through argv (load-buffer reads stdin), so a long prompt cannot hit
   * ARG_MAX and its text never shows up in ps. Bracketed paste (-p) delivers the text as one
   * atomic block, so the input box does not act on newlines mid-prompt. Enter is withheld until
   * the pane shows the text, because pressing it early submits an empty box.
   *
   * Note the two meanings of -p: bracketed paste for paste-buffer, print-to-stdout for
   * capture-pane.
   */
  async _sendPromptToWindow(sessionId: string, text: string) {
    // 检查tmux窗口是否存在，不存在抛出错误
    // Check tmux window exist, if not, throw error
    if (!windowExists(sessionId)) throw new Error(`window ${sessionId} does not exist`)

    // 取提示词去掉空白后的最后10个字符作为粘贴探针，取不到返回null
    // Take the last 10 whitespace-stripped chars of the prompt as paste probe, null if unusable
    const marker = findPasteMarker(text)

    // 打印窗口、长度和探针，探针可能含中文，用JSON.stringify加引号便于辨认
    // Log window, length and probe; JSON.stringify quotes it, the probe may hold CJK
    log(`[tmux-codex] sendPrompt window=${sessionId} len=${text.length} marker=${marker ? JSON.stringify(marker) : '(none)'}`)

    // tmux buffer是全局共享的，用进程号加毫秒命名避免并发互相覆盖
    // tmux buffers are server-global, name by pid and ms so concurrent sends do not clash
    const bufName = `imac_codex_${process.pid}_${Date.now()}`

    // 末尾的-表示从stdin读，提示词不进命令行，避免超长和泄漏
    // Trailing - reads stdin, keeps the prompt out of argv and ps
    const r1 = tmux(['load-buffer', '-b', bufName, '-'], { input: text })
    // 装载buffer失败直接抛出错误
    // Throw when loading the buffer fails
    if (r1.status !== 0) throw new Error(`tmux load-buffer failed: ${r1.stderr}`)

    // -p括号粘贴，-d粘贴成功后删buffer，-t指定目标窗口
    // -p bracketed paste, -d drop the buffer, -t target window
    const r2 = tmux(['paste-buffer', '-p', '-d', '-b', bufName, '-t', `${HUB}:${sessionId}`])
    if (r2.status !== 0) {
      // -d只在成功时生效，失败要手动清理buffer
      // -d only fires on success, clean the buffer by hand here
      tmux(['delete-buffer', '-b', bufName])
      // 粘贴失败抛出错误
      // Throw when pasting fails
      throw new Error(`tmux paste-buffer failed: ${r2.stderr}`)
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
      await new Promise((r) => setTimeout(r, PASTE_PROBE_INTERVAL_MS))
      attempt += 1
      // 只截最后80行，够覆盖输入框且开销小
      // Only the last 80 lines, enough for the input box and cheap
      const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-S', '-80'])
      // 截屏失败也要记一笔，排查时能区分没粘上还是没截到
      // Log a failed capture too, so a miss can be told apart from a blank screen
      if (pane.status !== 0) {
        log(`[tmux-codex] paste poll window=${sessionId} attempt=${attempt} capture=failed`)
        continue
      }
      // 比对前去掉面板里的空格和换行，避免TUI折行导致匹配不上
      // Strip the pane's whitespace before comparing, so TUI wrapping cannot break the match
      const compactPane = pane.stdout.replace(/\s+/g, '')
      const hitMarker = !!marker && compactPane.includes(marker)
      const hitPlaceholder = PASTE_PLACEHOLDER_RE.test(pane.stdout)
      // 每次轮询都记录结果，命中与否都要能看到
      // Log every poll, hit or miss, so the whole match stays visible when debugging
      log(`[tmux-codex] paste poll window=${sessionId} attempt=${attempt} marker=${hitMarker} placeholder=${hitPlaceholder} elapsed=${Date.now() - pasteWaitStartedAt}ms`)
      if (hitMarker || hitPlaceholder) {
        saw = true
        break
      }
    }
    // 超时也照样按回车，不能把这一轮卡死
    // Send Enter anyway on timeout, do not strand the turn
    if (!saw) console.warn(`[tmux-codex] paste marker/placeholder did not appear within ${PASTE_SLEEP_MAX_MS}ms (attempts=${attempt}); sending Enter anyway`)

    // 按回车前先标记为工作中，避免状态轮询误判这一轮已结束
    // Mark busy before Enter, so a status poll does not read idle
    const entry = this.runtime.get(sessionId)
    if (entry) entry.working = true

    // TUI偶发吞掉第一次回车，重发三次，重发是幂等的
    // The TUI sometimes swallows the first Enter, retries are idempotent
    for (let i = 0; i < SUBMIT_ENTER_ATTEMPTS; i++) {
      // 发送回车提交提示词
      // Send Enter to submit the prompt
      const r = tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
      // 回车发不出去说明窗口有问题，直接抛出错误
      // A window that cannot take Enter will not recover, throw
      if (r.status !== 0) throw new Error(`tmux send-keys Enter failed: ${r.stderr}`)
      // 最后一次不用再等
      // No wait after the last attempt
      if (i < SUBMIT_ENTER_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, SUBMIT_ENTER_INTERVAL_MS))
    }

    // 恢复旧会话时TUI显示Resume提示并吞掉回车，三次重发都无效，交给它专门等
    // Reopening an old session shows a Resume notice and swallows Enter, hand off to the waiter
    await this._patchSlowSessionLoading(sessionId)

    // 记录一次提示词投递，内部吞掉异常，不影响投递
    // Record one prompt delivery, it swallows its own failures
    recordPromptPaste({ backendName: this.name, sessionId, contentLength: text.length })
  }

  /*
   * Reopening an old session makes codex reload the rollout while showing "Resuming session…",
   * and Enter is swallowed for that whole window, so a prompt pasted in the meantime sits in the
   * input box unsent.
   *
   * Wait the notice out: while it is still on screen, nudge with an Enter every RESUME_POLL_MS
   * until RESUME_WAIT_MAX_MS. Once it disappears, send one final Enter to land the submit that
   * was dropped. On timeout send no extra Enter at all, because a prompt that may already have
   * been submitted must not be submitted twice.
   *
   * Past that, one more guard runs on every send: a prompt whose paste collapsed into the
   * "[Pasted Content N chars]" placeholder can sit in the composer unsent — no turn starts, so
   * codex never records a thread and the bind that follows times out. When the placeholder is
   * still on screen after the submit Enters, wait SUBMIT_RECHECK_DELAY_MS and press Enter once
   * more (an Enter on an already-submitted, empty composer is a no-op).
   */
  async _patchSlowSessionLoading(sessionId: string) {
    // 先截一次屏，屏幕上没有Resume提示就跳过恢复等待
    // Capture once first, skip the resume wait when the notice is absent
    const resumeCheck = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-S', '-20'])
    if (resumeCheck.status === 0 && resumeCheck.stdout.includes(RESUME_SENTINEL)) {
      const resumeStartedAt = Date.now()
      log(`[tmux-codex] resuming session detected window=${sessionId}, waiting up to ${RESUME_WAIT_MAX_MS}ms`)
      const resumeDeadline = resumeStartedAt + RESUME_WAIT_MAX_MS
      let resumeFinished = false
      let resumeAttempt = 0
      while (Date.now() < resumeDeadline) {
        // 每2秒看一次屏幕
        // Check the pane every 2 seconds
        await new Promise((r) => setTimeout(r, RESUME_POLL_MS))
        resumeAttempt += 1
        const pane = tmux(['capture-pane', '-pt', `${HUB}:${sessionId}`, '-p', '-S', '-20'])
        // 截屏失败也要记一笔，排查时能区分没恢复完还是没截到屏
        // Log a failed capture too, so a stuck resume can be told apart from a blank screen
        if (pane.status !== 0) {
          log(`[tmux-codex] resume poll window=${sessionId} attempt=${resumeAttempt} capture=failed`)
          continue
        }
        // 提示消失说明恢复完成，跳出等待
        // The notice is gone, the resume finished, stop waiting
        if (!pane.stdout.includes(RESUME_SENTINEL)) { resumeFinished = true; break }
        // 还在恢复中，先记一笔再补一次回车
        // Still resuming: log the round first, then nudge with another Enter
        log(`[tmux-codex] still resuming window=${sessionId} attempt=${resumeAttempt} elapsed=${Date.now() - resumeStartedAt}ms`)
        tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
      }
      // 恢复完成后补最后一次回车，把之前被吞掉的提交补上
      // One final Enter once the notice is gone, landing the submit that was dropped
      if (resumeFinished) {
        tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
        log(`[tmux-codex] resuming session finished window=${sessionId}, attempts=${resumeAttempt} final Enter sent`)
      // 超时就不再补回车，避免把提示词提交两次
      // On timeout send no extra Enter, so the prompt is never submitted twice
      } else {
        log(`[tmux-codex] still resuming window=${sessionId} gave up after ${RESUME_WAIT_MAX_MS}ms attempts=${resumeAttempt}`)
      }
    }

    // 提交校验：占位符还在屏幕上，说明这一轮没被提交
    // Submit check: the placeholder still on screen means this turn was never submitted
    await new Promise((r) => setTimeout(r, 200))
    if (!codexComposerHoldsPastedText(sessionId)) return
    log(`[tmux-codex] submit check window=${sessionId} paste placeholder still on screen, re-Enter in ${SUBMIT_RECHECK_DELAY_MS}ms`)
    await new Promise((r) => setTimeout(r, SUBMIT_RECHECK_DELAY_MS))
    // 延迟结束后补按一次回车，把卡在输入框里的提示词提交出去
    // One more Enter after the delay, landing the prompt stuck in the composer
    tmux(['send-keys', '-t', `${HUB}:${sessionId}`, 'Enter'])
    log(`[tmux-codex] submit check window=${sessionId} re-Enter sent`)
  }
}

module.exports = {
  TmuxCodexBackend,
  HUB,
  codexRolloutPathOf,
  codexThreadTitleById,
  codexThreadIdFromRolloutPath,
  runningFlagPathOf,
  failedFlagPathOf,
  findCodexRecentErrorInPane,
  resolveCodexConfigSecretValue,
}

// marker: make this file a module (top-level declarations file-private) for tsc
export {}
