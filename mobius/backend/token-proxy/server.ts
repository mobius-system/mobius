/**
 * token-proxy/server.ts — 黑客帝国数字雨 · 流式中转代理 (独立 pm2 进程).
 *
 * 在 claude code / codex 与真实模型 API 之间充当流式中转层:
 *   cc/codex (用 .withproxy 变体配置, base_url 指向本进程)
 *     ──POST /v1/messages 或 /responses──►  本进程 (Bearer mpx1.<编码>)
 *     ──解码还原真实 BASE_URL + AUTH_TOKEN + model + session/agent (见 encoding.ts)
 *     ──fetch 真实上游, 流式逐块回传 (绝不整体缓冲, 保证流式体验)
 *     ──旁路解析响应里的正文(text)与推理(thinking/reasoning)两类增量
 *
 * 缓存结构 (按 session 分桶, 每桶 16 个「完整请求」):
 *   sessionId -> { agent, last_activity, reqs: [req1..req16] }
 *   req = { id, model, cat_content, cat_reason, started_at, last_activity }
 *   一个「完整请求」= 一次响应从流开始到流结束 (message_stop / response.completed /
 *   [DONE] / 断开) 的完整累积, 正文与推理分开累积到 cat_content / cat_reason.
 *   GC: 每次一个请求结束(flush)时, 删除 last_activity 早于 1 小时的整桶.
 *
 * /token_stream:
 *   - SSE live tail (默认): 连上先推 snapshot(buckets 完整请求), 之后逐 delta 推 token(实时雨滴).
 *   - ?poll=1 返回 JSON 快照; ?session=<id> 过滤单会话.
 *   供主后端 /api/token_stream 反代 → matrix-rain 拓展消费.
 *
 * 仅监听 127.0.0.1:MOBIUS_TOKEN_PROXY_PORT, 无独立鉴权 (代理 token 已含全部信息,
 * 本机回环). 启动方式见 ecosystem.config.js 的 mobius-system-tokenproxy.
 */
import express from 'express'
import { randomUUID } from 'crypto'
import { decodeProxyToken, resolveUpstream, type UpstreamInfo } from './encoding'

const PORT = parseInt(process.env.MOBIUS_TOKEN_PROXY_PORT || '45630', 10)
const HOST = process.env.MOBIUS_TOKEN_PROXY_HOST || '127.0.0.1'

// ── 缓存: session 分桶, 每桶 16 个完整请求 ─────────────────────────────────
const BUCKET_MAX_REQS = 16
const GC_IDLE_MS = 3_600_000 // 1 小时

interface CompleteRequest {
  id: string
  model: string
  cat_content: string // 正文累积
  cat_reason: string // 推理/思考累积
  started_at: number
  last_activity: number
}

interface AgentBucket {
  agent: string | null
  last_activity: number
  reqs: CompleteRequest[]
}

// key = sessionId (mobius 执行会话); agent 作为桶元数据.
const buckets = new Map<string, AgentBucket>()

function ensureBucket(sessionId: string, agent: string | null, now: number): AgentBucket {
  let b = buckets.get(sessionId)
  if (!b) {
    b = { agent, last_activity: now, reqs: [] }
    buckets.set(sessionId, b)
  }
  if (agent != null) b.agent = agent
  b.last_activity = now
  return b
}

// GC: 清理 last_activity 早于 1 小时的整桶. 每次一个请求结束(flush)时调用.
function gc(now: number): void {
  const cutoff = now - GC_IDLE_MS
  for (const [key, b] of buckets) {
    if (b.last_activity < cutoff) buckets.delete(key)
  }
}

function flushRequest(bucket: AgentBucket, req: CompleteRequest, now: number): void {
  req.last_activity = now
  bucket.reqs.push(req)
  while (bucket.reqs.length > BUCKET_MAX_REQS) bucket.reqs.shift()
  bucket.last_activity = now
  gc(now)
}

// ── 实时订阅 (逐 delta 推送, 不入缓存) ─────────────────────────────────────
// 缓存存完整请求; 数字雨实时渲染仍需逐 delta 的雨滴, 走这条实时推送.
type Subscriber = (msg: any) => void
const subscribers = new Set<Subscriber>()

