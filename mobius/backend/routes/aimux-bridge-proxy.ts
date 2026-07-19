/**
 * /aimux_bridge/* → 127.0.0.1:${AIMUX_BRIDGE_PORT} 反向代理.
 *
 * 上游协议见 aimux Bridge Server v0.1 (aimux 0.1.3 自带 docs/bridge-protocol.md):
 *   /api/health, /api/remotes, /api/sessions,
 *   /api/sessions/{r}/{n}/{send-keys|capture|kill},
 *   /api/remotes/{r}/files/{stat|read|write|mkdir|list},
 *   /client/register, /client/events (SSE), /client/result.
 *
 * 鉴权两层:
 *   外部 → mobius auth 中间件 (JWT, 见 backend/middleware/auth)
 *   内部 → 注入 bridge Bearer token (从 runtime.json 读)
 *
 * runtime.json 由 aimux bridge broker 自己原子写, 路径来自 env.AIMUX_BRIDGE_RUNTIME.
 * 每次请求重读文件, 因为 token 在每次 bridge 重启时会变.
 *
 * Body 处理:
 *   server.js 已跳过 express.json() for /aimux_bridge/*, 所以 req 是原始 stream.
 *   这里手动 buffer + write 给 upstream, 而不是 pipe — pipe 在某些 express 状态下会丢数据.
 *   SSE 走 GET, 无 body, 走另一条流式 pipe 通路.
 */
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import url from 'url';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import { auth, authOrQuery } from '../middleware/auth';
import { Users } from '../repositories/users';

const router = express.Router();

const RUNTIME_PATH = process.env.AIMUX_BRIDGE_RUNTIME ||
  path.join(process.env.HOME || '/root', '.aimux', 'bridge', 'runtime.json');

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

interface BridgeTarget {
  baseUrl: string;
  token: string;
  hostname: string;
  port: number;
}

interface BridgeError extends Error {
  code: string;
}

function redactPath(rawPath: unknown): string {
  return String(rawPath || '').replace(/([?&]token=)[^&]+/g, '$1<redacted>');
}

function shouldLogPath(rawPath: unknown): boolean {
  const p = String(rawPath || '');
  return p.startsWith('/client/register') ||
    p.startsWith('/client/events') ||
    p.startsWith('/client/result');
}

function logBridgeProxy(req: express.Request, message: string, extra: string = ''): void {
  if (!shouldLogPath(req.url)) return;
  const suffix = extra ? ` ${extra}` : '';
  console.log(`[aimux-bridge-proxy] ${message}: ${req.method} ${redactPath(req.url)}${suffix}`);
}

function readBridgeTarget(): BridgeTarget {
  let raw: string;
  try {
    raw = fs.readFileSync(RUNTIME_PATH, 'utf-8');
  } catch {
    const err = new Error('aimux bridge broker is not running (runtime.json missing)') as BridgeError;
    err.code = 'BRIDGE_DOWN';
    throw err;
  }
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    const err = new Error('aimux bridge runtime.json is corrupt') as BridgeError;
    err.code = 'BRIDGE_DOWN';
    throw err;
  }
  if (!data || !data.url || !data.token) {
    const err = new Error('aimux bridge runtime.json missing url/token') as BridgeError;
    err.code = 'BRIDGE_DOWN';
    throw err;
  }
  const parsed = url.parse(data.url);
  return {
    baseUrl: data.url.replace(/\/$/, ''),
    token: data.token,
    hostname: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number(parsed.port) : 80,
  };
}

function buildUpstreamPath(req: express.Request): string {
  return req.url;
}

function pathWithoutQuery(rawPath: string): string {
  return rawPath.split('?')[0];
}

