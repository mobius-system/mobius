import express from 'express';
import { v4 as uuid } from 'uuid';
import { auth } from '../middleware/auth';
import { Sessions } from '../repositories/sessions';
import { Issues } from '../repositories/issues';
import { Projects } from '../repositories/projects';
import { Changes, Conflicts, Queue } from '../repositories/changes';
import { audit } from '../repositories/audit';
// @ts-ignore — service 仍是 .js
import {
  canManageIssue,
  canOperateSession,
  canReadIssue,
  canReadProject,
  canReadSession,
} from '../services/access-control';
// @ts-ignore — service 仍是 .js
import {
  scanSessionChange,
  recomputeProjectConflicts,
  refreshIssueIntegration,
  changePayload,
  integrateIssue,
} from '../services/change-scan';

const router = express.Router();

interface ScopedUser {
  id: string;
  role: string;
  [k: string]: any;
}

function getVisibleSession(req: express.Request, sessionId: string): any {
  const user = (req as any).user as ScopedUser;
  const session = Sessions.findByIdWithJoins(sessionId);
  if (!session) return null;
  if (!canReadSession(user, session)) return null;
  return session;
}

function getOperableSession(req: express.Request, sessionId: string): any {
  const user = (req as any).user as ScopedUser;
  const session = Sessions.findByIdWithJoins(sessionId);
  if (!session) return null;
  if (!canOperateSession(user, session)) return null;
  return session;
}

// ===== /api/sessions/:id/changes =====
router.get('/sessions/:id/changes', auth, (req: express.Request, res: express.Response) => {
  const session = getVisibleSession(req, String(req.params.id));
  if (!session) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  const change = Changes.findIdBySession(String(req.params.id));
  res.json(change ? changePayload(change.id) : null);
});

router.post('/sessions/:id/changes/scan', auth, (req: express.Request, res: express.Response) => {
  const session = getOperableSession(req, String(req.params.id));
  if (!session) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  const files = ((req.body as any)?.files as any[]) || [];
  res.json(scanSessionChange(req, session, files));
});

router.post('/sessions/:id/changes/check', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as ScopedUser;
  const session = getOperableSession(req, String(req.params.id));
  if (!session) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  const files = ((req.body as any)?.files as any[]) || [];
  const payload = scanSessionChange(req, session, files) as any;
  const hasBlocking = payload.conflicts.some((c: any) => c.severity === 'blocking');
  const checkStatus = hasBlocking ? 'failed' : 'passed';
  const detail = hasBlocking ? '存在阻塞冲突, 需要先消解或管理员忽略。' : '观测检查通过: 未发现阻塞冲突。';
  Changes.setCheckResult(payload.id, checkStatus, detail, hasBlocking ? 'conflict' : 'ready');
  refreshIssueIntegration(session.issue_id);
  audit(user.id, 'check_session_change', 'session', session.session_id, detail);
  res.json(changePayload(payload.id));
});

// ===== /api/issues/:id/integration =====
router.get('/issues/:id/integration', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as ScopedUser;
  const issue = Issues.findById(String(req.params.id));
  if (!issue || !canReadIssue(user, issue)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  const integration = refreshIssueIntegration(issue.id);
  const changes = Changes.forIssueWithUser(issue.id).map((c: any) => changePayload(c.id));
  res.json({ issue, integration, changes });
});

router.post('/issues/:id/integration/check', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as ScopedUser;
  const issue = Issues.findById(String(req.params.id));
  if (!issue || !canManageIssue(user, issue)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  const sessions = Sessions.listActiveByIssue(issue.id);
  for (const session of sessions) scanSessionChange(req, session, []);
  const integration = refreshIssueIntegration(issue.id);
  audit(user.id, 'check_issue_integration', 'issue', issue.id, `status=${integration?.status}`);
  res.json({
    issue,
    integration,
    changes: sessions
      .map((s: any) => Changes.findIdBySession(s.session_id))
      .filter(Boolean)
      .map((c: any) => changePayload(c.id)),
  });
});

