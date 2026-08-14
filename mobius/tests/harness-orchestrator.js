const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-orchestrator-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')

const { db } = require('../db')
const { Sessions } = require('../backend/repositories/sessions')
const { setup, rosterRequest, result, cleanup } = require('./harness/phase1-fixture')
const { createHarnessRun } = require('../backend/repositories/harness')
const { HarnessExecutorRegistry } = require('../backend/services/harness-executor')
const { FakeHarnessExecutor } = require('./harness/fake-executor')
const { claimNextHarnessDispatch, deliverClaimedHarnessDispatch } = require('../backend/services/harness-dispatcher')
const { completeHarnessNode } = require('../backend/services/harness-actions')
const { mintHarnessNodeToken, verifyHarnessNodeToken } = require('../backend/services/harness-token')
const { verifySubmittedHarnessNode } = require('../backend/services/harness-orchestrator')

class DatabaseFakeExecutor extends FakeHarnessExecutor {
  constructor() {
    super({ providesDeliveryConfirmation: true })
    this.kind = 'fake-database'
  }

  async startSession(spec) {
    const session = await super.startSession(spec)
    const node = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(spec.nodeId)
    const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(spec.runId)
    Sessions.insert({
      session_id: session.sessionId,
      issue_id: run.issue_id,
      project_id: run.project_id,
      scope_type: 'issue',
      user_id: run.owner_user_id,
      name: `Fake ${node.path}`,
      session_key: `fake:${spec.nodeId}`,
      model: node.model,
    })
    db.prepare(`INSERT INTO harness_node_sessions (node_id, session_id, generation, status)
      VALUES (?, ?, 0, 'active')`).run(spec.nodeId, session.sessionId)
    return session
  }
}

class FailingStartExecutor extends FakeHarnessExecutor {
  constructor() {
    super({ providesDeliveryConfirmation: true })
    this.kind = 'fake-failing-start'
  }

  async startSession() {
    throw new Error('configured backend is unavailable')
  }
}

async function main() {
  try {
    const fixture = setup(db, tempRoot, 'orchestrator')
    const snapshot = createHarnessRun(fixture.userId, fixture.projectId, {
      ...rosterRequest(fixture, 'single'), request_id: 'orchestrator-create',
    })
    const executor = new DatabaseFakeExecutor()
    const registry = new HarnessExecutorRegistry()
    registry.register(executor)

    const claim = claimNextHarnessDispatch('test-worker')
    assert.ok(claim)
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(claim.node.id).status, 'starting')
    assert.equal(executor.dispatches.length, 0, 'claim transaction must not invoke executor')
    await deliverClaimedHarnessDispatch(claim, registry)
    assert.equal(executor.dispatches.length, 1)
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(claim.node.id).status, 'running')
    assert.equal(db.prepare('SELECT status FROM harness_dispatches WHERE id=?').get(claim.dispatch.id).status, 'delivered')
    assert.equal(db.prepare('SELECT status FROM harness_runs WHERE id=?').get(snapshot.run.id).status, 'running')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM harness_node_sessions WHERE node_id=?').get(claim.node.id).count, 1)

    const member = snapshot.members[0]
    const payload = verifyHarnessNodeToken(mintHarnessNodeToken({
      runId: snapshot.run.id,
      nodeId: claim.node.id,
      memberId: member.id,
      role: 'main',
      allowedMemberIds: [member.id],
    }))
    completeHarnessNode(payload, claim.node.id, {
      request_id: 'root-complete-request', result: result('root-delivery', 'Final read-only report'),
    })
    verifySubmittedHarnessNode(claim.node.id)
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(claim.node.id).status, 'succeeded')
    assert.equal(db.prepare('SELECT status FROM harness_runs WHERE id=?').get(snapshot.run.id).status, 'completed')
    assert.equal(claimNextHarnessDispatch('test-worker'), null)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM harness_dispatches WHERE run_id=?').get(snapshot.run.id).count, 1)

    const failedFixture = setup(db, tempRoot, 'orchestrator_failed_start')
    const failedRun = createHarnessRun(failedFixture.userId, failedFixture.projectId, {
      ...rosterRequest(failedFixture, 'single'), request_id: 'orchestrator-failed-start-create',
    })
    const failedClaim = claimNextHarnessDispatch('test-worker-failed-start')
    const failingRegistry = new HarnessExecutorRegistry()
    failingRegistry.register(new FailingStartExecutor())
    await deliverClaimedHarnessDispatch(failedClaim, failingRegistry)
    assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(failedClaim.node.id).status, 'failed')
    assert.equal(db.prepare('SELECT status FROM harness_runs WHERE id=?').get(failedRun.run.id).status, 'failed')
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_events WHERE run_id=? AND type='run.failed'").get(failedRun.run.id).count, 1)

    console.log('harness Phase 1 orchestrator tests passed')
  } finally {
    cleanup(fs, db, tempRoot)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
