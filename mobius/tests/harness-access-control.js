const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-access-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.v3_run_session_gate = '1'

const { db } = require('../db')
const { setup, cleanup } = require('./harness/phase1-fixture')
const access = require('../backend/services/access-control')

try {
  const fixture = setup(db, tempRoot, 'access')
  db.prepare(`INSERT INTO users (id, display_name, password_hash, role, work_dir)
    VALUES ('outsider_harness', 'Outsider', '', 'user', ?)`).run(tempRoot)
  assert.equal(access.canCreateHarnessRun(fixture.user, fixture.issueId), true)
  assert.equal(access.canCreateHarnessRun({ id: 'outsider_harness', role: 'user' }, fixture.issueId), false)
  const run = {
    id: 'run_access', owner_user_id: fixture.userId, project_id: fixture.projectId,
    anchor_type: 'issue', issue_id: fixture.issueId,
  }
  assert.equal(access.canReadHarnessRun(fixture.user, run), true)
  assert.equal(access.canOperateHarnessRun({ id: 'outsider_harness', role: 'user' }, run), false)
  console.log('harness Phase 1 access-control tests passed')
} finally {
  cleanup(fs, db, tempRoot)
}
