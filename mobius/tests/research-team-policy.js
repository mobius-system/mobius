const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-research-team-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')
process.env.HOME_WORKSPACE_ROOT = path.join(tempRoot, 'home')
process.env.LOCAL_WORKSPACE_ROOT = path.join(tempRoot, 'local')
process.env.JWT_SECRET = 'research-team-test-secret'

const { db } = require('../db')
const team = require('../backend/services/research-team')

function run(sql, ...args) { return db.prepare(sql).run(...args) }

run(`INSERT INTO users (id, display_name, password_hash, role, work_dir, group_id)
     VALUES ('u1', 'u1', 'hash', 'user', ?, 'default')`, path.join(tempRoot, 'workspace', 'u1'))
run(`INSERT INTO projects (id, name, created_by, bind_path, research_enabled, visibility)
     VALUES ('p1', 'p1', 'u1', ?, 1, 'private')`, path.join(tempRoot, 'project'))
run(`INSERT INTO researches (id, project_id, title, description, created_by, mode, assistant_limit)
     VALUES ('r1', 'p1', 'r1', 'r1', 'u1', 'chief_led', 1)`)

assert.strictEqual(team.normalizeAssistantLimit(undefined), 3)
assert.throws(() => team.normalizeAssistantLimit(0), /1-12/)
assert.throws(() => team.normalizeAssistantLimit(13), /1-12/)

const token = team.createChiefTeamToken('r1', 'chief1')
assert.deepStrictEqual(team.verifyChiefTeamToken(token, 'r1'), { researchId: 'r1', chiefSessionId: 'chief1' })
assert.strictEqual(team.verifyChiefTeamToken(token, 'other'), null)

run(`INSERT INTO sessions_v2 (session_id, project_id, scope_type, research_id, research_role, user_id, name, session_key, model)
     VALUES ('chief1', 'p1', 'research', 'r1', 'chief_researcher', 'u1', 'Chief', 'web:u1:chief1', 'gpt-5.5')`)
run(`INSERT INTO sessions_v2 (session_id, project_id, scope_type, research_id, research_role, user_id, name, session_key, model)
     VALUES ('a1', 'p1', 'research', 'r1', 'research_assistant', 'u1', 'A1', 'web:u1:a1', 'gpt-5.5')`)

assert.strictEqual(team.activeAssistantCount('r1'), 1)
assert.throws(() => team.reserveRecruitment({
  researchId: 'r1',
  actorSessionId: 'chief1',
  requestId: 'req-limit',
  payload: { name: 'A2', purpose: 'new', model: 'gpt-5.5', initial_prompt: 'task', skill_ids: [] },
}), /limit/)

const columns = db.prepare('PRAGMA table_info(researches)').all().map(row => row.name)
assert(columns.includes('mode'))
assert(columns.includes('assistant_limit'))
const actionTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='research_team_actions'").get()
assert(actionTable)

console.log('PASS research team policy: schema, limit, chief capability, and reservation guard')

process.on('exit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
})
