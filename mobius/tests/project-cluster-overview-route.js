const assert = require('node:assert/strict')
const express = require('express')
const http = require('http')
const jwt = require('jsonwebtoken')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-cluster-overview-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')
process.env.ENABLE_PASSWORD_LOGIN = 'false'
process.env.JWT_SECRET = 'cluster-overview-route-test-secret'

const { db } = require('../db')
const { JWT_SECRET } = require('../backend/config')
const { Projects } = require('../backend/repositories/projects')
const { Issues } = require('../backend/repositories/issues')
const { Researches } = require('../backend/repositories/researches')
const { Sessions } = require('../backend/repositories/sessions')
const projectsRouter = require('../backend/routes/projects')

function cleanup() {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

async function listen(app) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

db.prepare(`
  INSERT INTO users (id, display_name, password_hash, role, work_dir, group_id)
  VALUES ('admin', 'Admin', 'hash', 'admin', ?, 'default')
`).run(path.join(tempRoot, 'workspace', 'admin'))

Projects.insert({ id: 'p-active', name: 'Active project', createdBy: 'admin', researchEnabled: true })
Projects.insert({ id: 'p-old', name: 'Old project', createdBy: 'admin', researchEnabled: false })
Issues.insert({ id: 'i-active', project_id: 'p-active', title: 'Active issue', description: '', created_by: 'admin', use_worktree: false, worktree_branch: '' })
Issues.insert({ id: 'i-old', project_id: 'p-old', title: 'Old issue', description: '', created_by: 'admin', use_worktree: false, worktree_branch: '' })
Researches.insert({ id: 'r-active', project_id: 'p-active', title: 'Active research', description: '', created_by: 'admin' })

Sessions.insert({
  session_id: 's-issue', issue_id: 'i-active', project_id: 'p-active', scope_type: 'issue',
  user_id: 'admin', name: 'Issue session', session_key: 'web:admin:s-issue',
})
Sessions.insert({
  session_id: 's-research', research_id: 'r-active', project_id: 'p-active', scope_type: 'research',
  research_role: 'chief_researcher', user_id: 'admin', name: 'Research session', session_key: 'web:admin:s-research',
})
Sessions.insert({
  session_id: 's-old', issue_id: 'i-old', project_id: 'p-old', scope_type: 'issue',
  user_id: 'admin', name: 'Old session', session_key: 'web:admin:s-old',
})
db.prepare("UPDATE sessions_v2 SET last_active = datetime('now', '-40 days') WHERE session_id = 's-old'").run()

const app = express()
app.use(express.json())
app.use('/api/projects', projectsRouter)

;(async () => {
  const { server, base } = await listen(app)
  try {
    const token = jwt.sign({ id: 'admin', role: 'admin' }, JWT_SECRET, { expiresIn: '1h' })
    const response = await fetch(`${base}/api/projects/cluster-overview?range=24h`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('cache-control') || '', /no-store/)
    const body = await response.json()

    assert.equal(body.range, '24h')
    assert.deepEqual(body.projects.map((project) => project.id).sort(), ['p-active', 'p-old'])
    assert.deepEqual(Object.keys(body.graphs), ['p-active'])
    assert.deepEqual(body.graphs['p-active'].issues.map((issue) => issue.id), ['i-active'])
    assert.deepEqual(body.graphs['p-active'].researches.map((research) => research.id), ['r-active'])
    assert.deepEqual(body.graphs['p-active'].sessionsByIssue['i-active'].map((session) => session.session_id), ['s-issue'])
    assert.deepEqual(body.graphs['p-active'].sessionsByResearch['r-active'].map((session) => session.session_id), ['s-research'])
    assert.equal('session_selection_snapshot' in body.graphs['p-active'].sessionsByIssue['i-active'][0], false)

    console.log('project cluster overview route: ok')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
