import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const runtimeBin = resolve('deepseek-harness-runtime/node_modules/.bin/dsh-jsonrpc-agent')
const runtimeConfig = resolve('deepseek-harness-runtime/cordis.yml')

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen(server.address()))
  })
}

function closeServer(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

function startRuntime({ cwd, sessionRoot, baseUrl }) {
  const child = spawn(process.execPath, [runtimeBin, runtimeConfig], {
    cwd,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'local-smoke-key',
      DEEPSEEK_BASE_URL: baseUrl,
      DSH_CWD: cwd,
      DSH_SESSION_ROOT: sessionRoot,
      DSH_MAX_TOKENS_AS_SUCCESS: 'false',
      DSH_SYSTEM_PROMPT: 'You are a local smoke-test coding agent.',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const frames = []
  const waiters = new Set()
  let stderr = ''
  let stdoutBuffer = ''
  let nonJsonLine = null

  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8')
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        frames.push(JSON.parse(line))
      } catch {
        nonJsonLine ||= line
      }
    }
    for (const wake of waiters) wake()
  })

  async function waitFor(predicate, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (nonJsonLine) throw new Error(`non-JSON runtime stdout: ${nonJsonLine}`)
      const match = frames.find(predicate)
      if (match) return match
      if (child.exitCode !== null) throw new Error(`runtime exited ${child.exitCode}; stderr=${stderr}`)
      await new Promise((resolveWait) => {
        const timer = setTimeout(() => { waiters.delete(wake); resolveWait() }, 20)
        const wake = () => { clearTimeout(timer); waiters.delete(wake); resolveWait() }
        waiters.add(wake)
      })
    }
    throw new Error(`timed out waiting for runtime frame; stderr=${stderr}`)
  }

  function request(id, method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
    return waitFor((frame) => frame.id === id)
  }

  async function shutdown(id) {
    const response = await request(id, 'shutdown')
    assert.deepEqual(response, { jsonrpc: '2.0', id, result: {} })
    const exit = await new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => reject(new Error(`runtime did not exit; stderr=${stderr}`)), 10_000)
      child.once('exit', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }) })
    })
    assert.equal(exit.code, 0, `runtime signal=${exit.signal}; stderr=${stderr}`)
    assert.equal(nonJsonLine, null)
  }

  return { child, frames, waitFor, request, shutdown, stderr: () => stderr }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'mobius-deepseek-harness-runtime-'))
  const sessionRoot = join(root, 'sessions')
  const modelRequests = []
  const modelServer = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      modelRequests.push({ url: request.url, body: JSON.parse(body) })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n')
      response.write(`data: {"choices":[{"delta":{"content":"answer-${modelRequests.length}"}}]}\n\n`)
      response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n')
      response.end('data: [DONE]\n\n')
    })
  })
  const address = await listen(modelServer)
  const baseUrl = `http://127.0.0.1:${address.port}`
  let runtime

  try {
    runtime = startRuntime({ cwd: root, sessionRoot, baseUrl })
    const initialized = await runtime.request(1, 'initialize', {
      cwd: root,
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      maxTokens: 1234,
    })
    assert.deepEqual(initialized.result?.serverInfo, {
      name: 'mobius-deepseek-harness-runtime',
      version: '0.0.1-rc.5',
    })
    const prompt = await runtime.request(2, 'session/prompt', {
      sessionId: 'smoke-session',
      contentBlocks: [{ type: 'text', text: 'first prompt' }],
    })
    assert.equal(typeof prompt.result?.messageId, 'string')
    await runtime.waitFor((frame) => frame.method === 'session.event' && frame.params?.event?.type === 'assistant/message')
    await runtime.waitFor((frame) => frame.method === 'session.event' && frame.params?.event?.type === 'turn/end')
    await runtime.waitFor((frame) => frame.method === 'session.status' && frame.params?.status === 'idle')

    assert.equal(modelRequests[0].url, '/chat/completions')
    assert.equal(modelRequests[0].body.max_tokens, 1234)
    assert.deepEqual(
      modelRequests[0].body.tools.map((tool) => tool.function?.name).sort(),
      ['bash', 'edit', 'read', 'subagent', 'todo_write', 'write'],
    )
    await runtime.shutdown(3)
    runtime = null

    const filesAfterFirstTurn = await readdir(sessionRoot, { recursive: true })
    const nativeLog = filesAfterFirstTurn.find((file) => file.endsWith('.jsonl'))
    assert.ok(nativeLog, `expected native JSONL under ${sessionRoot}`)
    const firstLog = await readFile(join(sessionRoot, nativeLog), 'utf8')
    assert.match(firstLog, /first prompt/)
    assert.match(firstLog, /answer-1/)

    runtime = startRuntime({ cwd: root, sessionRoot, baseUrl })
    await runtime.request(4, 'initialize', {
      cwd: root,
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      maxTokens: 1234,
    })
    await runtime.request(5, 'session/prompt', {
      sessionId: 'smoke-session',
      contentBlocks: [{ type: 'text', text: 'second prompt' }],
    })
    await runtime.waitFor((frame) => frame.method === 'session.event' && frame.params?.event?.type === 'turn/end')
    await runtime.waitFor((frame) => frame.method === 'session.status' && frame.params?.status === 'idle')
    assert.equal(modelRequests.length, 2)
    assert.match(JSON.stringify(modelRequests[1].body.messages), /first prompt/)
    assert.match(JSON.stringify(modelRequests[1].body.messages), /answer-1/)
    assert.match(JSON.stringify(modelRequests[1].body.messages), /second prompt/)
    await runtime.shutdown(6)
    runtime = null
  } finally {
    if (runtime?.child && runtime.child.exitCode === null) runtime.child.kill('SIGKILL')
    await closeServer(modelServer)
    await rm(root, { recursive: true, force: true })
  }
  console.log('deepseek-harness-runtime-smoke: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
