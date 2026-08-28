const assert = require('assert')
const fs = require('fs')

const {
  AUTO_COMPACT_INTERVAL,
  afterAssistantHumanInputQueued,
  clearAssistantAutoCompactCount,
  countFileForSession,
} = require('../backend/services/assistant-auto-compact')

async function main() {
  const sessionId = `test-auto-compact-${process.pid}-${Date.now()}`
  const countFile = countFileForSession(sessionId)
  clearAssistantAutoCompactCount(sessionId)

  let compactCalls = 0
  for (let i = 1; i < AUTO_COMPACT_INTERVAL; i += 1) {
    const triggered = await afterAssistantHumanInputQueued(sessionId, async () => { compactCalls += 1 })
    assert.strictEqual(triggered, false)
    assert.strictEqual(Number(fs.readFileSync(countFile, 'utf8')), i)
  }

  assert.strictEqual(await afterAssistantHumanInputQueued(sessionId, async () => { compactCalls += 1 }), true)
  assert.strictEqual(compactCalls, 1)
  assert.strictEqual(fs.existsSync(countFile), false)

  for (let i = 0; i < AUTO_COMPACT_INTERVAL - 1; i += 1) {
    await afterAssistantHumanInputQueued(sessionId, async () => { compactCalls += 1 })
  }
  assert.strictEqual(await afterAssistantHumanInputQueued(sessionId, async () => { throw new Error('expected') }), false)
  assert.strictEqual(Number(fs.readFileSync(countFile, 'utf8')), AUTO_COMPACT_INTERVAL)
  assert.strictEqual(await afterAssistantHumanInputQueued(sessionId, async () => { compactCalls += 1 }), true)
  assert.strictEqual(compactCalls, 2)
  assert.strictEqual(fs.existsSync(countFile), false)

  fs.mkdirSync('/tmp/mobius-assistant-auto-compact', { recursive: true })
  fs.writeFileSync(countFile, 'broken', 'utf8')
  await afterAssistantHumanInputQueued(sessionId, async () => { compactCalls += 1 })
  assert.strictEqual(Number(fs.readFileSync(countFile, 'utf8')), 1)

  clearAssistantAutoCompactCount(sessionId)
  console.log('assistant auto compact tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
