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
assert.ok(result[0].timeline.some(segment => segment.type === 'message' && segment.text === '我先检查页面结构。'))

const framedItems: JsonlViewItem[] = [
  { entry: { type: 'user', message: { content: '继续完成原始任务' } }, lineNo: 10 },
  { entry: { type: 'response_item', payload: { type: 'message', role: 'developer', content: '只改 Easy 模式' } }, lineNo: 11 },
  {
    entry: {
      type: 'event_msg',
      payload: {
        type: 'user_message',
        content: 'Mobius Main/Sub Harness Context\n\n## 用户的问题\n继续完成原始任务',
      },
    },
    lineNo: 12,
  },
  { entry: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } }] } }, lineNo: 13 },
  { entry: { type: 'assistant', message: { content: [{ type: 'text', text: '原任务已经完成。' }] } }, lineNo: 14 },
]

// 共享分组默认行为保持不变：developer 仍算输出，裸原文与 framed 原文会分轮。
assert.equal(buildRounds(framedItems).rounds.length, 2)

// Easy 路径剥框架正文去重，并保留 framed 条目供系统上下文折叠。
const framedGrouped = buildRounds(framedItems, { preferFramedUser: true })
assert.equal(framedGrouped.rounds.length, 1)
assert.equal(framedGrouped.rounds[0].items[0].lineNo, 12)
const framedResult = buildEasyJsonlRounds(framedGrouped.rounds)
assert.equal(framedResult.length, 1)
assert.deepEqual(splitEasyUserPrompt(framedResult[0].userPrompt), {
  visible: '继续完成原始任务',
  hidden: 'Mobius Main/Sub Harness Context',
  hiddenKind: 'system-prompt',
})
assert.equal(framedResult[0].assistantResponse, '原任务已经完成。')
assert.ok(framedResult[0].activities.some(activity => activity.kind === 'command'))
assert.ok(!framedResult[0].timeline.some(segment => segment.type === 'message' && segment.text === '原任务已经完成。'))

// 首条消息真实顺序: Codex 裸原文 → reasoning / 401 → Mobius framed。不能拆成两张用户气泡。
const retryItems: JsonlViewItem[] = [
  { entry: { type: 'event_msg', payload: { type: 'user_message', message: '你好' } }, lineNo: 20 },
  { entry: { type: 'response_item', payload: { type: 'reasoning', content: 'thinking' } }, lineNo: 21 },
  { entry: { type: 'event_msg', payload: { type: 'agent_message', message: '401 Authentication Failed · Retrying in 11s · attempt 6/10' } }, lineNo: 22 },
  {
    entry: {
      type: 'user',
      message: { content: '以下信息描述了你正在协助的用户\n项目: demo\n\n---\n\n## 用户的问题\n你好' },
      mobius: { input_text: '你好' },
    },
    lineNo: 23,
  },
]
const retryGrouped = buildRounds(retryItems, { preferFramedUser: true })
assert.equal(retryGrouped.rounds.length, 1)
assert.equal(retryGrouped.rounds[0].items[0].lineNo, 23)
const retryResult = buildEasyJsonlRounds(retryGrouped.rounds)
assert.equal(retryResult.length, 1)
assert.deepEqual(splitEasyUserPrompt(retryResult[0].userPrompt), {
  visible: '你好',
  hidden: '以下信息描述了你正在协助的用户\n项目: demo',
  hiddenKind: 'system-prompt',
})

// 真正的第二次提问（上一轮已有助手回复）即使正文相同也不能合并。
const secondQuestionItems: JsonlViewItem[] = [
  { entry: { type: 'user', message: { content: '你好' } }, lineNo: 30 },
  { entry: { type: 'assistant', message: { content: [{ type: 'text', text: '你好，需要我做什么？' }] } }, lineNo: 31 },
  { entry: { type: 'user', message: { content: '你好' } }, lineNo: 32 },
]
assert.equal(buildRounds(secondQuestionItems, { preferFramedUser: true }).rounds.length, 2)

// GLM/Z.ai mirrors a server-side tool call as Markdown around the structured
// server_tool_use/tool_result entries. Easy mode should show one compact tool
// activity, never the raw signed URL or duplicated Output block.
const providerToolItems: JsonlViewItem[] = [
  { entry: { type: 'user', message: { content: '检查这个页面' } }, lineNo: 40 },
  { entry: { type: 'assistant', message: { content: [{ type: 'text', text: '我先检查截图。' }] } }, lineNo: 41 },
  {
    entry: {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '**🌐 Z.ai Built-in Tool: analyze_image**\n\n**Input:**\n```json\n{"imageSource":"https://example.test/private.png?Signature=secret"}\n```\n*Executing on server...*',
        }],
      },
    },
    lineNo: 42,
  },
  {
    entry: {
      type: 'assistant',
      message: { content: [{ type: 'server_tool_use', id: 'server-call-1', name: 'analyze_image', input: {} }] },
    },
    lineNo: 43,
  },
  {
    entry: {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '**Output:**\n**analyze_image_result_summary:** [{"text":"MCP error 400: 图片输入格式/解析错误"}]',
        }],
      },
    },
    lineNo: 44,
  },
  {
    entry: {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'server-call-1',
          content: [{ type: 'text', text: 'MCP error 400: 图片输入格式/解析错误' }],
        }],
      },
    },
    lineNo: 45,
  },
]
const providerToolResult = buildEasyJsonlRounds(buildRounds(providerToolItems).rounds)
assert.equal(providerToolResult.length, 1)
assert.equal(providerToolResult[0].assistantResponse, '')
assert.ok(providerToolResult[0].timeline.some(segment => segment.type === 'message' && segment.text === '我先检查截图。'))
assert.ok(!providerToolResult[0].timeline.some(segment => segment.type === 'message' && /Built-in Tool|Signature=secret|result_summary/.test(segment.text)))
const providerToolActivity = providerToolResult[0].activities.find(activity => activity.title === 'analyze_image')
assert.ok(providerToolActivity)
assert.equal(providerToolActivity?.state, 'error')
assert.deepEqual(providerToolActivity?.lineNos, [43, 45])
assert.match(providerToolActivity?.outputTail || '', /图片输入格式\/解析错误/)

console.log('easy jsonl model tests passed')
