import assert from 'node:assert/strict'
import { buildEasyJsonlRounds } from '../src/components/easy-jsonl/easy-jsonl-model'
import { buildRounds } from '../src/components/viewer/rounds'
import type { JsonlViewItem } from '../src/components/viewer/types'

const items: JsonlViewItem[] = [
  { entry: { type: 'user', message: { content: [{ type: 'text', text: '实现一个简易页面' }] }, timestamp: '2026-07-27T10:00:00Z' }, lineNo: 1 },
  { entry: { type: 'assistant', message: { content: [{ type: 'text', text: '我先检查页面结构。' }] } }, lineNo: 2 },
  { entry: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/workspace/App.tsx' } }] } }, lineNo: 3 },
  { entry: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } }] } }, lineNo: 4 },
  { entry: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/workspace/App.tsx', old_string: 'old', new_string: 'new' } }] } }, lineNo: 5 },
  { entry: { type: 'assistant', message: { content: [{ type: 'text', text: '页面已经实现并通过构建。' }] }, timestamp: '2026-07-27T10:02:00Z' }, lineNo: 6 },
]

const grouped = buildRounds(items)
const result = buildEasyJsonlRounds(grouped.rounds)
assert.equal(result.length, 1)
assert.equal(result[0].userPrompt, '实现一个简易页面')
assert.equal(result[0].assistantResponse, '页面已经实现并通过构建。')
assert.ok(result[0].activities.some(activity => activity.kind === 'explore'))
assert.ok(result[0].activities.some(activity => activity.kind === 'command'))
assert.ok(result[0].activities.some(activity => activity.kind === 'file-change'))
assert.ok(result[0].activities.some(activity => activity.kind === 'progress'))
console.log('easy jsonl model tests passed')
