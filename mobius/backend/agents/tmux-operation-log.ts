const fs = require('fs')
const path = require('path')
const util = require('util')
const { spawnSync } = require('child_process')

const { AGENT_TMUX_SOCKET, TEST_ROOT } = require('../config')

const LOG_FILE = path.join(TEST_ROOT, 'logs', 'tmux-operation.log')
// Agent tmux runs in its own server, isolated from a user's/default tmux server.
// Keep one server for both agent backends so the existing backend hub sessions
// remain independently addressable while all agent operations share one socket.
const AGENT_TMUX_HISTORY_LIMIT = 100000
// Force every detached agent pane to advertise TERM=tmux-256color so claude-code /
// codex agents (and any tool they spawn) see a proper 256-color terminal regardless
// of the ambient TERM of the process that started mobius.
const AGENT_TMUX_DEFAULT_TERM = 'tmux-256color'
let warned = false
let serverReady = false

// tmux 调用选项: input = 写入 stdin 的文本; redactEnvironmentKeys = 日志脱敏的 env 前缀;
// 其余字段原样透传给 spawnSync.
interface TmuxCallOpts {
  input?: string
  redactEnvironmentKeys?: string[]
  [key: string]: unknown
}

function singleQuote(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function bashAnsiQuote(value: unknown): string {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\f/g, '\\f')
    .replace(/\v/g, '\\v')
    .replace(/\x1b/g, '\\e')
    .replace(/[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f]/g, (ch: string) => {
      return `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
    })
  return `$'${escaped}'`
}

function shellQuote(value: unknown): string {
  const s = String(value)
  if (s.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  if (/[\x00-\x1f\x7f]/.test(s)) return bashAnsiQuote(s)
  return singleQuote(s)
}

function tmuxCommandString(args: string[], opts: TmuxCallOpts = {}) {
  const command = ['tmux', ...args].map(shellQuote).join(' ')
  if (!Object.prototype.hasOwnProperty.call(opts, 'input')) return command
  return `printf %s ${bashAnsiQuote(opts.input ?? '')} | ${command}`
}

function redactEnvironmentArgs(args: string[], keys: string[] = []): string[] {
  const prefixes = new Set(
    (Array.isArray(keys) ? keys : [])
      .filter((key: unknown) => typeof key === 'string' && key)
      .map((key: string) => `${key}=`),
  )
  if (prefixes.size === 0) return args
  return args.map((arg: string) => {
    const value = String(arg)
    for (const prefix of prefixes) {
      if (value.startsWith(prefix)) return `${prefix}***`
    }
    return arg
  })
}

function agentTmuxServerExists() {
  // `tmux -L <socket> list-sessions` connects to the server: status 0 means a
  // server is already listening on the socket (even with zero sessions), while
  // status 1 with "no server running" / "No such file" means we must create one.
  // (Note: `tmux info` is NOT a reliable probe — it exits non-zero even on a
  // healthy server on some tmux builds.)
  const probe = spawnSync('tmux', ['-L', AGENT_TMUX_SOCKET, 'list-sessions'], { encoding: 'utf8' })
  return probe.status === 0
}

function normalizeExistingSessionsTerminal() {
  // The agent tmux server outlives mobius restarts, so a HUB session created
  // before `default-terminal` was pinned keeps its old value and would spawn
  // new agent windows with the wrong TERM. `set-option -g` only governs future
  // sessions, so also rewrite every existing session's default-terminal here.
  // Best-effort: never abort boot on a per-session failure. Panes already
  // running keep their current $TERM — only windows opened afterwards pick
  // this up.
  const list = spawnSync('tmux', ['-L', AGENT_TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
  if (list.status !== 0) return
  const sessions = (list.stdout || '').split('\n').map((s: string) => s.trim()).filter(Boolean)
  for (const name of sessions) {
    const r = spawnSync('tmux', ['-L', AGENT_TMUX_SOCKET, 'set-option', '-t', name, 'default-terminal', AGENT_TMUX_DEFAULT_TERM], { encoding: 'utf8' })
    if (r.status !== 0 && !warned) {
      warned = true
      console.warn(`[tmux-agent-server] set default-terminal for session "${name}" failed: ${(r.stderr || '').trim()}`)
    }
  }
}

function ensureAgentTmuxServer() {
  if (serverReady) return

  const existed = agentTmuxServerExists()

  // A tmux server normally exits immediately while it has no sessions.  Keep
  // this private server alive with exit-empty=off, apply the scrollback limit,
  // and pin default-terminal so every detached agent pane runs with
  // TERM=tmux-256color. `start-server` is idempotent (a no-op when a server is
  // already up), so running the whole chain again re-applies the options to a
  // pre-existing server instead of only configuring a freshly created one.
  const configured = spawnSync('tmux', [
    '-L', AGENT_TMUX_SOCKET,
    'start-server', ';',
    'set-option', '-g', 'exit-empty', 'off', ';',
    'set-option', '-g', 'history-limit', String(AGENT_TMUX_HISTORY_LIMIT), ';',
    'set-option', '-g', 'default-terminal', AGENT_TMUX_DEFAULT_TERM,
  ], { encoding: 'utf8' })
  if (configured.status !== 0) {
    throw new Error(`tmux agent server 初始化失败 (socket=${AGENT_TMUX_SOCKET}): ${configured.stderr || configured.error?.message || ''}`)
  }
  normalizeExistingSessionsTerminal()
  serverReady = true
  log(`[tmux-agent-server] ready (socket=${AGENT_TMUX_SOCKET}, ${existed ? 'reused existing' : 'created new'} server, default-terminal=${AGENT_TMUX_DEFAULT_TERM})`)
}

function shouldRecordTmuxCommand(args: string[]) {
  const commandArgs = args[0] === '-L' ? args.slice(2) : args
  if (commandArgs[0] === 'capture-pane') return false
  if (commandArgs[0] === 'list-windows' && commandArgs.includes('-t')) return false
  return true
}

function recordTmuxCommand(args: string[], opts: TmuxCallOpts = {}) {
  if (!shouldRecordTmuxCommand(args)) return

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    const safeArgs = redactEnvironmentArgs(args, opts.redactEnvironmentKeys)
    fs.appendFileSync(LOG_FILE, `${tmuxCommandString(safeArgs, opts)}\n`)
  } catch (e) {
    if (!warned) {
      warned = true
      console.warn(`[tmux-operation-log] append failed (${LOG_FILE}): ${e.message}`)
    }
  }
}

function tmux(args: string[], opts: TmuxCallOpts = {}) {
  ensureAgentTmuxServer()
  const effectiveArgs = ['-L', AGENT_TMUX_SOCKET, ...args]
  recordTmuxCommand(effectiveArgs, opts)
  const { redactEnvironmentKeys: _redactEnvironmentKeys, ...spawnOpts } = opts
  let result = spawnSync('tmux', effectiveArgs, { encoding: 'utf8', ...spawnOpts })
  const errorText = `${result.stderr || ''} ${result.error?.message || ''}`
  if (result.status !== 0 && /no server running|failed to connect to server/i.test(errorText)) {
    // The private server may have been killed externally after the one-time
    // initialization. Recreate/reconfigure it and retry the original action.
    serverReady = false
    ensureAgentTmuxServer()
    result = spawnSync('tmux', effectiveArgs, { encoding: 'utf8', ...spawnOpts })
  }
  return result
}

function log(...args: unknown[]) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, `${util.format(...args)}\n`)
  } catch (e) {
    if (!warned) {
      warned = true
      console.warn(`[tmux-operation-log] append failed (${LOG_FILE}): ${e.message}`)
    }
  }
  console.log(...args)
}

module.exports = {
  LOG_FILE,
  AGENT_TMUX_SOCKET,
  AGENT_TMUX_HISTORY_LIMIT,
  AGENT_TMUX_DEFAULT_TERM,
  agentTmuxServerExists,
  ensureAgentTmuxServer,
  log,
  redactEnvironmentArgs,
  recordTmuxCommand,
  shouldRecordTmuxCommand,
  tmux,
  tmuxCommandString,
}

// marker: make this file a module (top-level declarations file-private) for tsc
export {}
