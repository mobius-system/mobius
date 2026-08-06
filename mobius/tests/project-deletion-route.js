const assert = require('assert')
const express = require('express')
const http = require('http')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-project-delete-route-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')
process.env.HOME_WORKSPACE_ROOT = path.join(tempRoot, 'home')
process.env.LOCAL_WORKSPACE_ROOT = path.join(tempRoot, 'local')
process.env.ENABLE_PASSWORD_LOGIN = 'false'
process.env.JWT_SECRET = 'project-delete-route-test-secret'

const { db } = require('../db')
const { JWT_SECRET, APP_DIR } = require('../backend/config')
const { Projects } = require('../backend/repositories/projects')
const { ProjectMemberships } = require('../backend/repositories/project-memberships')
const projectsRouter = require('../backend/routes/projects')

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

function tokenFor(id, role = 'user') {
  return jwt.sign({ id, role }, JWT_SECRET, { expiresIn: '1h' })
}

async function listen(app) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

async function request(base, projectId, actorId, role, body, method = 'DELETE', suffix = '') {
  const response = await fetch(`${base}/api/projects/${projectId}${suffix}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(actorId, role)}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, body: await response.json() }
}

insertUser('creator')
insertUser('admin', 'admin')
insertUser('manager')

Projects.insert({ id: 'p-creator', name: '创建者项目', createdBy: 'creator', bindPath: path.join(tempRoot, 'creator') })
Projects.insert({ id: 'p-admin', name: '管理员代删项目', createdBy: 'creator', bindPath: path.join(tempRoot, 'admin') })
Projects.insert({ id: 'p-protected', name: '自迭代项目', createdBy: 'creator', bindPath: APP_DIR })
ProjectMemberships.addMany({ projectId: 'p-creator', userIds: ['manager'], role: 'manager', actorId: 'creator' })

const app = express()
app.use(express.json())
app.use('/api/projects', projectsRouter)

;(async () => {
  const { server, base } = await listen(app)
  try {
    const preview = await request(base, 'p-creator', 'creator', 'user', null, 'GET', '/delete-preview')
    assert.strictEqual(preview.status, 200)
    assert.strictEqual(preview.body.policy.mode, 'creator')
    assert.strictEqual(preview.body.policy.requires_password, true)

    const managerDenied = await request(base, 'p-creator', 'manager', 'user', {
      confirm: '创建者项目', irreversible_acknowledged: true, current_password: 'correct-password',
    })
    assert.strictEqual(managerDenied.status, 403)
    assert(Projects.findById('p-creator'))

    const missingPassword = await request(base, 'p-creator', 'creator', 'user', {
      confirm: '创建者项目', irreversible_acknowledged: true,
    })
    assert.strictEqual(missingPassword.status, 422)

    const wrongPassword = await request(base, 'p-creator', 'creator', 'user', {
      confirm: '创建者项目', irreversible_acknowledged: true, current_password: 'wrong-password',
    })
    assert.strictEqual(wrongPassword.status, 422)

    // 错误密码不会注销 JWT: 同一个凭据随后使用正确密码可以完成删除.
    const creatorDeleted = await request(base, 'p-creator', 'creator', 'user', {
      confirm: '创建者项目', irreversible_acknowledged: true, current_password: 'correct-password',
    })
    assert.strictEqual(creatorDeleted.status, 200)
    assert.strictEqual(Projects.findById('p-creator'), undefined)

    const adminPreview = await request(base, 'p-admin', 'admin', 'admin', null, 'GET', '/delete-preview')
    assert.strictEqual(adminPreview.status, 200)
    assert.strictEqual(adminPreview.body.policy.mode, 'system_admin_override')

    const missingReason = await request(base, 'p-admin', 'admin', 'admin', {
      confirm: '管理员代删项目', irreversible_acknowledged: true, current_password: 'correct-password',
    })
    assert.strictEqual(missingReason.status, 400)

    const adminDeleted = await request(base, 'p-admin', 'admin', 'admin', {
      confirm: '管理员代删项目', irreversible_acknowledged: true,
      current_password: 'correct-password', reason: '项目负责人已确认清理该临时项目',
    })
    assert.strictEqual(adminDeleted.status, 200)
    assert.strictEqual(Projects.findById('p-admin'), undefined)

    const protectedDelete = await request(base, 'p-protected', 'admin', 'admin', {
      confirm: '自迭代项目', irreversible_acknowledged: true,
      current_password: 'correct-password', reason: '测试不应删除受保护项目',
    })
    assert.strictEqual(protectedDelete.status, 409)
    assert(Projects.findById('p-protected'))

    const auditRows = db.prepare(`
      SELECT outcome, deletion_mode, failure_code
      FROM project_deletion_audit_log
      WHERE project_id IN ('p-creator', 'p-admin')
      ORDER BY id ASC
    `).all()
    assert(auditRows.some((row) => row.outcome === 'succeeded' && row.deletion_mode === 'creator'))
    assert(auditRows.some((row) => row.outcome === 'succeeded' && row.deletion_mode === 'system_admin_override'))
    assert(auditRows.some((row) => row.outcome === 'denied' && row.failure_code === 'password_invalid'))
    console.log('project-deletion-route: ok')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
