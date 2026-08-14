const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-context-protocol-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')

const { db } = require('../db')
const { setup, rosterRequest, cleanup } = require('./harness/phase1-fixture')
const { createHarnessRun, resolveRoster } = require('../backend/repositories/harness')
const { estimateHarnessRun } = require('../backend/services/harness-estimator')
const { buildHarnessContext } = require('../backend/services/harness-context')
const { isHarnessLoopbackAddress } = require('../backend/routes/harnesses')

try {
  const fixture = setup(db, tempRoot, 'context_protocol')
  const sourceProfile = db.prepare("SELECT * FROM harness_profiles WHERE id='system-codex-readonly-v1'").get()
  db.prepare(`INSERT INTO harness_profiles
    (id, scope, name, description, backend, default_model, capabilities_json, definition_json, version)
    VALUES ('system-profile-not-selected', 'system', 'Not selected', '', ?, ?, ?, ?, 1)`)
    .run(sourceProfile.backend, sourceProfile.default_model, sourceProfile.capabilities_json, sourceProfile.definition_json)
  const draft = rosterRequest(fixture, 'multi')
  const roster = resolveRoster(fixture.userId, fixture.projectId, draft)
  const estimate = estimateHarnessRun(fixture.userId, draft, roster.map((member) => ({ id: member.profile.id, definition: member.profile.definition })))
  const snapshot = createHarnessRun(fixture.userId, fixture.projectId, {
    ...draft,
    request_id: 'context-protocol-create',
    acknowledged_estimate: { estimate_id: estimate.estimate_id, shown_cost_usd_range: estimate.estimated_cost_usd_range },
  })
  const root = snapshot.nodes.find((node) => node.node_type === 'root')
  const context = buildHarnessContext(root.id)
  assert.match(context.prompt, /curl --silent --show-error --fail-with-body/)
  assert.match(context.prompt, new RegExp(`/runs/${snapshot.run.id}/nodes`))
  assert.match(context.prompt, new RegExp(`/nodes/${root.id}/progress`))
  assert.match(context.prompt, new RegExp(`/nodes/${root.id}/complete`))
  assert.match(context.prompt, new RegExp(`/nodes/${root.id}/fail`))
  assert.match(context.prompt, /after_seq=0&wait_ms=30000/)
  assert.match(context.prompt, /"request_id": "assign-<new-unique-id>"/)
  assert.match(context.prompt, /"workspace": \{\s+"mode": "read_only"/)
  assert.match(context.prompt, /--data-binary @-/)
  assert.match(context.prompt, /<<'MOBIUS_JSON'/)
  assert.match(context.prompt, /Completion is a terminal action/)
  assert.match(context.prompt, /Never probe or test this endpoint with a minimal payload/)
  assert.match(context.prompt, /any unresolved entry is an acceptance blocker and the server will fail the node/)
  assert.match(context.prompt, /non-blocking limitations in risks/)
  assert.ok(!context.prompt.includes("--data-binary '{"), 'JSON request bodies must not rely on shell single-quote wrapping')
  assert.match(context.prompt, /prompt_enforced read_only/)
  assert.match(context.prompt, /MOBIUS_HARNESS_TOKEN/)
  assert.ok(!context.prompt.includes(context.token), 'Harness context must not embed its scoped token')
  assert.ok(!context.prompt.includes('system-profile-not-selected'), 'Context must expose the locked snapshot, not unrelated profile catalog ids')
  assert.equal(isHarnessLoopbackAddress('127.0.0.1'), true)
  assert.equal(isHarnessLoopbackAddress('::1'), true)
  assert.equal(isHarnessLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isHarnessLoopbackAddress('10.0.0.8'), false)
  assert.equal(isHarnessLoopbackAddress(undefined), false)
  process.env.HARNESS_CONTEXT_PROTOCOL_ENABLED = '0'
  process.env.HARNESS_SYSTEM_SKILLS_ENABLED = '0'
  const ablated = buildHarnessContext(root.id).prompt
  assert.ok(!ablated.includes('## Exact internal action protocol'))
  assert.ok(!ablated.includes('## Forced System Skill'))
  assert.match(ablated, /## Task Contract/)
  assert.ok(!ablated.includes(context.token), 'Ablated Harness context must not embed a scoped token')
  delete process.env.HARNESS_CONTEXT_PROTOCOL_ENABLED
  delete process.env.HARNESS_SYSTEM_SKILLS_ENABLED
  console.log('harness Phase 1 context protocol tests passed')
} finally {
  cleanup(fs, db, tempRoot)
}
