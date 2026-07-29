const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-user-group-memberships-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')
process.env.HOME_WORKSPACE_ROOT = path.join(tempRoot, 'home')
process.env.LOCAL_WORKSPACE_ROOT = path.join(tempRoot, 'local')

const { db } = require('../db')
const { Users } = require('../backend/repositories/users')

function cleanup() {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

function expectEqual(label, actual, expected) {
  assert.strictEqual(actual, expected, `${label}: actual=${actual} expected=${expected}`)
  console.log(`PASS ${label}`)
}

function expectDeepEqual(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, label)
  console.log(`PASS ${label}`)
}

function run(sql, ...args) {
  db.prepare(sql).run(...args)
}

run("INSERT OR IGNORE INTO user_groups (id, name) VALUES ('g1', '研发组')")
run("INSERT OR IGNORE INTO user_groups (id, name) VALUES ('g2', '设计组')")
run(
  `INSERT INTO users (id, display_name, password_hash, role, work_dir, group_id)
   VALUES ('employee', '员工', 'hash', 'user', ?, 'g1')`,
  path.join(tempRoot, 'workspace', 'employee'),
)

assert(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_group_memberships'").get(), 'user_group_memberships table missing')
assert(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_memberships'").get(), 'project_memberships table missing')

assert.strictEqual(typeof Users.listGroupMemberships, 'function', 'Users.listGroupMemberships missing')
assert.strictEqual(typeof Users.replaceGroups, 'function', 'Users.replaceGroups missing')

Users.listGroupMemberships('employee')
expectDeepEqual(
  'legacy single group is backfilled',
  db.prepare('SELECT user_id, group_id, is_primary FROM user_group_memberships WHERE user_id = ?').get('employee'),
  { user_id: 'employee', group_id: 'g1', is_primary: 1 },
)

Users.replaceGroups('employee', ['g1', 'g2'], 'admin')
expectDeepEqual(
  'employee can belong to two groups',
  Users.listGroupMemberships('employee').map((row) => row.group_id),
  ['g1', 'g2'],
)

Users.replaceGroups('employee', [], 'admin')
expectDeepEqual(
  'empty replacement falls back to default group',
  Users.listGroupMemberships('employee').map((row) => row.group_id),
  ['default'],
)
expectEqual('legacy primary projection remains', db.prepare('SELECT group_id FROM users WHERE id = ?').get('employee').group_id, 'default')

console.log('user-group-memberships: ok')
