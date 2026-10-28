const assert = require('node:assert/strict')
const fs = require('node:fs')
const childProcess = require('node:child_process')
const modelAccessPath = require.resolve('../backend/services/model-access')
require.cache[modelAccessPath] = { id: modelAccessPath, filename: modelAccessPath, loaded: true, exports: {
  findClaudeCodeModel: model => model.endsWith(':missing') ? null : { settings_path: '/test/settings.json', claude_model: 'test-claude' },
  findCodexModel: () => ({ key: 'testchannel', codex_model: 'test-codex', secret_env_key: 'TEST_MODEL_KEY', secret_value: 'secret-value' }),
} }
let mode = 'success'
let lastCall
childProcess.execFile = (command, args, options, callback) => {
  lastCall = { command, args, options }
  if (mode === 'timeout') return callback({ killed: true }, '', '')
  if (mode === 'failure') return callback(new Error('failed'), '', 'bad secret-value')
  if (command === 'codex') fs.writeFileSync(args[args.indexOf('-o') + 1], mode === 'empty' ? '' : 'OK')
  callback(null, mode === 'empty' ? '' : 'OK', '')
}
const { testAccessModel } = require('../backend/services/model-access-test')
;(async () => {
  await assert.rejects(testAccessModel('unknown'), /不支持/)
  await assert.rejects(testAccessModel('claude-code:missing'), /不存在/)
  assert.equal((await testAccessModel('claude-code:test')).ok, true)
  assert.equal(lastCall.command, 'claude')
  assert.equal(lastCall.args[lastCall.args.indexOf('--tools') + 1], '')
  assert.equal(fs.existsSync(lastCall.options.cwd), false)
  assert.equal((await testAccessModel('codex:testchannel')).ok, true)
  assert.equal(lastCall.options.env.TEST_MODEL_KEY, 'secret-value')
  assert.equal(lastCall.args[lastCall.args.indexOf('--profile') + 1], 'testchannel')
  assert.equal(lastCall.args[lastCall.args.indexOf('--sandbox') + 1], 'read-only')
  mode = 'failure'
  const failed = await testAccessModel('codex:testchannel')
  assert.equal(failed.ok, false)
  assert.equal(failed.text.includes('secret-value'), false)
  mode = 'timeout'
  assert.match((await testAccessModel('codex:testchannel')).text, /超时/)
  mode = 'empty'
  assert.equal((await testAccessModel('claude-code:test')).ok, false)
  console.log('model-access-test: all assertions passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
