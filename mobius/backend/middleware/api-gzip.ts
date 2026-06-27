import type { Request, Response, NextFunction } from 'express';
import zlib from 'zlib';

// REST JSON 响应的 gzip 压缩中间件.
//
// 为什么不用 express 的 compression 包: SSE (text/event-stream) 不能被通用 compression
// 中间件处理——它会攒满内部 buffer 才吐字节, 毁掉事件实时投递. sessions.ts 的 /:id/events
// 已自己做流式 gzip (逐帧 Z_SYNC_FLUSH), 本中间件必须对 SSE 和"已带 Content-Encoding"的
// 响应一律放行, 绝不二次压缩/缓冲.
//
// 实现策略: 只拦截"一次性带 body 的"响应 (Express res.json()/res.send() 会把完整 body
// 作为单个 Buffer 传给 res.end). 流式响应 (多次 res.write 后 res.end() 无 chunk) 天然不命中,
// 直接透传. 因此 SSE / 文件下载 / 代理透传都安全.
//
// 压缩比参考: JSON/JSONL 通常压到原体积的 ~8-20%.

const MIN_COMPRESS_BYTES = 1024;   // 太小不压 (gzip 头开销反而更大)
const MAX_COMPRESS_BYTES = 8 * 1024 * 1024; // 超过 8MB 跳过, 避免 gzipSync 长时间阻塞事件循环

function acceptsGzip(req: Request): boolean {
  const ae = String(req.headers['accept-encoding'] || '').toLowerCase();
  return ae.split(',').some((t) => t.split(';')[0].trim() === 'gzip');
}

// 只压这些 content-type; 其它 (octet-stream / 图片 / 已编码 / SSE) 一律放行.
function isCompressibleContentType(ct: string): boolean {
  return ct.includes('json')
    || ct.includes('text/')
    || ct.includes('javascript')
    || ct.includes('xml')
    || ct.includes('css');
}

// apiGzip: 全局挂在路由之前. 对每个响应惰性拦截 res.end.
export function apiGzip(req: Request, res: Response, next: NextFunction): void {
  if (!acceptsGzip(req)) { next(); return; }

  const origEnd = res.end.bind(res) as (chunk?: any, encoding?: any) => Response;

  // @ts-ignore — 覆写 res.end, 只在"一次性带 body 的可压缩响应"时就地 gzip.
  res.end = function (chunk?: any, encoding?: any): Response {
    const ct = String(res.getHeader('content-type') || '');
    const alreadyEncoded = !!res.getHeader('content-encoding');
    const isStream = ct.includes('text/event-stream');
    const hasBody = chunk != null && chunk !== '';

    if (hasBody && !alreadyEncoded && !isStream && isCompressibleContentType(ct)) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding || 'utf8');
      if (buf.length >= MIN_COMPRESS_BYTES && buf.length <= MAX_COMPRESS_BYTES) {
        try {
          const gz = zlib.gzipSync(buf, { level: 6 });
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Vary', 'Accept-Encoding');
          res.setHeader('Content-Length', gz.length);
          return origEnd(gz);
        } catch {
          // 压缩失败回落原始 body, 不影响响应本身.
        }
      }
    }
    return origEnd(chunk, encoding);
  };

  next();
}

export default apiGzip;
