// Codex session titles: new Codex titles its own threads into state_5.sqlite → threads.name,
// so getSessionTitle must read that; older state dbs (no `name` column) and older rollouts must
// keep falling back to the base jsonl scan instead of throwing.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-codex-session-title-'))
const codexHome = path.join(tempRoot, 'codex')
fs.mkdirSync(codexHome, { recursive: true })
process.env.CODEX_HOME = codexHome
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.on('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }))

const Database = require('better-sqlite3')
const {
  TmuxCodexBackend,
  codexThreadTitleById,
  codexThreadIdFromRolloutPath,
} = require('../backend/agents/tmux-codex')

const THREAD_ID = '01a0bfaf-9c98-7171-9fa7-fd770723c932'
const TITLE = '梳理项目上下文'

// rollout-<ts>-<threadId>.jsonl → threadId, for a rollout bound before agentSessionId was recorded.
assert.strictEqual(
  codexThreadIdFromRolloutPath(`/home/u/.codex/sessions/2026/09/20/rollout-2026-09-20T16-39-12-${THREAD_ID}.jsonl`),
  THREAD_ID,
)
assert.strictEqual(codexThreadIdFromRolloutPath(null), null)
assert.strictEqual(codexThreadIdFromRolloutPath('/tmp/rollout-2026-09-20T16-39-12.jsonl'), null)

// A legacy Codex state db: threads exists but carries no `name` column at all.
const dbFile = path.join(codexHome, 'state_5.sqlite')
let db = new Database(dbFile)
db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)')
db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run(THREAD_ID, 'first user message')
db.close()

assert.strictEqual(codexThreadTitleById(THREAD_ID), null, 'a state db without a name column must miss, not throw')

// The session resolves its codex thread from the archive, and the legacy db yields no title
// (the base jsonl scan then runs and finds nothing: no rollout is bound here).
fs.writeFileSync(path.join(tempRoot, 'codex-hub-archive.json'), JSON.stringify({
  legacy: { agentSessionId: THREAD_ID, jsonlPath: null },
  unknown: { agentSessionId: null, jsonlPath: null },
}))
const backend = new TmuxCodexBackend()
assert.strictEqual(backend.getSessionTitle('legacy'), null, 'legacy codex keeps the base jsonl fallback')
assert.strictEqual(backend.getSessionTitle('unknown'), null)

// Current Codex: the same db gains the name column, and the generated title is what we report.
db = new Database(dbFile)
db.exec('ALTER TABLE threads ADD COLUMN name TEXT')
db.prepare('UPDATE threads SET name = ? WHERE id = ?').run(TITLE, THREAD_ID)
db.prepare('INSERT INTO threads (id, name) VALUES (?, ?)').run('01a0bfeb-a412-7d90-af0b-f38a604c9217', '  ')
db.close()

assert.strictEqual(codexThreadTitleById(THREAD_ID), TITLE)
assert.strictEqual(codexThreadTitleById('01a0bfeb-a412-7d90-af0b-f38a604c9217'), null, 'blank titles count as untitled')
assert.strictEqual(codexThreadTitleById('01a00000-0000-0000-0000-000000000000'), null, 'unknown thread')
assert.strictEqual(codexThreadTitleById(null), null)

// A stale in-process runtime still wins over the archive, as everywhere else in the backend.
backend.runtime.set('live', { agentSessionId: THREAD_ID })
assert.strictEqual(backend.getSessionTitle('live'), TITLE)

fs.writeFileSync(path.join(tempRoot, 'codex-hub-archive.json'), JSON.stringify({
  archived: { agentSessionId: THREAD_ID, jsonlPath: null },
}))
assert.strictEqual(backend.getSessionTitle('archived'), TITLE, 'a closed window still resolves its title')

console.log('codex-session-title: ok')
