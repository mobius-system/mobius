const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-bestapi-integration-'))
process.env.HOME = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.BESTAPI_CONNECTION_PATH = path.join(tempRoot, 'bestapi-connection.json')

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

const harnessSpecs = {
  codex: {
    id: 'codex', backend: 'codex', protocol: 'openai_responses',
    endpoint_path: '/v1/responses', config_profile: 'codex_responses_v1',
  },
  'claude-code': {
    id: 'claude-code', backend: 'claude_code', protocol: 'anthropic_messages',
    endpoint_path: '/v1/messages', config_profile: 'claude_code_messages_v1',
  },
  'deepseek-harness': {
    id: 'deepseek-harness', backend: 'deepseek_harness', protocol: 'openai_chat_completions',
    endpoint_path: '/v1/chat/completions', config_profile: 'deepseek_harness_openai_v1',
  },
}

function mobiusContract(preferred, harnesses = [preferred]) {
  return {
    schema_version: 1,
    preferred_harness: preferred,
    harnesses: harnesses.map((id) => harnessSpecs[id]),
  }
}

async function main() {
  let catalogRequests = 0
  let catalogRevision = 1
  let catalogModels = [{
    id: 'deepseek-chat', display_name: 'DeepSeek Chat',
    endpoints: ['chat_completions'], capabilities: ['text', 'stream'],
    preferred_backend: 'deepseek_harness',
    mobius: mobiusContract('deepseek-harness'),
  }]
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/integrations/mobius/catalog' && req.method === 'GET') {
        assert.equal(req.headers.authorization, 'Bearer sk-integration-secret')
        catalogRequests += 1
        res.end(JSON.stringify({
          ok: true,
          account: { username: 'alice' },
          api_base_path: '/v1',
          catalog: {
            data: catalogModels,
            meta: {
              count: catalogModels.length,
              catalog_version: `sha256:${catalogRevision}`,
              integration_schema_version: 1,
            },
          },
        }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })
  await listen(server)
  try {
    const address = server.address()
    const integration = require('../backend/services/bestapi-integration')
    assert.equal(
      integration.normalizeBestApiServerUrl('http://8.130.13.45:3333/'),
      'https://8.130.13.45:3333',
    )
    const stopAutoSync = integration.startBestApiAutoSync({
      initialDelayMs: 60_000,
      intervalMs: 60_000,
    })
    assert.equal(typeof stopAutoSync, 'function')
    assert.equal(integration.getBestApiConnection().auto_sync.running, true)
    stopAutoSync()
    assert.equal(integration.getBestApiConnection().auto_sync.running, false)
    const connected = await integration.connectBestApi({
      base_url: `http://127.0.0.1:${address.port}/v1`,
      api_key: 'sk-integration-secret',
    })
    assert.equal(catalogRequests, 1)
    assert.equal(connected.connected, true)
    assert.equal(connected.catalog_version, 'sha256:1')
    assert.equal(connected.integration_schema_version, 1)
    assert.equal(connected.model_count, 1)
    assert.equal(connected.counts.deepseek_harness, 1)
    assert.equal(Object.prototype.hasOwnProperty.call(connected, 'api_key'), false)

    const stored = fs.readFileSync(process.env.BESTAPI_CONNECTION_PATH, 'utf8')
    assert.equal(stored.includes('sk-integration-secret'), true)
    assert.equal(fs.statSync(process.env.BESTAPI_CONNECTION_PATH).mode & 0o777, 0o600)
    assert.equal(fs.statSync(process.env.MODEL_ACCESS_PATH).mode & 0o777, 0o600)

    const modelAccess = require('../backend/services/model-access')
    const model = modelAccess.findHarnessModel('bestapi-deepseek-chat-b45bfc6eb6', { includeSecret: true })
    assert.notEqual(model, null)
    assert.equal(model.base_url, `http://127.0.0.1:${address.port}/v1`)
    assert.equal(model.secret_value, 'sk-integration-secret')

    catalogModels = [
      ...catalogModels,
      {
        id: 'gpt-test', display_name: 'GPT Test',
        endpoints: ['responses'], capabilities: ['text', 'stream', 'reasoning'],
        preferred_backend: 'codex',
        mobius: mobiusContract('codex'),
      },
      {
        id: 'glm-test', display_name: '超长模型名称'.repeat(20),
        endpoints: ['messages'], capabilities: ['text', 'stream'],
        preferred_backend: 'claude_code',
        mobius: mobiusContract('claude-code'),
      },
    ]
    catalogRevision = 2
    const synced = await integration.syncBestApi()
    assert.equal(catalogRequests, 2)
    assert.equal(synced.catalog_version, 'sha256:2')
    assert.equal(synced.model_count, 3)
    assert.equal(synced.counts.codex, 1)
    assert.equal(synced.counts.claude_code, 1)

    const syncedAtBeforeNoChange = synced.synced_at
    const unchanged = await integration.runBestApiAutoSyncOnce()
    assert.equal(catalogRequests, 3)
    assert.equal(unchanged.catalog_changed, false)
    assert.equal(unchanged.synced_at, syncedAtBeforeNoChange)
    assert.equal(unchanged.auto_sync.last_error, null)

    catalogModels = [...catalogModels, {
      id: 'platform-new-model', display_name: 'Platform New Model',
      endpoints: ['messages'], capabilities: ['text', 'stream'],
      mobius: mobiusContract('claude-code'),
    }]
    catalogRevision = 3
    const autoAdded = await integration.runBestApiAutoSyncOnce()
    assert.equal(autoAdded.catalog_changed, true)
    assert.equal(autoAdded.catalog_version, 'sha256:3')
    assert.equal(autoAdded.model_count, 4)
    const autoModelPlan = integration.planBestApiModel(catalogModels[catalogModels.length - 1])
    assert.notEqual(modelAccess.findClaudeCodeModel(autoModelPlan.key), null)

    catalogModels = catalogModels.filter((model) => model.id !== 'platform-new-model')
    catalogRevision = 4
    const autoRemoved = await integration.runBestApiAutoSyncOnce()
    assert.equal(autoRemoved.catalog_changed, true)
    assert.equal(autoRemoved.model_count, 3)
    assert.equal(modelAccess.findClaudeCodeModel(autoModelPlan.key), null)

    const codexPlan = integration.planBestApiModel({
      id: 'gpt-test', endpoints: ['responses'], mobius: mobiusContract('codex'),
    })
    assert.equal(codexPlan.backend, 'codex')
    assert.equal(codexPlan.protocol, 'openai_responses')
    assert.equal(codexPlan.config_profile, 'codex_responses_v1')
    assert.match(codexPlan.key, /^[A-Za-z]+$/)
    const codex = modelAccess.findCodexModel(codexPlan.key, { includeConfig: true, includeSecret: true })
    assert.equal(codex.secret_value, 'sk-integration-secret')
    assert.equal(codex.config_toml.includes('api_key = "<API_KEY>"'), true)
    const { resolveSecretCandidate } = require('../backend/utils/secret-placeholder')
    assert.equal(resolveSecretCandidate('<API_KEY>', codex.secret_value), 'sk-integration-secret')
    assert.equal(fs.statSync(codex.config_path).mode & 0o777, 0o600)

    modelAccess.upsertCodexModel({
      key: codex.key,
      label: codex.label,
      codex_model: codex.codex_model,
      secret_env_key: codex.secret_env_key,
      secret_value: '',
      config_toml: codex.config_toml,
      enabled: true,
    }, { existingKey: codex.key })
    assert.equal(modelAccess.findCodexModel(codex.key, { includeSecret: true }).secret_value, 'sk-integration-secret')

    const claudePlan = integration.planBestApiModel({
      id: 'glm-test', endpoints: ['messages'], mobius: mobiusContract('claude-code'),
    })
    assert.equal(claudePlan.backend, 'claude_code')
    const claude = modelAccess.findClaudeCodeModel(claudePlan.key, { includeSettings: true })
    assert.equal(JSON.parse(claude.settings_json).env.ANTHROPIC_AUTH_TOKEN, 'sk-integration-secret')
    assert.ok(claude.label.length <= 80)
    assert.equal(fs.statSync(claude.settings_path).mode & 0o777, 0o600)

    const modelRegistry = require('../backend/services/model-registry')
    const available = new Set(modelRegistry.listSessionModelOptions().map((item) => item.key))
    assert.equal(available.has(model.session_model), true)
    assert.equal(available.has(codex.session_model), true)
    assert.equal(available.has(claude.session_model), true)
    assert.equal(modelRegistry.modelLaunchOptionsFor({ model: model.session_model }).harnessSecretValue, 'sk-integration-secret')
    assert.equal(modelRegistry.modelLaunchOptionsFor({ model: codex.session_model }).codexSecretValue, 'sk-integration-secret')
    assert.equal(modelRegistry.modelLaunchOptionsFor({ model: claude.session_model }).settingsPath, claude.settings_path)

    assert.throws(
      () => integration.planBestApiModel({ id: 'unsafe\nmodel', endpoints: ['responses'] }),
      /无效模型 ID/,
    )
    const multiHarnessPlan = integration.planBestApiModel({
      id: 'multi-protocol',
      endpoints: ['messages', 'chat_completions'],
      mobius: mobiusContract('claude-code', ['claude-code', 'deepseek-harness']),
    })
    assert.equal(multiHarnessPlan.harness_id, 'claude-code')
    assert.deepEqual(multiHarnessPlan.supported_harnesses, ['claude-code', 'deepseek-harness'])
    assert.throws(
      () => integration.planBestApiModel({
        id: 'tampered-profile',
        endpoints: ['responses'],
        mobius: {
          ...mobiusContract('codex'),
          harnesses: [{ ...harnessSpecs.codex, endpoint_path: '/v1/chat/completions' }],
        },
      }),
      /与 Mobius 模板不匹配/,
    )
    assert.throws(
      () => integration.planBestApiModel({
        id: 'future-contract', endpoints: ['responses'],
        mobius: { ...mobiusContract('codex'), schema_version: 2 },
      }),
      /Harness 契约无效/,
    )

    const validCatalogModels = catalogModels
    catalogModels = [...catalogModels, {
      id: 'missing-contract', endpoints: ['responses'], capabilities: ['text'],
    }]
    await assert.rejects(() => integration.runBestApiAutoSyncOnce(), /部分模型缺少 Mobius 配置/)
    assert.match(integration.getBestApiConnection().auto_sync.last_error, /部分模型缺少 Mobius 配置/)
    assert.equal(integration.getBestApiConnection().catalog_version, 'sha256:4')
    catalogModels = validCatalogModels
    const recovered = await integration.runBestApiAutoSyncOnce()
    assert.equal(recovered.catalog_changed, false)
    assert.equal(recovered.auto_sync.last_error, null)

    const collisionPlan = integration.planBestApiModel({
      id: 'manual-collision', endpoints: ['chat_completions'],
      mobius: mobiusContract('deepseek-harness'),
    })
    modelAccess.upsertHarnessModel({
      key: collisionPlan.key,
      label: 'Manual model',
      provider: 'deepseek-official',
      model: 'manual-model',
      base_url: 'https://manual.example/v1',
      secret_value: 'sk-manual-secret',
      enabled: true,
    })
    catalogModels = [...catalogModels, {
      id: 'manual-collision', display_name: 'Must not overwrite manual model',
      endpoints: ['chat_completions'], capabilities: ['text'],
      mobius: mobiusContract('deepseek-harness'),
    }]
    catalogRevision = 5
    await assert.rejects(() => integration.syncBestApi(), /与手动模型配置冲突/)
    const manual = modelAccess.findHarnessModel(collisionPlan.key, { includeSecret: true })
    assert.equal(manual.model, 'manual-model')
    assert.equal(manual.secret_value, 'sk-manual-secret')
    assert.equal(integration.getBestApiConnection().catalog_version, 'sha256:4')

    // 状态接口的 models 需实时标注每个模型当前是否仍在系统配置中 (前端据此显示「已注入 / 配置缺失」)
    const connectionView = integration.getBestApiConnection()
    assert.equal(connectionView.models.length, 3)
    assert.ok(connectionView.models.every((m) => m.configured === true))
    // 手动删除一个注入模型后, 状态接口应如实标注缺失, 而不是照抄同步时的旧清单
    modelAccess.deleteClaudeCodeModel(claude.key)
    const afterDelete = integration.getBestApiConnection()
    assert.equal(afterDelete.models.find((m) => m.key === claude.key).configured, false)
    assert.ok(afterDelete.models.filter((m) => m.key !== claude.key).every((m) => m.configured === true))
  } finally {
    await close(server)
  }
  console.log('bestapi integration: ok')
}

main()
  .finally(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  .catch((error) => { console.error(error); process.exitCode = 1 })
