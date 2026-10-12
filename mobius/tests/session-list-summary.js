const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-session-list-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')

const { db } = require('../db')
const { Sessions } = require('../backend/repositories/sessions')

function insertFixtures() {
  db.prepare(`
    INSERT INTO users (id, display_name, password_hash, role, work_dir)
    VALUES (?, ?, ?, ?, ?)
  `).run('u-test', 'Test User', 'hash', 'admin', path.join(tempRoot, 'workspace', 'u-test'))

  db.prepare(`
    INSERT INTO projects (id, name, description, created_by)
    VALUES (?, ?, ?, ?)
  `).run('p-test', 'Test Project', 'project fixture', 'u-test')

  db.prepare(`
    INSERT INTO issues (id, project_id, title, description, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run('i-test', 'p-test', 'Test Issue', 'issue fixture', 'u-test')

  db.prepare(`
    INSERT INTO researches (id, project_id, title, description, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run('r-test', 'p-test', 'Test Research', 'research fixture', 'u-test')

  Sessions.insert({
    session_id: 's-issue',
    issue_id: 'i-test',
    project_id: 'p-test',
    user_id: 'u-test',
    name: 'Issue Session',
    description: 'issue session fixture',
    session_key: 'web:u-test:s-issue',
    model: 'gpt-5.5',
    language: 'zh',
  })

  Sessions.insert({
    session_id: 's-research',
    issue_id: null,
    project_id: 'p-test',
    scope_type: 'research',
    research_id: 'r-test',
    research_role: 'chief_researcher',
    user_id: 'u-test',
    name: 'Research Session',
    description: 'research session fixture',
    session_key: 'web:u-test:s-research',
    model: 'gpt-5.5',
    language: 'zh',
  })

  const largeBody = 'x'.repeat(1024 * 1024)
  const largeSources = 'y'.repeat(1024 * 1024)
  const largeSelection = 'z'.repeat(1024 * 1024)
  const largeSkills = JSON.stringify(Array.from({ length: 5000 }, (_, i) => `skill-${i}`))
  const largeMemories = JSON.stringify(Array.from({ length: 5000 }, (_, i) => `memory-${i}`))

  db.prepare(`
    UPDATE sessions_v2
    SET context_snapshot_body = ?,
        context_snapshot_sources = ?,
        session_selection_snapshot = ?,
        session_excluded_skills = ?,
        session_excluded_memories = ?
    WHERE session_id IN ('s-issue', 's-research')
  `).run(largeBody, largeSources, largeSelection, largeSkills, largeMemories)

  db.prepare('INSERT INTO messages_v2 (task_id, role, content) VALUES (?, ?, ?)')
    .run('s-issue', 'user', 'hello')
  db.prepare('INSERT INTO messages_v2 (task_id, role, content) VALUES (?, ?, ?)')
    .run('s-research', 'user', 'hello')
}

function assertSummary(list, label) {
  assert.strictEqual(list.length, 1, `${label} should return exactly one row`)
  const row = list[0]
  const forbidden = [
    'context_snapshot_body',
    'context_snapshot_sources',
    'context_snapshot_at',
    'session_selection_snapshot',
    'session_selection_snapshot_at',
    'session_excluded_skills',
    'session_excluded_memories',
  ]
  for (const key of forbidden) {
    assert.ok(!(key in row), `${label} should not expose ${key}`)
  }
  assert.strictEqual(row.user_display_name, 'Test User')
  assert.strictEqual(row.raw_entry_count, 1)
}

function main() {
  insertFixtures()

  const issueList = Sessions.listForIssue('i-test')
  const researchList = Sessions.listForResearch('r-test')
  const fullIssue = db.prepare('SELECT * FROM sessions_v2 WHERE session_id = ?').all('s-issue')
  const fullResearch = db.prepare('SELECT * FROM sessions_v2 WHERE session_id = ?').all('s-research')

  assertSummary(issueList, 'issue list')
  assertSummary(researchList, 'research list')

  const issueListSize = Buffer.byteLength(JSON.stringify(issueList))
  const researchListSize = Buffer.byteLength(JSON.stringify(researchList))
  const fullSize = Buffer.byteLength(JSON.stringify([...fullIssue, ...fullResearch]))

  assert.ok(issueListSize < 10000, `issue list payload too large: ${issueListSize}`)
  assert.ok(researchListSize < 10000, `research list payload too large: ${researchListSize}`)
  assert.ok(fullSize > issueListSize + researchListSize + 2 * 1024 * 1024, 'full rows should be much larger than summary rows')

  console.log('session-list-summary: ok')
}

main()