function pushDelta(sessionId: string, agent: string | null, model: string, kind: 'content' | 'reason', text: string): void {
  if (!text) return
  const msg = { session: sessionId, agent, model, kind, text, ts: Date.now() }
  for (const sub of subscribers) {
    try { sub(msg) } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

// ── SSE 流式解析器 (双协议, 正文/推理分路累积) ─────────────────────────────
// Anthropic: content_block_delta (delta.type=text_delta→text / thinking_delta→thinking),
//            message_stop 结束.
// OpenAI   : response.output_text.delta (delta=正文) / response.reasoning_text.delta (delta=推理),
//            response.completed 结束. 通用 [DONE] 也视为结束.
interface StreamAcc {
  cat_content: string
  cat_reason: string
  ended: boolean
}

class SseStreamParser {
  private buf = ''
  constructor(
    private readonly acc: StreamAcc,
    private readonly onDelta?: (kind: 'content' | 'reason', text: string) => void,
  ) {}

  feed(chunk: Uint8Array | Buffer): void {
    this.buf += Buffer.from(chunk).toString('utf8')
    let idx: number
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const raw = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      this.handleEvent(raw)
    }
  }

  private emit(kind: 'content' | 'reason', text: string): void {
    if (!text) return
    if (kind === 'content') this.acc.cat_content += text
    else this.acc.cat_reason += text
    this.onDelta?.(kind, text)
  }

  private handleEvent(raw: string): void {
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (dataLines.length === 0) return
    const dataStr = dataLines.join('\n')
    if (dataStr === '[DONE]') { this.acc.ended = true; return }
    if (!dataStr.trim()) return
    let obj: any
    try { obj = JSON.parse(dataStr) } catch { return }

    const type = typeof obj?.type === 'string' ? obj.type : ''
    const delta = obj?.delta || {}

    // 结束信号: Anthropic message_stop / OpenAI response.completed.
    if (type === 'message_stop' || type === 'response.completed') { this.acc.ended = true; return }

    // Anthropic: content_block_delta, delta.type 区分 text_delta / thinking_delta.
    if (type === 'content_block_delta') {
      const dt = delta?.type
      if (dt === 'thinking_delta' && typeof delta.thinking === 'string') {
        this.emit('reason', delta.thinking)
      } else if (dt === 'text_delta' && typeof delta.text === 'string') {
        this.emit('content', delta.text)
      } else if (typeof delta.text === 'string') {
        // 兼容无 delta.type 的变体.
        this.emit('content', delta.text)
      }
      return
    }

    // OpenAI: response.output_text.delta / response.reasoning_text.delta, delta 为字符串.
    if (type === 'response.output_text.delta' && typeof obj.delta === 'string') {
      this.emit('content', obj.delta)
      return
    }
    if (type === 'response.reasoning_text.delta' && typeof obj.delta === 'string') {
      this.emit('reason', obj.delta)
      return
    }

    // 兼容少数把 text 放在 delta.text / delta.content 的变体.
    const legacy = typeof delta.text === 'string' ? delta.text
      : (typeof delta.content === 'string' ? delta.content : null)
    if (legacy) this.emit('content', legacy)
  }
}

// ── HTTP 转发 ───────────────────────────────────────────────────────────────
const REQ_DROP_HEADERS = new Set([
  'authorization', 'x-api-key', 'host', 'content-length', 'connection', 'accept-encoding',
])
const RESP_DROP_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection',
])

