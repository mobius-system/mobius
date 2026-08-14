class FakeHarnessExecutor {
  constructor({ providesDeliveryConfirmation = true } = {}) {
    this.kind = 'fake-harness'
    this.providesDeliveryConfirmation = providesDeliveryConfirmation
    this.supportsThreadFork = false
    this.supportsInlineApproval = false
    this.sessions = new Map()
    this.dispatches = []
  }

  async startSession(spec) {
    const sessionId = `fake_${spec.nodeId}_${this.sessions.size + 1}`
    this.sessions.set(sessionId, { ...spec })
    return { sessionId }
  }

  async dispatch(input) {
    this.dispatches.push({ ...input })
    return {
      delivered: true,
      evidence: this.providesDeliveryConfirmation ? 'observed' : 'unknown',
      sessionId: input.sessionId,
      detail: 'fake executor dispatch',
    }
  }

  async interrupt(sessionId) {
    if (this.sessions.has(sessionId)) this.sessions.get(sessionId).interrupted = true
  }

  async reconcile() {
    return 'unknown'
  }
}

module.exports = { FakeHarnessExecutor }
