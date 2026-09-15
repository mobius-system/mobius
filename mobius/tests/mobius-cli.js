const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const jwt = require('jsonwebtoken');

const mobiusRoot = path.resolve(__dirname, '..');
const sourceRoot = path.join(mobiusRoot, 'scripts');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-cli-test-'));
const appDir = path.join(tempRoot, 'app');
const binDir = path.join(tempRoot, 'bin');
const fakeMobius = path.join(appDir, 'mobius');
fs.mkdirSync(fakeMobius, { recursive: true });
fs.symlinkSync(path.join(mobiusRoot, 'node_modules'), path.join(fakeMobius, 'node_modules'), 'dir');

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
  for (const name of ['generate_localhost_jwt', 'multiagent_send']) {
    assert.strictEqual(fs.statSync(path.join(binDir, name)).mode & 0o777, 0o755);
  }

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

  console.log('mobius CLI tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