function readReqBody(req: express.Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

async function relay(req: express.Request, res: express.Response): Promise<void> {
  // 1) 解码代理 token → 真实上游 + session/agent.
  const authHeader = req.headers['authorization'] || ''
  const xApiKey = req.headers['x-api-key']
  const rawToken = (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (typeof xApiKey === 'string' ? xApiKey : ''))
  let up: UpstreamInfo
  try {
    up = resolveUpstream(decodeProxyToken(rawToken))
  } catch (e: any) {
    res.status(401).json({ error: 'invalid proxy token', detail: e?.message || String(e) })
    return
  }
  if (!up.authToken) {
    res.status(401).json({ error: 'proxy token missing upstream auth' })
    return
  }

  // 2) 读完整请求体, 原样转发.
  let body: Buffer
  try {
    body = await readReqBody(req)
  } catch (e: any) {
    res.status(400).json({ error: 'failed to read request body', detail: e?.message || String(e) })
    return
  }

  // 3) 组装上游请求头: 透传 anthropic-version/beta/user-agent 等, 替换鉴权.
  const upstreamHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (REQ_DROP_HEADERS.has(k.toLowerCase())) continue
    if (Array.isArray(v)) upstreamHeaders[k] = v.join(', ')
    else if (typeof v === 'string') upstreamHeaders[k] = v
  }
  upstreamHeaders['authorization'] = `Bearer ${up.authToken}`

  const upstreamUrl = up.baseUrl + req.path

  // 4) fetch 上游. 监听客户端断开 → abort 上游, 避免连接+推理 token 空烧.
  const ac = new AbortController()
  const onClientClose = () => { try { ac.abort() } catch { /* noop */ } }
  req.on('close', onClientClose)
  let resp: Response
  try {
    resp = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: body.length > 0 ? body : undefined,
      signal: ac.signal,
    })
  } catch (e: any) {
    req.off('close', onClientClose)
    res.status(502).json({ error: 'upstream fetch failed', detail: e?.message || String(e) })
    return
  }

  // 5) 透传响应头 + 流式回传 body, 旁路累积完整请求.
  const respHeaders: Record<string, string> = {}
  for (const [k, v] of resp.headers.entries()) {
    if (RESP_DROP_HEADERS.has(k.toLowerCase())) continue
    respHeaders[k] = v
  }
  res.writeHead(resp.status, respHeaders)

  const ct = (resp.headers.get('content-type') || '').toLowerCase()
  const isSse = ct.includes('text/event-stream')

  const sessionId = up.sessionId || 'unknown'
  const agent = up.agent ?? null
  const model = up.model || 'unknown'
  const now = Date.now()
  const bucket = ensureBucket(sessionId, agent, now)
  const acc: StreamAcc = { cat_content: '', cat_reason: '', ended: false }
  const reqEntry: CompleteRequest = {
    id: randomUUID(),
    model,
    cat_content: '',
    cat_reason: '',
    started_at: now,
    last_activity: now,
  }
  const parser = isSse
    ? new SseStreamParser(acc, (kind, text) => pushDelta(sessionId, agent, model, kind, text))
    : null

  try {
    if (!resp.body) {
      res.end()
    } else {
      const reader = resp.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            res.write(Buffer.from(value))
            if (parser) { parser.feed(value); bucket.last_activity = Date.now() }
          }
        }
      } finally {
        try { await reader.cancel() } catch { /* noop */ }
      }
    }
  } catch {
    // cc 提前断开 / 上游读取出错: 尽力结束响应, 不抛.
  } finally {
    req.off('close', onClientClose)
  }
  try { res.end() } catch { /* already ended */ }

  // 6) 收口: 完整请求入桶 + GC.
  reqEntry.cat_content = acc.cat_content
  reqEntry.cat_reason = acc.cat_reason
  flushRequest(bucket, reqEntry, Date.now())
}

// ── Express app ─────────────────────────────────────────────────────────────
const app = express()
// relay 路径走原始 body (readReqBody 自己消费 stream), 不能挂 express.json.
// Anthropic: /v1/messages[/count_tokens]; OpenAI/Codex: /responses (兼容 /v1/responses).
app.post('/v1/messages', (req, res) => { void relay(req, res) })
app.post('/v1/messages/count_tokens', (req, res) => { void relay(req, res) })
app.post('/responses', (req, res) => { void relay(req, res) })
app.post('/v1/responses', (req, res) => { void relay(req, res) })

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'mobius-token-proxy', buckets: buckets.size, subscribers: subscribers.size, ts: Date.now() })
})

// /token_stream: SSE live tail (默认) 或 ?poll=1 JSON 快照. 支持 ?session=<id> 过滤.
// 被主后端 /api/token_stream 反代; 纯只读 token 字符, 无敏感信息.
app.get('/token_stream', (req, res) => {
  const wantPoll = req.query.poll === '1' || req.query.poll === 'true'
  const session = typeof req.query.session === 'string' && req.query.session ? req.query.session : null

  const snapshot = (): any[] => {
    const list: any[] = []
    for (const [sid, b] of buckets) {
      if (session && sid !== session) continue
      list.push({ session: sid, agent: b.agent, last_activity: b.last_activity, reqs: b.reqs.slice() })
    }
    return list
  }

  if (wantPoll) {
    res.json({ ok: true, buckets: snapshot(), ts: Date.now() })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  // 连接时先推一次快照 (完整请求), 前端立刻有料可回放.
  res.write(`event: snapshot\ndata: ${sseDataLine({ buckets: snapshot() })}\n\n`)
  const sub: Subscriber = (msg) => {
    if (session && msg.session !== session) return
    if (res.writableEnded || res.destroyed) return
    res.write(`event: token\ndata: ${sseDataLine(msg)}\n\n`)
  }
  subscribers.add(sub)
  const keepalive = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n')
  }, 20000)
  const cleanup = () => {
    subscribers.delete(sub)
    clearInterval(keepalive)
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
})

// SSE data 行里的换行必须转义成 `\ndata: ` 前缀, 否则帧会被拆碎.
function sseDataLine(payload: any): string {
  return JSON.stringify(payload).replace(/\r?\n/g, '\ndata: ')
}

app.all('*', (req, res) => {
  res.status(404).json({ error: 'not found', path: req.path })
})

app.listen(PORT, HOST, () => {
  console.log(`[token-proxy] listening on http://${HOST}:${PORT} (mobius 数字雨中转代理)`)
})
