/**
 * session-reminders.ts — internal endpoint the agent hook CLI calls.
 *
 * The CLI (`mobius_session_reminder`) forwards the agent's PreToolUse JSON here
 * with two headers:
 *   x-mobius-session-id : the Mobius session id
 *   x-mobius-hook-token : HMAC(JWT_SECRET, "reminder:<session id>")
 *
 * Authentication is the per-session token, not a user JWT: the endpoint only
 * decides whether a reminder is shown, and the token is minted per session by
 * the launcher. A suppressed decision returns `{}` so the agent sees exactly
 * what it would see with no hook installed.
 */

import express from 'express';

import { JWT_SECRET } from '../config';
import { db } from '../../db';
import adminSettings from '../services/admin-settings';
import { aimuxRemoteNameFromMeta } from '../services/pc-client-context';
import { decideReminder } from '../services/session-reminder-decide';
import { createReminderStore } from '../services/session-reminder-store';
import { verifyReminderHookToken } from '../services/session-reminder-hook';

// 共享库上的缓存实例; 服务模块本身不依赖 db, 便于单测注入内存库
// The cache instance on the shared database; the service module stays db-free for tests
const reminderStore = createReminderStore(db);

const router = express.Router();

const REMINDER_TYPE_RE = /^[A-Za-z0-9_-]{1,64}$/;

router.post('/:reminderType/decide', express.json({ limit: '256kb' }), (req: express.Request, res: express.Response) => {
  const reminderType = String(req.params.reminderType || '');
  if (!REMINDER_TYPE_RE.test(reminderType)) {
    res.status(400).json({ error: 'invalid reminder type' });
    return;
  }

  const sessionId = String(req.header('x-mobius-session-id') || '').trim();
  const token = String(req.header('x-mobius-hook-token') || '').trim();
  if (!sessionId || !token || !verifyReminderHookToken(token, sessionId, JWT_SECRET)) {
    res.status(401).json({ error: 'invalid hook token' });
    return;
  }

  const session = db
    .prepare('SELECT session_id, pc_client_metadata FROM sessions_v2 WHERE session_id = ?')
    .get(sessionId) as { session_id?: string; pc_client_metadata?: string } | undefined;
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }

  const target = aimuxRemoteNameFromMeta(session.pc_client_metadata) || null;
  const config = adminSettings.getSessionReminderConfig(reminderType);
  const toolName = String(req.body?.tool_name || '');
  const lastShownAt = reminderStore.lastShownAt(sessionId, reminderType);

  const decision = decideReminder({
    reminderType,
    now: Date.now(),
    target,
    lastShownAt,
    toolName,
    config,
  });

  // 不提醒: 返回空对象, 两个 Agent 都视作"没有附加内容"
  // Suppressed: an empty object, which both agents treat as "no extra context"
  if (!decision.show || !decision.message) {
    res.json({});
    return;
  }

  reminderStore.recordShown({
    sessionId,
    reminderType,
    toolName,
    at: new Date().toISOString(),
  });

  res.json({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: decision.message,
    },
  });
});

export { router };
