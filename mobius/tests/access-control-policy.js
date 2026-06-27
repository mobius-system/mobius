const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-access-policy-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')
process.env.HOME_WORKSPACE_ROOT = path.join(tempRoot, 'home')
process.env.LOCAL_WORKSPACE_ROOT = path.join(tempRoot, 'local')
process.env.v3_run_session_gate = '1'

const { db } = require('../db')
const access = require('../backend/services/access-control')

const failures = []

function cleanup() {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  } catch {}
}

process.on('exit', cleanup)

function pass(label) {
  console.log(`PASS ${label}`)
}

function fail(label, detail) {
  failures.push(`${label}: ${detail}`)
  console.log(`FAIL ${label}: ${detail}`)
}

function expectEqual(label, actual, expected) {
  if (actual === expected) pass(label)
  else fail(label, `actual=${actual} expected=${expected}`)
}

function expectContains(label, text, patternDescription, predicate) {
  if (predicate(text)) pass(label)
  else fail(label, `missing ${patternDescription}`)
}

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

function insertProject(id, ownerId, visibility) {
  run(
    `INSERT INTO projects (id, name, created_by, visibility)
     VALUES (?, ?, ?, ?)`,
    id,
    id,
    ownerId,
    visibility,
  )
  access.setProjectAccess(id, { visibility })
}

function insertIssue(id, projectId, creatorId, visibility = 'inherit') {
  run(
    `INSERT INTO issues (id, project_id, title, created_by, visibility)
     VALUES (?, ?, ?, ?, ?)`,
    id,
    projectId,
    id,
    creatorId,
    visibility,
  )
}

function setupFixtures() {
  run("INSERT OR IGNORE INTO user_groups (id, name) VALUES ('g1', 'Group 1')")
  run("INSERT OR IGNORE INTO user_groups (id, name) VALUES ('g2', 'Group 2')")

  insertUser('owner', 'g1')
  insertUser('teammate', 'g1')
  insertUser('outsider', 'g2')
  insertUser('allowed', 'g2')
  insertUser('contrib', 'g2')
  insertUser('admin', 'g2', 'admin')

  insertProject('p-private', 'owner', 'private')
  insertProject('p-team', 'owner', 'team')
  insertProject('p-public', 'owner', 'public')
  insertProject('p-allowlist', 'owner', 'allowlist')

  access.setProjectAccess('p-private', { visibility: 'private', allowUserIds: ['allowed'] })
  access.setProjectAccess('p-allowlist', { visibility: 'allowlist', allowUserIds: ['allowed'] })

  insertIssue('i-public-inherit', 'p-public', 'owner')
  insertIssue('i-public-private', 'p-public', 'owner', 'private')
  insertIssue('i-private-public', 'p-private', 'owner', 'public')
}

function verifyReadPolicy() {
  expectEqual('private project owner can read', access.canReadProject(user('owner'), 'p-private'), true)
  expectEqual('private project outsider cannot read', access.canReadProject(user('outsider', 'g2'), 'p-private'), false)
  expectEqual('private project allow user can read', access.canReadProject(user('allowed', 'g2'), 'p-private'), true)
  expectEqual('team project same group can read', access.canReadProject(user('teammate'), 'p-team'), true)
  expectEqual('team project other group cannot read', access.canReadProject(user('outsider', 'g2'), 'p-team'), false)
  expectEqual('public project outsider can read', access.canReadProject(user('outsider', 'g2'), 'p-public'), true)
  expectEqual('allowlist project allow user can read', access.canReadProject(user('allowed', 'g2'), 'p-allowlist'), true)
  expectEqual('allowlist project outsider cannot read', access.canReadProject(user('outsider', 'g2'), 'p-allowlist'), false)
}

