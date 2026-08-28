const assert = require('assert')
const { spawnSync } = require('child_process')
const express = require('express')
const fs = require('fs')
const http = require('http')
const jwt = require('jsonwebtoken')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-project-git-history-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')
process.env.HOME_WORKSPACE_ROOT = path.join(tempRoot, 'home')
process.env.LOCAL_WORKSPACE_ROOT = path.join(tempRoot, 'local')
process.env.ENABLE_PASSWORD_LOGIN = 'false'
process.env.JWT_SECRET = 'project-git-history-test-secret'

const { db } = require('../db')
const { JWT_SECRET } = require('../backend/config')
const { Projects } = require('../backend/repositories/projects')
const projectsRouter = require('../backend/routes/projects')

function cleanup() {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

function runGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  assert.strictEqual(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}

function initRepo(repoPath) {
  fs.mkdirSync(repoPath, { recursive: true })
  runGit(repoPath, ['init'])
  runGit(repoPath, ['config', 'user.email', 'history@example.com'])
  runGit(repoPath, ['config', 'user.name', 'History Test'])
}

function commitFile(repoPath, relativePath, content, subject) {
  const absolutePath = path.join(repoPath, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, content)
  runGit(repoPath, ['add', '--', relativePath])
  runGit(repoPath, ['commit', '-m', subject])
  return runGit(repoPath, ['rev-parse', 'HEAD']).trim()
}

function insertUser(id) {
  db.prepare(
    `INSERT INTO users (id, display_name, password_hash, role, work_dir, group_id)
     VALUES (?, ?, '', 'user', ?, 'default')`,
  ).run(id, id, path.join(tempRoot, 'workspace', id))
}

function tokenFor(id) {
  return jwt.sign({ id, role: 'user' }, JWT_SECRET, { expiresIn: '1h' })
}

async function listen(app) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

async function request(base, projectId, actorId, suffix) {
  const response = await fetch(`${base}/api/projects/${projectId}${suffix}`, {
    headers: { authorization: `Bearer ${tokenFor(actorId)}` },
  })
  return { status: response.status, body: await response.json() }
}

insertUser('owner')
insertUser('outsider')

const repoPath = path.join(tempRoot, 'history-repo')
initRepo(repoPath)
const initialSha = commitFile(repoPath, 'old-name.txt', 'before rename\n', 'initial file')
runGit(repoPath, ['mv', 'old-name.txt', 'new-name.txt'])
runGit(repoPath, ['commit', '-m', 'rename tracked file'])
const renameSha = runGit(repoPath, ['rev-parse', 'HEAD']).trim()
const updateSha = commitFile(repoPath, 'new-name.txt', 'after rename\n', 'update renamed file')
for (let index = 1; index <= 32; index += 1) {
  commitFile(repoPath, 'counter.txt', `${index}\n`, `counter ${index}`)
}

const emptyRepoPath = path.join(tempRoot, 'empty-repo')
initRepo(emptyRepoPath)

const nestedRoot = path.join(tempRoot, 'nested-project')
const nestedRepoPath = path.join(nestedRoot, 'repo')
initRepo(nestedRepoPath)
commitFile(nestedRepoPath, 'inside.txt', 'inside\n', 'nested initial')
fs.writeFileSync(path.join(nestedRoot, 'outside.txt'), 'outside repo\n')

Projects.insert({ id: 'history', name: 'History', createdBy: 'owner', bindPath: repoPath })
Projects.insert({ id: 'empty', name: 'Empty', createdBy: 'owner', bindPath: emptyRepoPath })
Projects.insert({ id: 'nested', name: 'Nested', createdBy: 'owner', bindPath: nestedRoot })

const app = express()
app.use(express.json())
app.use('/api/projects', projectsRouter)

;(async () => {
  const { server, base } = await listen(app)
  const repoStatusBefore = runGit(repoPath, ['status', '--porcelain=v1'])
  const repoHeadBefore = runGit(repoPath, ['rev-parse', 'HEAD']).trim()
  const nestedStatusBefore = runGit(nestedRepoPath, ['status', '--porcelain=v1'])
  const nestedHeadBefore = runGit(nestedRepoPath, ['rev-parse', 'HEAD']).trim()
  try {
    const firstPage = await request(base, 'history', 'owner', '/git-history?limit=2')
    assert.strictEqual(firstPage.status, 200)
    assert.strictEqual(firstPage.body.source, 'git')
    assert.strictEqual(firstPage.body.limit, 2)
    assert.strictEqual(firstPage.body.commits.length, 2)
    assert.strictEqual(firstPage.body.commits[0].subject, 'counter 32')
    assert.deepStrictEqual(Object.keys(firstPage.body.commits[0]).sort(), [
      'author_email', 'author_name', 'date', 'hash', 'refs', 'relative_date', 'short_hash', 'subject',
    ])
    assert.strictEqual(firstPage.body.has_more, true)
    assert.match(firstPage.body.next_cursor, /^[0-9a-f]{40}$/)

    const secondPage = await request(
      base,
      'history',
      'owner',
      `/git-history?limit=2&cursor=${firstPage.body.next_cursor}`,
    )
    assert.strictEqual(secondPage.status, 200)
    assert.strictEqual(secondPage.body.commits.length, 2)
    assert.notStrictEqual(secondPage.body.commits[0].hash, firstPage.body.commits[1].hash)
    assert.strictEqual(secondPage.body.commits[0].subject, 'counter 30')

    const missingCursor = await request(base, 'history', 'owner', '/git-history?cursor=deadbee')
    assert.strictEqual(missingCursor.status, 404)

    const capped = await request(base, 'history', 'owner', '/git-history?limit=999')
    assert.strictEqual(capped.status, 200)
    assert.strictEqual(capped.body.limit, 30)
    assert.strictEqual(capped.body.commits.length, 30)
    assert.strictEqual(capped.body.has_more, true)

    const fileHistory = await request(base, 'history', 'owner', '/git-history?file=new-name.txt&limit=30')
    assert.strictEqual(fileHistory.status, 200, JSON.stringify(fileHistory.body))
    assert.strictEqual(fileHistory.body.file, 'new-name.txt')
    assert.deepStrictEqual(
      fileHistory.body.commits.map((commit) => commit.subject),
      ['update renamed file', 'rename tracked file', 'initial file'],
    )
    assert.strictEqual(fileHistory.body.commits[2].hash, initialSha)

    const literalPath = await request(base, 'history', 'owner', '/git-history?file=%2A&limit=30')
    assert.strictEqual(literalPath.status, 200)
    assert.deepStrictEqual(literalPath.body.commits, [])

    const fullDiff = await request(base, 'history', 'owner', `/git-history/${renameSha}/diff`)
    assert.strictEqual(fullDiff.status, 200)
    assert.strictEqual(fullDiff.body.sha, renameSha)
    assert.strictEqual(fullDiff.body.file, null)
    assert.match(fullDiff.body.diff, /rename from old-name\.txt/)
    assert.match(fullDiff.body.diff, /rename to new-name\.txt/)

    const fileDiff = await request(
      base,
      'history',
      'owner',
      `/git-history/${updateSha.slice(0, 7)}/diff?file=new-name.txt`,
    )
    assert.strictEqual(fileDiff.status, 200)
    assert.strictEqual(fileDiff.body.sha, updateSha)
    assert.strictEqual(fileDiff.body.file, 'new-name.txt')
    assert.match(fileDiff.body.diff, /\+after rename/)

    const emptyHistory = await request(base, 'empty', 'owner', '/git-history')
    assert.strictEqual(emptyHistory.status, 200)
    assert.deepStrictEqual(emptyHistory.body.commits, [])
    assert.strictEqual(emptyHistory.body.has_more, false)
    assert.strictEqual(emptyHistory.body.next_cursor, null)

    const badSha = await request(base, 'history', 'owner', '/git-history/not-a-sha/diff')
    assert.strictEqual(badSha.status, 400)
    assert.match(badSha.body.error, /7-40/)

    const missingSha = await request(base, 'history', 'owner', '/git-history/deadbee/diff')
    assert.strictEqual(missingSha.status, 404)

    const traversal = await request(base, 'history', 'owner', '/git-history?file=..%2Foutside.txt')
    assert.strictEqual(traversal.status, 400)
    assert.match(traversal.body.error, /路径穿越/)

    const outsideRepo = await request(base, 'nested', 'owner', '/git-history?file=outside.txt')
    assert.strictEqual(outsideRepo.status, 400)
    assert.match(outsideRepo.body.error, /Git 仓库内/)

    const hiddenProject = await request(base, 'history', 'outsider', '/git-history')
    assert.strictEqual(hiddenProject.status, 404)

    assert.strictEqual(runGit(repoPath, ['status', '--porcelain=v1']), repoStatusBefore)
    assert.strictEqual(runGit(repoPath, ['rev-parse', 'HEAD']).trim(), repoHeadBefore)
    assert.strictEqual(runGit(nestedRepoPath, ['status', '--porcelain=v1']), nestedStatusBefore)
    assert.strictEqual(runGit(nestedRepoPath, ['rev-parse', 'HEAD']).trim(), nestedHeadBefore)
    assert.strictEqual(runGit(emptyRepoPath, ['status', '--porcelain=v1']), '')
    console.log('project-git-history: ok')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
