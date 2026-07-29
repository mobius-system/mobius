const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-project-memberships-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')
process.env.HOME_WORKSPACE_ROOT = path.join(tempRoot, 'home')
process.env.LOCAL_WORKSPACE_ROOT = path.join(tempRoot, 'local')

const { db } = require('../db')
const { Projects } = require('../backend/repositories/projects')
const { ProjectMemberships } = require('../backend/repositories/project-memberships')

function cleanup() {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

function expectEqual(label, actual, expected) {
  assert.strictEqual(actual, expected, `${label}: actual=${actual} expected=${expected}`)
  console.log(`PASS ${label}`)
}

function expectThrows(label, fn, messageContains) {
  let threw = false
  try { fn() } catch (e) {
    threw = true
    if (messageContains && !String((e && e.message) || '').includes(messageContains)) {
      throw new Error(`${label}: error "${e && e.message}" does not contain "${messageContains}"`)
    }
  }
  if (!threw) throw new Error(`${label}: expected to throw`)
  console.log(`PASS ${label}`)
}

function insertUser(id, name, role) {
  db.prepare(
    `INSERT INTO users (id, display_name, password_hash, role, work_dir, group_id)
     VALUES (?, ?, 'hash', ?, ?, 'default')`
  ).run(id, name, role || 'user', path.join(tempRoot, 'workspace', id))
}

insertUser('owner', '负责人')
insertUser('alice', '爱丽丝')
insertUser('bob', '鲍勃')
insertUser('admin', '管理员', 'admin')

assert(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_memberships'").get(), 'project_memberships table missing')

// 创建项目 → 创建者自动 owner.
Projects.insert({ id: 'p1', name: '项目一', createdBy: 'owner' })
expectEqual('creator becomes owner', ProjectMemberships.roleFor('p1', 'owner'), 'owner')
expectEqual('non-member has no role', ProjectMemberships.roleFor('p1', 'alice'), null)

// 创建时带首批成员 (member 角色), 自动排除创建者本人, 去重.
Projects.insert({ id: 'p2', name: '项目二', createdBy: 'owner', memberUserIds: ['alice', 'bob', 'owner', 'alice'] })
expectEqual('p2 creator is owner', ProjectMemberships.roleFor('p2', 'owner'), 'owner')
expectEqual('p2 alice is member', ProjectMemberships.roleFor('p2', 'alice'), 'member')
expectEqual('p2 bob is member', ProjectMemberships.roleFor('p2', 'bob'), 'member')
expectEqual('p2 has 3 members', ProjectMemberships.list('p2').length, 3)

// 非法成员 → 整个创建事务回滚, 不留半成品项目.
expectThrows('invalid initial member rolls back creation', () => {
  Projects.insert({ id: 'p3', name: '项目三', createdBy: 'owner', memberUserIds: ['alice', 'ghost'] })
}, '不存在或已停用')
assert(!Projects.findById('p3'), 'p3 must not exist after rollback')

// canManage: owner/manager/admin 放行, 普通成员/外人拒绝.
expectEqual('owner can manage', ProjectMemberships.canManage('p2', { id: 'owner' }), true)
expectEqual('member cannot manage', ProjectMemberships.canManage('p2', { id: 'alice' }), false)
expectEqual('outsider cannot manage', ProjectMemberships.canManage('p2', { id: 'stranger' }), false)
expectEqual('admin can manage', ProjectMemberships.canManage('p2', { id: 'admin', role: 'admin' }), true)

// addMany 幂等 + 非法拒绝.
ProjectMemberships.addMany({ projectId: 'p1', userIds: ['alice'], role: 'member', actorId: 'owner' })
expectEqual('addMany adds member', ProjectMemberships.roleFor('p1', 'alice'), 'member')
ProjectMemberships.addMany({ projectId: 'p1', userIds: ['alice'], role: 'member', actorId: 'owner' })
expectEqual('addMany idempotent', ProjectMemberships.list('p1').length, 2)
expectThrows('addMany rejects invalid user', () => ProjectMemberships.addMany({ projectId: 'p1', userIds: ['ghost'] }), '不存在或已停用')

// updateRole 升级.
ProjectMemberships.updateRole({ projectId: 'p1', userId: 'alice', role: 'manager', actorId: 'owner' })
expectEqual('promote alice to manager', ProjectMemberships.roleFor('p1', 'alice'), 'manager')
expectEqual('manager can manage', ProjectMemberships.canManage('p1', { id: 'alice' }), true)

// last-owner 保护: 唯一 owner 不能被移除/降级.
expectThrows('cannot remove last owner', () => ProjectMemberships.remove({ projectId: 'p1', userId: 'owner' }), '至少保留')
expectThrows('cannot demote last owner', () => ProjectMemberships.updateRole({ projectId: 'p1', userId: 'owner', role: 'manager' }), '至少保留')

// 普通成员可正常移除.
ProjectMemberships.remove({ projectId: 'p1', userId: 'alice' })
expectEqual('alice removed', ProjectMemberships.roleFor('p1', 'alice'), null)

// counts.
const c = ProjectMemberships.counts('p2')
expectEqual('p2 owner count', c.owner, 1)
expectEqual('p2 member count', c.member, 2)

console.log('project-memberships: ok')
