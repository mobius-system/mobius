const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  CodexModelCatalogService,
  constants,
  toPublicCatalogSnapshot,
  _private,
} = require('../backend/services/codex-model-catalog.cjs')

function writeFakeCodex(file) {
  const source = `#!${process.execPath}
const fs = require('fs')
const readline = require('readline')
const trace = process.env.MOBIUS_TEST_TRACE
const mode = process.env.MOBIUS_TEST_MODE || 'success'
const events = []
function save(extra) {
  fs.writeFileSync(trace, JSON.stringify({ events, argv: process.argv.slice(2), home: process.env.HOME, codexHome: process.env.CODEX_HOME, ...extra }))
}
process.on('SIGTERM', () => { save({ stopped: 'SIGTERM' }); process.exit(0) })
process.on('SIGINT', () => { save({ stopped: 'SIGINT' }); process.exit(0) })
if (mode === 'long-line') {
  process.stdout.write('x'.repeat(4096) + '\\n')
} else if (mode === 'large-stderr') {
  process.stderr.write('s'.repeat(4096))
} else {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const message = JSON.parse(line)
    events.push({ method: message.method, limit: message.params && message.params.limit })
    save({ stopped: null })
    if (mode === 'timeout') return
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { serverInfo: { name: 'fake' } } }) + '\\n')
      return
    }
    if (message.method === 'model/list') {
      if (mode === 'rpc-error') {
        process.stdout.write(JSON.stringify({ id: message.id, error: { message: 'secret upstream detail' } }) + '\\n')
        return
      }
      const data = [
        {
          id: 'gpt-alpha', displayName: 'GPT Alpha', description: 'Alpha model',
          supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'high' }],
          defaultReasoningEffort: 'high', additionalSpeedTiers: ['fast'], defaultServiceTier: 'fast',
          inputModalities: ['text', 'image']
        },
        { id: 'gpt-alpha', displayName: 'duplicate must be ignored', isDefault: true },
        { id: 'bad id with spaces', displayName: 'malformed' },
        { model: 'gpt-beta', display_name: 'GPT Beta', is_default: true }
      ]
      process.stdout.write(JSON.stringify({ id: message.id, result: { data } }) + '\\n')
    }
  })
}
`
  fs.writeFileSync(file, source, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
}

function runtime(executable, root, mode = 'success') {
  return {
    executable,
    env: {
      ...process.env,
      HOME: path.join(root, 'home'),
      CODEX_HOME: path.join(root, 'codex-home'),
      MOBIUS_TEST_TRACE: path.join(root, `trace-${mode}.json`),
      MOBIUS_TEST_MODE: mode,
      SHOULD_NEVER_LEAK: 'catalog-secret-value',
    },
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-codex-catalog-'))
  try {
    const executable = path.join(root, 'codex')
    writeFakeCodex(executable)

    let spawnRecord = null
    const handshakeRuntime = runtime(executable, root)
    const service = new CodexModelCatalogService({
      timeoutMs: 3000,
      stopTimeoutMs: 200,
      getRuntime: () => handshakeRuntime,
      spawnProcess: (command, args, options) => {
        spawnRecord = { command, args, options }
        return childProcess.spawn(command, args, options)
      },
    })
    const discovered = await service.getCatalog({ force: true })
    assert.equal(spawnRecord.command, executable)
    assert.deepEqual(spawnRecord.args, ['app-server'])
    assert.equal(spawnRecord.options.shell, false)
    assert.equal(spawnRecord.options.env.HOME, handshakeRuntime.env.HOME)
    assert.equal(spawnRecord.options.env.CODEX_HOME, handshakeRuntime.env.CODEX_HOME)
    assert.equal(discovered.source, constants.SOURCE_APP_SERVER, JSON.stringify(discovered))
    assert.equal(discovered.fallback, false)
    assert.deepEqual(discovered.models.map((model) => model.id), ['gpt-alpha', 'gpt-beta'])
    assert.deepEqual(discovered.models.map((model) => model.isDefault), [false, true])
    assert.deepEqual(discovered.models[0].supportedReasoningEfforts.map((option) => option.value), ['low', 'high'])
    assert.deepEqual(discovered.models[0].supportedSpeeds.map((option) => option.value), ['fast'])
    assert.equal(discovered.models[0].defaultSpeed, 'fast')
    assert.equal(discovered.models[0].supportsImageInput, true)

    const trace = JSON.parse(fs.readFileSync(handshakeRuntime.env.MOBIUS_TEST_TRACE, 'utf8'))
    assert.deepEqual(trace.events.map((event) => event.method), ['initialize', 'initialized', 'model/list'])
    assert.equal(trace.events[2].limit, 200)
    assert.deepEqual(trace.argv, ['app-server'])
    assert.equal(trace.home, handshakeRuntime.env.HOME)
    assert.equal(trace.codexHome, handshakeRuntime.env.CODEX_HOME)
    assert.equal(trace.stopped, 'SIGTERM')

    // No advertised default means the first valid CLI item becomes the one default.
    const firstDefault = _private.normalizeModels([{ id: 'one' }, { id: 'two' }])
    assert.deepEqual(firstDefault.map((model) => model.isDefault), [true, false])

    // Timeout is bounded and the child is terminated; cold failure is explicit.
    const timeoutRuntime = runtime(executable, root, 'timeout')
    const timeoutService = new CodexModelCatalogService({
      timeoutMs: 300,
      stopTimeoutMs: 100,
      getRuntime: () => timeoutRuntime,
    })
    const timeoutStarted = Date.now()
    const timeoutResult = await timeoutService.getCatalog({ force: true })
    assert.ok(Date.now() - timeoutStarted < 1000)
    assert.equal(timeoutResult.source, constants.SOURCE_COMPATIBILITY_FALLBACK)
    assert.equal(timeoutResult.fallback, true)
    assert.deepEqual(timeoutResult.models.map((model) => model.id), ['gpt-5.5'])
    assert.match(timeoutResult.reason, /超时/)
    const timeoutTrace = JSON.parse(fs.readFileSync(timeoutRuntime.env.MOBIUS_TEST_TRACE, 'utf8'))
    assert.equal(timeoutTrace.stopped, 'SIGTERM')

    const unsupportedRuntime = runtime(executable, root, 'rpc-error')
    const unsupportedService = new CodexModelCatalogService({
      timeoutMs: 3000,
      getRuntime: () => unsupportedRuntime,
    })
    const unsupported = await unsupportedService.getCatalog({ force: true })
    assert.equal(unsupported.source, constants.SOURCE_COMPATIBILITY_FALLBACK)
    assert.match(unsupported.reason, /model\/list/)
    assert.equal(JSON.stringify(unsupported).includes('secret upstream detail'), false)

    // A single oversized line is rejected before JSON parsing.
    const lineRuntime = runtime(executable, root, 'long-line')
    const lineService = new CodexModelCatalogService({
      timeoutMs: 3000,
      maxLineBytes: 128,
      maxStdoutBytes: 8192,
      getRuntime: () => lineRuntime,
    })
    const lineResult = await lineService.getCatalog({ force: true })
    assert.equal(lineResult.source, constants.SOURCE_COMPATIBILITY_FALLBACK)
    assert.match(lineResult.reason, /单行输出/)

    const stderrRuntime = runtime(executable, root, 'large-stderr')
    const stderrService = new CodexModelCatalogService({
      timeoutMs: 3000,
      maxStderrBytes: 128,
      getRuntime: () => stderrRuntime,
    })
    const stderrResult = await stderrService.getCatalog({ force: true })
    assert.equal(stderrResult.source, constants.SOURCE_COMPATIBILITY_FALLBACK)
    assert.match(stderrResult.reason, /stderr/)

    // The response model cap is enforced, not silently truncated.
    const excessiveService = new CodexModelCatalogService({
      getRuntime: () => ({ executable, env: {} }),
      fetchRawModels: async () => Array.from({ length: 201 }, (_, index) => ({ id: `model-${index}` })),
    })
    const excessive = await excessiveService.getCatalog({ force: true })
    assert.equal(excessive.source, constants.SOURCE_COMPATIBILITY_FALLBACK)
    assert.match(excessive.reason, /模型数量/)

    // Successful TTL cache, concurrent single-flight, and force refresh.
    let now = 1000
    let calls = 0
    let releaseFirst
    const firstFetch = new Promise((resolve) => { releaseFirst = resolve })
    const cacheService = new CodexModelCatalogService({
      now: () => now,
      ttlMs: 1000,
      getRuntime: () => ({ executable, env: {} }),
      fetchRawModels: async () => {
        calls += 1
        if (calls === 1) await firstFetch
        return [{ id: `model-${calls}`, isDefault: true }]
      },
    })
    const concurrent = [cacheService.getCatalog(), cacheService.getCatalog(), cacheService.getCatalog()]
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls, 1)
    releaseFirst()
    const shared = await Promise.all(concurrent)
    assert.deepEqual(shared.map((snapshot) => snapshot.models[0].id), ['model-1', 'model-1', 'model-1'])
    assert.equal((await cacheService.getCatalog()).models[0].id, 'model-1')
    assert.equal(calls, 1)
    assert.equal((await cacheService.getCatalog({ force: true })).models[0].id, 'model-2')
    assert.equal(calls, 2)
    now += 1001
    assert.equal((await cacheService.getCatalog()).models[0].id, 'model-3')
    assert.equal(calls, 3)
    cacheService.invalidate()
    assert.equal((await cacheService.getCatalog()).models[0].id, 'model-4')
    assert.equal(calls, 4)

    // A failed refresh retains the last successful model list.
    let shouldFail = false
    const lkgService = new CodexModelCatalogService({
      getRuntime: () => ({ executable, env: {} }),
      fetchRawModels: async () => {
        if (shouldFail) throw new Error('raw secret from provider')
        return [{ id: 'last-good', isDefault: true }]
      },
    })
    await lkgService.getCatalog({ force: true })
    shouldFail = true
    const lkg = await lkgService.getCatalog({ force: true })
    assert.equal(lkg.source, constants.SOURCE_LAST_KNOWN_GOOD)
    assert.equal(lkg.fallback, true)
    assert.equal(lkg.models[0].id, 'last-good')
    assert.equal(JSON.stringify(lkg).includes('raw secret'), false)

    // Public API serializer is an allowlist and cannot expose raw output/env/secrets.
    const publicSnapshot = toPublicCatalogSnapshot({
      ...discovered,
      raw: 'catalog-secret-value',
      stderr: 'catalog-secret-value',
      models: discovered.models.map((model) => ({ ...model, token: 'catalog-secret-value', apiKey: 'catalog-secret-value' })),
    })
    const serialized = JSON.stringify(publicSnapshot)
    assert.equal(serialized.includes('catalog-secret-value'), false)
    assert.deepEqual(Object.keys(publicSnapshot), ['models', 'source', 'fallback', 'checkedAt', 'reason'])

    const adminRouteSource = fs.readFileSync(path.join(__dirname, '../backend/routes/admin.ts'), 'utf8')
    assert.match(adminRouteSource, /router\.get\('\/codex-model-catalog', adminAuth,/)
    assert.match(adminRouteSource, /toPublicCatalogSnapshot/)
    assert.match(adminRouteSource, /invalidateCodexModelCatalog/)

    console.log('codex-model-catalog: ok')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
