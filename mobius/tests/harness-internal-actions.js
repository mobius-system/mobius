const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-actions-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')

const { db } = require('../db')
const { setup, rosterRequest, contract, result, cleanup } = require('./harness/phase1-fixture')
const { createHarnessRun, resolveRoster } = require('../backend/repositories/harness')
const { estimateHarnessRun } = require('../backend/services/harness-estimator')
const { mintHarnessNodeToken, verifyHarnessNodeToken } = require('../backend/services/harness-token')
const {
  createTaskForMember,
  completeHarnessNode,
  reportHarnessProgress,
} = require('../backend/services/harness-actions')
const { verifySubmittedHarnessNode } = require('../backend/services/harness-orchestrator')

function createMulti(fixture, requestId) {
  const draft = rosterRequest(fixture, 'multi')
  const roster = resolveRoster(fixture.userId, fixture.projectId, draft)
  const estimate = estimateHarnessRun(fixture.userId, draft, roster.map((member) => ({ id: member.profile.id, definition: member.profile.definition })))
  return createHarnessRun(fixture.userId, fixture.projectId, {
    ...draft,
    request_id: requestId,
    acknowledged_estimate: { estimate_id: estimate.estimate_id, shown_cost_usd_range: estimate.estimated_cost_usd_range },
  })
}

try {
  const fixture = setup(db, tempRoot, 'actions')
  const snapshot = createMulti(fixture, 'actions-create-run')
  const root = snapshot.nodes[0]
  const main = snapshot.members.find((member) => member.role === 'main')
  const worker = snapshot.members.find((member) => member.role === 'worker')
  db.prepare("UPDATE harness_nodes SET status='running', version=version+1 WHERE id=?").run(root.id)
  db.prepare("UPDATE harness_runs SET status='running', version=version+1 WHERE id=?").run(snapshot.run.id)
  db.prepare("UPDATE harness_dispatches SET status='delivered', delivered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE run_id=?").run(snapshot.run.id)

  const mainPayload = verifyHarnessNodeToken(mintHarnessNodeToken({
    runId: snapshot.run.id,
    nodeId: root.id,
    memberId: main.id,
    role: 'main',
    allowedMemberIds: snapshot.members.map((member) => member.id),
  }))
  assert.throws(
    () => createTaskForMember(mainPayload, {
      request_id: 'unknown-member-request', assignee_member_id: 'not-selected', task_contract: contract(),
    }),
    (error) => error.code === 'member_not_allowed',
  )
  assert.throws(
    () => createTaskForMember(mainPayload, {
      request_id: 'main-reassign-request', assignee_member_id: main.id, task_contract: contract(),
    }),
    (error) => error.code === 'main_reassignment_forbidden',
  )
  assert.throws(
    () => createTaskForMember(mainPayload, {
      request_id: 'medium-risk-request', assignee_member_id: worker.id,
      task_contract: { ...contract(), risk_level: 'medium' },
    }),
    (error) => error.code === 'phase1_risk_forbidden',
  )
  assert.throws(
    () => createTaskForMember(mainPayload, {
      request_id: 'patch-deliverable-request', assignee_member_id: worker.id,
      task_contract: { ...contract(), deliverables: [{ kind: 'patch', name: 'patch', required: true }] },
    }),
    (error) => error.code === 'phase1_deliverable_forbidden',
  )
  const created = createTaskForMember(mainPayload, {
    request_id: 'create-worker-request', assignee_member_id: worker.id, task_contract: contract(),
  })
  const replay = createTaskForMember(mainPayload, {
    request_id: 'create-worker-request', assignee_member_id: worker.id, task_contract: contract(),
  })
  assert.equal(created.ok, true)
  assert.equal(replay.replayed, true)
  assert.equal(created.data.node_id, replay.data.node_id)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=?").get(snapshot.run.id).count, 2)

  const childId = created.data.node_id
  db.prepare("UPDATE harness_nodes SET status='running', version=version+1 WHERE id=?").run(childId)
  const workerPayload = verifyHarnessNodeToken(mintHarnessNodeToken({
    runId: snapshot.run.id, nodeId: childId, memberId: worker.id, role: 'worker', allowedMemberIds: [worker.id],
  }))
  assert.throws(
    () => createTaskForMember(workerPayload, {
      request_id: 'worker-delegate-request', assignee_member_id: main.id, task_contract: contract(),
    }),
    (error) => error.code === 'root_main_required',
  )
  assert.throws(
    () => reportHarnessProgress(workerPayload, root.id, { request_id: 'sibling-progress-req', message: 'forbidden' }),
    (error) => error.code === 'harness_scope_violation',
  )
  const completed = completeHarnessNode(workerPayload, childId, {
    request_id: 'worker-complete-request', result: result(),
  })
  assert.equal(completed.data.status, 'submitted')
  assert.equal(completeHarnessNode(workerPayload, childId, {
    request_id: 'worker-complete-request', result: result(),
  }).replayed, true)
  verifySubmittedHarnessNode(childId)
  assert.equal(db.prepare('SELECT status FROM harness_nodes WHERE id=?').get(childId).status, 'succeeded')
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM harness_events WHERE run_id=? AND type='member.task_completed'").get(snapshot.run.id).count, 1)

  const singleFixture = setup(db, tempRoot, 'single')
  const singleDraft = rosterRequest(singleFixture, 'single')
  const single = createHarnessRun(singleFixture.userId, singleFixture.projectId, { ...singleDraft, request_id: 'single-create-run' })
  const singleMain = single.members[0]
  const singleRoot = single.nodes[0]
  const singlePayload = verifyHarnessNodeToken(mintHarnessNodeToken({
    runId: single.run.id, nodeId: singleRoot.id, memberId: singleMain.id, role: 'main', allowedMemberIds: [singleMain.id],
  }))
  assert.throws(
    () => createTaskForMember(singlePayload, {
      request_id: 'single-delegate-request', assignee_member_id: singleMain.id, task_contract: contract(),
    }),
    (error) => error.code === 'multi_harness_disabled',
  )

  console.log('harness Phase 1 internal action tests passed')
} finally {
  cleanup(fs, db, tempRoot)
}
