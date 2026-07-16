import express from 'express';
import { v4 as uuid } from 'uuid';
import { auth } from '../middleware/auth';
import { Sessions } from '../repositories/sessions';
import { Messages } from '../repositories/messages';
// @ts-ignore — service 仍是 .js
import { withSessionProxyState, withSessionProxyStates } from '../services/session-proxy-state';
// @ts-ignore — service 仍是 .js
import { canOperateSession, canReadSession } from '../services/access-control';

const router = express.Router();

function findSessionReadable(id: string, user: any): any {
  const session = Sessions.findById(id);
  return session && canReadSession(user, session) ? session : null;
}

function findSessionOperable(id: string, user: any): any {
  const session = Sessions.findById(id);
  return session && canOperateSession(user, session) ? session : null;
}

router.get('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  res.json(withSessionProxyStates(Sessions.listForUser(user.id)));
});

router.get('/recent', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const rawLimit = Number(req.query.limit || 12);
  const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 12));
  res.json(Sessions.listRecentForUser(user.id, limit));
});

router.post('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const { name, description, issue_id } = (req.body || {}) as { name?: string; description?: string; issue_id?: string };
  if (!name) {
    res.status(400).json({ error: '请填写任务名称' });
    return;
  }

  const sessionId = uuid().slice(0, 8);
  const sessionKey = `web:${user.id}:${sessionId}`;
  const targetIssue = issue_id || '__default_issue__';

  Sessions.insert({
    session_id: sessionId,
    issue_id: targetIssue,
    user_id: user.id,
    name,
    description,
    session_key: sessionKey,
  } as any);
  res.json(withSessionProxyState(Sessions.findById(sessionId)));
});

router.get('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const session = findSessionReadable(String(req.params.id), user);
  if (!session) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  res.json(withSessionProxyState(session));
});

router.patch('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const session = findSessionOperable(id, user);
  if (!session) {
    res.status(404).json({ error: '未找到' });
    return;
  }

  const { name, status, description, risk_level } = (req.body || {}) as {
    name?: string;
    status?: string;
    description?: string;
    risk_level?: string;
  };
  if (name) Sessions.updateName(id, name);
  if (status) {
    if (status === 'deleted') {
      res.status(400).json({ error: 'Session 删除请使用 DELETE；删除后不会进入回收站' });
      return;
    }
    if (session.scope_type === 'research' && ['deleted', 'archived'].includes(status)) {
      res.status(400).json({ error: 'Research Session 创建后不能删除或归档' });
      return;
    }
    Sessions.updateStatus(id, status as any);
  }
  if (description !== undefined) Sessions.updateDescription(id, description);
  if (risk_level && ['medium', 'low'].includes(risk_level)) Sessions.updateRiskLevel(id, risk_level);

  res.json(withSessionProxyState(Sessions.findById(id)));
});

router.delete('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const session = findSessionOperable(id, user);
  if (!session) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  if (session.scope_type === 'research') {
    res.status(400).json({ error: 'Research Session 创建后不能删除；如需暂停执行，请使用"终止"按钮' });
    return;
  }
  Sessions.archive(id);
  res.json({ ok: true });
});

router.post('/:id/restore', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const session = findSessionOperable(id, user);
  if (!session) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  Sessions.restoreFromArchive(id);
  res.json({ ok: true, session: withSessionProxyState(Sessions.findById(id)) });
});

router.delete('/:id/permanent', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const session = findSessionOperable(id, user);
  if (!session) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  if (session.scope_type === 'research') {
    res.status(400).json({ error: 'Research Session 不能永久删除' });
    return;
  }
  Sessions.permanentDelete(id);
  res.json({ ok: true });
});

router.get('/:id/messages', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const session = findSessionReadable(id, user);
  if (!session) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  res.json(Messages.recentForTask(id, req.query.limit));
});

router.get('/:id/bookmarks', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const task = findSessionReadable(id, user);
  if (!task) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json(Messages.bookmarksForTask(id));
});

// no-auth: wrapper/hooks 查询用
router.get('/:id/risk', (req: express.Request, res: express.Response) => {
  const id = String(req.params.id);
  const task = Sessions.findRiskById(id);
  res.json({ risk_level: task ? task.risk_level : 'medium' });
});

export = router;
