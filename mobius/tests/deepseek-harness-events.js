const assert = require('assert')
const { projectHarnessEvent } = require('../backend/agents/deepseek-harness-events')

const context = { sessionId: 'mobius-1', agentSessionId: 'harness-1', cwd: '/tmp/work', runtimeVersion: 'test' }

const assistant = projectHarnessEvent({
  type: 'assistant/message', seq: 3, time: 1,
  data: { message: { content: [
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'answer' },
    { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' },
  ] } },
}, context)
assert.equal(assistant.length, 1)
assert.deepEqual(assistant[0].message.content, [
  { type: 'thinking', thinking: 'thinking' },
  { type: 'text', text: 'answer' },
])

const toolCall = projectHarnessEvent({
  type: 'tool/call', seq: 4,
  data: { callId: 'call-1', name: 'read', arguments: '{"path":"a.txt"}' },
}, context)
assert.deepEqual(toolCall[0].message.content[0], {
  type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a.txt' },
})

const result = projectHarnessEvent({
  type: 'tool/result', seq: 5,
  data: {
    message: {
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }],
    },
  },
}, context)
assert.equal(result[0].message.content[0].tool_use_id, 'call-1')
assert.equal(result[0].message.content[0].content, 'ok')

const error = projectHarnessEvent({ type: 'turn/end', seq: 6, data: { reason: { kind: 'error', error: { message: 'bad' } } } }, context)
assert.equal(error[0].type, 'error')
assert.equal(error[0].message.content, 'bad')
assert.equal(projectHarnessEvent({ type: 'turn/end', seq: 7, data: { reason: { kind: 'completed' } } }, context).length, 0)
assert.equal(projectHarnessEvent({ type: 'turn/end', seq: 8, data: { reason: { kind: 'aborted' } } }, context)[0].message.content, 'DeepSeek Harness turn aborted')
assert.equal(projectHarnessEvent({ type: 'turn/end', seq: 9, data: { reason: { kind: 'blocked' } } }, context)[0].message.content, 'DeepSeek Harness turn blocked')

const approval = projectHarnessEvent({ type: 'approval/asked', seq: 10, data: { requestId: 'approval-1' } }, context)
assert.equal(approval[0].type, 'system')
assert.match(approval[0].message.content, /approval\/asked/)

console.log('deepseek-harness-events: ok')
