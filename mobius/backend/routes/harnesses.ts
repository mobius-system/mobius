import express from 'express';
import { auth } from '../middleware/auth';
import { Issues } from '../repositories/issues';
import { Projects } from '../repositories/projects';
import {
  createHarnessRun,
  findRunOwner,
  getHarnessRunSnapshot,
  listHarnessRunsForIssue,
  listVisibleHarnessProfiles,
  resolveRoster,
} from '../repositories/harness';
import {
  canCreateHarnessRun,
  canReadHarnessRun,
  canReadIssue,
  canReadProject,
} from '../services/access-control';
import {
  completeHarnessNode,
  createTaskForMember,
  failHarnessNode,
  internalRoster,
  reportHarnessProgress,
  waitForInternalRunEvents,
} from '../services/harness-actions';
import { estimateHarnessRun } from '../services/harness-estimator';
import {
  HarnessSchemaError,
  parseHarnessCreateRunRequest,
  parseHarnessEstimateRequest,
} from '../services/harness-schema';
import { requestHarnessScan } from '../services/harness-orchestrator';
import { requireHarnessAction, verifyHarnessNodeToken } from '../services/harness-token';
import type { HarnessInternalTokenPayload } from '../types/harness';

type AnyError = Error & { status?: number; code?: string; details?: unknown };

const profilesRouter = express.Router();
const runsRouter = express.Router();
const internalRouter = express.Router();

function sendError(res: express.Response, error: unknown): void {
  const err = error as AnyError;
  const status = Number(err?.status) || (err instanceof HarnessSchemaError ? 400 : 500);
  res.status(status).json({
    ok: false,
    error: err?.message || 'Harness 请求失败',
    code: err?.code || (err instanceof HarnessSchemaError ? err.code : 'harness_error'),
    ...(err instanceof HarnessSchemaError ? { details: err.details } : {}),
  });
}

function userOf(req: express.Request): any {
  return (req as any).user;
}

profilesRouter.get('/', auth, (req, res) => {
  try {
    const projectId = String(req.query.project_id || '').trim();
    const project = Projects.findById(projectId);
    if (!project || !canReadProject(userOf(req), project)) {
      res.status(404).json({ error: '未找到项目' });
      return;
    }
    res.json(listVisibleHarnessProfiles(userOf(req).id, projectId));
  } catch (error) {
    sendError(res, error);
  }
});

runsRouter.post('/estimate', auth, (req, res) => {
  try {
    const input = parseHarnessEstimateRequest(req.body);
    const issue = Issues.findById(input.issue_id, userOf(req).id);
    if (!issue || !canCreateHarnessRun(userOf(req), issue)) {
      res.status(403).json({ error: '无权为此 Issue 创建 Harness Run', code: 'harness_create_forbidden' });
      return;
    }
    const members = resolveRoster(userOf(req).id, issue.project_id, input);
    res.json(estimateHarnessRun(userOf(req).id, input, members.map((member) => ({ id: member.profile.id, definition: member.profile.definition }))));
  } catch (error) {
    sendError(res, error);
  }
});

runsRouter.post('/', auth, (req, res) => {
  try {
    const input = parseHarnessCreateRunRequest(req.body);
    const issue = Issues.findById(input.issue_id, userOf(req).id);
    if (!issue || !canCreateHarnessRun(userOf(req), issue)) {
      res.status(403).json({ error: '无权为此 Issue 创建 Harness Run', code: 'harness_create_forbidden' });
      return;
    }
    const snapshot = createHarnessRun(userOf(req).id, issue.project_id, input);
    requestHarnessScan();
    res.status(201).json(snapshot);
  } catch (error) {
    sendError(res, error);
  }
});

runsRouter.get('/', auth, (req, res) => {
  try {
    const issueId = String(req.query.issue_id || '').trim();
    const issue = Issues.findById(issueId, userOf(req).id);
    if (!issue || !canReadIssue(userOf(req), issue)) {
      res.status(404).json({ error: '未找到 Issue' });
      return;
    }
    res.json(listHarnessRunsForIssue(issueId).filter((run) => canReadHarnessRun(userOf(req), run)));
  } catch (error) {
    sendError(res, error);
  }
});

runsRouter.get('/:runId', auth, (req, res) => {
  try {
    const run = findRunOwner(String(req.params.runId));
    if (!run || !canReadHarnessRun(userOf(req), run)) {
      res.status(404).json({ error: '未找到 Harness Run' });
      return;
    }
    res.json(getHarnessRunSnapshot(run.id));
  } catch (error) {
    sendError(res, error);
  }
});

function internalAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!isHarnessLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({ error: 'Harness scoped token 仅接受本机连接', code: 'harness_localhost_required' });
    return;
  }
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    res.status(401).json({ error: 'Harness scoped token required', code: 'harness_token_required' });
    return;
  }
  try {
    (req as any).harness = verifyHarnessNodeToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Harness scoped token invalid or expired', code: 'harness_token_invalid' });
  }
}

export function isHarnessLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

function harnessPayload(req: express.Request): HarnessInternalTokenPayload {
  return (req as any).harness;
}

internalRouter.use(internalAuth);

internalRouter.get('/runs/:runId/members', (req, res) => {
  try {
    const payload = harnessPayload(req);
    requireHarnessAction(payload, 'read_roster');
    res.json({ ok: true, members: internalRoster(payload, req.params.runId) });
  } catch (error) { sendError(res, error); }
});

internalRouter.get('/runs/:runId/events', async (req, res) => {
  try {
    const payload = harnessPayload(req);
    requireHarnessAction(payload, 'read_events');
    const afterSeq = Math.max(0, Number(req.query.after_seq) || 0);
    const waitMs = Math.min(30_000, Math.max(0, Number(req.query.wait_ms) || 0));
    res.json({ ok: true, events: await waitForInternalRunEvents(payload, req.params.runId, afterSeq, waitMs) });
  } catch (error) { sendError(res, error); }
});

internalRouter.post('/runs/:runId/nodes', (req, res) => {
  try {
    const payload = harnessPayload(req);
    if (payload.run_id !== req.params.runId) throw Object.assign(new Error('Scoped token 不能访问其他 Run'), { status: 403, code: 'harness_scope_violation' });
    requireHarnessAction(payload, 'create_task_for_member');
    const result = createTaskForMember(payload, req.body);
    requestHarnessScan();
    res.status(result.ok ? 200 : 409).json(result);
  } catch (error) { sendError(res, error); }
});

internalRouter.post('/nodes/:nodeId/progress', (req, res) => {
  try {
    const payload = harnessPayload(req);
    requireHarnessAction(payload, 'progress');
    const result = reportHarnessProgress(payload, req.params.nodeId, req.body);
    res.status(result.ok ? 200 : 409).json(result);
  } catch (error) { sendError(res, error); }
});

internalRouter.post('/nodes/:nodeId/complete', (req, res) => {
  try {
    const payload = harnessPayload(req);
    requireHarnessAction(payload, 'complete');
    const result = completeHarnessNode(payload, req.params.nodeId, req.body);
    requestHarnessScan();
    res.status(result.ok ? 200 : 409).json(result);
  } catch (error) { sendError(res, error); }
});

internalRouter.post('/nodes/:nodeId/fail', (req, res) => {
  try {
    const payload = harnessPayload(req);
    requireHarnessAction(payload, 'fail');
    const result = failHarnessNode(payload, req.params.nodeId, req.body);
    requestHarnessScan();
    res.status(result.ok ? 200 : 409).json(result);
  } catch (error) { sendError(res, error); }
});

export { profilesRouter, runsRouter, internalRouter };
