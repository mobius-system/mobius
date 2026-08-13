const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-model-access-'))
process.env.MODEL_ACCESS_PATH = path.join(root, 'model-access.json')

async function main() {
  const modelAccess = require('../backend/services/model-access')

  assert.throws(() => modelAccess.upsertHarnessModel({
    key: 'missing-secret',
    model: 'deepseek-chat',
  }), /API Key/)

  const created = modelAccess.upsertHarnessModel({
    key: 'deepseek-test',
    label: 'DeepSeek Test',
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    base_url: 'https://api.deepseek.com/',
    secret_value: 'test-secret-that-must-not-be-public',
    max_tokens: 8192,
    enabled: true,
  })
  assert.equal(created.session_model, 'deepseek-harness:deepseek-test')
  assert.equal(created.base_url, 'https://api.deepseek.com')
  assert.equal(created.secret_value_set, true)
  assert.equal(Object.prototype.hasOwnProperty.call(created, 'secret_value'), false)

  const publicRow = modelAccess.findHarnessModel(created.session_model)
  assert.equal(Object.prototype.hasOwnProperty.call(publicRow, 'secret_value'), false)
  const privateRow = modelAccess.findHarnessModel(created.session_model, { includeSecret: true })
  assert.equal(privateRow.secret_value, 'test-secret-that-must-not-be-public')

  modelAccess.upsertHarnessModel({
    label: 'Updated',
    model: 'deepseek-reasoner',
    base_url: 'https://api.deepseek.com',
    secret_value: '',
    max_tokens: null,
    enabled: false,
  }, { existingKey: 'deepseek-test' })
  const updated = modelAccess.findHarnessModel('deepseek-test', { includeSecret: true })
  assert.equal(updated.secret_value, 'test-secret-that-must-not-be-public')
  assert.equal(updated.model, 'deepseek-reasoner')
  assert.equal(updated.max_tokens, null)
  assert.equal(modelAccess.listHarnessModels({ enabledOnly: true }).length, 0)

  assert.equal(modelAccess.deleteHarnessModel('deepseek-test'), true)
  assert.equal(modelAccess.findHarnessModel('deepseek-test'), null)
  assert.equal(modelAccess.deleteHarnessModel('deepseek-test'), false)
  console.log('deepseek-harness-model-access: ok')
}

main()
  .finally(() => fs.rmSync(root, { recursive: true, force: true }))
  .catch((error) => { console.error(error); process.exitCode = 1 })
