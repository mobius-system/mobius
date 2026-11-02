const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-research-disabled-'));
process.env.DB_PATH = path.join(root, 'test.db');
process.env.MOBIUS_DATA_PATH = root;
process.env.CORE_DATA_PATH = root;
process.env.MODEL_ACCESS_PATH = path.join(root, 'model-access.json');
process.env.MOBIUS_SELF_TEST_ON_BOOT = '0';
const { db } = require('../db');
const { Sessions } = require('../backend/repositories/sessions');
const { AgentBackend } = require('../backend/agents/base');
const board = require('../backend/services/research-blackboard');
const agents = require('../backend/agents').default;
const registry = require('../backend/services/model-registry').default;
const { router } = require('../backend/routes/sessions');
const { blackboardRouter } = require('../backend/routes/researches');
const { runSessionMessage } = require('../backend/services/session-message-runner');
const { ScheduledWakeups } = require('../backend/repositories/scheduled-wakeups');
const { router: wakeupRouter } = require('../backend/routes/scheduled-wakeups');
const { scanScheduledWakeupsOnce } = require('../backend/services/scheduled-wakeup-scheduler');
const { JWT_SECRET } = require('../backend/config');
const express = require('express');
const jwt = require('jsonwebtoken');
const run = (sql, ...params) => db.prepare(sql).run(...params);
run("INSERT INTO users (id, display_name, password_hash, role, work_dir) VALUES ('owner', 'Owner', 'x', 'admin', ?)", root);
run("INSERT INTO users (id, display_name, password_hash, role, work_dir) VALUES ('other', 'Other', 'x', 'user', ?)", root);
run("INSERT INTO projects (id, name, created_by, bind_path, research_enabled, visibility) VALUES ('p1', 'p1', 'owner', ?, 1, 'private')", root);
run("INSERT INTO researches (id, project_id, title, created_by, status, visibility) VALUES ('r1', 'p1', 'r1', 'owner', 'active', 'private')");
for (const id of ['a', 'b', 'c']) {
  run("INSERT INTO sessions_v2 (session_id, project_id, scope_type, research_id, user_id, name, session_key, model) VALUES (?, 'p1', 'research', 'r1', 'owner', ?, ?, 'gpt-5.5')", id, id, `test:${id}`);
}
run("INSERT INTO sessions_v2 (session_id, project_id, user_id, name, session_key) VALUES ('issue', 'p1', 'owner', 'issue', 'test:issue')");
const delivered = [];
let disableDuringDelivery = false;
agents.get = () => ({
  pauseCurrentAndTerminateSession: async () => {},
  noPauseCurrentAndQueueQueryAtSession: async opts => {
    delivered.push(opts.sessionId);
    if (disableDuringDelivery && opts.sessionId === 'a') Sessions.setResearchAgentDisabled('b', true);
  },
});
registry.modelLaunchOptionsFor = () => ({ backend: 'test' });
const file = board.resolveBlackboardFile('r1').file;
fs.mkdirSync(path.dirname(file), { recursive: true });
const write = records => fs.writeFileSync(file, records.map(record => JSON.stringify({ research_id: 'r1', author: 'HR', created_at: new Date().toISOString(), content: 'hello', ...record })).join('\n') + '\n');

