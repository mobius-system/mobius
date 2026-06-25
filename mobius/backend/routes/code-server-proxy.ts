/**
 * code-server-proxy.ts — /code-server/<userId>__<projectId>/* 反代 + JWT.
 *
 * 流程:
 *   1. window.open(`/code-server/<key>/?folder=...&_jwt=<token>`)
 *   2. 路由检 _jwt → 写 cookie cc_cs_jwt → 302 去掉 _jwt 的干净 URL
 *   3. 后续 HTTP / WS 全走 cookie
 *   4. jwt.id 必须 === URL 里的 userId, 防越权
 *   5. pool.ensure() lazy 起进程, 反代过去
 */
import express from 'express';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
// @ts-ignore — http-proxy 没有 TS 类型 / 仍是 CommonJS
import httpProxy from 'http-proxy';
// @ts-ignore — cookie 没有 TS 类型声明
import cookie from 'cookie';
import { JWT_SECRET } from '../config';
import { Projects } from '../repositories/projects';
// @ts-ignore — service 仍是 .js
import { canReadProject } from '../services/access-control';
// @ts-ignore — service 仍是 .js
import pool from '../services/code-server-pool';
// @ts-ignore — service 仍是 .js
import { resolveCodeServerWorkspace, validateCodeServerPayload } from '../services/code-server-workspace';

const COOKIE_NAME = 'cc_cs_jwt';
const PATH_PREFIX = '/code-server/';

// 小莫面板的 "Skill" 快捷按钮使用一个虚拟 projectId 直接打开 mobius-assistant
// 技能源目录, 不需要真实项目行. 仅管理员可访问, 防止普通用户改动内置技能.
const SKILL_VIRTUAL_PROJECT_ID = 'xm-skills';
const BUILTIN_MOBIUS_ASSISTANT_SKILL_DIR = path.resolve(__dirname, '..', '..', '..', 'skills', 'mobius-assistant');

const proxy: any = httpProxy.createProxyServer({
  ws: true,
  xfwd: true,
  changeOrigin: false,
});

proxy.on('error', (err: Error, req: any, res: any) => {
  console.error('[cs-proxy] proxy error:', err.message);
  try {
    if (res && !res.headersSent && res.writeHead) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('code-server 代理失败: ' + err.message);
    }
  } catch { /* ignore */ }
});

interface ParsedKey {
  userId: string;
  projectId: string;
  rest: string;
  key: string;
}

function parseKey(urlPath: string): ParsedKey | null {
  if (!urlPath.startsWith(PATH_PREFIX)) return null;
  const after = urlPath.slice(PATH_PREFIX.length);
  const sep = after.indexOf('/');
  const key = sep === -1 ? after : after.slice(0, sep);
  const rest = sep === -1 ? '/' : after.slice(sep);
  const m = key.match(/^([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  return { userId: m[1], projectId: m[2], rest, key };
}

interface JwtLocation {
  token: string;
  from: 'query' | 'cookie';
}

function extractJwt(req: { url: string; headers: { cookie?: string } | any }): JwtLocation | null {
  try {
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams.get('_jwt');
    if (q) return { token: q, from: 'query' };
  } catch { /* fallthrough */ }
  const cookies = cookie.parse(req.headers?.cookie || '');
  if (cookies[COOKIE_NAME]) return { token: cookies[COOKIE_NAME], from: 'cookie' };
  return null;
}

function verifyJwt(token: string): { id: string; role?: string; [k: string]: any } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { id: string; role?: string; [k: string]: any };
  } catch {
    return null;
  }
}

function queryParam(rawUrl: string, name: string): string {
  try {
    return new URL(rawUrl, 'http://x').searchParams.get(name) || '';
  } catch {
    return '';
  }
}

function hasQueryParam(rawUrl: string, name: string): boolean {
  try {
    return new URL(rawUrl, 'http://x').searchParams.has(name);
  } catch {
    return false;
  }
}

function liveEntry(k: string): any {
  const entry = pool.get(k);
  return entry && entry.proc && !entry.proc.killed ? entry : null;
}

interface WorkspaceResult {
  workspacePath?: string;
  hasFolder: boolean;
  error?: string;
  code?: string;
}

function pickWorkspace(project: any, rawUrl: string, k: string): WorkspaceResult {
  const hasFolder = hasQueryParam(rawUrl, 'folder');
  if (!hasFolder) {
    const existing = liveEntry(k);
    if (existing?.bindPath) return { workspacePath: existing.bindPath, hasFolder };
  }
  const resolved: any = resolveCodeServerWorkspace(project, queryParam(rawUrl, 'folder'));
  return { ...resolved, hasFolder };
}

interface ProjectAccessOk {
  ok: true;
  project: any;
}
interface ProjectAccessFail {
  ok: false;
  status: number;
  msg: string;
}
type ProjectAccessResult = ProjectAccessOk | ProjectAccessFail;

function checkProjectAccess(user: { id: string; role?: string } | null, projectId: string): ProjectAccessResult {
  if (projectId === SKILL_VIRTUAL_PROJECT_ID) {
    if (user?.role !== 'admin') return { ok: false, status: 403, msg: '仅管理员可编辑小莫内置技能' };
    const skillDir = BUILTIN_MOBIUS_ASSISTANT_SKILL_DIR;
    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
      return { ok: false, status: 404, msg: '小莫内置技能目录不存在: ' + skillDir };
    }
    return {
      ok: true,
      project: { id: projectId, bind_path: skillDir, bind_path_manual: true, kind: '' },
    };
  }
  const p = Projects.findById(projectId);
  if (!p) return { ok: false, status: 404, msg: '项目不存在' };
  if (!canReadProject(user, p)) return { ok: false, status: 404, msg: '项目不存在' };
  if (!p.bind_path) return { ok: false, status: 400, msg: '项目未配置 bind_path' };
  return { ok: true, project: p };
}

