const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-blackboard-auth-'));
process.env.DB_PATH = path.join(tempRoot, 'mobius.db');
process.env.MOBIUS_DATA_PATH = tempRoot;
process.env.CORE_DATA_PATH = tempRoot;
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json');
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace');
process.env.HOME_WORKSPACE_ROOT = path.join(tempRoot, 'home');
process.env.LOCAL_WORKSPACE_ROOT = path.join(tempRoot, 'local');
process.env.JWT_SECRET = 'blackboard-route-test-secret';
process.env.MOBIUS_HIDDEN_FOLDER_NAME = '.imac';

const express = require('express');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { blackboardRouter } = require('../backend/routes/researches');
const { Sessions } = require('../backend/repositories/sessions');
const board = require('../backend/services/research-blackboard');
const capability = require('../backend/utils/research-blackboard-capability');

function run(sql, ...args) { return db.prepare(sql).run(...args); }

const projectRoot = path.join(tempRoot, 'project');
fs.mkdirSync(projectRoot, { recursive: true });
run(`INSERT INTO users (id, display_name, password_hash, role, work_dir, group_id)
     VALUES ('owner', 'owner', 'hash', 'user', ?, 'default')`, path.join(tempRoot, 'workspace', 'owner'));
run(`INSERT INTO users (id, display_name, password_hash, role, work_dir, group_id)
     VALUES ('outsider', 'outsider', 'hash', 'user', ?, 'default')`, path.join(tempRoot, 'workspace', 'outsider'));
run(`INSERT INTO projects (id, name, created_by, bind_path, research_enabled, visibility)
     VALUES ('p1', 'p1', 'owner', ?, 1, 'private')`, projectRoot);
run(`INSERT INTO researches (id, project_id, title, description, created_by, status, visibility)
     VALUES ('r1', 'p1', 'r1', '', 'owner', 'active', 'private')`);
run(`INSERT INTO researches (id, project_id, title, description, created_by, status, visibility)
     VALUES ('r2', 'p1', 'r2', '', 'owner', 'active', 'private')`);

function addSession(id, researchId, role = 'research_assistant', agentId = null, status = 'active') {
  run(`INSERT INTO sessions_v2
       (session_id, project_id, scope_type, research_id, research_role, user_id, name, session_key, model, status, agent_session_id)
       VALUES (?, 'p1', 'research', ?, ?, 'owner', ?, ?, 'gpt-5.5', ?, ?)`,
    id, researchId, role, id, `web:owner:${id}`, status, agentId);
}

addSession('sender', 'r1', 'research_assistant', 'agent-sender');
addSession('receiver', 'r1', 'chief_researcher', 'agent-receiver');
addSession('other', 'r1', 'research_assistant', 'agent-other');
addSession('foreign', 'r2', 'research_assistant', 'agent-foreign');
addSession('archived-sender', 'r1', 'research_assistant', 'agent-archived-sender', 'archived');
addSession('archived-receiver', 'r1', 'research_assistant', 'agent-archived-receiver', 'archived');
addSession('deleted-sender', 'r1', 'research_assistant', 'agent-deleted-sender');
addSession('deleted-receiver', 'r1', 'research_assistant', 'agent-deleted-receiver');
addSession('duplicate-a', 'r1', 'research_assistant', 'agent-duplicate');
addSession('duplicate-b', 'r1', 'research_assistant', 'agent-duplicate');
addSession('collision-ref', 'r1', 'research_assistant', 'agent-exact-precedence');
addSession('collision-other', 'r1', 'research_assistant', 'collision-ref');
run("UPDATE sessions_v2 SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE session_id IN ('deleted-sender', 'deleted-receiver')");
run(`INSERT INTO sessions_v2
     (session_id, project_id, scope_type, research_id, user_id, name, session_key, model, status)
     VALUES ('issue-session', 'p1', 'issue', NULL, 'owner', 'issue', 'web:owner:issue', 'gpt-5.5', 'active')`);

// Keep appendBlackboardRecord's asynchronous scan from launching agent backends.
Sessions.listActiveByResearch = () => [];

const app = express();
app.use(express.json());
app.use('/api/research-blackboard', blackboardRouter);

function request(port, method, routePath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const encodedBody = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, method, path: routePath,
      headers: { ...headers, ...(encodedBody ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encodedBody) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (encodedBody) req.write(encodedBody);
    req.end();
  });
}

function cliToken(action, from, research, limitedReceiver = false, receiverRef = null, now) {
  return capability.createResearchBlackboardCliToken(process.env.JWT_SECRET, {
    action, sessionRef: from, researchId: research, limitedReceiver, receiverRef,
  }, now);
}

