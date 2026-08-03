const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-codex-error-scan-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.on('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }))

const { findCodexRecentErrorInPane } = require('../backend/agents/tmux-codex')

const interrupted = '\x1b[0m■ Conversation interrupted - tell the model what to do differently. Something went wrong? Hit `/feedback` to report the issue.'

assert.strictEqual(findCodexRecentErrorInPane(interrupted), null)
assert.strictEqual(
  findCodexRecentErrorInPane(`■ API request failed with status 403\n${interrupted}`),
  null,
  'a newer user interruption must not expose an older stale error',
)
assert.deepStrictEqual(findCodexRecentErrorInPane('\x1b[31m■ API request failed with status 403\x1b[0m'), {
  message: '■ API request failed with status 403',
  rawLine: '\x1b[31m■ API request failed with status 403\x1b[0m',
})
assert.deepStrictEqual(findCodexRecentErrorInPane('  ⚠ Selected model is at capacity'), {
  message: '⚠ Selected model is at capacity',
  rawLine: '  ⚠ Selected model is at capacity',
})
assert.deepStrictEqual(
  findCodexRecentErrorInPane(`Conversation text mentioning Conversation interrupted\n■ Latest real failure`),
  {
    message: '■ Latest real failure',
    rawLine: '■ Latest real failure',
  },
)
assert.strictEqual(findCodexRecentErrorInPane('normal output only'), null)

console.log('codex error scan: ok')