function verifyIssueAndSessionPolicy() {
  expectEqual(
    'public project inherited issue readable by outsider',
    access.canReadIssue(user('outsider', 'g2'), 'i-public-inherit'),
    true,
  )
  expectEqual(
    'private issue in public project not readable by outsider',
    access.canReadIssue(user('outsider', 'g2'), 'i-public-private'),
    false,
  )
  expectEqual(
    'public issue inside private project still requires project access',
    access.canReadIssue(user('outsider', 'g2'), 'i-private-public'),
    false,
  )
  expectEqual('public project reader cannot create issue when can_post_issue is off', access.canCreateIssue(user('outsider', 'g2'), 'p-public'), false)
  run('UPDATE projects SET can_post_issue = 1 WHERE id = ?', 'p-public')
  expectEqual('public project reader can create issue when can_post_issue is on', access.canCreateIssue(user('outsider', 'g2'), 'p-public'), true)
  run('UPDATE projects SET can_post_issue = 0 WHERE id = ?', 'p-public')
  expectEqual('private project outsider cannot create issue', access.canCreateIssue(user('outsider', 'g2'), 'p-private'), false)
  expectEqual('public project reader cannot create session when can_run_session is off', access.canCreateSessionForIssue(user('outsider', 'g2'), 'i-public-inherit'), false)
  run('UPDATE projects SET can_run_session = 1 WHERE id = ?', 'p-public')
  expectEqual('public project reader can create session when can_run_session is on', access.canCreateSessionForIssue(user('outsider', 'g2'), 'i-public-inherit'), true)
  run('UPDATE projects SET can_run_session = 0 WHERE id = ?', 'p-public')
  expectEqual('admin cannot widen issue visibility beyond private project', access.canSetIssueVisibilityWithinProject('p-private', 'public'), false)
  expectEqual('team project can keep issue visibility at team', access.canSetIssueVisibilityWithinProject('p-team', 'team'), true)
  expectEqual('allowlist project can use allowlist issue visibility', access.canSetIssueVisibilityWithinProject('p-allowlist', 'allowlist'), true)

  const ownSession = { session_id: 's-own', project_id: 'p-public', issue_id: 'i-public-inherit', user_id: 'outsider' }
  const othersSession = { session_id: 's-other', project_id: 'p-public', issue_id: 'i-public-inherit', user_id: 'teammate' }
  expectEqual('session creator can operate own session', access.canOperateSession(user('outsider', 'g2'), ownSession), true)
  expectEqual('public project user cannot operate another user session', access.canOperateSession(user('outsider', 'g2'), othersSession), false)
  expectEqual('project owner can operate session in own project', access.canOperateSession(user('owner'), othersSession), true)
}

function verifySkillMemoryPolicy() {
  const userSkill = { id: 'user:owner:skill-a', scope: 'user', owner_id: 'owner', created_by: 'owner' }
  expectEqual('user skill defaults to private', access.canReadContextItem(user('outsider', 'g2'), 'skill', userSkill), false)
  access.setResourcePolicy('skill', userSkill.id, { visibility: 'public', createdBy: 'owner' })
  expectEqual('public user skill is readable', access.canReadContextItem(user('outsider', 'g2'), 'skill', userSkill), true)

  const projectMemory = { id: 'project:contrib:p-public:mem-a', scope: 'project', owner_id: 'p-public', created_by: 'contrib' }
  expectEqual('project memory inherits public project read access', access.canReadContextItem(user('outsider', 'g2'), 'memory', projectMemory), true)

  // Desired safety boundary: project context affects later sessions and should not be writable by every reader.
  expectEqual(
    'public project reader must not be able to contribute project-level Skill/Memory',
    access.canContributeProjectContext(user('outsider', 'g2'), 'p-public'),
    false,
  )
}

function routeBlock(source, routeMarker) {
  const start = source.indexOf(routeMarker)
  if (start < 0) return ''
  const next = source.indexOf("\n});", start)
  return next < 0 ? source.slice(start) : source.slice(start, next + 5)
}

function verifyWriteRouteGuards() {
  const integrationPath = path.join(__dirname, '..', 'backend', 'routes', 'integration.ts')
  const integration = fs.readFileSync(integrationPath, 'utf8')
  expectContains(
    'session change scan route should require operable session',
    routeBlock(integration, "router.post('/sessions/:id/changes/scan'"),
    'canOperateSession/getOperableSession guard',
    (text) => /canOperateSession|getOperableSession|findSessionOperable/.test(text),
  )
  expectContains(
    'session change check route should require operable session',
    routeBlock(integration, "router.post('/sessions/:id/changes/check'"),
    'canOperateSession/getOperableSession guard',
    (text) => /canOperateSession|getOperableSession|findSessionOperable/.test(text),
  )
  for (const [label, marker] of [
    ['issue integration check route should require manageable issue', "router.post('/issues/:id/integration/check'"],
    ['issue integration accept route should require manageable issue', "router.post('/issues/:id/integration/accept'"],
    ['issue integration enqueue route should require manageable issue', "router.post('/issues/:id/integration/enqueue'"],
  ]) {
    expectContains(label, routeBlock(integration, marker), 'canManageIssue guard', (text) => /canManageIssue/.test(text))
  }
}

function main() {
  setupFixtures()
  verifyReadPolicy()
  verifyIssueAndSessionPolicy()
  verifySkillMemoryPolicy()
  verifyWriteRouteGuards()

  if (failures.length) {
    console.error(`access-control-policy: failed ${failures.length} policy checks`)
    for (const failure of failures) console.error(` - ${failure}`)
    process.exitCode = 1
    return
  }
  console.log('access-control-policy: ok')
}

main()
