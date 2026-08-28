import assert from 'node:assert/strict'
import { buildEasyJsonlRounds, splitEasyUserPrompt } from '../src/components/easy-jsonl/easy-jsonl-model'
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

const framed = splitEasyUserPrompt('以下信息描述了你正在协助的用户、当前Project、Issue/Research 与 Session.\n\n## 用户\n- 姓名: admin\n\n---\n\n## 用户的问题\n调研婚恋 AI 产品')
assert.equal(framed.visible, '调研婚恋 AI 产品')
assert.match(framed.hidden, /以下信息描述了你正在协助的用户/)
assert.doesNotMatch(framed.hidden, /调研婚恋 AI 产品/)

const english = splitEasyUserPrompt("The following describes the user you are assisting, and the Project, Issue/Research, and Session this work belongs to.\n\n---\n\n## User's Question\nWrite a brief")
assert.equal(english.visible, 'Write a brief')
assert.match(english.hidden, /The following describes the user you are assisting/)

const harness = splitEasyUserPrompt('# Mobius Main/Sub Harness Context\n- Run: hr_123\n\nInternal API\nAuthorization: use the session token')
assert.equal(harness.visible, '')
assert.match(harness.hidden, /Internal API/)
assert.equal(harness.hiddenKind, 'system-prompt')

const wrappedHarness = splitEasyUserPrompt('以下信息描述了你正在协助的用户、当前Project、Issue/Research 与 Session.\n\n---\n\n## 用户的问题\n# Mobius Main/Sub Harness Context\n- Run: hr_123')
assert.equal(wrappedHarness.visible, '')
assert.match(wrappedHarness.hidden, /Mobius Main\/Sub Harness Context/)

const env = splitEasyUserPrompt('<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>')
assert.equal(env.visible, '')
assert.equal(env.hiddenKind, 'system-prompt')

const notice = splitEasyUserPrompt('Harness result notification (trusted control metadata only).\nrun_id: hr_1')
assert.equal(notice.visible, '')

const plain = splitEasyUserPrompt('实现一个简易页面')
assert.equal(plain.visible, '实现一个简易页面')
assert.equal(plain.hidden, '')

const framedPrompt = '以下信息描述了你正在协助的用户、当前Project、Issue/Research 与 Session.\n\n---\n\n## 用户的问题\n强化学习是什么'
const plainThenFramed = buildEasyJsonlRounds(buildRounds([
  { entry: { type: 'event_msg', payload: { type: 'user_message', message: '强化学习是什么' } }, lineNo: 1 },
  { entry: { type: 'user', message: { content: [{ type: 'text', text: framedPrompt }] } }, lineNo: 2 },
  { entry: { type: 'assistant', message: { content: [{ type: 'text', text: '强化学习是一种从反馈中学习的方法。' }] } }, lineNo: 3 },
]).rounds)
assert.equal(plainThenFramed.length, 1, '裸原文和带框架的同一次提问不得拆成两轮')
assert.equal(plainThenFramed[0].userPrompt, framedPrompt)
assert.equal(splitEasyUserPrompt(plainThenFramed[0].userPrompt).visible, '强化学习是什么')
assert.ok(splitEasyUserPrompt(plainThenFramed[0].userPrompt).hidden)

const framedThenPlain = buildEasyJsonlRounds(buildRounds([
  { entry: { type: 'user', message: { content: framedPrompt } }, lineNo: 1 },
  { entry: { type: 'event_msg', payload: { type: 'user_message', message: '强化学习是什么' } }, lineNo: 2 },
]).rounds)
assert.equal(framedThenPlain.length, 1)
assert.equal(framedThenPlain[0].userPrompt, framedPrompt)

const askedTwice = buildEasyJsonlRounds(buildRounds([
  { entry: { type: 'user', message: { content: '强化学习是什么' } }, lineNo: 1 },
  { entry: { type: 'assistant', message: { content: [{ type: 'text', text: '先讲定义。' }] } }, lineNo: 2 },
  { entry: { type: 'user', message: { content: '强化学习是什么' } }, lineNo: 3 },
]).rounds)
assert.equal(askedTwice.length, 2, '中间已有回复时，相同提问仍是新一轮')

const developerBetween = buildEasyJsonlRounds(buildRounds([
  { entry: { type: 'user', message: { content: '强化学习是什么' } }, lineNo: 1 },
  { entry: { type: 'response_item', payload: { type: 'message', role: 'developer', content: '<permissions instructions>' } }, lineNo: 2 },
  { entry: { type: 'user', message: { content: [{ type: 'text', text: framedPrompt }] } }, lineNo: 3 },
  { entry: { type: 'assistant', message: { content: [{ type: 'text', text: '强化学习是一种从反馈中学习的方法。' }] } }, lineNo: 4 },
]).rounds)
assert.equal(developerBetween.length, 1, 'developer 系统指令不得把同一次提问拆成两张气泡')
assert.equal(developerBetween[0].userPrompt, framedPrompt)

console.log('easy jsonl model tests passed')
