const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-project-session-search-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')
process.env.HOME_WORKSPACE_ROOT = path.join(tempRoot, 'home')
process.env.LOCAL_WORKSPACE_ROOT = path.join(tempRoot, 'local')

const { db } = require('../db')
const { Sessions } = require('../backend/repositories/sessions')
const { searchProjectSessionMetadata } = require('../backend/services/project-session-search')

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
})

function run(sql, ...params) {
  db.prepare(sql).run(...params)
}

function insertUser(id, role = 'user') {
  run(
    'INSERT INTO users (id, display_name, password_hash, role, work_dir) VALUES (?, ?, ?, ?, ?)',
    id,
    id,
    'hash',
    role,
    path.join(tempRoot, 'workspace', id),
  )
}

function insertSession({ id, projectId = 'p-main', issueId = 'i-main', researchId = null, userId = 'member', name, description }) {
  Sessions.insert({
    session_id: id,
    issue_id: researchId ? null : issueId,
    project_id: projectId,
    scope_type: researchId ? 'research' : 'issue',
    research_id: researchId,
    research_role: researchId ? 'research_assistant' : null,
    user_id: userId,
    name,
    description,
    session_key: `web:${userId}:${id}`,
    model: 'gpt-5.5',
    language: 'zh',
  })
}

function setupFixtures() {
  insertUser('owner')
  insertUser('member')
  insertUser('other')
  run("INSERT INTO projects (id, name, description, created_by, visibility, research_enabled) VALUES ('p-main', 'Main', '', 'owner', 'public', 1)")
  run("INSERT INTO projects (id, name, description, created_by, visibility) VALUES ('p-other', 'Other', '', 'owner', 'public')")
  run("INSERT INTO project_memberships (project_id, user_id, role, created_by) VALUES ('p-main', 'member', 'member', 'owner')")
  run("INSERT INTO project_memberships (project_id, user_id, role, created_by) VALUES ('p-main', 'other', 'member', 'owner')")
  run("INSERT INTO project_memberships (project_id, user_id, role, created_by) VALUES ('p-other', 'member', 'member', 'owner')")
  run("INSERT INTO issues (id, project_id, title, description, created_by) VALUES ('i-main', 'p-main', 'Interface', '', 'owner')")
  run("INSERT INTO issues (id, project_id, title, description, created_by) VALUES ('i-other', 'p-other', 'Other', '', 'owner')")
  run("INSERT INTO researches (id, project_id, title, description, created_by) VALUES ('r-main', 'p-main', 'Research', '', 'owner')")

  insertSession({ id: 's-name', userId: 'member', name: 'Nested Search Keyword', description: 'ordinary' })
  insertSession({ id: 's-description', userId: 'member', name: 'Interface Session', description: '搜索优化' })
  insertSession({ id: 's-other-user', userId: 'other', name: 'Nested Search Keyword', description: 'private to another user' })
  insertSession({ id: 's-research', userId: 'member', researchId: 'r-main', name: 'Research Agent', description: '搜索优化' })
  insertSession({ id: 's-percent', userId: 'member', name: 'Budget 100%', description: 'literal wildcard test' })
  insertSession({ id: 's-archived', userId: 'member', name: 'Nested Search Keyword archived', description: '' })
  Sessions.archive('s-archived')
  insertSession({ id: 's-other-project', projectId: 'p-other', issueId: 'i-other', userId: 'member', name: 'Nested Search Keyword elsewhere', description: '' })
}

function ids(map) {
  return Object.values(map).flat().map((session) => session.session_id).sort()
}

function main() {
  setupFixtures()

  const memberResult = searchProjectSessionMetadata('p-main', 'search keyword', { id: 'member', role: 'user' })
  assert.deepStrictEqual(ids(memberResult.issues), ['s-name'])
  assert.strictEqual(memberResult.total, 1)
  assert.strictEqual(memberResult.truncated, false)
  const memberMatch = memberResult.issues['i-main'][0]
  for (const forbidden of ['session_key', 'claude_session_id', 'model', 'context_snapshot_body', 'session_selection_snapshot']) {
    assert.ok(!(forbidden in memberMatch), `search result should not expose ${forbidden}`)
  }

  const descriptionResult = searchProjectSessionMetadata('p-main', '搜索优化', { id: 'member', role: 'user' })
  assert.deepStrictEqual(ids(descriptionResult.issues), ['s-description'])
  assert.deepStrictEqual(ids(descriptionResult.researches), ['s-research'])

  const ownerResult = searchProjectSessionMetadata('p-main', 'NESTED SEARCH KEYWORD', { id: 'owner', role: 'user' })
  assert.deepStrictEqual(ids(ownerResult.issues), ['s-name', 's-other-user'])

  const literalResult = searchProjectSessionMetadata('p-main', '%', { id: 'member', role: 'user' })
  assert.deepStrictEqual(ids(literalResult.issues), ['s-percent'])

  const blankResult = searchProjectSessionMetadata('p-main', '   ', { id: 'member', role: 'user' })
  assert.deepStrictEqual(blankResult, { query: '', issues: {}, researches: {}, total: 0, truncated: false })

  console.log('project-session-search: ok')
}

main()
