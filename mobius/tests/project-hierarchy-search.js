const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-project-hierarchy-search-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')
process.env.HOME_WORKSPACE_ROOT = path.join(tempRoot, 'home')
process.env.LOCAL_WORKSPACE_ROOT = path.join(tempRoot, 'local')

const { db } = require('../db')
const { Sessions } = require('../backend/repositories/sessions')
const { UserProjectView } = require('../backend/services/user-project-view')
const { searchProjectHierarchy } = require('../backend/services/project-hierarchy-search')

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
})

function run(sql, ...params) { db.prepare(sql).run(...params) }

function insertUser(id) {
  run('INSERT INTO users (id, display_name, password_hash, role, work_dir) VALUES (?, ?, ?, ?, ?)', id, id, 'hash', 'user', path.join(tempRoot, 'workspace', id))
}

function insertSession({ id, userId = 'member', issueId = 'i-main', researchId = null, name, description }) {
  Sessions.insert({
    session_id: id,
    issue_id: researchId ? null : issueId,
    project_id: 'p-main',
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
  run("INSERT INTO projects (id, name, description, created_by, bind_path, research_enabled) VALUES ('p-main', 'Navigation Workbench', 'project metadata', 'owner', '/work/navigation', 1)")
  run("INSERT INTO projects (id, name, description, created_by) VALUES ('p-private', 'Private Keyword', '', 'other')")
  run("INSERT INTO project_memberships (project_id, user_id, role, created_by) VALUES ('p-main', 'member', 'member', 'owner')")
  run("INSERT INTO project_memberships (project_id, user_id, role, created_by) VALUES ('p-main', 'other', 'member', 'owner')")
  run("INSERT INTO issues (id, project_id, title, description, created_by) VALUES ('i-main', 'p-main', 'Interface Analysis', '层级检索任务', 'owner')")
  run("INSERT INTO researches (id, project_id, title, description, created_by) VALUES ('r-main', 'p-main', 'Search Research', '研究导航', 'owner')")
  insertSession({ id: 's-own', name: 'Nested Session', description: '搜索优化' })
  insertSession({ id: 's-other', userId: 'other', name: 'Other Nested Session', description: '搜索优化' })
  insertSession({ id: 's-agent', researchId: 'r-main', name: 'Research Agent', description: 'Agent 关键词' })
  insertSession({ id: 's-archived', name: 'Archived Match', description: '搜索优化' })
  Sessions.archive('s-archived')
}

function findProject(result, id = 'p-main') {
  return result.projects.find((group) => group.project.id === id)
}

function main() {
  setupFixtures()
  const member = { id: 'member', role: 'user' }
  const owner = { id: 'owner', role: 'user' }

  const projectResult = searchProjectHierarchy('navigation', member)
  assert.strictEqual(projectResult.project_count, 1)
  assert.strictEqual(findProject(projectResult).project_match, true)
  assert.ok(findProject(projectResult).project_matched_fields.includes('name'))

  const issueResult = searchProjectHierarchy('层级检索', member)
  assert.deepStrictEqual(findProject(issueResult).matches.map((hit) => hit.kind), ['issue'])
  assert.strictEqual(findProject(issueResult).matches[0].id, 'i-main')

  const sessionResult = searchProjectHierarchy('搜索优化', member)
  const memberHits = findProject(sessionResult).matches
  assert.deepStrictEqual(memberHits.map((hit) => hit.id), ['s-own'])
  assert.strictEqual(memberHits[0].parent_id, 'i-main')
  assert.strictEqual(memberHits[0].parent_title, 'Interface Analysis')
  assert.ok(!('session_key' in memberHits[0]))

  const ownerResult = searchProjectHierarchy('搜索优化', owner)
  assert.deepStrictEqual(findProject(ownerResult).matches.map((hit) => hit.id).sort(), ['s-other', 's-own'])

  const agentResult = searchProjectHierarchy('Agent 关键词', member)
  assert.strictEqual(findProject(agentResult).matches[0].kind, 'research_agent')
  assert.strictEqual(findProject(agentResult).matches[0].parent_id, 'r-main')

  const privateResult = searchProjectHierarchy('Private Keyword', member)
  assert.strictEqual(privateResult.project_count, 0)

  UserProjectView.mute('member', 'p-main')
  const mutedResult = searchProjectHierarchy('搜索优化', member)
  assert.strictEqual(findProject(mutedResult).project.id, 'p-main', 'muted projects remain searchable')

  console.log('project-hierarchy-search: ok')
}

main()
