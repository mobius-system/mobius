/**
 * token-stream-proxy.ts — /api/token_stream → 本机 token-proxy (server.ts) 反向代理.
 *
 * token-proxy 是独立 pm2 进程 (mobius-system-tokenproxy), 持有 token 环形缓冲.
 * 但拓展前端跑在用户浏览器里 (可能远程访问), 直连 127.0.0.1:TOKEN_PROXY_PORT 不通,
 * 所以拓展只请求主后端同源的 /api/token_stream, 由这里反代到本机 token-proxy.
 *
 * 这是主项目为"数字雨"拓展做的联合修改 (mobius-extension SKILL §4): /api/token_stream 是
 * 一条通用、只读、公开、与拓展名无关的 token 流端点, matrix-rain 只是它的一个渲染者.
 * 拓展的实时 SSE 流必须走它, 因为拓展 handler 跑在 30s 超时的 worker_thread 里, 无法维持
 * 长连接 (见 matrix-rain/backend/extension_backend_handler.js 注释).
 *
 * 纯只读 (近期的模型输出字符片段), 无敏感信息, 故无需鉴权; EventSource 也难带 JWT.
 * SSE 透传: pipe + 保留上游 X-Accel-Buffering:no, 与 sessions.ts 一致避免 nginx 缓冲.
 */
import express from 'express'
import http from 'http'
import { TOKEN_PROXY_HOST, TOKEN_PROXY_PORT } from '../config'

const router = express.Router()

router.get('/', (req: express.Request, res: express.Response) => {
  // 透传 query (如 ?poll=1) 给 token-proxy.
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  const upstreamReq = http.request(
    {
      hostname: TOKEN_PROXY_HOST,
      port: TOKEN_PROXY_PORT,
      path: `/token_stream${qs}`,
      method: 'GET',
      headers: { Accept: String(req.headers.accept || 'text/event-stream') },
    },
    (upstreamRes) => {
      // 逐字透传上游状态码与响应头 (含 content-type: text/event-stream, X-Accel-Buffering:no).
      // 不设 content-length: 上游是 chunked SSE, 主后端 res 也是流式, 由 Node 自动 chunked.
      res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstreamReq.on('error', (e) => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'token-proxy unreachable', detail: e?.message || String(e) })
    } else {
      try { res.end() } catch { /* already ended */ }
    }
  })
  // 客户端断开时中止上游连接, 避免僵尸 SSE.
  req.on('close', () => { upstreamReq.destroy() })
  upstreamReq.end()
})

export { router }
