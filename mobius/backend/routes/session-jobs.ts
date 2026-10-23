/**
 * session-jobs.ts — declare a Session's job done/failed through the backend.
 *
 * Why this exists: `declare_job_done` / `declare_job_failed` used to read the
 * SQLite database directly, which is impossible inside a Docker sandbox (the
 * file is not mounted). The CLIs now call this endpoint when they have
 * MOBIUS_BASE + MOBIUS_JWT, and keep the old database path as a fallback for
 * manual host runs.
 *
 * Permissions are the same as terminating a session: owner, project owner or
 * admin (`findSessionOperable`).
 */

import express from 'express';

import { auth } from '../middleware/auth';
import { findSessionOperable } from './sessions';
import { Projects } from '../repositories/projects';
import { db } from '../../db';
import { safeWriteFailedFlag, safeRemoveRunningFlag } from '../utils/session-flags';

const router = express.Router();

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_REASON_LENGTH = 2000;

/**
 * POST /api/session-jobs/declare
 * Body: { session_id, status: "done" | "failed", reason? }
 */
router.post('/declare', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const sessionId = String(req.body?.session_id || req.body?.sessionId || '').trim();
  const status = String(req.body?.status || '').trim();
  const reason = String(req.body?.reason || '').slice(0, MAX_REASON_LENGTH);

  if (!SESSION_ID_RE.test(sessionId)) {
    res.status(400).json({ error: 'session_id is invalid' });
    return;
  }
  if (status !== 'done' && status !== 'failed') {
    res.status(400).json({ error: 'status must be "done" or "failed"' });
    return;
  }

  // 与终止会话同一权限口径: owner / 项目 owner / 管理员
  // Same permission as terminating a session: owner, project owner or admin
  let session = findSessionOperable(sessionId, user);
  if (!session) {
    // 兼容按 Agent 会话 id 调用 (CLI 的旧行为)
    // Accept an agent session id too, as the CLI always has
    const matches = db
      .prepare('SELECT session_id FROM sessions_v2 WHERE agent_session_id = ? LIMIT 2')
      .all(sessionId) as Array<{ session_id?: string }>;
    if (matches.length === 1 && matches[0].session_id) {
      session = findSessionOperable(String(matches[0].session_id), user);
    }
  }
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }

  const project = session.project_id ? (Projects.findById(session.project_id) as any) : null;
  const bindPath = String(project?.bind_path || '').trim();
  if (!bindPath) {
    res.status(409).json({ error: 'session has no project bind_path' });
    return;
  }

  if (status === 'failed') {
    safeWriteFailedFlag(bindPath, sessionId, { reason }, 'session-jobs');
  }
  // 两种结局都要清掉 running.flag；不存在时是幂等成功
  // Both outcomes clear running.flag; a missing flag is an idempotent success
  safeRemoveRunningFlag(bindPath, sessionId, 'session-jobs');

  res.json({
    ok: true,
    session_id: sessionId,
    status,
    bind_path: bindPath,
  });
});

export { router };