async function main() {
  assert.equal(Sessions.findById('b').research_agent_disabled, 0);
  Sessions.setResearchAgentDisabled('b', true);
  assert.equal(Sessions.listForResearch('r1').find(s => s.session_id === 'b').research_agent_disabled, 1);
  write([{ id: 'broadcast' }, { id: 'direct', content: '<limited_receiver>b</limited_receiver>\nsecret' }, {
    id: 'pending', delivery: { target_session_ids: ['b'], delivered_to_session_ids: [] },
  }]);
  await board.scanBlackboardDeliveryOnce();
  assert.deepEqual(delivered, ['a', 'c']);
  assert.equal(board.readBlackboardEntries('r1').entries.find(e => e.record.id === 'pending').record.delivered, false);
  Sessions.setResearchAgentDisabled('b', false);
  delivered.length = 0;
  await board.scanBlackboardDeliveryOnce();
  assert.deepEqual(delivered, ['b']);
  delivered.length = 0;
  disableDuringDelivery = true;
  write([{ id: 'race' }]);
  await board.scanBlackboardDeliveryOnce();
  assert.deepEqual(delivered, ['a', 'c'], 'state must be refreshed between awaited batches');

  const backend = new AgentBackend({ name: 'test', runtimeFile: path.join(root, 'runtime.json') });
  await assert.rejects(backend._withDispatchLock('b', () => assert.fail('disabled agent ran')), { code: 'research_agent_disabled' });
  await backend._withLock('b', () => {}); // stop operations remain allowed
  Sessions.setResearchAgentDisabled('b', false);
  let release;
  const barrier = backend._withLock('b', () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  const waiting = backend._withDispatchLock('b', () => assert.fail('queued work revived disabled agent'));
  Sessions.setResearchAgentDisabled('b', true);
  release();
  await barrier;
  await assert.rejects(waiting, { code: 'research_agent_disabled' });
  for (const [fileName, className] of [
    ['tmux-claude-code', 'TmuxClaudeCodeBackend'], ['tmux-codex', 'TmuxCodexBackend'], ['deepseek-harness', 'DeepSeekHarnessBackend'],
  ]) {
    const prototype = require(`../backend/agents/${fileName}`)[className].prototype;
    const instance = Object.create(prototype);
    instance.locks = new Map();
    for (const method of ['createNewSession', 'pauseCurrentAndResumeFromSession', 'noPauseCurrentAndQueueQueryAtSession']) {
      await assert.rejects(instance[method]({ sessionId: 'b', prompt: 'do not run' }), { code: 'research_agent_disabled' });
    }
  }
  await assert.rejects(runSessionMessage({ user: { id: 'owner', role: 'admin' }, sessionId: 'b', content: 'auto wakeup' }), { code: 'research_agent_disabled' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages_v2 WHERE task_id = 'b' AND role = 'user'").get().n, 0);

  ScheduledWakeups.create({ id: 'job', user_id: 'owner', session_id: 'b', mode: 'once', schedule_seconds: 1, reminder: 'hello', next_run_at: '2020-01-01T00:00:00.000Z' });
  await scanScheduledWakeupsOnce();
  assert.equal(ScheduledWakeups.listActiveForUser('owner')[0].id, 'job');
  assert.equal(ScheduledWakeups.listRuns('job').length, 0, 'disabled jobs should not be consumed');
  ScheduledWakeups.create({ id: 'enabled-job', user_id: 'owner', session_id: 'a', mode: 'once', schedule_seconds: 1, reminder: 'hello', next_run_at: '2021-01-01T00:00:00.000Z' });
  assert.equal(ScheduledWakeups.listDue(new Date().toISOString(), 1)[0].id, 'enabled-job', 'disabled jobs must not occupy the scan limit');

  const app = express(); app.use(express.json()); app.use('/api/sessions', router);
  app.use('/api/research-blackboard', blackboardRouter);
  app.use('/api/scheduled-wake-ups', wakeupRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const call = async (id, suffix, method, body, user = 'owner') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${id}${suffix}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ id: user }, JWT_SECRET)}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const direct = await fetch(`http://127.0.0.1:${server.address().port}/api/research-blackboard/cli/r1`, {
      method: 'POST', headers: {
        Authorization: `Bearer ${jwt.sign({ id: 'owner' }, JWT_SECRET)}`, 'Content-Type': 'application/json',
        'x-mobius-session-id': 'a', 'x-mobius-limited-receiver': '1', 'x-mobius-receiver': 'b',
      }, body: JSON.stringify({ content: 'do not wake disabled receiver' }),
    });
    assert.equal(direct.status, 403);
    assert.match((await direct.json()).error, /已禁用/);
    assert.equal((await call('b', '/research-agent-state', 'GET')).body.research_agent_disabled, true);
    assert.equal((await call('b', '', 'PATCH', { research_agent_disabled: false })).status, 400);
    assert.equal((await call('b', '/research-agent/enable', 'POST', {}, 'other')).status, 404);
    assert.equal((await call('b', '/messages', 'POST', { content: 'wake up' })).body.code, 'research_agent_disabled');
    assert.equal((await call('issue', '/research-agent/enable', 'POST', {})).status, 400);
    assert.equal((await call('b', '/research-agent/enable', 'POST', {})).status, 200);
    assert.equal(Sessions.findById('b').research_agent_disabled, 0);
    await backend._withDispatchLock('b', () => delivered.push('enabled'));
    assert.equal(delivered.at(-1), 'enabled');
    assert.equal((await call('b', '', 'PATCH', { research_agent_disabled: true })).status, 200);
    assert.equal((await call('b', '/stop', 'POST', {})).body.research_agent_disabled, true);
    assert.equal((await call('issue', '', 'PATCH', { research_agent_disabled: true })).status, 400);
    const scheduleUrl = `http://127.0.0.1:${server.address().port}/api/scheduled-wake-ups`;
    const scheduleHeaders = { Authorization: `Bearer ${jwt.sign({ id: 'owner' }, JWT_SECRET)}`, 'Content-Type': 'application/json' };
    const created = await fetch(scheduleUrl, { method: 'POST', headers: scheduleHeaders, body: JSON.stringify({ session_id: 'a', mode: 'once', after_seconds: 30, reminder: 'check' }) });
    assert.equal(created.status, 201);
    const listed = await fetch(`${scheduleUrl}?session_id=b`, { headers: scheduleHeaders });
    assert.equal((await listed.json()).wakeups.length, 1, 'disabled jobs remain visible for cancellation');
    const cancelled = await fetch(`${scheduleUrl}?session_id=b`, { method: 'DELETE', headers: scheduleHeaders });
    assert.equal((await cancelled.json()).cancelled, 1);
    assert.equal(ScheduledWakeups.listActiveForUser('owner').filter(job => job.session_id === 'a').length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('Disabled research agent persistence, delivery races, dispatch locks, scheduler, and API authorization: passed');
}
main().then(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); process.exit(0); }).catch(error => { console.error(error); process.exit(1); });
