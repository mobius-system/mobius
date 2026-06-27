/**
 * token-proxy/server.ts — 黑客帝国数字雨 · 流式中转代理 (独立 pm2 进程).
 *
 * 在 claude code (cc) 与真实模型 API 之间充当流式中转层:
 *   cc (用 ~/.claude/settings-<key>.withproxy.json)
 *     ──POST /v1/messages──►  本进程 (Bearer mpx1.<编码>)
 *     ──解码 key 还原真实 BASE_URL + AUTH_TOKEN (见 encoding.ts)
 *     ──fetch 真实上游, 流式逐块回传给 cc (绝不整体缓冲, 保证 cc 流式体验)
 *     ──旁路解析响应里的 SSE text_delta → 写入环形缓冲
 *
 *   /token_stream  : 返回/尾随近期捕获的 token
 *                   (SSE live tail, 或 ?poll=1 返回 JSON 快照)
 *                   供主后端 /api/token_stream 反代 → matrix-rain 拓展消费.
 *
 * 仅监听 127.0.0.1:MOBIUS_TOKEN_PROXY_PORT, 无独立鉴权 (代理 token 已含全部信息,
 * 本机回环). 启动方式见 ecosystem.config.js 的 imac-mobius-tokenproxy.
 *
 * 运行: 通过 tsx 直跑 (与主后端一致), 无需编译. 隔离为独立进程的原因:
 *   1) 用户明确要求"建立一层中转代理 / server.ts";
 *   2) 流式转发是大流量长连接, 不应压到主后端单 worker 的事件循环上;
 *   3) 可独立重启/关停, 不影响 Mobius 主体.
 */
import express from 'express'
import { decodeProxyToken, upstreamFromSettings } from './encoding'

const PORT = parseInt(process.env.MOBIUS_TOKEN_PROXY_PORT || '45630', 10)
const HOST = process.env.MOBIUS_TOKEN_PROXY_HOST || '127.0.0.1'

// ── 环形缓冲 + SSE 订阅 ────────────────────────────────────────────────────
// 全局 feed: 所有模型/会话的 token 混流. 对"数字雨"视觉是加分 (越热闹越好看).
const RING_MAX_ENTRIES = 1000
const RING_MAX_CHARS = 65536
interface TokenEntry { text: string; model: string; ts: number }
const ring: TokenEntry[] = []
let ringChars = 0
type Subscriber = (entry: TokenEntry) => void
const subscribers = new Set<Subscriber>()

