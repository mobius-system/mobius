import express from 'express';
import crypto from 'crypto';
import { auth } from '../middleware/auth';
import { Sessions } from '../repositories/sessions';
import { ScheduledWakeups, type ScheduledWakeupMode } from '../repositories/scheduled-wakeups';
import { canOperateSession } from '../services/access-control';

const router = express.Router();
const MIN_INTERVAL_SECONDS = 10 * 60;
const MAX_SCHEDULE_SECONDS = 365 * 24 * 60 * 60;
const MAX_REMINDER_LENGTH = 100_000;

/*
 * Normalize and validate the public create payload shared by CLI and future UI clients.
 */
function parseCreatePayload(body: any): {
  sessionId: string;
  mode: ScheduledWakeupMode;
  scheduleSeconds: number;
  reminder: string;
} {
  const sessionId = String(body?.session_id || '').trim();
  const mode = String(body?.mode || '').trim() as ScheduledWakeupMode;
  const secondsValue = mode === 'once' ? body?.after_seconds : body?.interval_seconds;
  const scheduleSeconds = Number(secondsValue);
  const reminder = typeof body?.reminder === 'string' ? body.reminder.trim() : '';

  if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw Object.assign(new Error('session_id 格式非法'), { status: 400 });
  }
  if (mode !== 'once' && mode !== 'interval') {
    throw Object.assign(new Error('mode 必须是 once 或 interval'), { status: 400 });
  }
  if (mode === 'once' && body?.interval_seconds !== undefined) {
    throw Object.assign(new Error('interval_seconds 不能与 once 一起使用'), { status: 400 });
  }
  if (mode === 'interval' && body?.after_seconds !== undefined) {
    throw Object.assign(new Error('after_seconds 不能与 interval 一起使用'), { status: 400 });
  }
  if (!Number.isSafeInteger(scheduleSeconds) || scheduleSeconds <= 0 || scheduleSeconds > MAX_SCHEDULE_SECONDS) {
    throw Object.assign(new Error('定时时长必须是 1 秒到 365 天之间的整数'), { status: 400 });
  }
  if (mode === 'interval' && scheduleSeconds < MIN_INTERVAL_SECONDS) {
    throw Object.assign(new Error('interval-time 最短为 10m'), { status: 400 });
  }
  if (!reminder) {
    throw Object.assign(new Error('reminder 不能为空'), { status: 400 });
  }
  if (reminder.length > MAX_REMINDER_LENGTH) {
    throw Object.assign(new Error(`reminder 不能超过 ${MAX_REMINDER_LENGTH} 个字符`), { status: 400 });
  }
  return { sessionId, mode, scheduleSeconds, reminder };
}

router.post('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  try {
    const input = parseCreatePayload(req.body);
    const session = Sessions.findById(input.sessionId);
    if (!session || !canOperateSession(user, session)) {
      res.status(404).json({ error: '未找到可操作的 Session' });
      return;
    }
    if (session.status !== 'active') {
      res.status(409).json({ error: '只能为进行中的 Session 创建定时唤醒' });
      return;
    }
    const nextRunAt = new Date(Date.now() + input.scheduleSeconds * 1000).toISOString();
    const wakeup = ScheduledWakeups.create({
      id: crypto.randomUUID(),
      user_id: user.id,
      session_id: input.sessionId,
      mode: input.mode,
      schedule_seconds: input.scheduleSeconds,
      reminder: input.reminder,
      next_run_at: nextRunAt,
    });
    res.status(201).json({ ok: true, wakeup });
  } catch (error) {
    const err = error as any;
    res.status(err.status || 500).json({ error: err.message || '创建定时唤醒失败' });
  }
});

router.get('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const sessionId = String(req.query.session_id || '').trim();
  const wakeups = ScheduledWakeups.listActiveForUser(user.id)
    .filter((item) => !sessionId || item.session_id === sessionId);
  res.json({ wakeups });
});

router.delete('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const sessionId = String(req.query.session_id || '').trim();
  if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    res.status(400).json({ error: 'session_id 必填且格式必须合法' });
    return;
  }
  const session = Sessions.findById(sessionId);
  if (!session || !canOperateSession(user, session)) {
    res.status(404).json({ error: '未找到可操作的 Session' });
    return;
  }
  const cancelled = ScheduledWakeups.cancelActiveForSession(user.id, sessionId);
  res.json({ ok: true, session_id: sessionId, cancelled });
});

export { router, parseCreatePayload, MIN_INTERVAL_SECONDS, MAX_SCHEDULE_SECONDS };
