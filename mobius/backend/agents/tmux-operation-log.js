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
let warned = false
let serverReady = false

function singleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function bashAnsiQuote(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\f/g, '\\f')
    .replace(/\v/g, '\\v')
    .replace(/\x1b/g, '\\e')
    .replace(/[\x00-\x08\x0e-\x1a\x1c-\x1f\x7f]/g, (ch) => {
      return `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`
    })
  return `$'${escaped}'`
}

function shellQuote(value) {
  const s = String(value)
  if (s.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  if (/[\x00-\x1f\x7f]/.test(s)) return bashAnsiQuote(s)
  return singleQuote(s)
}

function tmuxCommandString(args, opts = {}) {
  const command = ['tmux', ...args].map(shellQuote).join(' ')
  if (!Object.prototype.hasOwnProperty.call(opts, 'input')) return command
  return `printf %s ${bashAnsiQuote(opts.input ?? '')} | ${command}`
}

function ensureAgentTmuxServer() {
  if (serverReady) return

  // A tmux server normally exits immediately while it has no sessions.  Keep
  // this private server alive with exit-empty=off, then apply the scrollback
  // limit in the same invocation so a newly-created server cannot disappear
  // between start-server and set-option.
  const configured = spawnSync('tmux', [
    '-L', AGENT_TMUX_SOCKET,
    'start-server', ';',
    'set-option', '-g', 'exit-empty', 'off', ';',
    'set-option', '-g', 'history-limit', String(AGENT_TMUX_HISTORY_LIMIT),
  ], { encoding: 'utf8' })
  if (configured.status !== 0) {
    throw new Error(`tmux agent server 初始化失败 (socket=${AGENT_TMUX_SOCKET}): ${configured.stderr || configured.error?.message || ''}`)
  }
  serverReady = true
}

function shouldRecordTmuxCommand(args) {
  const commandArgs = args[0] === '-L' ? args.slice(2) : args
  if (commandArgs[0] === 'capture-pane') return false
  if (commandArgs[0] === 'list-windows' && commandArgs.includes('-t')) return false
  return true
}

function recordTmuxCommand(args, opts = {}) {
  if (!shouldRecordTmuxCommand(args)) return

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, `${tmuxCommandString(args, opts)}\n`)
  } catch (e) {
    if (!warned) {
      warned = true
      console.warn(`[tmux-operation-log] append failed (${LOG_FILE}): ${e.message}`)
    }
  }
}

function tmux(args, opts = {}) {
  ensureAgentTmuxServer()
  const effectiveArgs = ['-L', AGENT_TMUX_SOCKET, ...args]
  recordTmuxCommand(effectiveArgs, opts)
  let result = spawnSync('tmux', effectiveArgs, { encoding: 'utf8', ...opts })
  const errorText = `${result.stderr || ''} ${result.error?.message || ''}`
  if (result.status !== 0 && /no server running|failed to connect to server/i.test(errorText)) {
    // The private server may have been killed externally after the one-time
    // initialization. Recreate/reconfigure it and retry the original action.
    serverReady = false
    ensureAgentTmuxServer()
    result = spawnSync('tmux', effectiveArgs, { encoding: 'utf8', ...opts })
  }
  return result
}

function log(...args) {
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
  ensureAgentTmuxServer,
  log,
  recordTmuxCommand,
  shouldRecordTmuxCommand,
  tmux,
  tmuxCommandString,
}
