const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-user-isolation-v3-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')

const assert = require('assert')
const { db } = require('../db')
const access = require('../backend/services/access-control')
const { UserProjectView, filterProjectListForUser } = require('../backend/services/user-project-view')
const { AdminAuditLog } = require('../backend/repositories/admin-audit-log')

function cleanup() {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  } catch {}
}

process.on('exit', cleanup)

function run(sql, ...args) {
  db.prepare(sql).run(...args)
}

function user(id, groupId = 'g1', role = 'user') {
  return { id, group_id: groupId, role }
}

function insertUser(id, groupId = 'g1', role = 'user') {
  run(
    `INSERT INTO users (id, display_name, password_hash, role, work_dir, group_id)
     VALUES (?, ?, 'hash', ?, ?, ?)`,
    id,
    id,
    role,
    path.join(tempRoot, 'workspace', id),
    groupId,
  )
}

function insertProject(id, ownerId, visibility = 'public', name = id) {
  run(
    `INSERT INTO projects (id, name, description, created_by, visibility)
     VALUES (?, ?, ?, ?, ?)`,
    id,
    name,
    `${name} description`,
    ownerId,
    visibility,
  )
  access.setProjectAccess(id, { visibility })
}

function setupFixtures() {
  run("INSERT OR IGNORE INTO user_groups (id, name) VALUES ('g1', 'Group 1')")
  run("INSERT OR IGNORE INTO user_groups (id, name) VALUES ('g2', 'Group 2')")
  insertUser('alice', 'g1')
  insertUser('bob', 'g2')
  insertUser('admin', 'g1', 'admin')
  insertProject('p-alice', 'alice', 'public', 'Alpha')
  insertProject('p-bob', 'bob', 'public', 'Beta')
  insertProject('p-private', 'bob', 'private', 'Private')
}

function readableProjectsFor(u) {
  return db.prepare(`
    SELECT p.*, u.display_name AS created_by_name
    FROM projects p
    LEFT JOIN users u ON p.created_by = u.id
    ORDER BY p.id ASC
  `).all().filter((project) => access.canReadProject(u, project))
}

function main() {
  setupFixtures()
  assert.strictEqual(UserProjectView.getPrefs('alice').hide_others_projects, false)
  UserProjectView.setPrefs('alice', { hideOthersProjects: true })
  assert.strictEqual(UserProjectView.getPrefs('alice').hide_others_projects, true)

  let visible = filterProjectListForUser(readableProjectsFor(user('alice')), user('alice'))
  assert.deepStrictEqual(visible.map((p) => p.id), ['p-alice'])

  run(
    `INSERT INTO project_user_stars (project_id, user_id)
     VALUES ('p-bob', 'alice')`
  )
  const starredReadable = readableProjectsFor(user('alice')).map((project) => ({
    ...project,
    starred: project.id === 'p-bob' ? 1 : 0,
  }))
  visible = filterProjectListForUser(starredReadable, user('alice'))
  assert.deepStrictEqual(visible.map((p) => p.id), ['p-alice', 'p-bob'])

  UserProjectView.mute('alice', 'p-alice')
  visible = filterProjectListForUser(readableProjectsFor(user('alice')), user('alice'))
  assert.deepStrictEqual(visible.map((p) => p.id), [])

  const searchVisible = filterProjectListForUser(readableProjectsFor(user('alice')), user('alice'), { query: 'Alpha' })
  assert.deepStrictEqual(searchVisible.map((p) => p.id), ['p-alice'])
  assert.strictEqual(UserProjectView.isMuted('alice', 'p-alice'), true)
  UserProjectView.unmute('alice', 'p-alice')
  assert.strictEqual(UserProjectView.isMuted('alice', 'p-alice'), false)

  const auditId = AdminAuditLog.record({
    adminId: 'admin',
    action: 'read_project',
    resourceType: 'project',
    resourceId: 'p-bob',
  })
  assert.ok(auditId)
  const rows = AdminAuditLog.list({ limit: 10 })
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].admin_id, 'admin')
  assert.strictEqual(rows[0].resource_id, 'p-bob')
  assert.strictEqual(AdminAuditLog.count(), 1)

  console.log('user-isolation-v3: ok')
}

main()
