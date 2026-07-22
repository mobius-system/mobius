const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-claude-realtime-info-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.on('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }))

const { findClaudeRealTimeInfo } = require('../backend/agents/tmux-claude-code')

const regularStatus = '✻ Propagating… (7m 44s · ↓ 24.1k tokens)'
const retryStatus = '✻ Unable to connect to API (ConnectionRefused) · Retrying in 25s · attempt 10/10'

assert.strictEqual(findClaudeRealTimeInfo(regularStatus), regularStatus)
assert.strictEqual(findClaudeRealTimeInfo(`${retryStatus}\n  ⎿  Tip: Use /btw to ask a quick side question`), retryStatus)
assert.strictEqual(findClaudeRealTimeInfo(`${regularStatus}\n${retryStatus}`), retryStatus)
assert.strictEqual(findClaudeRealTimeInfo('Unable to connect to API (ConnectionRefused)\nRetrying soon'), '')

console.log('claude realtime info: ok')
