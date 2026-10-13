import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { JWT_SECRET } from '../config';
import { Users } from '../repositories/users';

interface AuthPayload {
  id: string;
  [key: string]: unknown;
}

function loadUser(token: string): unknown {
  const payload = jwt.verify(token, JWT_SECRET) as AuthPayload | string;
  const id = typeof payload === 'string' ? payload : payload.id;
  return Users.findAuthById(id);
}

function extractToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  const fromHeader = header ? header.replace(/^Bearer\s+/i, '') : '';
  return fromHeader || undefined;
}

function auth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'No token' });
    return;
  }
  try {
    const dbUser = loadUser(token);
    if (!dbUser) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    (req as any).user = dbUser;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminAuth(req: Request, res: Response, next: NextFunction): void {
  auth(req, res, () => {
    const user = (req as any).user as { role?: string } | undefined;
    if (!user || user.role !== 'admin') {
      res.status(403).json({ error: 'Admin only' });
      return;
    }
    next();
  });
}

// Download 路由也接受 ?token= query
function downloadAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req) || (req.query.token as string | undefined);
  if (!token) {
    res.status(401).json({ error: 'No token' });
    return;
  }
  try {
    const dbUser = loadUser(token);
    if (!dbUser) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    (req as any).user = dbUser;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function authOrQuery(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req) || (req.query.token as string | undefined);
  if (!token) {
    res.status(401).json({ error: 'No token' });
    return;
  }
  try {
    const dbUser = loadUser(token);
    if (!dbUser) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    (req as any).user = dbUser;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── 临时措施 (2026-10-13, 用户决策): 普通用户全站封禁 ─────────────────────────
// 挂在 /api 与 /aimux_bridge 之前: 带有效 token 的普通用户一律 401.
// 为什么用 401 而不是 403: 前端 api() 收到 401 会清 token 并跳回登录页, 正好把
// 已登录的普通用户干净地踢出; 403 只会让页面带着坏 token 反复报错.
// 无 token / token 无效一律放行, 交给原 auth 中间件按老逻辑处理 (登录页要读 /api/auth/config).
export function blockNormalUsersWhileLocked(req: Request, res: Response, next: NextFunction): void {
  const userIsolation = require('../services/user-isolation') as typeof import('../services/user-isolation');
  if (!userIsolation.NORMAL_USER_ACCESS_BLOCKED) return next();
  const token = extractToken(req) || (req.query.token as string | undefined);
  if (!token) return next();
  let dbUser: unknown;
  try { dbUser = loadUser(token); } catch { return next(); } // token 无效 → 交给 auth 中间件 401
  if (!dbUser) return next();
  if (userIsolation.normalUserAccessBlockedFor(dbUser)) {
    res.status(401).json({ error: '普通用户访问已暂时关闭，请稍后再试', code: 'NORMAL_USER_ACCESS_DISABLED' });
    return;
  }
  next();
}

export { auth, adminAuth, downloadAuth, authOrQuery };

// 触发 RequestHandler 类型推导 (供外部按需标注时取用)
export type { RequestHandler };
