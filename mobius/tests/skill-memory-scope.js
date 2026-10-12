// 「Skill与Memory管理」对普通用户开放后, 后端必须按调用者身份收窄:
//   用户级 = 只列自己的; 项目级 = 只列自己可读的项目; 导出逐条过读权限; 导入到项目级要有写权限.
// 用真实库 + 真实文件目录测, 不 mock.
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-skill-memory-scope-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')

const { db } = require('../db')
const memoriesFs = require('../backend/services/memories-fs')
const skillsFs = require('../backend/services/skills-fs')
const migration = require('../backend/services/skill-memory-migration')

const failures = []

function cleanup() {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

function pass(label) { console.log(`PASS ${label}`) }
function fail(label, detail) {
  failures.push(`${label}: ${detail}`)
  console.log(`FAIL ${label}: ${detail}`)
}
function expectEqual(label, actual, expected) {
  if (actual === expected) pass(label)
  else fail(label, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}
function expectTrue(label, value, detail) {
  if (value) pass(label)
  else fail(label, detail || 'expected truthy')
}

function insertUser(id, role, displayName) {
  db.prepare(
    `INSERT INTO users (id, display_name, password_hash, role, work_dir)
     VALUES (?, ?, 'hash', ?, ?)`,
  ).run(id, displayName || id, role, path.join(tempRoot, 'workspace', id))
}

function insertProject(id, name, ownerId) {
  db.prepare(
    `INSERT INTO projects (id, name, created_by, visibility)
     VALUES (?, ?, ?, 'private')`,
  ).run(id, name, ownerId)
}

function insertMembership(projectId, userId, role) {
  db.prepare(
    `INSERT INTO project_memberships (project_id, user_id, role) VALUES (?, ?, ?)`,
  ).run(projectId, userId, role)
}

// skill 的最小夹具: <ROOT>/user=<uid>[/project=<pid>]/.claude/skills/<dir>/SKILL.md
function writeSkill(userId, projectId, dirName, name) {
  const base = projectId
    ? path.join(skillsFs.ROOT, `user=${userId}`, `project=${projectId}`, '.claude', 'skills')
    : path.join(skillsFs.ROOT, `user=${userId}`, 'default_project', '.claude', 'skills')
  const dir = path.join(base, dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\nbody\n`, 'utf8')
}

insertUser('admin', 'admin', '管理员')
insertUser('alice', 'user', 'Alice')
insertUser('bob', 'user', 'Bob')
insertProject('p_alice', 'Alice 的项目', 'alice')
insertProject('p_bob', 'Bob 的项目', 'bob')
// alice 只是 p_bob 的只读成员: 可读, 不可写 → 项目级可见但不可导入.
insertMembership('p_bob', 'alice', 'viewer')

const aliceUser = db.prepare('SELECT * FROM users WHERE id = ?').get('alice')
const bobUser = db.prepare('SELECT * FROM users WHERE id = ?').get('bob')
const adminUser = db.prepare('SELECT * FROM users WHERE id = ?').get('admin')

const mAlice = memoriesFs.create({ userId: 'alice', name: 'Alice 的用户级记忆', body: 'a' }).memory
const mBob = memoriesFs.create({ userId: 'bob', name: 'Bob 的用户级记忆', body: 'b' }).memory
const mProjAlice = memoriesFs.create({ userId: 'alice', projectId: 'p_alice', name: 'Alice 项目记忆', body: 'pa' }).memory
const mProjBob = memoriesFs.create({ userId: 'bob', projectId: 'p_bob', name: 'Bob 项目记忆', body: 'pb' }).memory
writeSkill('alice', null, 's-alice', 'alice-skill')
writeSkill('bob', null, 's-bob', 'bob-skill')

const projects = [
  { id: 'p_alice', name: 'Alice 的项目', created_by: 'alice' },
  { id: 'p_bob', name: 'Bob 的项目', created_by: 'bob' },
]

// ── 1. inventory 按身份收窄 ───────────────────────────────────────────────
const aliceInventory = migration.buildInventory({ userId: 'alice', user: aliceUser, projects })

expectEqual('alice 的用户级只含自己', aliceInventory.user_scope.memories.map((m) => m.id).join(','), mAlice.id)
expectEqual('alice 看不到他人用户级条目', aliceInventory.others_user_scopes.length, 0)
expectEqual(
  'alice 的项目级 = 自己创建的 + 可读的',
  aliceInventory.project_scopes.map((s) => s.project_id).sort().join(','),
  'p_alice,p_bob',
)
expectTrue(
  'alice 对 Bob 的项目只有读没有管理',
  aliceInventory.project_scopes.find((s) => s.project_id === 'p_bob').memories.every((m) => m.can_manage === false),
  'viewer 成员不应拿到 can_manage',
)
expectTrue(
  'alice 对自己项目的条目可管理',
  aliceInventory.project_scopes.find((s) => s.project_id === 'p_alice').memories.every((m) => m.can_manage === true),
)

const adminInventory = migration.buildInventory({ userId: 'admin', user: adminUser, projects })
expectEqual('管理员项目级 = 全部项目', adminInventory.project_scopes.length, 2)
// 「他人用户级」区不锁具体条数: 用户级条目在 v3 权限模型里已不再跨用户共享, 该区目前对谁都为空.
// 只锁不变式 —— 出现在这里的条目必须是调用者读得到的, 不能因为"是管理员"就无条件塞进来.
expectTrue(
  '他人用户级区只含调用者读得到的条目',
  adminInventory.others_user_scopes.every((s) => s.memories.every((m) => m.can_manage === false && !!m.id)),
)

// ── 2. 导出逐条过读权限 ──────────────────────────────────────────────────
const stolen = migration.buildExportBundle({ userId: 'alice', user: aliceUser, memoryIds: [mBob.id] })
expectTrue('导出他人记忆被拒', stolen.ok === false, `got ${JSON.stringify(stolen)}`)

const mixed = migration.buildExportBundle({ userId: 'alice', user: aliceUser, memoryIds: [mAlice.id, mBob.id] })
expectTrue('混合导出只保留自己有权限的条目', mixed.ok === true)
expectEqual('混合导出条数', mixed.summary.memories, 1)
expectEqual('混合导出跳过他人条目', mixed.skipped.length, 1)

const adminExport = migration.buildExportBundle({ userId: 'admin', user: adminUser, memoryIds: [mBob.id] })
expectTrue('管理员仍可导出他人条目', adminExport.ok === true)

// ── 3. 导入到项目级要写权限 ──────────────────────────────────────────────
const aliceBundle = migration.buildExportBundle({ userId: 'alice', user: aliceUser, memoryIds: [mAlice.id] })
expectTrue('准备导入用的 bundle', aliceBundle.ok === true)

const toBobProject = migration.importBundle({
  requesterUserId: 'alice',
  user: aliceUser,
  base64: aliceBundle.base64,
  target: { scope: 'project', project_id: 'p_bob' },
})
expectEqual('alice 导入 Bob 的项目被拒', toBobProject.ok, false)

const toOwnProject = migration.importBundle({
  requesterUserId: 'alice',
  user: aliceUser,
  base64: aliceBundle.base64,
  target: { scope: 'project', project_id: 'p_alice' },
})
expectEqual('alice 导入自己的项目成功', toOwnProject.ok, true)

const toUserScope = migration.importBundle({
  requesterUserId: 'alice',
  user: aliceUser,
  base64: aliceBundle.base64,
  target: { scope: 'user' },
})
expectEqual('alice 导入用户级成功', toUserScope.ok, true)

const adminToBobProject = migration.importBundle({
  requesterUserId: 'admin',
  user: adminUser,
  base64: aliceBundle.base64,
  target: { scope: 'project', project_id: 'p_bob' },
})
expectEqual('管理员导入任意项目仍允许', adminToBobProject.ok, true)

// ── 结果 ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.log(`\n${failures.length} failure(s):`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
console.log('\nskill-memory scope tests passed')
