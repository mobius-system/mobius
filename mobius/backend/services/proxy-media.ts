// services/proxy-media.ts — 同源外链图片代理 (server-side fetch).
//
// 为什么需要它: jsonl 查看器里的 display_images / 附件图片卡片, 当图片源是
// http(s) URL 时, 原来由浏览器 <img src="https://外链"> 直连. 一旦图床做了
// 防盗链(Referer 校验)、外链不可达、或被浏览器混合内容/CORS 拦截, <img> 就
// onError, 卡片只剩死占位. 这里改成: 浏览器请求同源的 GET /api/proxy-media
// ?url=<encodeURIComponent>&token=<jwt>, 由 Mobius 后端在服务端 fetch 外链
// (带浏览器 UA + 同源 Referer 绕过防盗链), 流式回吐给浏览器.
//
// 安全红线 (必须满足):
//   1. 鉴权: 挂在 downloadAuth 下 (<img> 无法带 Authorization 头, 故 token 走 query).
//   2. 仅允许 http/https scheme (file:// / data: / gopher:// 等一律拒绝).
//   3. SSRF 防护: 自定义 DNS lookup, 解析到 内网/环回/链路本地/保留地址 一律拒绝;
//      在 connect 时机校验并复用同一解析地址连接, 防 DNS rebinding.
//   4. 跟随重定向时对每一跳重新做 scheme + SSRF 校验 (最多 5 跳).
//   5. 连接/读取超时 + 响应体大小上限 (50MB), 防放大攻击/资源耗尽.
import type { RequestHandler } from 'express';
import http from 'http';
import https from 'https';
import { Transform } from 'stream';
import dns from 'dns';
import net from 'net';

// ---- 可调常量 ----------------------------------------------------------
const MAX_REDIRECTS = 5;
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB 响应体上限
const CONNECT_TIMEOUT_MS = 10_000; // DNS/TCP/TLS 建连阶段看门狗超时
const SOCKET_TIMEOUT_MS = 20_000; // 连接建立后, 读取无活动超时
// 伪装成桌面 Chrome, 最大化过图床的 UA/Referer 校验.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 带状态码的业务错误, 便于 catch 里区分 400(请求非法/SSRF) vs 502(上游故障).
class ProxyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
  }
}

// ---- SSRF: 判定一个 IP 是否属于 内网/环回/链路本地/保留 ----------------
// 返回 true => 必须拒绝代理. 未知协议族也按拒绝处理 (保守).
function isPrivateOrReserved(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((n) => parseInt(n, 10));
    if (parts.length !== 4 || parts.some((x) => Number.isNaN(x))) return true;
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 "本机"
    if (a === 10) return true; // 10.0.0.0/8 私网
    if (a === 127) return true; // 127.0.0.0/8 环回
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 私网
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 私网
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // 224/4 多播 + 240/4 保留
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true; // 环回 / 未指定
    if (v.startsWith('fe80')) return true; // 链路本地
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // 唯一本地地址 (ULA)
    // IPv4-mapped IPv6 (::ffff:a.b.c.d): 抽出内嵌 IPv4 再判一次.
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateOrReserved(mapped[1]);
    if (v.startsWith('64:ff9b:')) return true; // NAT64 well-known 前缀, 可达内网映射, 保守拒
    return false;
  }
  return true; // 未知族 => 拒绝
}

// 自定义 DNS lookup: 解析后逐个校验, 命中私网/保留地址即报错.
// 作为 http(s).request 的 `lookup` 选项传入, 校验发生在建连时机且复用该解析地址,
// 从结构上防住 DNS rebinding (解析与连接用的是同一个已校验 IP).
function safeLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
): void {
  dns.lookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses) => {
    // 错误路径下 Node 只读 err, address/family 给占位值即可 (满足回调签名).
    if (err) return callback(err, '', 0);
    if (!addresses || addresses.length === 0) {
      return callback(new Error('No DNS result') as NodeJS.ErrnoException, '', 0);
    }
    for (const a of addresses) {
      if (isPrivateOrReserved(a.address)) {
        return callback(
          new Error('Blocked: target resolves to a private/internal address') as NodeJS.ErrnoException,
          '',
          0,
        );
      }
    }
    const first = addresses[0];
    callback(null, first.address, first.family);
  });
}

