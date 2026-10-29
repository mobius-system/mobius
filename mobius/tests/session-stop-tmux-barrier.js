/**
 * Exercise Claude and Codex hard-stop barriers against real tmux windows.
 *
 * A second operation is queued immediately behind stop on the same backend lock. It may observe the
 * session only after the old window has disappeared and its watcher has stopped; this is the exact
 * ordering that prevents a fast follow-up send from targeting a window still dying from /stop.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-stop-barrier-'))
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.MOBIUS_AGENT_TMUX_SOCKET = `mobius-stop-${process.pid}`

const { tmux, AGENT_TMUX_SOCKET } = require('../backend/agents/tmux-operation-log')
const { TmuxClaudeCodeBackend } = require('../backend/agents/tmux-claude-code')
const { TmuxCodexBackend } = require('../backend/agents/tmux-codex')

function windowExists(hub, sessionId) {
  const result = tmux(['list-windows', '-t', hub, '-F', '#{window_name}'])
  return result.status === 0 && result.stdout.split('\n').includes(sessionId)
}

function createWindow(hub, sessionId) {
  const hubResult = tmux(['new-session', '-d', '-s', hub, '-n', '_root'])
  assert.equal(hubResult.status, 0, hubResult.stderr)
  const windowResult = tmux(['new-window', '-d', '-t', hub, '-n', sessionId, 'bash', '-lc', 'while :; do sleep 60; done'])
  assert.equal(windowResult.status, 0, windowResult.stderr)
  assert.equal(windowExists(hub, sessionId), true)
}

async function verifyBackend({ label, Backend, hub, entry }) {
  const sessionId = `${label}-${process.pid}`
  let watcherStopped = false
  const backend = new Backend()
  backend.runtime.set(sessionId, {
    ...entry,
    cwd: tempRoot,
    flagRoot: tempRoot,
    watch: { stop: () => { watcherStopped = true } },
  })
  createWindow(hub, sessionId)

  const stop = backend.pauseCurrentAndTerminateSession({ sessionId, cwd: tempRoot, flagRoot: tempRoot })
  const queuedBehindStop = backend._withLock(sessionId, () => ({
    oldWindowExists: windowExists(hub, sessionId),
    watcherStopped,
  }))
  const observed = await queuedBehindStop
  await stop

  assert.deepEqual(observed, { oldWindowExists: false, watcherStopped: true }, `${label}: lock released before hard-stop completed`)
  assert.equal(windowExists(hub, sessionId), false, `${label}: old window survived stop`)
  assert.equal(backend.runtime.get(sessionId)?.watch, null, `${label}: stale watcher survived stop`)
}

async function main() {
  try {
    await verifyBackend({
      label: 'claude',
      Backend: TmuxClaudeCodeBackend,
      hub: 'imac_claude_code_agent_hub',
      entry: {
        agentSessionId: 'claude-agent-session', model: null, useProxy: false, forceNoProxy: true,
        settingsPath: null, displayName: null, jsonlPath: path.join(tempRoot, 'claude.jsonl'), startedAt: Date.now(),
      },
    })
    await verifyBackend({
      label: 'codex',
      Backend: TmuxCodexBackend,
      hub: 'imac_codex_agent_hub',
      entry: {
        agentSessionId: 'codex-agent-session', model: 'test', useProxy: false, proxyMode: 'direct', working: true,
        codexProfileKey: null, codexConfigPath: null, codexSecretEnvKey: null, displayName: null,
        jsonlPath: path.join(tempRoot, 'codex.jsonl'), startedAt: Date.now(),
      },
    })
    console.log('session stop tmux barrier: ok')
  } finally {
    tmux(['kill-server'])
    fs.rmSync(tempRoot, { recursive: true, force: true })
    assert(AGENT_TMUX_SOCKET.startsWith('mobius-stop-'))
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
