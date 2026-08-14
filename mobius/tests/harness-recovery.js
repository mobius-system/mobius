const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-recovery-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')

const { db } = require('../db')
const { Sessions } = require('../backend/repositories/sessions')
const { setup, rosterRequest, cleanup } = require('./harness/phase1-fixture')
const { createHarnessRun } = require('../backend/repositories/harness')
const { HarnessExecutorRegistry } = require('../backend/services/harness-executor')
const { claimNextHarnessDispatch, reconcileExpiredHarnessDispatch } = require('../backend/services/harness-dispatcher')

class MarkerRecoveryExecutor {
  constructor() {
    this.kind = 'fake-marker-recovery'
    this.providesDeliveryConfirmation = false
    this.supportsThreadFork = false
    this.supportsInlineApproval = false
  }
  async startSession() { throw new Error('not used') }
  async dispatch() { throw new Error('not used') }
  async interrupt() {}
  async reconcile(dispatch) {
    if (!dispatch.targetSessionId) return 'absent'
    const found = db.prepare(`SELECT 1 FROM messages_v2 WHERE task_id=? AND role='user' AND instr(content, ?) > 0 LIMIT 1`)
      .get(dispatch.targetSessionId, dispatch.receiptMarker)
    return found ? 'inferred' : 'absent'
  }
}

class UnknownRecoveryExecutor extends MarkerRecoveryExecutor {
  async reconcile() { return 'unknown' }
}

async function main() {
  try {
    const fixture = setup(db, tempRoot, 'recovery')
    const snapshot = createHarnessRun(fixture.userId, fixture.projectId, {
      ...rosterRequest(fixture, 'single'), request_id: 'recovery-create',
    })
    const claim = claimNextHarnessDispatch('crashed-worker')
    const sessionId = 'recovery_session'
    Sessions.insert({
      session_id: sessionId,
      issue_id: fixture.issueId,
      project_id: fixture.projectId,
      scope_type: 'issue',
      user_id: fixture.userId,
      name: 'Recovery fake session',
      session_key: 'recovery:session',
      model: claim.node.model,
    })
    db.prepare(`INSERT INTO harness_node_sessions (node_id, session_id, generation, status)
      VALUES (?, ?, 0, 'active')`).run(claim.node.id, sessionId)
    db.prepare(`UPDATE harness_dispatches SET status='dispatching', target_session_id=?, lease_expires_at='2000-01-01T00:00:00.000Z'
      WHERE id=?`).run(sessionId, claim.dispatch.id)
    db.prepare(`INSERT INTO messages_v2 (task_id, role, content, turn_number)
      VALUES (?, 'user', ?, 1)`).run(sessionId, `marked prompt ${claim.dispatch.receipt_marker}`)

    const registry = new HarnessExecutorRegistry()
    registry.register(new MarkerRecoveryExecutor())
    const expired = db.prepare('SELECT * FROM harness_dispatches WHERE id=?').get(claim.dispatch.id)
    await reconcileExpiredHarnessDispatch(expired, registry)
    await reconcileExpiredHarnessDispatch(db.prepare('SELECT * FROM harness_dispatches WHERE id=?').get(claim.dispatch.id), registry)
    assert.equal(db.prepare('SELECT status FROM harness_dispatches WHERE id=?').get(claim.dispatch.id).status, 'delivered')
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(claim.node.id).status, 'running')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM harness_dispatch_receipts WHERE dispatch_id=?').get(claim.dispatch.id).count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM harness_dispatches WHERE run_id=?').get(snapshot.run.id).count, 1)

    const absentFixture = setup(db, tempRoot, 'recovery_absent')
    const absentRun = createHarnessRun(absentFixture.userId, absentFixture.projectId, {
      ...rosterRequest(absentFixture, 'single'), request_id: 'recovery-absent-create',
    })
    const absentClaim = claimNextHarnessDispatch('crashed-worker-2')
    db.prepare(`UPDATE harness_dispatches SET status='dispatching', lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?`).run(absentClaim.dispatch.id)
    await reconcileExpiredHarnessDispatch(db.prepare('SELECT * FROM harness_dispatches WHERE id=?').get(absentClaim.dispatch.id), registry)
    assert.equal(db.prepare('SELECT status FROM harness_dispatches WHERE id=?').get(absentClaim.dispatch.id).status, 'failed')
    assert.equal(db.prepare('SELECT status FROM harness_runs WHERE id=?').get(absentRun.run.id).status, 'failed')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM harness_dispatches WHERE run_id=?').get(absentRun.run.id).count, 1)

    const uncertainFixture = setup(db, tempRoot, 'recovery_uncertain')
    const uncertainRun = createHarnessRun(uncertainFixture.userId, uncertainFixture.projectId, {
      ...rosterRequest(uncertainFixture, 'single'), request_id: 'recovery-uncertain-create',
    })
    const uncertainClaim = claimNextHarnessDispatch('crashed-worker-3')
    db.prepare(`UPDATE harness_dispatches SET status='dispatching',
      lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?`).run(uncertainClaim.dispatch.id)
    const unknownRegistry = new HarnessExecutorRegistry()
    unknownRegistry.register(new UnknownRecoveryExecutor())
    const uncertainDispatch = db.prepare('SELECT * FROM harness_dispatches WHERE id=?').get(uncertainClaim.dispatch.id)
    await reconcileExpiredHarnessDispatch(uncertainDispatch, unknownRegistry)
    await reconcileExpiredHarnessDispatch(db.prepare('SELECT * FROM harness_dispatches WHERE id=?').get(uncertainClaim.dispatch.id), unknownRegistry)
    assert.equal(db.prepare('SELECT status FROM harness_dispatches WHERE id=?').get(uncertainClaim.dispatch.id).status, 'uncertain')
    const uncertainNode = db.prepare('SELECT status,failure_json FROM harness_nodes WHERE id=?').get(uncertainClaim.node.id)
    assert.equal(uncertainNode.status, 'orphaned')
    assert.equal(JSON.parse(uncertainNode.failure_json).category, 'uncertain_dispatch')
    const failedRun = db.prepare('SELECT status,failure_json FROM harness_runs WHERE id=?').get(uncertainRun.run.id)
    assert.equal(failedRun.status, 'failed')
    assert.equal(JSON.parse(failedRun.failure_json).category, 'uncertain_dispatch')
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_events WHERE run_id=? AND type='run.failed'").get(uncertainRun.run.id).count, 1)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_events WHERE run_id=? AND type='dispatch.uncertain'").get(uncertainRun.run.id).count, 1)

    console.log('harness Phase 1 recovery tests passed')
  } finally {
    cleanup(fs, db, tempRoot)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