const router = express.Router();

router.use(async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const urlPath = req.originalUrl.split('?')[0];
  const parsed = parseKey(urlPath);
  if (!parsed) {
    res.status(404).send('bad code-server path');
    return;
  }

  const found = extractJwt(req);
  if (!found) {
    res.status(401).send('需要登录: 缺 JWT (cookie 或 _jwt query)');
    return;
  }
  const user = verifyJwt(found.token);
  if (!user) {
    res.status(401).send('JWT 校验失败');
    return;
  }
  if (user.id !== parsed.userId) {
    res.status(403).send('用户身份不匹配 URL key');
    return;
  }

  const acc = checkProjectAccess(user, parsed.projectId);
  if (!acc.ok) {
    res.status(acc.status).send(acc.msg);
    return;
  }

  if (found.from === 'query') {
    res.setHeader('Set-Cookie', cookie.serialize(COOKIE_NAME, found.token, {
      httpOnly: true, sameSite: 'lax', path: '/code-server', maxAge: 4 * 3600,
    }));
    const cleanUrl = new URL(req.originalUrl, 'http://x');
    cleanUrl.searchParams.delete('_jwt');
    res.redirect(302, cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
    return;
  }

  const workspace = pickWorkspace(acc.project, req.originalUrl, parsed.key);
  if (workspace.error) {
    if (workspace.code === 'BIND_PATH_DENIED') {
      res.status(403).send(workspace.error);
      return;
    }
    res.status(404).send(workspace.error);
    return;
  }
  const payloadCheck: any = validateCodeServerPayload(acc.project, queryParam(req.originalUrl, 'payload'), workspace.workspacePath);
  if (!payloadCheck.ok) {
    res.status(403).send(payloadCheck.error);
    return;
  }

  let entry: { port: number; [k: string]: any };
  try {
    entry = await pool.ensure(user, parsed.projectId, workspace.workspacePath);
  } catch (e) {
    const err = e as Error & { code?: string };
    console.error('[cs-proxy] pool.ensure failed:', err.message);
    if (err.code === 'BIND_PATH_RO') {
      res.status(403).send(`📂 此项目目录对服务进程不可写: ${workspace.workspacePath}\n请联系管理员 chmod 调权限`);
      return;
    }
    if (err.code === 'BIND_PATH_INVALID') {
      res.status(404).send(`📂 项目目录不存在: ${workspace.workspacePath}`);
      return;
    }
    res.status(503).send('code-server 启动失败: ' + err.message);
    return;
  }
  pool.touch(parsed.key);

  req.url = parsed.rest + (req.originalUrl.includes('?') ? '?' + req.originalUrl.split('?').slice(1).join('?') : '');
  if (workspace.hasFolder && workspace.workspacePath) {
    req.url = req.url.replace(
      /([?&]folder=)[^&]*/,
      `$1${encodeURIComponent(workspace.workspacePath)}`,
    );
  }
  proxy.web(req, res, { target: `http://127.0.0.1:${entry.port}` });
});

async function handleUpgrade(req: any, socket: any, head: Buffer): Promise<void> {
  const urlPath = (req.url as string).split('?')[0];
  const parsed = parseKey(urlPath);
  if (!parsed) { socket.destroy(); return; }

  const found = extractJwt(req);
  if (!found) { socket.destroy(); return; }
  const user = verifyJwt(found.token);
  if (!user || user.id !== parsed.userId) { socket.destroy(); return; }

  const acc = checkProjectAccess(user, parsed.projectId);
  if (!acc.ok) { socket.destroy(); return; }

  const workspace = pickWorkspace(acc.project, req.url, parsed.key);
  if (workspace.error) { socket.destroy(); return; }

  let entry: { port: number; [k: string]: any };
  try {
    entry = await pool.ensure(user, parsed.projectId, workspace.workspacePath);
  } catch (e) {
    console.error('[cs-proxy/ws] ensure failed:', (e as Error).message);
    socket.destroy();
    return;
  }
  pool.touch(parsed.key);

  req.url = parsed.rest + (req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '');
  proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${entry.port}` });
}

const adminRouter = express.Router();
adminRouter.get('/list', (req: express.Request, res: express.Response) => {
  const found = extractJwt(req);
  const user = found && verifyJwt(found.token);
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'admin only' });
    return;
  }
  res.json(pool.list());
});

export { router, handleUpgrade, adminRouter };
