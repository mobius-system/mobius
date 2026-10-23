/**
 * Route-level test for POST /api/internal/session-reminders/:type/decide.
 *
 * Mounts the real router in a minimal express app and talks to it over HTTP.
 * Uses the configured Mobius database read-only, picking an existing session:
 *   - one with add_remote_aimux_mcp=true exercises the "show" path
 *   - any session without it exercises the "suppress" path
 * The only writes are to the disposable session_reminder_cache table, which is
 * cleaned up afterwards.
 *
 * Run: node --require tsx/cjs tests/session-reminders-route.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const express = require('express');

const ROOT = path.resolve(__dirname, '..', '..');

// 在加载后端模块之前注入 .env 里的关键变量 (config 在 import 时读取)
// Set the keys config reads at import time before requiring backend modules
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  const out = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const key of ['JWT_SECRET', 'DB_PATH', 'MOBIUS_DATA_PATH', 'MOBIUS_PORT']) {
    if (out[key] && !process.env[key]) process.env[key] = out[key];
  }
  return out;
}

const env = loadEnv();
if (!env.JWT_SECRET) {
  console.log('skip - JWT_SECRET is not configured in .env');
  process.exit(0);
}

const { router } = require('../backend/routes/session-reminders');
const { reminderHookToken } = require('../backend/services/session-reminder-hook');

const TYPE = 'remote_target_local_tool';
const TOKEN = reminderHookToken;

function request(baseUrl, sessionId, token, body) {
  return fetch(`${baseUrl}/api/internal/session-reminders/${TYPE}/decide`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mobius-session-id': sessionId,
      'x-mobius-hook-token': token,
    },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

async function main() {
  const dbfile = process.env.DB_PATH;
  assert.ok(dbfile && fs.existsSync(dbfile), `database not found: ${dbfile}`);
  const db = new Database(dbfile, { readonly: true });

  const remote = db.prepare(
    "SELECT session_id FROM sessions_v2 WHERE pc_client_metadata LIKE '%add_remote_aimux_mcp%true%' LIMIT 1",
  ).get();
  const local = db.prepare(
    "SELECT session_id FROM sessions_v2 WHERE session_id <> ? AND (pc_client_metadata IS NULL OR pc_client_metadata NOT LIKE '%add_remote_aimux_mcp%true%') LIMIT 1",
  ).get(remote?.session_id || '');
  db.close();

  assert.ok(remote?.session_id, 'need an existing remote-target session to test the show path');
  assert.ok(local?.session_id, 'need an existing non-remote session to test suppression');

  const app = express();
  app.use('/api/internal/session-reminders', router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const cleanup = () => {
    const rw = new Database(dbfile);
    rw.prepare('DELETE FROM session_reminder_cache WHERE session_id IN (?, ?)')
      .run(remote.session_id, local.session_id);
    rw.close();
  };
  cleanup();

  try {
    // 1. 令牌校验
    const noToken = await request(baseUrl, remote.session_id, '', { tool_name: 'Bash' });
    assert.strictEqual(noToken.status, 401, 'missing token must be rejected');

    const wrongToken = await request(baseUrl, remote.session_id, 'wrong', { tool_name: 'Bash' });
    assert.strictEqual(wrongToken.status, 401, 'invalid token must be rejected');

    const tokenForOther = await request(baseUrl, remote.session_id, TOKEN(local.session_id, env.JWT_SECRET), { tool_name: 'Bash' });
    assert.strictEqual(tokenForOther.status, 401, 'a token for another session must not work');

    // 2. 不存在的会话
    const missing = await request(baseUrl, 'no-such-session', TOKEN('no-such-session', env.JWT_SECRET), { tool_name: 'Bash' });
    assert.strictEqual(missing.status, 404);

    // 3. 无远端目标 → 空决策
    const suppressed = await request(baseUrl, local.session_id, TOKEN(local.session_id, env.JWT_SECRET), { tool_name: 'Bash' });
    assert.strictEqual(suppressed.status, 200);
    assert.deepStrictEqual(suppressed.body, {}, 'no remote target means no reminder');

    // 4. 有远端目标 → 第一次提醒, 一小时内第二次被压制, 清缓存后恢复
    const token = TOKEN(remote.session_id, env.JWT_SECRET);
    const first = await request(baseUrl, remote.session_id, token, { tool_name: 'Bash' });
    assert.strictEqual(first.status, 200);
    assert.ok(first.body.hookSpecificOutput, 'first call must return a reminder');
    assert.strictEqual(first.body.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(first.body.hookSpecificOutput.additionalContext, /remote_exec_command|remote_apply_patch/);

    const second = await request(baseUrl, remote.session_id, token, { tool_name: 'apply_patch' });
    assert.deepStrictEqual(second.body, {}, 'second call within the hour is suppressed');

    cleanup();
    const third = await request(baseUrl, remote.session_id, token, { tool_name: 'Bash' });
    assert.ok(third.body.hookSpecificOutput, 'clearing the cache re-enables the reminder');

    // 5. 未知类型
    const badType = await fetch(`${baseUrl}/api/internal/session-reminders/../evil/decide`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mobius-session-id': remote.session_id,
        'x-mobius-hook-token': token,
      },
      body: '{}',
    });
    assert.ok([400, 404].includes(badType.status), `invalid type must be rejected (got ${badType.status})`);

    console.log('ok 1 - token and session validation');
    console.log('ok 2 - non-remote sessions get an empty decision');
    console.log('ok 3 - remote sessions remind once per hour');
    console.log('ok 4 - clearing the cache restores eligibility');
    console.log('\n4/4 session reminder route checks passed');
  } finally {
    cleanup();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
