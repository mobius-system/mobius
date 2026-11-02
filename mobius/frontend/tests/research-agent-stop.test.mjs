import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const source = fs.readFileSync(new URL('../src/services/session-stop.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const exports = {}
vm.runInNewContext(compiled, { exports })
const { stopSessionWithFollowup, postMessageWithResearchGuard } = exports

for (const state of [false, true, null]) {
  for (const acceptDisable of [false, true]) {
    for (const cancelJobs of [false, true]) {
      const events = []
      await stopSessionWithFollowup({
        sessionId: 's1',
        request: async (url, options) => {
          const method = options?.method || 'GET'
          events.push(`${method} ${url}`)
          if (url.endsWith('/stop')) return { ok: true, research_agent_disabled: state }
          if (method === 'GET') return { wakeups: [{}, {}] }
          return {}
        },
        confirm: text => { const disable = text.includes('是否同时禁用'); events.push(disable ? 'confirm-disable' : 'confirm-jobs'); return disable ? acceptDisable : cancelJobs },
        onStopped() {}, onDisabledChanged() {},
      })
      assert.equal(events[0], 'POST /api/sessions/s1/stop')
      assert.equal(events.includes('confirm-disable'), state === false)
      assert.equal(events.includes('PATCH /api/sessions/s1'), state === false && acceptDisable)
      assert.equal(events.includes('DELETE /api/scheduled-wake-ups?session_id=s1'), cancelJobs)
      if (state === false) assert(events.indexOf('confirm-disable') < events.indexOf('GET /api/scheduled-wake-ups?session_id=s1'))
    }
  }
}
for (const failAt of ['stop', 'disable', 'jobs']) {
  const calls = []
  await assert.rejects(stopSessionWithFollowup({
    sessionId: 's1', request: async (url, options) => {
      calls.push(url)
      if (url.endsWith('/stop')) return { ok: failAt !== 'stop', research_agent_disabled: false }
      if (options?.method === 'PATCH' && failAt === 'disable') throw new Error('disable failed')
      if (url.includes('wake-ups')) throw new Error('jobs failed')
      return {}
    }, confirm: () => true, onStopped() {}, onDisabledChanged() {},
  }))
  if (failAt !== 'jobs') assert(!calls.some(url => url.includes('wake-ups')))
}
for (const disabled of [false, true]) {
  for (const accept of [false, true]) {
    const calls = []
    const promise = postMessageWithResearchGuard({
      sessionId: 's1', isResearch: true, payload: { content: 'hello' },
      request: async (url) => { calls.push(url); return { research_agent_disabled: disabled } },
      confirm: message => { assert.equal(message, '当前研究智能体处于禁用状态，是否解禁？'); calls.push('confirm'); return accept },
      onDisabledChanged() {},
    })
    if (disabled && !accept) {
      await assert.rejects(promise, /已取消发送/)
      assert.deepEqual(calls, ['/api/sessions/s1/research-agent-state', 'confirm'])
    } else {
      await promise
      assert.deepEqual(calls, [
        '/api/sessions/s1/research-agent-state',
        ...(disabled ? ['confirm', '/api/sessions/s1/research-agent/enable'] : []),
        '/api/sessions/s1/messages',
      ])
    }
  }
}
// A stale UI must use the dedicated enable API before retrying a rejected message.
const calls = []
await postMessageWithResearchGuard({
  sessionId: 's1', isResearch: false, payload: {},
  request: async url => {
    calls.push(url)
    if (calls.length === 1) throw Object.assign(new Error('disabled'), { code: 'research_agent_disabled' })
    return {}
  }, confirm: () => true, onDisabledChanged() {},
})
assert.deepEqual(calls, ['/api/sessions/s1/messages', '/api/sessions/s1/research-agent/enable', '/api/sessions/s1/messages'])
console.log('Research stop order, skip/decline/error paths, and explicit enable before send: passed')
