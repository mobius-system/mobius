const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-scheduled-wakeups-'));
process.env.DB_PATH = path.join(tempRoot, 'mobius.db');
process.env.MOBIUS_DATA_PATH = path.join(tempRoot, 'data');
process.env.CORE_DATA_PATH = path.join(tempRoot, 'core');
process.env.MOBIUS_SELF_TEST_ON_BOOT = '0';

const { db } = require('../db');
const { ScheduledWakeups } = require('../backend/repositories/scheduled-wakeups');
const { router, parseCreatePayload } = require('../backend/routes/scheduled-wakeups');
const { JWT_SECRET } = require('../backend/config');

db.prepare(`
  INSERT INTO users (id, display_name, password_hash, role, work_dir)
  VALUES ('u1', 'User 1', 'x', 'user', ?)
`).run(tempRoot);
db.prepare(`
  INSERT INTO sessions_v2 (session_id, user_id, name, session_key)
  VALUES ('session-1', 'u1', 'Scheduled Session', 'test:session-1')
`).run();
db.prepare(`
  INSERT INTO users (id, display_name, password_hash, role, work_dir)
  VALUES ('u2', 'User 2', 'x', 'user', ?)
`).run(tempRoot);
db.prepare(`
  INSERT INTO sessions_v2 (session_id, user_id, name, session_key)
  VALUES ('session-2', 'u2', 'Other Session', 'test:session-2')
`).run();

const onceInput = parseCreatePayload({
  session_id: 'session-1', mode: 'once', after_seconds: 30, reminder: ' check build ',
});
assert.deepStrictEqual(onceInput, {
  sessionId: 'session-1', mode: 'once', scheduleSeconds: 30, reminder: 'check build',
});
assert.throws(
  () => parseCreatePayload({ session_id: 'session-1', mode: 'interval', interval_seconds: 599, reminder: 'x' }),
  /10m/,
);
assert.throws(
  () => parseCreatePayload({
    session_id: 'session-1', mode: 'once', after_seconds: 30, interval_seconds: 600, reminder: 'x',
  }),
  /interval_seconds/,
);

const now = new Date('2026-10-09T12:00:00.000Z');
const once = ScheduledWakeups.create({
  id: 'once-1', user_id: 'u1', session_id: 'session-1', mode: 'once',
  schedule_seconds: 30, reminder: 'check build', next_run_at: '2026-10-09T11:59:30.000Z',
});
assert.strictEqual(once.status, 'active');
const claimedOnce = ScheduledWakeups.claimDue('once-1', now.toISOString());
assert.strictEqual(claimedOnce.id, 'once-1');
assert.strictEqual(ScheduledWakeups.claimDue('once-1', now.toISOString()), null);
const onceStored = db.prepare('SELECT status, next_run_at FROM scheduled_wakeups WHERE id = ?').get('once-1');
assert.deepStrictEqual(onceStored, { status: 'completed', next_run_at: null });
ScheduledWakeups.finishRun('once-1', claimedOnce.next_run_at, { ok: true, turnNumber: 7 });
assert.deepStrictEqual(
  db.prepare('SELECT status, turn_number FROM scheduled_wakeup_runs WHERE wakeup_id = ?').get('once-1'),
  { status: 'ok', turn_number: 7 },
);

ScheduledWakeups.create({
  id: 'interval-1', user_id: 'u1', session_id: 'session-1', mode: 'interval',
  schedule_seconds: 600, reminder: 'check service', next_run_at: '2026-10-09T11:25:00.000Z',
});
const claimedInterval = ScheduledWakeups.claimDue('interval-1', now.toISOString());
assert.strictEqual(claimedInterval.id, 'interval-1');
const intervalStored = db.prepare('SELECT status, next_run_at FROM scheduled_wakeups WHERE id = ?').get('interval-1');
assert.deepStrictEqual(intervalStored, { status: 'active', next_run_at: '2026-10-09T12:05:00.000Z' });
assert.strictEqual(ScheduledWakeups.claimDue('interval-1', now.toISOString()), null);
ScheduledWakeups.finishRun('interval-1', claimedInterval.next_run_at, { ok: false, error: 'temporary failure' });
assert.strictEqual(ScheduledWakeups.listRuns('interval-1')[0].status, 'error');

ScheduledWakeups.create({
  id: 'cancel-1', user_id: 'u1', session_id: 'session-1', mode: 'once',
  schedule_seconds: 60, reminder: 'cancel me', next_run_at: '2026-10-09T12:01:00.000Z',
});
assert.strictEqual(ScheduledWakeups.cancelActiveForSession('someone-else', 'session-1'), 0);
assert.strictEqual(ScheduledWakeups.cancelActiveForSession('u1', 'session-1'), 2);
assert.strictEqual(ScheduledWakeups.listActiveForUser('u1').length, 0);

/*
 * Exercise the real auth middleware and route-level ownership checks over HTTP.
 */
async function testApiIsolation() {
  const app = express();
  app.use(express.json());
  app.use('/api/scheduled-wake-ups', router);
  const server = await new Promise((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/scheduled-wake-ups`;
  const token1 = jwt.sign({ id: 'u1' }, JWT_SECRET, { expiresIn: '5m' });
  const token2 = jwt.sign({ id: 'u2' }, JWT_SECRET, { expiresIn: '5m' });
  const call = (url, token, init = {}) => fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  try {
    const created = await call(base, token1, {
      method: 'POST',
      body: JSON.stringify({ session_id: 'session-1', mode: 'once', after_seconds: 30, reminder: 'api check' }),
    });
    assert.strictEqual(created.status, 201);
    assert.strictEqual((await created.json()).wakeup.user_id, 'u1');

    const forbiddenCreate = await call(base, token2, {
      method: 'POST',
      body: JSON.stringify({ session_id: 'session-1', mode: 'once', after_seconds: 30, reminder: 'not mine' }),
    });
    assert.strictEqual(forbiddenCreate.status, 404);

    const list = await call(base, token1);
    const listed = await list.json();
    assert.strictEqual(list.status, 200);
    assert.strictEqual(listed.wakeups.length, 1);
    assert.strictEqual(listed.wakeups[0].reminder, 'api check');

    const forbiddenCancel = await call(`${base}?session_id=session-1`, token2, { method: 'DELETE' });
    assert.strictEqual(forbiddenCancel.status, 404);
    const cancelled = await call(`${base}?session_id=session-1`, token1, { method: 'DELETE' });
    assert.deepStrictEqual(await cancelled.json(), { ok: true, session_id: 'session-1', cancelled: 1 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

testApiIsolation().then(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log('scheduled wake-up tests passed');
}).catch((error) => {
  try { db.close(); } catch {}
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
