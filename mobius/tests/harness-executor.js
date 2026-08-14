const assert = require('assert')
const { HarnessExecutorRegistry } = require('../backend/services/harness-executor')
const { FakeHarnessExecutor } = require('./harness/fake-executor')

async function main() {
  const confirmed = new FakeHarnessExecutor({ providesDeliveryConfirmation: true })
  const unconfirmed = new FakeHarnessExecutor({ providesDeliveryConfirmation: false })
  confirmed.kind = 'fake-confirmed'
  unconfirmed.kind = 'fake-unconfirmed'

  const registry = new HarnessExecutorRegistry()
  registry.register(confirmed)
  registry.register(unconfirmed)
  assert.equal(registry.list().length, 2)
  assert.equal(registry.get('fake-confirmed'), confirmed)
  assert.throws(() => registry.register(confirmed), /already registered/)

  const session = await confirmed.startSession({ runId: 'run_1', nodeId: 'node_1', memberId: 'member_1' })
  const outcome = await confirmed.dispatch({
    runId: 'run_1', nodeId: 'node_1', sessionId: session.sessionId,
    requestId: 'req_1', prompt: 'read only', receiptMarker: 'receipt_1',
  })
  assert.equal(outcome.delivered, true)
  assert.equal(outcome.evidence, 'observed')

  const uncertainSession = await unconfirmed.startSession({ runId: 'run_1', nodeId: 'node_2', memberId: 'member_2' })
  const uncertain = await unconfirmed.dispatch({
    runId: 'run_1', nodeId: 'node_2', sessionId: uncertainSession.sessionId,
    requestId: 'req_2', prompt: 'read only', receiptMarker: 'receipt_2',
  })
  assert.equal(uncertain.evidence, 'unknown')
  assert.equal(await unconfirmed.reconcile({}), 'unknown')

  console.log('harness executor tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
