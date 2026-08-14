import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

export const name = 'mobius-sdk-jsonrpc-server'
export const inject = ['agents', 'sessionPersistence']
export const Config = Schema.object({ maxTokensAsSuccess: Schema.boolean().default(false) })

class MobiusHarnessServer {
  constructor(ctx, transport) {
    this.ctx = ctx
    this.transport = transport
    this.cwd = process.cwd()
    this.provider = 'deepseek-official'
    this.model = 'deepseek-chat'
    this.maxTokens = undefined
    this.sessions = new Map()
    this.creations = new Map()
    this.disposers = [
      ctx.on('session/event', (session, event) => {
        transport.notify('session.event', { sessionId: String(session.id), event })
      }),
      ctx.on('agent/status', ({ agent, status }) => {
        transport.notify('session.status', { sessionId: String(agent.session.id), status })
      }),
    ]
  }

  async initialize(params) {
    if (params?.maxTokens !== undefined && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    this.cwd = params.cwd
    this.provider = params.provider
    this.model = params.model
    this.maxTokens = params.maxTokens
    return { serverInfo: { name: 'mobius-deepseek-harness-runtime', version: '0.0.1-rc.5' } }
  }

  async sessionExists(sessionId) {
    try {
      await this.ctx.sessionPersistence.load(SessionId(sessionId))
      return true
    } catch (error) {
      if (/not found/i.test(String(error?.message || error))) return false
      throw error
    }
  }

  async createOrResume(sessionId) {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.creations.get(sessionId)
    if (pending) return pending
    const task = (async () => {
      const agentOptions = {
        provider: this.provider,
        model: this.model,
        ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
      }
      const handle = await this.sessionExists(sessionId)
        ? this.ctx.agents.resume({ resumeSessionId: SessionId(sessionId), agentOptions })
        : this.ctx.agents.create({ sessionId: SessionId(sessionId), meta: { cwd: this.cwd }, agentOptions })
      this.sessions.set(sessionId, handle)
      return handle
    })()
    this.creations.set(sessionId, task)
    try { return await task } finally { this.creations.delete(sessionId) }
  }

  async prompt(params) {
    const handle = await this.createOrResume(params.sessionId)
    const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
    handle.agent.followup(message)
    return { messageId: message.id }
  }

  async shutdown() {
    await Promise.allSettled([...this.creations.values()])
    const handles = [...this.sessions.values()]
    this.sessions.clear()
    while (this.disposers.length) this.disposers.pop()?.()
    await Promise.allSettled(handles.map((handle) => (
      typeof handle.dispose === 'function' ? handle.dispose() : undefined
    )))
    return {}
  }

  handleRequest(method, params) {
    if (method === 'initialize') return this.initialize(params)
    if (method === 'session/prompt') return this.prompt(params)
    if (method === 'shutdown') return this.shutdown()
    throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
  }
}

export function apply(ctx, config) {
  const rootFiber = ctx.root.fiber
  const transport = new JsonRpcLineTransport(process.stdin, process.stdout)
  const server = new MobiusHarnessServer(ctx, transport, config)
  let exitTask
  const disposeAndExit = () => {
    exitTask ??= (async () => {
      await Promise.allSettled([transport.flush()])
      await Promise.allSettled([rootFiber.dispose()])
      process.exit(0)
    })()
    return exitTask
  }
  transport.onRequest(async (method, params) => {
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') setImmediate(() => { void disposeAndExit() })
    return result
  })
  ctx.effect(() => {
    transport.start()
    return async () => {
      await server.shutdown()
      transport.close()
    }
  }, 'mobius-jsonrpc.serve')
}
