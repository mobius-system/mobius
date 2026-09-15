const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-assistant-flag-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')
process.env.HOME_WORKSPACE_ROOT = path.join(tempRoot, 'home')
process.env.LOCAL_WORKSPACE_ROOT = path.join(tempRoot, 'local')

const { db } = require('../db')
const { Sessions } = require('../backend/repositories/sessions')
const { buildSessionContext } = require('../backend/services/session-context')
const { safeWriteRunningFlag, readRunningFlag } = require('../backend/utils/session-flags')
const { scanOnce, LOG_FILE } = require('../backend/services/forgotten-flag-scanner')

function cleanup() {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  } catch {}
}

process.on('exit', cleanup)

function run(sql, ...args) {
  db.prepare(sql).run(...args)
}

function insertFixtures(repoRoot) {
  run(
    `INSERT INTO users (id, display_name, password_hash, role, work_dir)
     VALUES (?, ?, 'hash', 'admin', ?)`,
    'u-test',
    'Test User',
    path.join(tempRoot, 'workspace', 'u-test'),
  )

  run(
    `INSERT INTO projects (id, name, description, created_by, bind_path, bind_path_manual)
     VALUES (?, ?, ?, ?, ?, 1)`,
    'p-test',
    'Test Project',
    'project fixture',
    'u-test',
    repoRoot,
  )

  run(
    `INSERT INTO issues (id, project_id, title, description, created_by, use_worktree, worktree_branch)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    'i-normal',
    'p-test',
    'Normal Issue',
    'normal fixture',
    'u-test',
    'normal-branch',
  )

  run(
    `INSERT INTO issues (id, project_id, title, description, created_by, use_worktree, worktree_branch)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
    'i-assistant',
    'p-test',
    '小莫对话',
    'assistant fixture',
    'u-test',
    'assistant-branch',
  )

  Sessions.insert({
    session_id: 's-normal',
    issue_id: 'i-normal',
    project_id: 'p-test',
    user_id: 'u-test',
    name: 'Normal Session',
    description: 'normal session fixture',
    session_key: 'web:u-test:s-normal',
    model: 'gpt-5.5',
    language: 'zh',
  })

  Sessions.insert({
    session_id: 's-assist',
    issue_id: 'i-assistant',
    project_id: 'p-test',
    user_id: 'u-test',
    name: 'Assistant Session',
    description: 'assistant session fixture',
    session_key: 'assistant-question:u-test:s-assist',
    model: 'gpt-5.5',
    language: 'zh',
  })
}

function initGitRepo(repoRoot) {
  fs.mkdirSync(repoRoot, { recursive: true })
  const result = spawnSync('git', ['init'], { cwd: repoRoot, encoding: 'utf8' })
  assert.strictEqual(result.status, 0, result.stderr || result.stdout)
}

function assertContext() {
  const user = { id: 'u-test', display_name: 'Test User', role: 'admin' }
  const normal = buildSessionContext(user, 's-normal').body
  const assistant = buildSessionContext(user, 's-assist').body

  assert.match(normal, /declare_job_done s-normal/, 'normal session should include the completion command')
  assert.doesNotMatch(normal, /flags\/s-normal\/running\.flag/, 'normal session should not expose the flag path')
  assert.doesNotMatch(assistant, /declare_job_done/, 'assistant session context must not mention the completion command')
  assert.doesNotMatch(assistant, /running\.flag/, 'assistant session context must not mention running.flag')
  assert.doesNotMatch(assistant, /标记文件|marker file/, 'assistant session context must not ask for marker cleanup')
  assert.match(assistant, /小莫对话/, 'assistant context should still include the issue context')
}

async function assertScannerExemption(repoRoot) {
  safeWriteRunningFlag(repoRoot, 's-normal', { backend: 'test' }, 'assistant-running-flag-test')
  safeWriteRunningFlag(repoRoot, 's-assist', { backend: 'test' }, 'assistant-running-flag-test')

  await scanOnce()

  const log = fs.readFileSync(LOG_FILE, 'utf8')
  assert.match(log, /forgotten=1/, 'only the normal session should be counted as forgotten')
  assert.match(log, /assistant_exempt=1/, 'assistant session with running.flag should be counted as exempt')
  assert.match(log, /session_id\s+: s-normal/, 'normal session should be logged as forgotten')
  assert.doesNotMatch(log, /session_id\s+: s-assist/, 'assistant session should not be logged as forgotten')
}

function assertRunningFlagInstanceStable(repoRoot) {
  safeWriteRunningFlag(repoRoot, 's-normal', { backend: 'first' }, 'assistant-running-flag-test')
  const first = readRunningFlag(repoRoot, 's-normal')
  assert.ok(first?.runId, 'running.flag should include stable runId')
  assert.ok(first?.startedAt, 'running.flag should include stable startedAt')

  safeWriteRunningFlag(repoRoot, 's-normal', { backend: 'second' }, 'assistant-running-flag-test')
  const second = readRunningFlag(repoRoot, 's-normal')
  assert.strictEqual(second.runId, first.runId, 're-writing running.flag must keep same runId')
  assert.strictEqual(second.startedAt, first.startedAt, 're-writing running.flag must keep same startedAt')
  assert.strictEqual(second.backend, 'second', 'latest metadata should still be refreshed')
}

async function main() {
  const repoRoot = path.join(tempRoot, 'repo')
  initGitRepo(repoRoot)
  insertFixtures(repoRoot)
  assertContext()
  assertRunningFlagInstanceStable(repoRoot)
  await assertScannerExemption(repoRoot)
  console.log('assistant-running-flag: ok')
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