function isAllowedScheme(u: URL): boolean {
  return u.protocol === 'http:' || u.protocol === 'https:';
}

// IPv6 host 字面量在 URL 里带方括号 (new URL('http://[::1]/').hostname === '[::1]'),
// 去掉括号才能用 net.isIP / isPrivateOrReserved 判定.
function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

// 发起单次上游请求 (不跟随重定向), 用 safeLookup 做 SSRF 校验.
function fetchUpstream(target: URL): Promise<http.IncomingMessage> {
  // ⚠️ Node 对"字面量 IP"主机 (http://127.0.0.1 / http://10.0.0.1 / http://[::1])
  // 会跳过自定义 lookup 直接建连 —— safeLookup 只拦得住走 DNS 的主机名 (如 localhost).
  // 故在此对字面量 IP 显式校验, 私网/环回/链路本地一律拒绝.
  const literalHost = stripBrackets(target.hostname);
  if (net.isIP(literalHost) && isPrivateOrReserved(literalHost)) {
    return Promise.reject(new ProxyError(400, 'Blocked: target is a private/internal address'));
  }
  return new Promise((resolve, reject) => {
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        path: target.pathname + target.search,
        method: 'GET',
        lookup: safeLookup,
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'image/*,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
          // 伪装请求来自图床自身来源: 很多图床按 Referer 防盗链, 同源 Referer 通常放行.
          Referer: `${target.protocol}//${target.host}/`,
        },
      },
      (res) => resolve(res),
    );
    // 建连看门狗: req.setTimeout 只在 socket 已连接后管"读取无活动", 不覆盖
    // DNS/TCP/TLS 建连阶段的挂起 (被 DROP 的不可达主机会让 connect 永久卡住).
    // 故再起一个建连定时器, 连接建好 (connect / secureConnect) 即清除.
    let connectTimer: NodeJS.Timeout | null = null;
    req.on('socket', (socket) => {
      connectTimer = setTimeout(() => req.destroy(new Error('Upstream connect timeout')), CONNECT_TIMEOUT_MS);
      const clearConnect = (): void => {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      };
      socket.once('connect', clearConnect);
      socket.once('secureConnect', clearConnect);
    });
    // 读取无活动超时: socket 已连上后, 长时间收不到数据则中止.
    req.setTimeout(SOCKET_TIMEOUT_MS, () => {
      req.destroy(new Error('Upstream socket timeout'));
    });
    req.on('error', (err) => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      reject(err);
    });
    req.end();
  });
}

// 跟随 3xx 重定向, 每跳重新校验 scheme + SSRF (safeLookup 在每跳 fetch 内生效).
async function fetchFollowingRedirects(start: URL): Promise<http.IncomingMessage> {
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedScheme(current)) {
      throw new ProxyError(400, 'Only http/https URLs are allowed');
    }
    const res = await fetchUpstream(current);
    const code = res.statusCode || 0;
    if (code >= 300 && code < 400 && res.headers.location) {
      res.resume(); // 排空响应体, 释放 socket
      let next: URL;
      try {
        next = new URL(res.headers.location, current);
      } catch {
        throw new ProxyError(502, 'Upstream returned invalid redirect Location');
      }
      current = next;
      continue;
    }
    return res;
  }
  throw new ProxyError(502, 'Too many redirects');
}

// 计数字节流: 透传的同时, 一旦累计超过上限就销毁 (触发上游断开 + 管线 error).
class ByteLimitStream extends Transform {
  private received = 0;
  constructor(private readonly max: number) {
    super();
  }
  _transform(chunk: Buffer, _encoding: string, callback: (err?: Error | null) => void): void {
    this.received += chunk.length;
    if (this.received > this.max) {
      // 用自定义 error 让上层管线 'error' 处理器识别为"超限".
      const e = new Error('Upstream response exceeds size limit') as Error & { tooLarge?: boolean };
      e.tooLarge = true;
      callback(e);
      return;
    }
    this.push(chunk);
    callback();
  }
}

