/**
 * Unit tests for declare_job_done / declare_job_failed: both are HTTP-only and
 * authenticate with the session's MOBIUS_CLI_JWT (there is no local fallback).
 *
 * Run: node tests/session-jobs-cli.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');

const CLI_DIR = path.resolve(__dirname, '../scripts/cli');
const DONE = path.join(CLI_DIR, 'declare_job_done');
const FAILED = path.join(CLI_DIR, 'declare_job_failed');
const CLI_JWT = 'test-session-jwt';

function startServer(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const { status, payload } = respond(req, body);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function run(cli, args, env) {
  return new Promise((resolve) => {
    execFile(cli, args, {
      encoding: 'utf8',
      timeout: 20000,
      env: { ...process.env, MOBIUS_BASE: '', MOBIUS_CLI_JWT: '', ...env },
    }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

async function testDone() {
  const server = await startServer(() => ({ status: 200, payload: { ok: true } }));
  try {
    const result = await run(DONE, ['sess-1'], { MOBIUS_BASE: server.baseUrl, MOBIUS_CLI_JWT: CLI_JWT });
    assert.strictEqual(result.status, 0, result.stderr);

    assert.strictEqual(server.requests.length, 1);
    const req = server.requests[0];
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.url, '/api/session-jobs/declare');
    assert.strictEqual(req.headers['content-type'], 'application/json');
    assert.strictEqual(req.headers.authorization, `Bearer ${CLI_JWT}`);
    assert.deepStrictEqual(JSON.parse(req.body), { session_id: 'sess-1', status: 'done' });
    console.log('ok 1 - declare_job_done posts to the backend');
  } finally {
    await server.close();
  }
}

async function testFailedWithTrickyReason() {
  const server = await startServer(() => ({ status: 200, payload: { ok: true } }));
  try {
    const reason = 'line one\nline "two" \\ end';
    const result = await run(FAILED, ['sess-2', reason], { MOBIUS_BASE: server.baseUrl, MOBIUS_CLI_JWT: CLI_JWT });
    assert.strictEqual(result.status, 0, result.stderr);

    const body = JSON.parse(server.requests[0].body);
    assert.strictEqual(body.session_id, 'sess-2');
    assert.strictEqual(body.status, 'failed');
    assert.strictEqual(body.reason, reason, 'reason must survive JSON encoding unchanged');
    console.log('ok 2 - declare_job_failed encodes the reason safely');
  } finally {
    await server.close();
  }
}

async function testBackendRejection() {
  const server = await startServer(() => ({ status: 404, payload: { error: 'session not found' } }));
  try {
    const result = await run(DONE, ['sess-3'], { MOBIUS_BASE: server.baseUrl, MOBIUS_CLI_JWT: CLI_JWT });
    assert.strictEqual(result.status, 5, 'non-200 must exit 5');
    assert.match(result.stderr, /Backend error \(HTTP 404\)/);
    assert.match(result.stderr, /session not found/);
    console.log('ok 3 - backend rejection is reported and non-zero');
  } finally {
    await server.close();
  }
}

async function testNetworkFailure() {
  const server = await startServer(() => ({ status: 200, payload: { ok: true } }));
  const baseUrl = server.baseUrl;
  await server.close();

  const result = await run(DONE, ['sess-4'], { MOBIUS_BASE: baseUrl, MOBIUS_CLI_JWT: CLI_JWT });
  assert.strictEqual(result.status, 3, 'unreachable backend must exit 3');
  assert.match(result.stderr, /Network error/);
  console.log('ok 4 - unreachable backend exits 3');
}

async function main() {
  await testDone();
  await testFailedWithTrickyReason();
  await testBackendRejection();
  await testNetworkFailure();
  console.log('\n4/4 session job CLI checks passed');
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
