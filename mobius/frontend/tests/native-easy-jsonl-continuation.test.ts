import assert from 'node:assert/strict'
import { buildEasyJsonlRounds } from '../src/native-easy/components/easy-jsonl/easy-jsonl-model'
import type { JsonlViewItem } from '../src/native-easy/components/viewer/types'

const continuationItems: JsonlViewItem[] = [
  {
    entry: {
      type: 'event_msg',
      payload: { type: 'agent_message', message: '历史任务已经完成并通过验证。' },
      timestamp: '2026-08-29T10:00:00Z',
    },
    lineNo: 201,
  },
]

const continuation = buildEasyJsonlRounds([], continuationItems)
assert.equal(continuation.length, 1)
assert.equal(continuation[0].userPrompt, '')
assert.equal(continuation[0].assistantResponse, '历史任务已经完成并通过验证。')
assert.deepEqual(continuation[0].lineNos, [201])

const codexContinuation = buildEasyJsonlRounds([], [{
  entry: {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Codex 历史结果仍可见。' }],
    },
  },
  lineNo: 350,
}])
assert.equal(codexContinuation[0].assistantResponse, 'Codex 历史结果仍可见。')

console.log('native easy JSONL continuation tests passed')