router.post('/issues/:id/integration/accept', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as ScopedUser;
  const issue = Issues.findById(String(req.params.id));
  if (!issue || !canManageIssue(user, issue)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  let integration = refreshIssueIntegration(issue.id);
  const canAccept = integration && integration.internal_conflict_count === 0 && integration.build_status !== 'failed';
  // setAcceptance signature: (issueId, acceptance, status, releaseNote)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { IssueIntegrations } = require('../repositories/issues');
  IssueIntegrations.setAcceptance(
    issue.id,
    canAccept ? 'passed' : 'failed',
    canAccept ? 'ready' : 'blocked',
    (req.body as any)?.release_note || null,
  );
  integration = refreshIssueIntegration(issue.id);
  audit(user.id, 'accept_issue', 'issue', issue.id, canAccept ? 'passed' : 'failed');
  res.json({ issue, integration });
});

router.post('/issues/:id/integration/enqueue', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as ScopedUser;
  const issue = Issues.findById(String(req.params.id));
  if (!issue || !canManageIssue(user, issue)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  const integration = refreshIssueIntegration(issue.id);
  const maxPriority = Queue.maxPriority(issue.project_id);
  const status = integration?.status === 'ready' ? 'queued' : 'blocked';
  const reason = status === 'queued' ? '' : 'Issue 尚未验收通过或存在阻塞冲突';
  Queue.upsert({
    id: uuid().slice(0, 12),
    projectId: issue.project_id,
    issueId: issue.id,
    priority: maxPriority + 1,
    status,
    reason,
  });
  audit(user.id, 'enqueue_issue', 'issue', issue.id, status);
  res.json({ ok: true, status, reason });
});

// ===== /api/projects/:id/integration-queue =====
router.get('/projects/:id/integration-queue', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as ScopedUser;
  const project = Projects.findById(String(req.params.id));
  if (!project || !canReadProject(user, project)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  recomputeProjectConflicts(project.id);
  res.json({
    project,
    metrics: Queue.projectMetrics(project.id),
    queue: Queue.listForProject(project.id),
    issues: Queue.issuesWithIntegrationForProject(project.id),
  });
});

router.post('/projects/:id/integration-queue/reorder', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as ScopedUser;
  const project = Projects.findById(String(req.params.id));
  if (!project || user.role !== 'admin') {
    res.status(404).json({ error: '未找到或无权限' });
    return;
  }
  const issueIds: any[] = Array.isArray((req.body as any)?.issue_ids) ? (req.body as any).issue_ids : [];
  Queue.reorder(project.id, issueIds);
  audit(user.id, 'reorder_queue', 'project', project.id, issueIds.join(','));
  res.json({ ok: true });
});

router.post('/projects/:id/integration-queue/run', auth, (req: express.Request, res: express.Response) => {
  const project = Projects.findById(String(req.params.id));
  const user = (req as any).user as ScopedUser;
  if (!project || user.role !== 'admin') {
    res.status(404).json({ error: '未找到或无权限' });
    return;
  }
  const selected: any[] = Array.isArray((req.body as any)?.issue_ids) ? (req.body as any).issue_ids : [];
  const queue = Queue.queuedIssueIds(project.id).filter((id: any) => selected.length === 0 || selected.includes(id));
  const results = queue.map((issueId: any) => ({ issue_id: issueId, ...integrateIssue(req, issueId) }));
  res.json({ results });
});

// ===== /api/conflicts =====
router.get('/conflicts', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as ScopedUser;
  const projectId = req.query.project_id as string | undefined;
  const project = projectId ? Projects.findById(projectId) : null;
  if (!project || !canReadProject(user, project)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  recomputeProjectConflicts(projectId as string);
  res.json(Conflicts.listForProject(projectId as string));
});

router.patch('/conflicts/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as ScopedUser;
  const conflict = Conflicts.findByIdJoined(String(req.params.id));
  if (!conflict || user.role !== 'admin') {
    res.status(404).json({ error: '未找到或无权限' });
    return;
  }
  const status = ['open', 'resolved', 'ignored'].includes((req.body as any)?.status) ? (req.body as any).status : conflict.status;
  const note = (req.body as any)?.resolution_note || '';
  Conflicts.updateStatus(conflict.id, status, note);
  refreshIssueIntegration(conflict.left_issue_id);
  refreshIssueIntegration(conflict.right_issue_id);
  audit(user.id, 'update_conflict', 'conflict', conflict.id, `${status}: ${note}`);
  res.json(Conflicts.findById(conflict.id));
});

export = router;
