const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const mobiusRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(mobiusRoot, 'scripts');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-cli-test-'));
const appDir = path.join(tempRoot, 'app');
const binDir = path.join(tempRoot, 'bin');
const fakeMobius = path.join(appDir, 'mobius');
fs.mkdirSync(fakeMobius, { recursive: true });
fs.symlinkSync(path.join(mobiusRoot, 'node_modules'), path.join(fakeMobius, 'node_modules'), 'dir');
fs.symlinkSync(path.join(mobiusRoot, 'backend'), path.join(fakeMobius, 'backend'), 'dir');

function run(command, args = [], options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    cwd: options.cwd || tempRoot,
  });
}

function writeEnv(contents) {
  fs.writeFileSync(path.join(appDir, '.env'), contents, { mode: 0o600 });
}

function sign(userId, extraEnv = {}) {
  return run(path.join(binDir, 'generate_localhost_jwt'), [userId], {
    env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', ...extraEnv },
  });
}

function verifyToken(result, secret, userId) {
  assert.strictEqual(result.status, 0, result.stderr);
  const payload = jwt.verify(result.stdout.trim(), secret);
  assert.strictEqual(payload.id, userId);
  assert.strictEqual(payload.exp - payload.iat, 3600);
}

async function main() {
  const install = run('bash', [path.join(sourceRoot, 'install-mobius-cli.bash')], { env: { PREFIX: binDir } });
  // The installer binds commands to its actual APP_DIR. For the isolated
  // fixture, replace only that non-secret path marker after validating install.
  assert.strictEqual(install.status, 0, install.stderr);
  assert.strictEqual(fs.readFileSync(path.join(binDir, '.mobius-cli-app-dir'), 'utf8').trim(), path.resolve(mobiusRoot, '..'));
  fs.writeFileSync(path.join(binDir, '.mobius-cli-app-dir'), `${appDir}\n`);
  for (const name of ['generate_localhost_jwt', 'multiagent_send', 'declare_job_done', 'declare_job_failed', 'research_blackboard_read', 'research_blackboard_write', '.research_blackboard_cli']) {
    assert.strictEqual(fs.statSync(path.join(binDir, name)).mode & 0o777, 0o755);
  }

  for (const name of ['research_blackboard_read', 'research_blackboard_write']) {
    const helpResult = run(path.join(binDir, name), ['--help']);
    assert.strictEqual(helpResult.status, 0, helpResult.stderr);
    assert.match(helpResult.stdout, /--from=<self_id>/);
    assert.match(helpResult.stdout, /--research=<research_id>/);
  }

  const doneHelp = run(path.join(binDir, 'declare_job_done'), ['--help']);
  assert.strictEqual(doneHelp.status, 0, doneHelp.stderr);
  assert.match(doneHelp.stdout, /session_or_agent_id/);
  assert.strictEqual(run(path.join(binDir, 'declare_job_done'), []).status, 2);
  assert.strictEqual(run(path.join(binDir, 'declare_job_done'), ['../escape']).status, 2);
  assert.strictEqual(run(path.join(binDir, 'declare_job_done'), ['a/b']).status, 2);

  const failedHelp = run(path.join(binDir, 'declare_job_failed'), ['--help']);
  assert.strictEqual(failedHelp.status, 0, failedHelp.stderr);
  assert.match(failedHelp.stdout, /failure_reason/);
  assert.strictEqual(run(path.join(binDir, 'declare_job_failed'), ['session-123']).status, 2);

  const cliDbPath = path.join(appDir, 'cli.db');
  const projectRoot = path.join(tempRoot, 'project-root');
  fs.mkdirSync(projectRoot, { recursive: true });
  const cliDb = new Database(cliDbPath);
  cliDb.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, bind_path TEXT);
    CREATE TABLE sessions_v2 (
      session_id TEXT PRIMARY KEY,
      project_id TEXT,
      agent_session_id TEXT
    );
  `);
  cliDb.prepare('INSERT INTO projects (id, bind_path) VALUES (?, ?)').run('p1', projectRoot);
  cliDb.prepare('INSERT INTO sessions_v2 (session_id, project_id, agent_session_id) VALUES (?, ?, ?)')
    .run('session-123', 'p1', 'agent-abc');
  cliDb.prepare('INSERT INTO sessions_v2 (session_id, project_id, agent_session_id) VALUES (?, ?, ?)')
    .run('session-default', 'p1', 'agent-default');
  cliDb.prepare('INSERT INTO sessions_v2 (session_id, project_id, agent_session_id) VALUES (?, ?, ?)')
    .run('session-dup-a', 'p1', 'agent-duplicate');
  cliDb.prepare('INSERT INTO sessions_v2 (session_id, project_id, agent_session_id) VALUES (?, ?, ?)')
    .run('session-dup-b', 'p1', 'agent-duplicate');
  cliDb.prepare('INSERT INTO sessions_v2 (session_id, project_id, agent_session_id) VALUES (?, ?, ?)')
    .run('session-escape', 'p1', 'agent-escape');
  cliDb.close();

  const customFlagDir = path.join(projectRoot, '.imac', 'flags', 'session-123');
  fs.mkdirSync(customFlagDir, { recursive: true });
  fs.writeFileSync(path.join(customFlagDir, 'running.flag'), 'session=session-123\n');
  fs.writeFileSync(path.join(customFlagDir, 'failed.flag'), 'reason=preserve-me\n');
  writeEnv(`export MOBIUS_HIDDEN_FOLDER_NAME=".imac"\r\nDB_PATH=${cliDbPath} # test database\r\n`);

  const doneByAgent = run(path.join(binDir, 'declare_job_done'), ['agent-abc'], {
    env: { APP_DIR: '', MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', DB_PATH: '', MOBIUS_DATA_PATH: '', MOBIUS_HIDDEN_FOLDER_NAME: '' },
  });
  assert.strictEqual(doneByAgent.status, 0, doneByAgent.stderr);
  assert.match(doneByAgent.stdout, /Session session-123/);
  assert.strictEqual(fs.existsSync(path.join(customFlagDir, 'running.flag')), false);
  assert.strictEqual(fs.readFileSync(path.join(customFlagDir, 'failed.flag'), 'utf8'), 'reason=preserve-me\n');

  const doneAgain = run(path.join(binDir, 'declare_job_done'), ['session-123'], {
    env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', DB_PATH: '', MOBIUS_DATA_PATH: '', MOBIUS_HIDDEN_FOLDER_NAME: '' },
  });
  assert.strictEqual(doneAgain.status, 0, doneAgain.stderr);
  assert.match(doneAgain.stdout, /already done/);

  const defaultFlagDir = path.join(projectRoot, '.mobius', 'flags', 'session-default');
  fs.mkdirSync(defaultFlagDir, { recursive: true });
  fs.writeFileSync(path.join(defaultFlagDir, 'running.flag'), 'session=session-default\n');
  writeEnv(`DB_PATH='${cliDbPath}'\n`);
  const doneDefault = run(path.join(binDir, 'declare_job_done'), ['session-default'], {
    env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', DB_PATH: '', MOBIUS_DATA_PATH: '', MOBIUS_HIDDEN_FOLDER_NAME: '' },
  });
  assert.strictEqual(doneDefault.status, 0, doneDefault.stderr);
  assert.strictEqual(fs.existsSync(path.join(defaultFlagDir, 'running.flag')), false);

  fs.writeFileSync(path.join(defaultFlagDir, 'running.flag'), 'session=session-default\n');
  const failedDefault = run(path.join(binDir, 'declare_job_failed'), ['session-default', 'build', 'failed\nwith details'], {
    env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', DB_PATH: '', MOBIUS_DATA_PATH: '', MOBIUS_HIDDEN_FOLDER_NAME: '' },
  });
  assert.strictEqual(failedDefault.status, 0, failedDefault.stderr);
  assert.match(failedDefault.stdout, /Job declared failed/);
  assert.strictEqual(fs.existsSync(path.join(defaultFlagDir, 'running.flag')), false);
  assert.match(fs.readFileSync(path.join(defaultFlagDir, 'failed.flag'), 'utf8'), /reason=build failed\\nwith details/);

  const unknownDone = run(path.join(binDir, 'declare_job_done'), ['unknown-session'], {
    env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', DB_PATH: '', MOBIUS_DATA_PATH: '', MOBIUS_HIDDEN_FOLDER_NAME: '' },
  });
  assert.strictEqual(unknownDone.status, 4);
  assert.match(unknownDone.stderr, /no Mobius Session found/);

  const legacyDbPath = path.join(appDir, 'legacy-cli.db');
  const legacyDb = new Database(legacyDbPath);
  legacyDb.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, bind_path TEXT);
    CREATE TABLE sessions_v2 (
      session_id TEXT PRIMARY KEY,
      project_id TEXT,
      claude_session_id TEXT
    );
  `);
  legacyDb.prepare('INSERT INTO projects (id, bind_path) VALUES (?, ?)').run('p1', projectRoot);
  legacyDb.prepare('INSERT INTO sessions_v2 (session_id, project_id, claude_session_id) VALUES (?, ?, ?)')
    .run('session-legacy', 'p1', 'agent-legacy');
  legacyDb.close();
  const legacyFlagDir = path.join(projectRoot, '.imac', 'flags', 'session-legacy');
  fs.mkdirSync(legacyFlagDir, { recursive: true });
  fs.writeFileSync(path.join(legacyFlagDir, 'running.flag'), 'session=session-legacy\n');
  writeEnv(`MOBIUS_HIDDEN_FOLDER_NAME=.imac\nDB_PATH=${legacyDbPath}\n`);
  const legacyAgent = run(path.join(binDir, 'declare_job_done'), ['agent-legacy'], {
    env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', DB_PATH: '', MOBIUS_DATA_PATH: '', MOBIUS_HIDDEN_FOLDER_NAME: '' },
  });
  assert.strictEqual(legacyAgent.status, 0, legacyAgent.stderr);
  assert.strictEqual(fs.existsSync(path.join(legacyFlagDir, 'running.flag')), false);

  writeEnv(`MOBIUS_HIDDEN_FOLDER_NAME=.imac\nDB_PATH=${cliDbPath}\n`);
  const duplicateAgent = run(path.join(binDir, 'declare_job_done'), ['agent-duplicate'], {
    env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', DB_PATH: '', MOBIUS_DATA_PATH: '', MOBIUS_HIDDEN_FOLDER_NAME: '' },
  });
  assert.strictEqual(duplicateAgent.status, 4);
  assert.match(duplicateAgent.stderr, /multiple Sessions/);

  const outsideFlagDir = path.join(tempRoot, 'outside-flag-dir');
  fs.mkdirSync(outsideFlagDir, { recursive: true });
  fs.writeFileSync(path.join(outsideFlagDir, 'running.flag'), 'must-not-delete\n');
  const escapeLink = path.join(projectRoot, '.imac', 'flags', 'session-escape');
  fs.mkdirSync(path.dirname(escapeLink), { recursive: true });
  fs.symlinkSync(outsideFlagDir, escapeLink, 'dir');
  const symlinkEscape = run(path.join(binDir, 'declare_job_done'), ['session-escape'], {
    env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', DB_PATH: '', MOBIUS_DATA_PATH: '', MOBIUS_HIDDEN_FOLDER_NAME: '' },
  });
  assert.strictEqual(symlinkEscape.status, 5);
  assert.match(symlinkEscape.stderr, /escapes the project bind_path/);
  assert.strictEqual(fs.readFileSync(path.join(outsideFlagDir, 'running.flag'), 'utf8'), 'must-not-delete\n');

  writeEnv(`MOBIUS_HIDDEN_FOLDER_NAME=../unsafe\nDB_PATH=${cliDbPath}\n`);
  const unsafeHiddenDir = run(path.join(binDir, 'declare_job_done'), ['session-123'], {
    env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', DB_PATH: '', MOBIUS_DATA_PATH: '', MOBIUS_HIDDEN_FOLDER_NAME: '' },
  });
  assert.strictEqual(unsafeHiddenDir.status, 3);
  assert.match(unsafeHiddenDir.stderr, /safe directory name/);

  const help = run(path.join(binDir, 'generate_localhost_jwt'), ['--help']);
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /APP_DIR/);

  writeEnv('JWT_SECRET=plain-secret\nVITE_PORT=41234\nMOBIUS_PORT=40000\n');
  verifyToken(sign('user-plain'), 'plain-secret', 'user-plain');

  writeEnv('export JWT_SECRET="quoted secret # preserved"\r\nVITE_PORT=41234\r\n');
  verifyToken(sign('user-double'), 'quoted secret # preserved', 'user-double');

  writeEnv("JWT_SECRET='single secret with \\\"quotes\\\"'\nVITE_PORT=41234\n");
  verifyToken(sign('user-single'), 'single secret with \\"quotes\\"', 'user-single');

  writeEnv('JWT_SECRET=unquoted-secret # comment\nVITE_PORT=41234\n');
  verifyToken(sign('user-comment'), 'unquoted-secret', 'user-comment');

  writeEnv('JWT_SECRET=first-secret\nJWT_SECRET=second-secret\nVITE_PORT=41234\n');
  verifyToken(sign('user-last'), 'second-secret', 'user-last');

  const configuredInstall = run(path.join(binDir, 'generate_localhost_jwt'), ['user-installed'], {
    env: { APP_DIR: '', MOBIUS_APP_DIR: '', MOBIUS_ROOT: '' },
  });
  verifyToken(configuredInstall, 'second-secret', 'user-installed');

  const fakeNode = path.join(tempRoot, 'fake-node');
  const capturedArgv = path.join(tempRoot, 'node-argv.txt');
  fs.writeFileSync(fakeNode, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CAPTURE_ARGV"\nprintf "fake-token\\n"\n', { mode: 0o755 });
  writeEnv('JWT_SECRET=must-never-appear-in-process-arguments\nVITE_PORT=41234\n');
  const noArgvLeak = sign('user-argv', { MOBIUS_NODE: fakeNode, CAPTURE_ARGV: capturedArgv });
  assert.strictEqual(noArgvLeak.status, 0, noArgvLeak.stderr);
  assert.doesNotMatch(fs.readFileSync(capturedArgv, 'utf8'), /must-never-appear-in-process-arguments/);

  writeEnv('VITE_PORT=41234\n');
  const missingSecret = sign('user-missing');
  assert.strictEqual(missingSecret.status, 3);
  assert.match(missingSecret.stderr, /JWT_SECRET is missing or empty/);

  writeEnv('JWT_SECRET=\nVITE_PORT=41234\n');
  const emptySecret = sign('user-empty');
  assert.strictEqual(emptySecret.status, 3);
  assert.match(emptySecret.stderr, /JWT_SECRET is missing or empty/);

  const absentApp = sign('user-absent', { MOBIUS_APP_DIR: path.join(tempRoot, 'does-not-exist') });
  assert.strictEqual(absentApp.status, 3);
  assert.match(absentApp.stderr, /APP_DIR does not exist/);

  writeEnv('JWT_SECRET=mock-secret\nVITE_PORT=0\nMOBIUS_PORT=0\n');
  let captured;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      captured = {
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, turn_number: 7 }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  writeEnv(`JWT_SECRET=mock-secret\nVITE_PORT=${port}\nMOBIUS_PORT=1\n`);

  const nested = path.join(tempRoot, 'workspace', 'nested');
  fs.mkdirSync(path.join(tempRoot, 'workspace', '.imac'), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'workspace', '.imac', 'multiagent.env'), 'MOBIUS_USER_ID=user-from-file\r\n');
  const send = spawn(path.join(binDir, 'multiagent_send'), ['self-session', 'target-session', 'hello', 'world'], {
    cwd: nested,
    env: {
      ...process.env,
      APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', MOBIUS_BASE: '', MOBIUS_USER_ID: '',
      VITE_PORT: '', MOBIUS_PORT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  send.stdout.on('data', (chunk) => { stdout += chunk; });
  send.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve) => send.on('close', resolve));
  await new Promise((resolve) => server.close(resolve));
  assert.strictEqual(status, 0, stderr);
  assert.match(stdout, /turn 7/);
  assert.strictEqual(captured.url, '/api/multiagent_communication');
  assert.deepStrictEqual(captured.body, {
    self_id: 'self-session',
    target_id: 'target-session',
    content: 'hello world',
  });
  assert.strictEqual(jwt.verify(captured.authorization.replace(/^Bearer /, ''), 'mock-secret').id, 'user-from-file');

  let overrideCaptured = false;
  const overrideServer = http.createServer((req, res) => {
    overrideCaptured = true;
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, turn_number: 8 }));
  });
  await new Promise((resolve) => overrideServer.listen(0, '127.0.0.1', resolve));
  const overridePort = overrideServer.address().port;
  const overrideSend = spawn(path.join(binDir, 'multiagent_send'), ['self', 'target', 'override'], {
    cwd: nested,
    env: {
      ...process.env,
      APP_DIR: '', MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', MOBIUS_BASE: '', MOBIUS_USER_ID: 'user',
      VITE_PORT: String(overridePort), MOBIUS_PORT: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let overrideError = '';
  overrideSend.stderr.on('data', (chunk) => { overrideError += chunk; });
  const overrideStatus = await new Promise((resolve) => overrideSend.on('close', resolve));
  await new Promise((resolve) => overrideServer.close(resolve));
  assert.strictEqual(overrideStatus, 0, overrideError);
  assert.strictEqual(overrideCaptured, true);

  writeEnv('JWT_SECRET=mock-secret\nVITE_PORT=invalid\nMOBIUS_PORT=32100\n');
  const invalidPort = run(path.join(binDir, 'multiagent_send'), ['self', 'target', 'message'], {
    env: {
      APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', MOBIUS_BASE: '', MOBIUS_USER_ID: 'user',
      VITE_PORT: '', MOBIUS_PORT: '',
    },
  });
  assert.strictEqual(invalidPort.status, 3);
  assert.match(invalidPort.stderr, /valid VITE_PORT or MOBIUS_PORT/);

  const codec = require(path.join(mobiusRoot, 'backend', 'utils', 'research-blackboard-capability'));
  const blackboardRequests = [];
  const blackboardServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const action = req.method === 'GET' ? 'read' : 'write';
      const token = req.headers[codec.RESEARCH_BLACKBOARD_CLI_TOKEN_HEADER];
      const claims = codec.verifyResearchBlackboardCliToken(token, 'blackboard-secret', { action, researchId: 'r1' });
      blackboardRequests.push({ method: req.method, url: req.url, claims, body: Buffer.concat(chunks).toString('utf8') });
      const forcedStatus = claims?.sessionRef === 'force-401' ? 401
        : claims?.sessionRef === 'force-403' ? 403
          : claims?.sessionRef === 'force-404' ? 404
            : 0;
      if (forcedStatus) {
        res.statusCode = forcedStatus;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `forced HTTP ${forcedStatus}` }));
        return;
      }
      if (!claims) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid capability' }));
        return;
      }
      if (action === 'read') {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.end('{"id":"record-1","content":"hello"}\n');
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, record: { id: 'record-2' } }));
      }
    });
  });
  await new Promise((resolve) => blackboardServer.listen(0, '127.0.0.1', resolve));
  const blackboardPort = blackboardServer.address().port;
  writeEnv(`JWT_SECRET=blackboard-secret\nVITE_PORT=${blackboardPort}\nMOBIUS_PORT=45616\n`);

  async function runBlackboard(name, args, stdin = null) {
    const child = spawn(path.join(binDir, name), args, {
      cwd: nested,
      env: { ...process.env, APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', VITE_PORT: '', MOBIUS_PORT: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    if (stdin == null) child.stdin.end();
    else child.stdin.end(stdin);
    const childStatus = await new Promise((resolve) => child.on('close', resolve));
    return { status: childStatus, stdout: out, stderr: err };
  }

  const boardRead = await runBlackboard('research_blackboard_read', ['--from=sender-agent', '--research=r1']);
  assert.strictEqual(boardRead.status, 0, boardRead.stderr);
  assert.strictEqual(boardRead.stdout, '{"id":"record-1","content":"hello"}\n');
  assert.strictEqual(blackboardRequests.at(-1).url, '/api/research-blackboard/cli/r1');
  assert.strictEqual(blackboardRequests.at(-1).claims.sessionRef, 'sender-agent');
  assert.strictEqual(blackboardRequests.at(-1).claims.action, 'read');

  const boardWrite = await runBlackboard('research_blackboard_write', ['--from=sender-agent', '--research=r1', 'hello', 'team']);
  assert.strictEqual(boardWrite.status, 0, boardWrite.stderr);
  assert.match(boardWrite.stdout, /record-2/);
  assert.deepStrictEqual(JSON.parse(blackboardRequests.at(-1).body), { content: 'hello team' });
  assert.strictEqual(blackboardRequests.at(-1).claims.limitedReceiver, false);

  const limitedWrite = await runBlackboard('research_blackboard_write', [
    '--from=sender-agent', '--research=r1', '--limit-receiver', '--receiver=receiver-agent', 'private progress',
  ]);
  assert.strictEqual(limitedWrite.status, 0, limitedWrite.stderr);
  assert.strictEqual(limitedWrite.stderr.trim(), '【Mobius不鼓励使用 --limit-receiver，建议仅在用户强烈要求的情况下才去用它】');
  assert.strictEqual(blackboardRequests.at(-1).claims.limitedReceiver, true);
  assert.strictEqual(blackboardRequests.at(-1).claims.receiverRef, 'receiver-agent');

  const limitedStdin = await runBlackboard('research_blackboard_write', [
    '--from=sender-agent', '--research=r1', '--limit-receiver', '--receiver=receiver-agent', '--stdin',
  ], 'line one\nline two\n');
  assert.strictEqual(limitedStdin.status, 0, limitedStdin.stderr);
  assert.deepStrictEqual(JSON.parse(blackboardRequests.at(-1).body), { content: 'line one\nline two\n' });

  const missingReceiver = run(path.join(binDir, 'research_blackboard_write'), [
    '--from=sender-agent', '--research=r1', '--limit-receiver', 'content',
  ], { env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '' } });
  assert.strictEqual(missingReceiver.status, 2);
  assert.match(missingReceiver.stderr, /Mobius不鼓励使用 --limit-receiver/);
  assert.match(missingReceiver.stderr, /requires exactly one/);

  const emptyReceiver = run(path.join(binDir, 'research_blackboard_write'), [
    '--from=sender-agent', '--research=r1', '--limit-receiver', '--receiver=', 'content',
  ], { env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '' } });
  assert.strictEqual(emptyReceiver.status, 2);
  assert.strictEqual((emptyReceiver.stderr.match(/Mobius不鼓励/g) || []).length, 1);
  assert.match(emptyReceiver.stderr, /accepts exactly one Session\/Agent ID/);

  const multipleReceivers = run(path.join(binDir, 'research_blackboard_write'), [
    '--from=sender-agent', '--research=r1', '--limit-receiver', '--receiver=a1', '--receiver=a2', 'content',
  ], { env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '' } });
  assert.strictEqual(multipleReceivers.status, 2);
  assert.match(multipleReceivers.stderr, /Mobius不鼓励使用 --limit-receiver/);
  assert.match(multipleReceivers.stderr, /exactly one receiver/);

  const receiverWithoutLimit = run(path.join(binDir, 'research_blackboard_write'), [
    '--from=sender-agent', '--research=r1', '--receiver=a1', 'content',
  ], { env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '' } });
  assert.strictEqual(receiverWithoutLimit.status, 2);
  assert.match(receiverWithoutLimit.stderr, /requires --limit-receiver/);
  assert.doesNotMatch(receiverWithoutLimit.stderr, /Mobius不鼓励/);

  for (const forcedStatus of [401, 403, 404]) {
    const rejected = await runBlackboard('research_blackboard_write', [
      `--from=force-${forcedStatus}`, '--research=r1', '--limit-receiver', '--receiver=receiver-agent', 'content',
    ]);
    assert.notStrictEqual(rejected.status, 0);
    assert.strictEqual((rejected.stderr.match(/Mobius不鼓励/g) || []).length, 1);
    assert.match(rejected.stderr, new RegExp(`forced HTTP ${forcedStatus}`));
  }

  await new Promise((resolve) => blackboardServer.close(resolve));

  const networkFailure = await runBlackboard('research_blackboard_write', [
    '--from=sender-agent', '--research=r1', '--limit-receiver', '--receiver=receiver-agent', 'content',
  ]);
  assert.strictEqual(networkFailure.status, 5);
  assert.strictEqual((networkFailure.stderr.match(/Mobius不鼓励/g) || []).length, 1);
  assert.match(networkFailure.stderr, /Network error/);

  writeEnv('JWT_SECRET=blackboard-secret\nMOBIUS_PORT=\n');
  const noFixedPort = run(path.join(binDir, 'research_blackboard_read'), ['--from=sender-agent', '--research=r1'], {
    env: { APP_DIR: appDir, MOBIUS_APP_DIR: '', MOBIUS_ROOT: '', VITE_PORT: '45616', MOBIUS_PORT: '45616' },
  });
  assert.strictEqual(noFixedPort.status, 3);
  assert.match(noFixedPort.stderr, /no fixed default is used/);

  console.log('mobius CLI tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
