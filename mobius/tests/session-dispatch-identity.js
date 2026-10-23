/**
 * Unit test for resolveDispatchIdentity: a respawn that forgets userId or the
 * aimux binding must get them back from the session row.
 *
 * Run: node --require tsx/cjs tests/session-dispatch-identity.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..', '..');

// config/db read these at import time
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  const out = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const key of ['DB_PATH', 'MOBIUS_DATA_PATH']) {
    if (out[key] && !process.env[key]) process.env[key] = out[key];
  }
  return out;
}

loadEnv();

const { resolveDispatchIdentity } = require('../backend/services/session-dispatch-identity');

const dbPath = process.env.DB_PATH;
assert.ok(dbPath && fs.existsSync(dbPath), `database not found: ${dbPath}`);
const db = new Database(dbPath, { readonly: true });

const remote = db.prepare(
  "SELECT session_id, user_id, pc_client_metadata FROM sessions_v2 WHERE pc_client_metadata LIKE '%add_remote_aimux_mcp%true%' LIMIT 1",
).get();
const local = db.prepare(
  "SELECT session_id, user_id FROM sessions_v2 WHERE pc_client_metadata IS NULL OR pc_client_metadata NOT LIKE '%add_remote_aimux_mcp%true%' LIMIT 1",
).get();
db.close();

assert.ok(remote?.session_id, 'need a remote-bound session');
assert.ok(local?.session_id, 'need a plain session');

// 1. 空入参 → 从会话行补齐 userId 和远端绑定
{
  const resolved = resolveDispatchIdentity(remote.session_id, {});
  assert.strictEqual(resolved.userId, remote.user_id, 'userId must come from sessions_v2');
  assert.ok(resolved.aimuxRemoteName, 'aimux binding must come from pc_client_metadata');
  assert.strictEqual(resolved.projectId !== undefined, true);
  console.log('ok 1 - missing userId and aimux binding are filled from the session row');
}

// 2. 调用方给的值优先
{
  const resolved = resolveDispatchIdentity(remote.session_id, {
    userId: 'explicit-user',
    aimuxRemoteName: 'explicit-remote',
  });
  assert.strictEqual(resolved.userId, 'explicit-user');
  assert.strictEqual(resolved.aimuxRemoteName, 'explicit-remote');
  console.log('ok 2 - caller-provided values win');
}

// 3. 没有远端绑定的会话 → aimux 保持空, userId 仍补齐
{
  const resolved = resolveDispatchIdentity(local.session_id, {});
  assert.strictEqual(resolved.userId, local.user_id);
  assert.strictEqual(resolved.aimuxRemoteName, undefined);
  console.log('ok 3 - plain sessions resolve userId without inventing a remote');
}

// 4. 不存在的会话 → 原样返回
{
  const input = { userId: 'u', aimuxRemoteName: '' };
  const resolved = resolveDispatchIdentity('no-such-session', input);
  assert.strictEqual(resolved.userId, 'u');
  assert.strictEqual(resolved.aimuxRemoteName, '');
  console.log('ok 4 - unknown sessions leave the input untouched');
}

console.log('\n4/4 dispatch identity checks passed');
