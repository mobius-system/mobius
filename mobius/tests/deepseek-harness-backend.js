const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DeepSeekHarnessBackend, resolveRuntimeCommand } = require('../backend/agents/deepseek-harness')

async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for backend state')
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-backend-'))
  const runtimeFile = path.join(root, 'runtime.json')
  const archiveFile = path.join(root, 'archive.json')
  const fakeRuntime = path.join(__dirname, 'fixtures', 'deepseek-harness-fake-runtime.js')
  const backend = new DeepSeekHarnessBackend({
    runtimeFile,
    archiveFile,
    sessionRoot: path.join(root, 'sessions'),
    runtimeOptions: { runtimeCommand: process.execPath, runtimeArgs: [fakeRuntime] },
  })
  const sessionId = `harness-test-${Date.now()}`
  const cwd = path.join(root, 'workspace')
  const flagRoot = path.join(root, 'project')
  fs.mkdirSync(cwd)
  fs.mkdirSync(flagRoot)
  try {
    const proxyBin = path.join(root, 'proxychains')
    const proxyConfig = path.join(root, 'proxy.conf')
    fs.writeFileSync(proxyBin, '')
    fs.writeFileSync(proxyConfig, '')
    const proxied = resolveRuntimeCommand({
      runtimeCommand: process.execPath,
      runtimeArgs: [fakeRuntime],
      useProxy: true,
      proxyBin,
      proxyConfig,
    })
    assert.deepEqual(proxied, {
      command: proxyBin,
      args: ['-q', '-f', proxyConfig, process.execPath, fakeRuntime],
    })

    await backend.createNewSession({
      sessionId,
      cwd,
      flagRoot,
      prompt: 'hello',
      model: 'deepseek-test',
      harnessSecretValue: 'never-persist-this-secret',
      mobiusJsonl: {
        source: 'test',
        kind: 'user_input',
        content: 'hello',
        inputText: 'hello',
        turnNumber: 1,
      },
    })
    assert.equal(backend.isAlive(sessionId), true)
    assert.equal(backend.listSessions().length, 1)
    assert.equal(backend.isJobGoalAccomplished(sessionId), false)
    await waitFor(() => !backend.isWorking(sessionId))
    const history = backend.getHistory(sessionId)
    assert.equal(history.entries.some((entry) => entry.type === 'user' && entry.message?.content === 'hello'), true)
    assert.equal(history.entries.some((entry) => entry.type === 'assistant' && entry.message?.content?.[0]?.text === 'fake answer'), true)
    assert.equal(fs.readFileSync(runtimeFile, 'utf8').includes('never-persist-this-secret'), false)

    await backend.noPauseCurrentAndQueueQueryAtSession({
      sessionId, cwd, flagRoot, prompt: 'follow up', model: 'deepseek-test',
      mobiusJsonl: {
        source: 'test',
        kind: 'user_input',
        content: 'follow up',
        inputText: 'follow up',
        turnNumber: 2,
      },
    })
    await waitFor(() => !backend.isWorking(sessionId))
    assert.equal(backend.getHistory(sessionId).entries.filter((entry) => entry.type === 'assistant').length, 2)
    assert.equal(backend.getHistory(sessionId).entries.filter((entry) => entry.type === 'user').length, 2)

    await backend.pauseCurrentAndResumeFromSession({ sessionId, cwd, flagRoot, prompt: 'urgent', model: 'deepseek-test' })
    await waitFor(() => !backend.isWorking(sessionId))
    assert.equal(backend.getHistory(sessionId).entries.filter((entry) => entry.type === 'assistant').length, 3)

    await backend.pauseCurrentAndResumeFromSession({ sessionId, cwd, flagRoot, prompt: '' })
    assert.equal(backend.isAlive(sessionId), false)
    assert.equal(backend.listSessions().length, 0)
    assert.equal(backend.isJobGoalAccomplished(sessionId), true)
  } finally {
    await backend.terminateSession(sessionId).catch(() => {})
    fs.rmSync(root, { recursive: true, force: true })
  }
  console.log('deepseek-harness-backend: ok')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