function proxyRequest(req: express.Request, res: express.Response): void {
  let target: BridgeTarget;
  try {
    target = readBridgeTarget();
  } catch (e) {
    const err = e as BridgeError;
    res.status(503).json({
      error: {
        kind: 'remote_disconnected',
        message: err.message,
        code: 2,
      },
    });
    return;
  }

  const upstreamPath = buildUpstreamPath(req);
  const isSSE = req.method === 'GET' && upstreamPath.startsWith('/client/events');
  const isForward = pathWithoutQuery(upstreamPath) === '/api/forward';

  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  for (const h of Object.keys(headers)) {
    if (HOP_BY_HOP_HEADERS.has(h.toLowerCase())) delete (headers as any)[h];
  }
  headers.host = `${target.hostname}:${target.port}`;
  headers.authorization = `Bearer ${target.token}`;
  headers['x-forwarded-for'] = req.ip || '';
  headers['x-forwarded-proto'] = req.protocol || 'http';

  if (isSSE || isForward) {
    logBridgeProxy(req, 'sse open');
    const upstreamReq = http.request({
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: upstreamPath,
      headers,
    }, (upstreamRes) => {
      logBridgeProxy(req, 'sse upstream', `status=${upstreamRes.statusCode}`);
      // nginx 默认 proxy_buffering on 会缓冲 SSE 响应, 导致反向连接的 client 收不到任务事件
      // (session.create / send-keys / capture) → broker 端 30s 超时, 表现为"连上了却下发不了指令".
      // X-Accel-Buffering: no 让 nginx 对该响应关闭缓冲, 心跳/事件即时 flush 到 client.
      const responseHeaders: http.OutgoingHttpHeaders = {
        ...upstreamRes.headers,
        'x-accel-buffering': 'no',
      };
      if (isSSE || String(upstreamRes.headers['content-type'] || '').includes('text/event-stream')) {
        responseHeaders['cache-control'] = 'no-cache, no-transform';
      }
      res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => logBridgeProxy(req, 'sse upstream end'));
    });
    upstreamReq.on('error', (err: Error) => {
      logBridgeProxy(req, 'sse upstream error', err.message);
      if (res.headersSent) { res.end(); return; }
      res.status(502).json({
        error: { kind: 'remote_disconnected', message: `aimux bridge broker is unreachable: ${err.message}`, code: 2 },
      });
    });
    upstreamReq.setTimeout(0);
    req.on('aborted', () => {
      logBridgeProxy(req, 'sse client close');
      upstreamReq.destroy();
    });
    res.on('close', () => {
      if (!res.writableEnded) upstreamReq.destroy();
    });
    if (isForward) req.pipe(upstreamReq);
    else upstreamReq.end();
    return;
  }

  // 非 SSE: 完整 buffer body 再转发, 避免 pipe 在 express 下丢数据
  const bodyChunks: Buffer[] = [];
  let totalLen = 0;
  req.on('data', (chunk: Buffer) => { bodyChunks.push(chunk); totalLen += chunk.length; });
  req.on('error', (err: Error) => {
    logBridgeProxy(req, 'request read error', err.message);
    if (res.headersSent) return;
    res.status(400).json({ error: { kind: 'bad_request', message: `request read error: ${err.message}`, code: 1 } });
  });
  req.on('end', () => {
    const body = Buffer.concat(bodyChunks, totalLen);
    headers['content-length'] = String(body.length);
    logBridgeProxy(req, 'proxy request', `bytes=${body.length}`);

    const upstreamReq = http.request({
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: upstreamPath,
      headers,
    }, (upstreamRes) => {
      logBridgeProxy(req, 'upstream response', `status=${upstreamRes.statusCode}`);
      res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', (err: Error) => {
      logBridgeProxy(req, 'upstream error', err.message);
      if (res.headersSent) { res.end(); return; }
      res.status(502).json({
        error: { kind: 'remote_disconnected', message: `aimux bridge broker is unreachable: ${err.message}`, code: 2 },
      });
    });
    upstreamReq.setTimeout(180000, () => {
      upstreamReq.destroy(new Error('aimux bridge upstream timeout'));
    });
    if (body.length > 0) upstreamReq.write(body);
    upstreamReq.end();
  });
}

// SSE 长连接走 authOrQuery (允许 ?token= 方便 curl 调试), 其余走标准 auth.
router.get('/client/events', authOrQuery, proxyRequest);
router.use(auth, proxyRequest);

function verifyUpgrade(req: any): boolean {
  const authorization = String(req.headers?.authorization || '');
  const token = authorization.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  try {
    const payload: any = jwt.verify(token, JWT_SECRET);
    const id = typeof payload === 'string' ? payload : payload?.id;
    return Boolean(id && Users.findAuthById(id));
  } catch {
    return false;
  }
}

function handleUpgrade(req: any, socket: any, head: Buffer): void {
  const rawPath = String(req.url || '');
  if (pathWithoutQuery(rawPath) !== '/aimux_bridge/api/forward' || !verifyUpgrade(req)) {
    socket.destroy();
    return;
  }
  let target: BridgeTarget;
  try {
    target = readBridgeTarget();
  } catch {
    socket.destroy();
    return;
  }
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'host' || name.toLowerCase() === 'authorization') delete (headers as any)[name];
  }
  headers.host = `${target.hostname}:${target.port}`;
  headers.authorization = `Bearer ${target.token}`;
  const upstreamReq = http.request({
    hostname: target.hostname,
    port: target.port,
    method: 'GET',
    path: '/api/forward',
    headers,
  });
  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`;
    socket.write(statusLine);
    for (let index = 0; index < upstreamRes.rawHeaders.length; index += 2) {
      socket.write(`${upstreamRes.rawHeaders[index]}: ${upstreamRes.rawHeaders[index + 1]}\r\n`);
    }
    socket.write('\r\n');
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
  });
  upstreamReq.on('response', (upstreamRes) => {
    socket.write(`HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\nConnection: close\r\n\r\n`);
    upstreamRes.pipe(socket);
  });
  upstreamReq.on('error', () => socket.destroy());
  upstreamReq.setTimeout(0);
  upstreamReq.end();
}

(router as any).handleUpgrade = handleUpgrade;
export = router;
