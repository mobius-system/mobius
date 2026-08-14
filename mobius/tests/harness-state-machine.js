const assert = require('assert')
const {
  evaluateNodeTransition,
  evaluateRunTransition,
  isNodeActive,
  isNodeTerminal,
  nodeTransitionTable,
  toNodeTransitionRejectedEvent,
} = require('../backend/services/harness-state-machine')

const actors = {
  'created:queued': 'orchestrator',
  'created:cancelled': 'user',
  'queued:starting': 'orchestrator',
  'starting:running': 'lease_holder',
  'starting:orphaned': 'recovery',
  'starting:failed': 'orchestrator',
  'running:submitted': 'agent',
  'waiting_input:queued': 'main',
  'waiting_input:cancelled': 'user',
  'waiting_input:failed': 'timeout',
  'submitted:verifying': 'orchestrator',
  'submitted:failed': 'orchestrator',
  'verifying:succeeded': 'orchestrator',
  'verifying:queued': 'orchestrator',
  'verifying:failed': 'orchestrator',
  'cancelling:cancelled': 'orchestrator',
  'failed:queued': 'main',
  'timed_out:queued': 'orchestrator',
  'interrupted:queued': 'user',
  'orphaned:queued': 'recovery',
  'orphaned:failed': 'recovery',
}

for (const [from, destinations] of Object.entries(nodeTransitionTable())) {
  for (const to of destinations) {
    const context = from === 'orphaned' && to === 'queued'
      ? { has_handoff_artifact: true }
      : from === 'orphaned' && to === 'failed'
        ? { has_handoff_artifact: false }
        : {}
    const result = evaluateNodeTransition({
      from,
      to,
      actor: actors[`${from}:${to}`] || (to === 'cancelling' ? 'cascade' : 'system'),
      context,
    })
    assert.equal(result.accepted, true, `${from} -> ${to} should be accepted: ${result.reason || ''}`)
  }
}

for (const [from, to] of [
  ['created', 'running'],
  ['queued', 'succeeded'],
  ['submitted', 'succeeded'],
  ['succeeded', 'queued'],
  ['cancelled', 'running'],
]) {
  const result = evaluateNodeTransition({ from, to, actor: 'system' })
  assert.equal(result.accepted, false)
  assert.equal(result.code, 'illegal_transition')
  assert.ok(result.reason.includes(from) && result.reason.includes(to))
}

assert.deepEqual(
  evaluateNodeTransition({ from: 'queued', to: 'starting', actor: 'agent' }).code,
  'actor_not_allowed',
)
assert.equal(
  evaluateNodeTransition({ from: 'starting', to: 'running', actor: 'orchestrator' }).code,
  'actor_not_allowed',
)

const rejectedRequest = { from: 'created', to: 'running', actor: 'agent' }
const rejectedResult = evaluateNodeTransition(rejectedRequest)
const rejectedEvent = toNodeTransitionRejectedEvent(rejectedRequest, rejectedResult)
assert.equal(rejectedEvent.type, 'node.transition_rejected')
assert.equal(rejectedEvent.payload.code, 'illegal_transition')
assert.ok(rejectedEvent.payload.reason)
assert.equal(
  evaluateNodeTransition({ from: 'running', to: 'submitted', actor: 'main' }).code,
  'actor_not_allowed',
)
assert.equal(
  evaluateNodeTransition({ from: 'verifying', to: 'queued', actor: 'orchestrator', context: { attempts_exhausted: true } }).code,
  'attempts_exhausted',
)
assert.equal(
  evaluateNodeTransition({ from: 'failed', to: 'queued', actor: 'main', context: { attempts_exhausted: true } }).code,
  'attempts_exhausted',
)
assert.equal(
  evaluateNodeTransition({ from: 'orphaned', to: 'queued', actor: 'recovery' }).code,
  'handoff_required',
)
assert.equal(
  evaluateNodeTransition({ from: 'orphaned', to: 'failed', actor: 'recovery', context: { has_handoff_artifact: true } }).code,
  'handoff_available',
)

assert.equal(evaluateRunTransition({ from: 'synthesizing', to: 'completed', actor: 'agent' }).accepted, false)
assert.equal(evaluateRunTransition({ from: 'synthesizing', to: 'completed', actor: 'orchestrator' }).accepted, true)
assert.equal(evaluateRunTransition({ from: 'completed', to: 'running', actor: 'system' }).accepted, false)
assert.equal(evaluateRunTransition({ from: 'failed', to: 'running', actor: 'system' }).code, 'retry_not_allowed')
assert.equal(evaluateRunTransition({
  from: 'failed', to: 'running', actor: 'system',
  context: { has_retryable_node: true, failure_retryable: true },
}).accepted, true)

for (const state of ['queued', 'starting', 'running', 'waiting_input', 'submitted', 'verifying']) {
  assert.equal(isNodeActive(state), true, `${state} should occupy a member seat`)
}
assert.equal(isNodeActive('created'), false)
assert.equal(isNodeTerminal('succeeded'), true)
assert.equal(isNodeTerminal('cancelled'), true)
assert.equal(isNodeTerminal('failed'), false)

console.log('harness state machine tests passed')