function pushToken(text: string, model: string): void {
  if (!text) return
  const entry: TokenEntry = { text, model: model || 'unknown', ts: Date.now() }
  ring.push(entry)
  ringChars += entry.text.length
  while ((ring.length > RING_MAX_ENTRIES || ringChars > RING_MAX_CHARS) && ring.length > 0) {
    const old = ring.shift() as TokenEntry
    ringChars -= old.text.length
  }
  for (const sub of subscribers) {
    try { sub(entry) } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

// ── SSE text_delta 解析器 (流式, 跨 chunk 维护状态) ─────────────────────────
// Anthropic 流式协议: 事件以空行 (\n\n) 分隔, 内容在 `data: <json>` 行.
// 我们只关心 content_block_delta 里 delta.text 的文本增量.
class SseTextExtractor {
  private buf = ''
  constructor(private readonly onText: (t: string) => void) {}

  feed(chunk: Uint8Array | Buffer): void {
    this.buf += Buffer.from(chunk).toString('utf8')
    let idx: number
    // 事件之间用空行分隔; 逐个处理完整事件, 剩余不完整片段留在 buf 里等下个 chunk.
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const raw = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      this.handleEvent(raw)
    }
  }

  private handleEvent(raw: string): void {
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (dataLines.length === 0) return
    const dataStr = dataLines.join('\n')
    if (dataStr === '[DONE]' || !dataStr.trim()) return
    let obj: any
    try { obj = JSON.parse(dataStr) } catch { return }
    // 文本增量: Anthropic 标准位 delta.text; 兼容少数把 text 放在 message.delta.text 的变体.
    const text = typeof obj?.delta?.text === 'string' ? obj.delta.text
      : (typeof obj?.delta?.content === 'string' ? obj.delta.content : null)
    if (text) this.onText(text)
  }
}

// ── HTTP 转发 ───────────────────────────────────────────────────────────────
// 这些请求头转发给上游时必须剥离 (host 由 fetch 重算; content-length 因重新发 body 失真;
// connection/accept-encoding 交给 fetch 自己处理).
const REQ_DROP_HEADERS = new Set([
  'authorization', 'x-api-key', 'host', 'content-length', 'connection', 'accept-encoding',
])
// 上游响应头回传给 cc 时剥离这些 (undici fetch 已对 gzip/br 透明解压, content-length 失真;
// 我们用 res.write 逐块流式, Node 会自动 chunked, 不能带 content-length).
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
  // 1) 解码代理 token → 真实上游.
  const authHeader = req.headers['authorization'] || ''
  const xApiKey = req.headers['x-api-key']
  const rawToken = (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (typeof xApiKey === 'string' ? xApiKey : ''))
  let upstream: { baseUrl: string; authToken: string; model: string }
  try {
    upstream = upstreamFromSettings(decodeProxyToken(rawToken))
  } catch (e: any) {
    res.status(401).json({ error: 'invalid proxy token', detail: e?.message || String(e) })
    return
  }
  if (!upstream.authToken) {
    res.status(401).json({ error: 'proxy token missing upstream auth' })
    return
  }

  // 2) 读完整请求体 (cc 发的是完整 JSON 请求, 非流式上传), 原样转发.
  let body: Buffer
  try {
    body = await readReqBody(req)
  } catch (e: any) {
    res.status(400).json({ error: 'failed to read request body', detail: e?.message || String(e) })
    return
  }

  // 3) 组装上游请求头: 透传 cc 的 anthropic-version/beta/user-agent 等, 替换鉴权.
  const upstreamHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (REQ_DROP_HEADERS.has(k.toLowerCase())) continue
    if (Array.isArray(v)) upstreamHeaders[k] = v.join(', ')
    else if (typeof v === 'string') upstreamHeaders[k] = v
  }
  upstreamHeaders['authorization'] = `Bearer ${upstream.authToken}`

  const upstreamUrl = upstream.baseUrl + req.path

  // 4) fetch 上游.
  let resp: Response
  try {
    resp = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body: body.length > 0 ? body : undefined,
    })
  } catch (e: any) {
    res.status(502).json({ error: 'upstream fetch failed', detail: e?.message || String(e) })
    return
  }

  // 5) 透传响应头 + 流式回传 body.
  const respHeaders: Record<string, string> = {}
  for (const [k, v] of resp.headers.entries()) {
    if (RESP_DROP_HEADERS.has(k.toLowerCase())) continue
    respHeaders[k] = v
  }
  res.writeHead(resp.status, respHeaders)

  const ct = (resp.headers.get('content-type') || '').toLowerCase()
  const isSse = ct.includes('text/event-stream')
  const extractor = isSse ? new SseTextExtractor((t) => pushToken(t, upstream.model)) : null

  try {
    if (!resp.body) {
      res.end()
      return
    }
    const reader = resp.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        res.write(Buffer.from(value))
        if (extractor) extractor.feed(value)
      }
    }
  } catch {
    // cc 提前断开 / 上游读取出错: 尽力结束响应, 不抛.
  }
  try { res.end() } catch { /* already ended */ }
}

// ── Express app ─────────────────────────────────────────────────────────────
const app = express()
// relay 路径走原始 body (上面 readReqBody 自己消费 stream), 不能挂 express.json.
// 其它路由 (token_stream/healthz) 无 body, 也不需要.

app.post('/v1/messages', (req, res) => { void relay(req, res) })
app.post('/v1/messages/count_tokens', (req, res) => { void relay(req, res) })

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'mobius-token-proxy', subscribers: subscribers.size, ts: Date.now() })
})

// /token_stream: SSE live tail (默认) 或 ?poll=1 JSON 快照.
// 被主后端 /api/token_stream 反代; 纯只读 token 字符, 无敏感信息.
app.get('/token_stream', (req, res) => {
  const wantPoll = req.query.poll === '1' || req.query.poll === 'true'
  if (wantPoll) {
    res.json({ ok: true, tokens: ring.slice(), ts: Date.now() })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // 告诉 nginx 别缓冲, 否则 SSE 实时性会被毁 (与 sessions.ts 一致).
    'X-Accel-Buffering': 'no',
  })
  // 连接时先推一次近期快照, 前端立刻有料可画.
  res.write(`event: snapshot\ndata: ${sseDataLine({ tokens: ring.slice() })}\n\n`)
  const sub: Subscriber = (entry) => {
    if (res.writableEnded || res.destroyed) return
    res.write(`event: token\ndata: ${sseDataLine(entry)}\n\n`)
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

// SSE data 行里的换行必须转义成 `\ndata: ` 前缀, 否则帧会被拆碎 (与 sessions.ts 一致).
function sseDataLine(payload: any): string {
  return JSON.stringify(payload).replace(/\r?\n/g, '\ndata: ')
}

app.all('*', (req, res) => {
  res.status(404).json({ error: 'not found', path: req.path })
})

app.listen(PORT, HOST, () => {
  console.log(`[token-proxy] listening on http://${HOST}:${PORT} (mobius 数字雨中转代理)`)
})