// 转发给客户端的安全响应头集合 (其余一律丢弃, 避免泄露/被滥用).
function copySafeHeaders(upstream: http.IncomingMessage, res: http.ServerResponse): void {
  const ct = upstream.headers['content-type'];
  if (ct) res.setHeader('Content-Type', ct);
  const cc = upstream.headers['cache-control'];
  if (cc) res.setHeader('Cache-Control', cc);
  const etag = upstream.headers['etag'];
  if (etag) res.setHeader('ETag', etag);
  const lm = upstream.headers['last-modified'];
  if (lm) res.setHeader('Last-Modified', lm);
  // 仅当上游明确声明且 <= 上限时转发 Content-Length (避免流式截断导致长度失配).
  const declared = upstream.headers['content-length'];
  if (declared) {
    const n = parseInt(declared, 10);
    if (Number.isFinite(n) && n >= 0 && n <= MAX_BYTES) {
      res.setHeader('Content-Length', String(n));
    }
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

// Express handler 工厂.
export function proxyMediaHandler(): RequestHandler {
  return (req, res) => {
    const raw = req.query.url as string | undefined;
    if (!raw || !raw.trim()) {
      res.status(400).json({ error: 'Missing url' });
      return;
    }
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      res.status(400).json({ error: 'Invalid url' });
      return;
    }
    if (!isAllowedScheme(target)) {
      res.status(400).json({ error: 'Only http/https URLs are allowed' });
      return;
    }

    let aborted = false;
    // 客户端中途断开: 立刻销毁上游连接, 释放资源.
    const onClose = (): void => {
      aborted = true;
    };
    req.on('close', onClose);

    fetchFollowingRedirects(target)
      .then((upstream) => {
        if (aborted) {
          upstream.destroy();
          return;
        }
        const code = upstream.statusCode || 502;
        // 非 2xx: 把上游状态映射回客户端 (4xx 原样透传, 5xx 归 502), 附简短说明.
        if (code < 200 || code >= 300) {
          upstream.resume();
          const mapped = code === 401 || code === 403 || code === 404 || code === 410 ? code : 502;
          res.status(mapped).json({ error: `Upstream responded ${code}` });
          return;
        }
        // 提前拦截: 上游已声明超过上限的体积, 直接拒, 不流式.
        const declared = upstream.headers['content-length'];
        if (declared) {
          const n = parseInt(declared, 10);
          if (Number.isFinite(n) && n > MAX_BYTES) {
            upstream.destroy();
            res.status(413).json({ error: 'Upstream response too large' });
            return;
          }
        }
        copySafeHeaders(upstream, res);
        res.status(200);

        const limiter = new ByteLimitStream(MAX_BYTES);
        // 上游/计数流任一报错: 尽量给客户端一个明确状态 (头部未发时), 否则直接结束.
        const fail = (status: number, message: string): void => {
          upstream.destroy();
          if (!res.headersSent) {
            res.status(status).json({ error: message });
          } else if (!res.writableEnded) {
            res.end();
          }
        };
        upstream.on('error', (err) => fail(502, `Upstream read error: ${err.message}`));
        limiter.on('error', (err: Error & { tooLarge?: boolean }) => {
          if (err.tooLarge) fail(413, 'Upstream response too large');
          else fail(502, `Stream error: ${err.message}`);
        });
        res.on('error', () => upstream.destroy());

        upstream.pipe(limiter).pipe(res);
      })
      .catch((err: unknown) => {
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
          return;
        }
        if (err instanceof ProxyError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        const e = err as NodeJS.ErrnoException | undefined;
        const msg = e?.message || 'Proxy fetch failed';
        // SSRF / scheme / 解析类 => 400 (请求本身不合法); 其余网络/上游故障 => 502.
        const looksLikeBadInput = /Blocked|private|internal|Only http|Invalid|Missing|No DNS|ENOTFOUND|EAI_/i.test(msg);
        res.status(looksLikeBadInput ? 400 : 502).json({ error: msg });
      });
  };
}
