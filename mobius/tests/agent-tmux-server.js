const assert = require('assert')
const { spawnSync } = require('child_process')

const socket = `mobius-agent-test-${process.pid}`
process.env.MOBIUS_AGENT_TMUX_SOCKET = socket

const {
  AGENT_TMUX_HISTORY_LIMIT,
  AGENT_TMUX_SOCKET,
  ensureAgentTmuxServer,
  shouldRecordTmuxCommand,
  tmux,
} = require('../backend/agents/tmux-operation-log')

function direct(args) {
  return spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' })
}

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

try {
  assert.strictEqual(AGENT_TMUX_SOCKET, socket)
  assert.strictEqual(shouldRecordTmuxCommand(['-L', socket, 'capture-pane', '-pt', 'x']), false)
  assert.strictEqual(shouldRecordTmuxCommand(['-L', socket, 'list-windows', '-t', 'x']), false)
  assert.strictEqual(shouldRecordTmuxCommand(['-L', socket, 'send-keys', '-t', 'x', 'Enter']), true)
  ensureAgentTmuxServer()
  assert.strictEqual(direct(['show-options', '-gv', 'history-limit']).stdout.trim(), String(AGENT_TMUX_HISTORY_LIMIT))
  assert.strictEqual(direct(['show-options', '-gv', 'exit-empty']).stdout.trim(), 'off')

  const hub = 'test_agent_hub'
  assert.strictEqual(tmux(['new-session', '-d', '-s', hub, '-n', '_root']).status, 0)
  assert.notStrictEqual(spawnSync('tmux', ['has-session', '-t', hub]).status, 0)
  assert.strictEqual(tmux(['new-window', '-d', '-t', hub, '-n', 'probe', 'bash']).status, 0)
  assert.strictEqual(tmux(['load-buffer', '-b', 'probe-buffer', '-'], { input: 'printf mobius-private-server-ok' }).status, 0)
  assert.strictEqual(tmux(['paste-buffer', '-p', '-d', '-b', 'probe-buffer', '-t', `${hub}:probe`]).status, 0)
  assert.strictEqual(tmux(['send-keys', '-t', `${hub}:probe`, 'Enter']).status, 0)
  wait(200)
  const captured = tmux(['capture-pane', '-pt', `${hub}:probe`, '-S', '-20'])
  assert.strictEqual(captured.status, 0)
  assert.match(captured.stdout, /mobius-private-server-ok/)

  // External server removal must be healed by the next operation.
  assert.strictEqual(direct(['kill-server']).status, 0)
  assert.notStrictEqual(tmux(['has-session', '-t', hub]).status, 0)
  assert.strictEqual(direct(['show-options', '-gv', 'history-limit']).stdout.trim(), String(AGENT_TMUX_HISTORY_LIMIT))
  assert.strictEqual(direct(['show-options', '-gv', 'exit-empty']).stdout.trim(), 'off')

  console.log('agent tmux private server test passed')
} finally {
  direct(['kill-server'])
}