function resignToken(token, mutatePayload) {
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  mutatePayload(payload);
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(`research-blackboard-cli:v2:${encoded}`)
    .digest('base64url');
  return `mrb2.${encoded}.${signature}`;
}

async function main() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const cliHeader = capability.RESEARCH_BLACKBOARD_CLI_TOKEN_HEADER;

  assert.strictEqual((await request(port, 'GET', '/api/research-blackboard/r1')).status, 401);
  const outsiderJwt = jwt.sign({ id: 'outsider' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.strictEqual((await request(port, 'GET', '/api/research-blackboard/r1', { Authorization: `Bearer ${outsiderJwt}` })).status, 404);
  const ownerJwt = jwt.sign({ id: 'owner' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.strictEqual((await request(port, 'GET', '/api/research-blackboard/r1', { Authorization: `Bearer ${ownerJwt}` })).status, 200);

  const normalWrite = await request(port, 'POST', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('write', 'agent-sender', 'r1'),
  }, { content: 'normal progress', author: 'forged', session_id: 'foreign', metadata: { session_id: 'foreign' } });
  assert.strictEqual(normalWrite.status, 200, normalWrite.body);
  const normalRecord = JSON.parse(normalWrite.body).record;
  assert.strictEqual(normalRecord.author, 'research_assistant (sender)');
  assert.deepStrictEqual(normalRecord.metadata, { session_id: 'sender' });

  const limitedWrite = await request(port, 'POST', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('write', 'sender', 'r1', true, 'agent-receiver'),
  }, { content: 'limited progress' });
  assert.strictEqual(limitedWrite.status, 200, limitedWrite.body);
  assert.strictEqual(JSON.parse(limitedWrite.body).record.content, 'limited progress');

  const rawEntries = board.readBlackboardEntries('r1').entries.map((entry) => entry.record).filter(Boolean);
  const rawLimited = rawEntries.find((record) => board.parseLimitedReceiverContent(record.content).limited);
  assert(rawLimited);
  assert.strictEqual(rawLimited.content, '<limited_receiver>receiver</limited_receiver>\nlimited progress');
  assert.strictEqual(board.parseLimitedReceiverContent(rawLimited.content).receiverSessionId, 'receiver');

  const senderRead = await request(port, 'GET', '/api/research-blackboard/cli/r1', { [cliHeader]: cliToken('read', 'sender', 'r1') });
  const receiverRead = await request(port, 'GET', '/api/research-blackboard/cli/r1', { [cliHeader]: cliToken('read', 'receiver', 'r1') });
  const otherRead = await request(port, 'GET', '/api/research-blackboard/cli/r1', { [cliHeader]: cliToken('read', 'other', 'r1') });
  assert.strictEqual(senderRead.status, 200);
  assert.strictEqual(receiverRead.status, 200);
  assert.strictEqual(otherRead.status, 200);
  assert.match(senderRead.body, /limited progress/);
  assert.match(receiverRead.body, /limited progress/);
  assert.doesNotMatch(otherRead.body, /limited progress/);
  assert.match(otherRead.body, /normal progress/);
  assert.doesNotMatch(senderRead.body, /<limited_receiver>/);

  const webRead = await request(port, 'GET', '/api/research-blackboard/r1', { Authorization: `Bearer ${ownerJwt}` });
  assert.strictEqual(webRead.status, 200);
  assert.match(webRead.body, /limited progress/);
  assert.doesNotMatch(webRead.body, /<limited_receiver>/);

  const wrongSenderResearch = await request(port, 'GET', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('read', 'foreign', 'r1'),
  });
  assert.strictEqual(wrongSenderResearch.status, 403);
  assert.match(wrongSenderResearch.body, /不在 Research r1 中/);

  const missingResearch = await request(port, 'GET', '/api/research-blackboard/cli/missing-research', {
    [cliHeader]: cliToken('read', 'sender', 'missing-research'),
  });
  assert.strictEqual(missingResearch.status, 404);
  assert.match(missingResearch.body, /Research 不存在/);

  const missingSender = await request(port, 'GET', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('read', 'missing-sender', 'r1'),
  });
  assert.strictEqual(missingSender.status, 404);
  assert.match(missingSender.body, /未找到 Session\/Agent/);

  const wrongReceiverResearch = await request(port, 'POST', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('write', 'sender', 'r1', true, 'foreign'),
  }, { content: 'must fail' });
  assert.strictEqual(wrongReceiverResearch.status, 403);
  assert.match(wrongReceiverResearch.body, /不在同一个 Research/);

  const archivedSender = await request(port, 'POST', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('write', 'archived-sender', 'r1'),
  }, { content: 'must fail' });
  assert.strictEqual(archivedSender.status, 403);
  assert.match(archivedSender.body, /只有 active Session 可以写入/);

  const archivedReader = await request(port, 'GET', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('read', 'archived-sender', 'r1'),
  });
  assert.strictEqual(archivedReader.status, 200);

  const archivedReceiver = await request(port, 'POST', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('write', 'sender', 'r1', true, 'archived-receiver'),
  }, { content: 'must fail' });
  assert.strictEqual(archivedReceiver.status, 403);
  assert.match(archivedReceiver.body, /无法接收定向消息/);

  const deletedSender = await request(port, 'GET', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('read', 'deleted-sender', 'r1'),
  });
  assert.strictEqual(deletedSender.status, 403);
  assert.match(deletedSender.body, /已被删除/);

  const deletedReceiver = await request(port, 'POST', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('write', 'sender', 'r1', true, 'deleted-receiver'),
  }, { content: 'must fail' });
  assert.strictEqual(deletedReceiver.status, 403);
  assert.match(deletedReceiver.body, /接收者 Session deleted-receiver 已被删除/);

  const ambiguousSender = await request(port, 'GET', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('read', 'agent-duplicate', 'r1'),
  });
  assert.strictEqual(ambiguousSender.status, 400);
  assert.match(ambiguousSender.body, /对应多个 Session/);

  const ambiguousReceiver = await request(port, 'POST', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('write', 'sender', 'r1', true, 'agent-duplicate'),
  }, { content: 'must fail' });
  assert.strictEqual(ambiguousReceiver.status, 400);
  assert.match(ambiguousReceiver.body, /接收者无效.*对应多个 Session/);

  const sameCanonicalSession = await request(port, 'POST', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('write', 'sender', 'r1', true, 'agent-sender'),
  }, { content: 'must fail' });
  assert.strictEqual(sameCanonicalSession.status, 400);
  assert.match(sameCanonicalSession.body, /不能是同一个 Session/);

  const exactIdPrecedence = await request(port, 'POST', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('write', 'sender', 'r1', true, 'collision-ref'),
  }, { content: 'exact ID wins over another Session agent ID' });
  assert.strictEqual(exactIdPrecedence.status, 200, exactIdPrecedence.body);
  const exactRaw = board.readBlackboardEntries('r1').entries
    .map((entry) => entry.record)
    .find((record) => record?.content?.includes('exact ID wins'));
  assert.strictEqual(board.parseLimitedReceiverContent(exactRaw.content).receiverSessionId, 'collision-ref');

  const issueSender = await request(port, 'GET', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('read', 'issue-session', 'r1'),
  });
  assert.strictEqual(issueSender.status, 403);
  assert.match(issueSender.body, /不是 Research Session/);

  const issueReceiver = await request(port, 'POST', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('write', 'sender', 'r1', true, 'issue-session'),
  }, { content: 'must fail' });
  assert.strictEqual(issueReceiver.status, 403);
  assert.match(issueReceiver.body, /接收者 issue-session 不是 Research Session/);

  const missingReceiver = await request(port, 'POST', '/api/research-blackboard/cli/r1', {
    [cliHeader]: cliToken('write', 'sender', 'r1', true, 'missing-receiver'),
  }, { content: 'must fail' });
  assert.strictEqual(missingReceiver.status, 404);
  assert.match(missingReceiver.body, /接收者无效.*未找到 Session\/Agent/);

  const oldV1Payload = Buffer.from(JSON.stringify({ v: 1, scope: 'blackboard', research_id: 'r1', session_id: 'sender' })).toString('base64url');
  const oldV1 = `${oldV1Payload}.invalid-old-signature`;
  assert.strictEqual((await request(port, 'GET', '/api/research-blackboard/cli/r1', { [cliHeader]: oldV1 })).status, 401);

  const now = Math.floor(Date.now() / 1000);
  const expired = cliToken('read', 'sender', 'r1', false, null, now - 1000);
  assert.strictEqual(capability.verifyResearchBlackboardCliToken(expired, process.env.JWT_SECRET, { action: 'read', researchId: 'r1' }, now), null);
  assert.strictEqual(capability.verifyResearchBlackboardCliToken(cliToken('read', 'sender', 'r1', false, null, now), process.env.JWT_SECRET, { action: 'write', researchId: 'r1' }, now), null);
  assert.strictEqual(capability.verifyResearchBlackboardCliToken(cliToken('read', 'sender', 'r1', false, null, now), process.env.JWT_SECRET, { action: 'read', researchId: 'r2' }, now), null);

  const tamperedParts = cliToken('read', 'sender', 'r1', false, null, now).split('.');
  const tamperedPayload = JSON.parse(Buffer.from(tamperedParts[1], 'base64url').toString('utf8'));
  tamperedPayload.session_ref = 'other';
  tamperedParts[1] = Buffer.from(JSON.stringify(tamperedPayload), 'utf8').toString('base64url');
  assert.strictEqual(capability.verifyResearchBlackboardCliToken(tamperedParts.join('.'), process.env.JWT_SECRET, {}, now), null);

  const futureIssued = resignToken(cliToken('read', 'sender', 'r1', false, null, now), (payload) => {
    payload.iat = now + capability.CLOCK_SKEW_SECONDS + 1;
    payload.exp = payload.iat + 60;
  });
  assert.strictEqual(capability.verifyResearchBlackboardCliToken(futureIssued, process.env.JWT_SECRET, {}, now), null);

  const overlongLifetime = resignToken(cliToken('read', 'sender', 'r1', false, null, now), (payload) => {
    payload.exp = payload.iat + capability.MAX_TOKEN_LIFETIME_SECONDS + 1;
  });
  assert.strictEqual(capability.verifyResearchBlackboardCliToken(overlongLifetime, process.env.JWT_SECRET, {}, now), null);

  const wrongPathResearch = await request(port, 'GET', '/api/research-blackboard/cli/r2', {
    [cliHeader]: cliToken('read', 'sender', 'r1'),
  });
  assert.strictEqual(wrongPathResearch.status, 401);

  const limitedTargets = board.markRecordPendingTargets({
    ...rawLimited, delivered: false, delivered_at: null,
    delivery: { status: 'pending', target_session_ids: [], delivered_to_session_ids: [], attempt_count: 0, last_attempt_at: null, last_error: null },
  }, [{ session_id: 'sender' }, { session_id: 'receiver' }, { session_id: 'other' }]);
  assert.deepStrictEqual(limitedTargets.delivery.target_session_ids, ['receiver']);

  const normalTargets = board.markRecordPendingTargets({
    ...rawEntries.find((record) => record.content === 'normal progress'), delivered: false, delivered_at: null,
    delivery: { status: 'pending', target_session_ids: [], delivered_to_session_ids: [], attempt_count: 0, last_attempt_at: null, last_error: null },
  }, [{ session_id: 'sender' }, { session_id: 'receiver' }, { session_id: 'other' }]);
  assert.deepStrictEqual(normalTargets.delivery.target_session_ids, ['receiver', 'other']);

  const malformedRecord = {
    id: 'malformed-limited', research_id: 'r1', author: 'research_assistant (sender)',
    content: '<limited_receiver>receiver', created_at: new Date().toISOString(),
    metadata: { session_id: 'sender' }, delivered: false, delivered_at: null,
    delivery: { status: 'pending', target_session_ids: [], delivered_to_session_ids: [], attempt_count: 0, last_attempt_at: null, last_error: null },
  };
  const malformedTargets = board.markRecordPendingTargets(malformedRecord, [
    { session_id: 'sender' }, { session_id: 'receiver' }, { session_id: 'other' },
  ]);
  assert.deepStrictEqual(malformedTargets.delivery.target_session_ids, []);
  assert.strictEqual(malformedTargets.delivered, true);
  const boardFile = board.readBlackboardEntries('r1').file;
  fs.appendFileSync(boardFile, `${JSON.stringify(malformedRecord)}\n`);
  assert.match(board.readBlackboardForSession('r1', 'sender').content, /malformed-limited/);
  assert.doesNotMatch(board.readBlackboardForSession('r1', 'receiver').content, /malformed-limited/);

  const maxLimitedContent = '界'.repeat(50000);
  const maxLimitedAppend = board.appendBlackboardRecord({
    researchId: 'r1', author: 'research_assistant (sender)',
    content: board.prefixLimitedReceiverContent('receiver', maxLimitedContent),
    metadata: { session_id: 'sender' },
  });
  assert(maxLimitedAppend.record, maxLimitedAppend.error);
  assert.strictEqual(board.sanitizedRecord(maxLimitedAppend.record).content.length, 50000);
  assert.match(board.appendBlackboardRecord({
    researchId: 'r1', author: 'research_assistant (sender)',
    content: '<limited_receiver>receiver', metadata: { session_id: 'sender' },
  }).error, /定向接收前缀非法/);

  const notify = board.buildNotifyPrompt([rawLimited], 'receiver');
  assert.match(notify, /research_blackboard_read --from=receiver --research=r1/);
  assert.match(notify, /limited progress/);
  assert.doesNotMatch(notify, /<limited_receiver>|curl|localhost/);

  const reservedPrefix = await request(port, 'POST', '/api/research-blackboard/r1', { Authorization: `Bearer ${ownerJwt}` }, {
    author: 'HR', content: '<limited_receiver>other</limited_receiver>spoof',
  });
  assert.strictEqual(reservedPrefix.status, 400);
  assert.match(reservedPrefix.body, /内部保留前缀/);

  await new Promise((resolve) => server.close(resolve));
  console.log('research Blackboard auth tests passed');
}

main().then(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
