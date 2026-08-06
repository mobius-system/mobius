const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-project-delete-policy-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')
process.env.HOME_WORKSPACE_ROOT = path.join(tempRoot, 'home')
process.env.LOCAL_WORKSPACE_ROOT = path.join(tempRoot, 'local')
process.env.ENABLE_PASSWORD_LOGIN = 'false'

const bcrypt = require('bcryptjs')
const { db } = require('../db')
const { Projects } = require('../backend/repositories/projects')
const { ProjectDeletionAudit } = require('../backend/repositories/project-deletion-audit')
const { projectDeletePolicy, FIXED_LOGO_REVIEW_PROJECT_ID } = require('../backend/services/project-deletion-policy')
const { SensitiveActionRateLimiter, verifySensitiveActionPassword } = require('../backend/services/sensitive-action-auth')

function cleanup() {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

function insertUser(id, role = 'user', password = 'correct-password') {
  db.prepare(
    `INSERT INTO users (id, display_name, password_hash, role, work_dir, group_id)
     VALUES (?, ?, ?, ?, ?, 'default')`,
  ).run(id, id, bcrypt.hashSync(password, 10), role, path.join(tempRoot, 'workspace', id))
}

insertUser('creator')
insertUser('admin', 'admin')
insertUser('manager')
insertUser('empty', 'user', 'empty-password')

Projects.insert({ id: 'ordinary', name: '普通项目', createdBy: 'creator', bindPath: path.join(tempRoot, 'ordinary') })
const ordinary = Projects.findById('ordinary')
const fixed = { id: FIXED_LOGO_REVIEW_PROJECT_ID, name: '固定案例', created_by: 'creator', kind: 'normal', bind_path: path.join(tempRoot, 'fixed') }
const extension = { id: 'extension', name: '拓展', created_by: 'creator', kind: 'extension', bind_path: path.join(tempRoot, 'extension') }
const selfDevelop = { id: 'self-develop', name: '自迭代', created_by: 'creator', kind: 'normal', bind_path: path.resolve(__dirname, '..', '..') }

assert.strictEqual(projectDeletePolicy(ordinary, { id: 'creator', role: 'user' }).mode, 'creator')
assert.strictEqual(projectDeletePolicy(ordinary, { id: 'admin', role: 'admin' }).mode, 'system_admin_override')
assert.strictEqual(projectDeletePolicy(ordinary, { id: 'manager', role: 'manager' }).allowed, false)
assert.strictEqual(projectDeletePolicy(fixed, { id: 'admin', role: 'admin' }).protected, true)
assert.strictEqual(projectDeletePolicy(extension, { id: 'admin', role: 'admin' }).protected, true)
assert.strictEqual(projectDeletePolicy(selfDevelop, { id: 'admin', role: 'admin' }).protected, true)
console.log('PASS project deletion policy matrix')

let now = 0
const limiter = new SensitiveActionRateLimiter(1000, 2, () => now)
assert.deepStrictEqual(limiter.check('actor\nip'), { allowed: true, retryAfterSeconds: 0 })
limiter.recordFailure('actor\nip')
limiter.recordFailure('actor\nip')
assert.strictEqual(limiter.check('actor\nip').allowed, false)
now = 1001
assert.strictEqual(limiter.check('actor\nip').allowed, true)
console.log('PASS sensitive action rate limiter')

assert.deepStrictEqual(verifySensitiveActionPassword({ userId: 'creator', password: 'wrong-password', clientAddress: 'test' }), { ok: false, code: 'password_invalid' })
assert.deepStrictEqual(verifySensitiveActionPassword({ userId: 'creator', password: 'correct-password', clientAddress: 'test' }), { ok: true })
console.log('PASS password verification works with password login disabled')

const impact = ProjectDeletionAudit.impact(ordinary.id)
const auditId = ProjectDeletionAudit.record({
  actorId: 'admin',
  actorSystemRole: 'admin',
  projectId: ordinary.id,
  projectName: ordinary.name,
  projectCreator: ordinary.created_by,
  deletionMode: 'system_admin_override',
  reason: '测试代删审计',
  outcome: 'pending',
  impact,
  requestIp: 'test',
})
ProjectDeletionAudit.complete(auditId, 'succeeded')
const audit = db.prepare('SELECT outcome, auth_method, reason FROM project_deletion_audit_log WHERE id = ?').get(auditId)
assert.deepStrictEqual(audit, { outcome: 'succeeded', auth_method: 'password', reason: '测试代删审计' })
console.log('PASS project deletion audit persistence')

console.log('project-deletion-policy: ok')
