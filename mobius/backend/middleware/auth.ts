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

// docker 隔离的心跳: 任意带 JWT 的鉴权请求都会续命/创建该用户的沙箱容器 (方案 A, 2026-10-13).
function touchIsolationHeartbeat(dbUser: unknown): void {
  try {
    const ui = require('../services/user-isolation') as typeof import('../services/user-isolation');
    ui.onAuthedRequest?.(dbUser);
  } catch { /* 心跳失败不影响鉴权 */ }
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
    touchIsolationHeartbeat(dbUser);
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
    touchIsolationHeartbeat(dbUser);
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
    touchIsolationHeartbeat(dbUser);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

export { auth, adminAuth, downloadAuth, authOrQuery };

// 触发 RequestHandler 类型推导 (供外部按需标注时取用)
export type { RequestHandler };
