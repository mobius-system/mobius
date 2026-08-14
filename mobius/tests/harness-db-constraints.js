const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-db-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot

const { db } = require('../db')

function insertBase(id) {
  db.prepare(`INSERT INTO users (id, display_name, password_hash, role, work_dir) VALUES (?, ?, '', 'admin', ?)`)
    .run(`user_${id}`, `User ${id}`, tempRoot)
  db.prepare(`INSERT INTO projects (id, name, created_by, bind_path) VALUES (?, ?, ?, ?)`)
    .run(`project_${id}`, `Project ${id}`, `user_${id}`, tempRoot)
  db.prepare(`INSERT INTO issues (id, project_id, title, created_by) VALUES (?, ?, ?, ?)`)
    .run(`issue_${id}`, `project_${id}`, `Issue ${id}`, `user_${id}`)
  db.prepare(`INSERT INTO harness_runs
    (id, owner_user_id, project_id, anchor_type, issue_id, goal, execution_mode, policy_json)
    VALUES (?, ?, ?, 'issue', ?, 'test', 'multi', '{}')`)
    .run(`run_${id}`, `user_${id}`, `project_${id}`, `issue_${id}`)
}

function insertMember(runId, id, role = 'worker', profileId = null) {
  db.prepare(`INSERT INTO harness_run_members
    (id, run_id, profile_id, role, display_name, config_snapshot_json)
    VALUES (?, ?, ?, ?, ?, '{}')`).run(id, runId, profileId, role, id)
}

function insertNode({ id, runId, memberId, pathValue, type = 'worker', status = 'created' }) {
  db.prepare(`INSERT INTO harness_nodes
    (id, run_id, assignee_member_id, path, node_type, status, task_contract_json,
     context_policy_json, tool_policy_json, workspace_mode)
    VALUES (?, ?, ?, ?, ?, ?, '{}', '{}', '{}', 'read_only')`)
    .run(id, runId, memberId, pathValue, type, status)
}

try {
  assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 1)
  assert.equal(Number(db.pragma('busy_timeout', { simple: true })), 5000)

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'harness_%'").all().map((row) => row.name)
  assert.equal(tables.length, 11)

  db.prepare(`INSERT INTO harness_profiles
    (id, scope, name, backend, default_model, definition_json)
    VALUES ('profile_deepseek', 'system', 'DeepSeek', 'deepseek-harness', 'deepseek', '{}')`).run()

  insertBase('a')
  insertBase('b')
  insertMember('run_a', 'main_a', 'main')
  assert.throws(() => insertMember('run_a', 'main_a_2', 'main'), /UNIQUE constraint failed/)

  insertMember('run_a', 'worker_a')
  insertMember('run_b', 'worker_b')
  insertNode({ id: 'worker_b_node', runId: 'run_b', memberId: 'worker_b', pathValue: 'worker-b' })
  insertNode({ id: 'root_a', runId: 'run_a', memberId: 'main_a', pathValue: 'root', type: 'root' })
  assert.throws(
    () => insertNode({ id: 'root_a_2', runId: 'run_a', memberId: 'worker_a', pathValue: 'root-2', type: 'root' }),
    /UNIQUE constraint failed/,
  )

  const insertEvent = db.prepare(`INSERT INTO harness_events
    (seq, event_id, run_id, from_node_id, type, request_id, payload_json)
    VALUES (?, ?, ?, ?, 'test.event', ?, '{}')`)
  insertEvent.run(1, 'event_a_1', 'run_a', 'root_a', 'event_req_a_1')
  insertEvent.run(1, 'event_b_1', 'run_b', 'worker_b_node', 'event_req_b_1')
  assert.throws(() => insertEvent.run(2, 'event_a_duplicate_request', 'run_a', 'root_a', 'event_req_a_1'), /UNIQUE constraint failed/)
  assert.throws(() => insertEvent.run(1, 'event_a_duplicate_seq', 'run_a', 'root_a', 'event_req_a_2'), /UNIQUE constraint failed/)
  assert.throws(() => insertEvent.run(2, 'event_cross_node', 'run_a', 'worker_b_node', 'event_req_a_3'), /FOREIGN KEY constraint failed/)
  assert.throws(
    () => db.prepare(`INSERT INTO harness_dependencies (run_id, node_id, depends_on_node_id) VALUES ('run_a', 'root_a', 'worker_b_node')`).run(),
    /FOREIGN KEY constraint failed/,
  )

  assert.throws(
    () => db.prepare(`INSERT INTO harness_artifacts
      (id, run_id, node_id, kind, name, storage_uri, sha256)
      VALUES ('artifact_cross', 'run_a', 'worker_b_node', 'report', 'x', 'memory:x', 'abc')`).run(),
    /FOREIGN KEY constraint failed/,
  )

  assert.throws(
    () => db.prepare("UPDATE harness_nodes SET waived_at='2026-01-01T00:00:00Z', waiver_reason='approved' WHERE id='root_a'").run(),
    /CHECK constraint failed/,
  )
  db.prepare(`UPDATE harness_nodes
    SET waived_at='2026-01-01T00:00:00Z', waived_by_user_id='user_a', waiver_reason='approved exception'
    WHERE id='root_a'`).run()
  assert.throws(
    () => insertNode({ id: 'cross_run', runId: 'run_a', memberId: 'worker_b', pathValue: 'cross' }),
    /FOREIGN KEY constraint failed/,
  )

  insertNode({ id: 'active_a', runId: 'run_a', memberId: 'worker_a', pathValue: 'worker-1', status: 'queued' })
  insertNode({ id: 'prebuilt_a', runId: 'run_a', memberId: 'worker_a', pathValue: 'worker-2', status: 'created' })
  assert.throws(
    () => db.prepare("UPDATE harness_nodes SET status='queued' WHERE id='prebuilt_a'").run(),
    /UNIQUE constraint failed/,
  )
  db.prepare("UPDATE harness_nodes SET status='succeeded' WHERE id='active_a'").run()
  db.prepare("UPDATE harness_nodes SET status='queued' WHERE id='prebuilt_a'").run()

  db.pragma('foreign_keys = OFF')
  insertNode({ id: 'fk_disabled', runId: 'run_a', memberId: 'missing_member', pathValue: 'fk-disabled' })
  assert.ok(db.prepare("SELECT id FROM harness_nodes WHERE id='fk_disabled'").get())
  db.prepare("DELETE FROM harness_nodes WHERE id='fk_disabled'").run()
  db.pragma('foreign_keys = ON')
  assert.equal(Number(db.pragma('foreign_keys', { simple: true })), 1)

  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8')
  const start = schemaSql.indexOf('-- ===== Harness core schema (Phase 0) =====')
  const endMarker = '-- ===== End Harness core schema ====='
  const harnessSql = schemaSql.slice(start, schemaSql.indexOf(endMarker, start) + endMarker.length)
  db.transaction(() => db.exec(harnessSql))()
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'harness_%'").get().count, 11)

  console.log('harness database constraint tests passed')
} finally {
  db.close()
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
