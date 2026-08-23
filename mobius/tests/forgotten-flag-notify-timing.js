const assert = require('assert')

const {
  continuousInactiveMs,
  observeInactiveFlag,
  observeWorkingFlag,
} = require('../backend/services/forgotten-flag-notify-timing')

const MINUTE = 60 * 1000
const oldFlag = {
  runId: 'session-1:old-start',
  startedAt: '2026-08-18T08:25:45.041Z',
  mtimeMs: Date.parse('2026-08-18T08:25:45.041Z'),
}

// Regression: a long-running task's old flag must not consume the post-stop grace period.
const stoppedAt = Date.parse('2026-08-18T08:53:00.000Z')
const firstIdle = observeInactiveFlag(null, oldFlag, stoppedAt)
assert.strictEqual(firstIdle.startedNow, true)
assert.strictEqual(firstIdle.state.inactiveSince, stoppedAt)
assert.strictEqual(continuousInactiveMs(firstIdle.state, stoppedAt + MINUTE), MINUTE)
assert.ok(
  continuousInactiveMs(firstIdle.state, stoppedAt + MINUTE) < 10 * MINUTE,
  'a task that stopped one minute ago must still be inside a ten-minute grace period',
)

// Repeated idle scans preserve the original transition time, including across process reloads.
const secondIdle = observeInactiveFlag(firstIdle.state, oldFlag, stoppedAt + 2 * MINUTE)
assert.strictEqual(secondIdle.startedNow, false)
assert.strictEqual(secondIdle.state.inactiveSince, stoppedAt)

// Once work resumes, the next idle period starts from zero even for the same stable runId.
const working = observeWorkingFlag(secondIdle.state, oldFlag)
assert.strictEqual(working.inactiveSince, null)
const stoppedAgainAt = stoppedAt + 20 * MINUTE
const thirdIdle = observeInactiveFlag(working, oldFlag, stoppedAgainAt)
assert.strictEqual(thirdIdle.startedNow, true)
assert.strictEqual(thirdIdle.state.inactiveSince, stoppedAgainAt)
assert.strictEqual(continuousInactiveMs(thirdIdle.state, stoppedAgainAt + MINUTE), MINUTE)

// A genuinely new flag instance gets a fresh counter and grace period.
const newFlag = { runId: 'session-1:new-start', startedAt: '2026-08-18T09:30:00.000Z' }
const previousNotification = { ...thirdIdle.state, count: 2, lastNotifiedAt: stoppedAgainAt }
const newIdle = observeInactiveFlag(previousNotification, newFlag, stoppedAgainAt + 30 * MINUTE)
assert.strictEqual(newIdle.sameFlag, false)
assert.strictEqual(newIdle.state.count, 0)
assert.strictEqual(newIdle.state.lastNotifiedAt, null)

console.log('forgotten-flag-notify-timing: ok')
