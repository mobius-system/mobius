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

const { findClaudeRealTimeInfo, detectDangerPermission } = require('../backend/agents/tmux-claude-code')

const regularStatus = '✻ Propagating… (7m 44s · ↓ 24.1k tokens)'
const retryStatus = '✻ Unable to connect to API (ConnectionRefused) · Retrying in 25s · attempt 10/10'

assert.strictEqual(findClaudeRealTimeInfo(regularStatus), regularStatus)
assert.strictEqual(findClaudeRealTimeInfo(`${retryStatus}\n  ⎿  Tip: Use /btw to ask a quick side question`), retryStatus)
assert.strictEqual(findClaudeRealTimeInfo(`${regularStatus}\n${retryStatus}`), retryStatus)
assert.strictEqual(findClaudeRealTimeInfo('Unable to connect to API (ConnectionRefused)\nRetrying soon'), '')

const variablePathWarning = 'Dangerous rm operation on possibly-empty variable path: "$BASE/$f"'
const variablePathPrompt = `# Rule 3: delete forbidden files
rm -v "$BASE/$f"

 ${variablePathWarning}

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend · ctrl+e to explain`
assert.deepStrictEqual(detectDangerPermission(variablePathPrompt), {
  pending: true,
  warning: variablePathWarning,
})

const ancestorWarning = 'Dangerous rm operation on working directory or its ancestor: /tmp/worktree'
assert.deepStrictEqual(detectDangerPermission(`${ancestorWarning}\nDo you want to proceed?\nEsc to cancel`), {
  pending: true,
  warning: ancestorWarning,
})
assert.deepStrictEqual(detectDangerPermission(variablePathWarning), { pending: false, warning: null })
assert.deepStrictEqual(
  detectDangerPermission(`${variablePathWarning}\nDo you want to proceed?`),
  { pending: false, warning: null },
)

console.log('claude realtime info: ok')
