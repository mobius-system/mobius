import assert from 'node:assert/strict'
import { buildEasyJsonlRounds, buildEasyAssistantResponse } from '../src/components/easy-jsonl/easy-jsonl-model'
import { buildRounds } from '../src/components/viewer/rounds'
import type { AnyEntry, JsonlViewItem } from '../src/components/viewer/types'

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
console.log('easy jsonl model base tests passed')

// ═══════════════════════════════════════════════════════════════════════
// 极简长回复选择规则 (Phase 0 修复): 最终正文不截断、不被短镜像覆盖、分片无损合并。
// ═══════════════════════════════════════════════════════════════════════

function roundsOf(...entries: Array<{ entry: AnyEntry; lineNo: number }>) {
  const viewItems = entries.map(item => ({ entry: item.entry, lineNo: item.lineNo })) as JsonlViewItem[]
  const { rounds } = buildRounds(viewItems)
  return buildEasyJsonlRounds(rounds)
}

function userEntry(text: string, lineNo: number) {
  return { entry: { type: 'user', message: { content: [{ type: 'text', text }] } } as AnyEntry, lineNo }
}

// ── 1. 中间进度 + 10000 字 stop_reason=end_turn 完整回复 → 正文逐字相等 ──
{
  const longBody = Array.from({ length: 1000 }, (_, i) => `第${i + 1}段：这是长回复的完整内容，包含充分的说明文字，用于验证不会被截断。`).join('\n')
  assert.ok(longBody.length >= 9000, `长回复应超过 9000 字, 实际 ${longBody.length}`)
  const rounds = roundsOf(
    userEntry('请详细说明', 1),
    { entry: { type: 'assistant', message: { content: [{ type: 'text', text: '我先检查一下相关文件。' }] } } as AnyEntry, lineNo: 2 },
    { entry: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } }] } } as AnyEntry, lineNo: 3 },
    { entry: { type: 'assistant', message: { content: [{ type: 'text', text: longBody }], stop_reason: 'end_turn' } } as AnyEntry, lineNo: 4 },
  )
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0].assistantResponse, longBody, '10000 字完整回复必须逐字相等, 不得截断')
  assert.ok(!rounds[0].assistantResponse.includes('…'), '最终正文不得出现截断省略号')
  assert.ok(rounds[0].activities.some(a => a.kind === 'progress'), '中间 assistant 文本应降级为进度')
  console.log('1. 长回复逐字完整: passed')
}

// ── 2. 完整 assistant 之后跟更短的 event_msg.agent_message 镜像 → 仍选完整回复 ──
{
  const full = '这是完整的最终回答，包含全部要点、结论与后续步骤的详细说明。'
  const rounds = roundsOf(
    userEntry('总结一下', 1),
    { entry: { type: 'assistant', message: { content: [{ type: 'text', text: full }], stop_reason: 'end_turn' } } as AnyEntry, lineNo: 2 },
    { entry: { type: 'event_msg', payload: { type: 'agent_message', message: '短镜像' } } as AnyEntry, lineNo: 3 },
  )
  assert.equal(rounds[0].assistantResponse, full, '不得被更短的 event 镜像覆盖')
  console.log('2. 短镜像不覆盖完整回复: passed')
}

// ── 3. Codex final 分成三段 → 按顺序完整拼接 ──
{
  const seg1 = '第一部分：需求分析与目标拆解。'
  const seg2 = '第二部分：实现方案与关键代码。'
  const seg3 = '第三部分：验证结果与后续建议。'
  const rounds = roundsOf(
    userEntry('设计方案', 1),
    { entry: { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: seg1 }] } } as AnyEntry, lineNo: 2 },
    { entry: { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: seg2 }] } } as AnyEntry, lineNo: 3 },
    { entry: { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text: seg3 }] } } as AnyEntry, lineNo: 4 },
  )
  assert.equal(rounds[0].assistantResponse, [seg1, seg2, seg3].join('\n\n'), 'final 分片按序无损合并')
  console.log('3. Codex final 三段合并: passed')
}

// ── 4. 相同镜像消息只显示一次 ──
{
  const text = '这条消息被镜像了两次，但正文只能出现一次。'
  const rounds = roundsOf(
    userEntry('重复检查', 1),
    { entry: { type: 'assistant', message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } } as AnyEntry, lineNo: 2 },
    { entry: { type: 'event_msg', payload: { type: 'agent_message', message: text } } as AnyEntry, lineNo: 3 },
    { entry: { type: 'event_msg', payload: { type: 'agent_message', message: text } } as AnyEntry, lineNo: 4 },
  )
  assert.equal(rounds[0].assistantResponse, text, '相同内容去重')
  assert.equal(rounds[0].assistantResponse.split(text).length - 1, 1, '正文只出现一次')
  console.log('4. 镜像去重: passed')
}

// ── 5. 后一条包含前一条 → 不重复 ──
{
  const short = '开始分析。'
  const long = '开始分析。经过深入检查，最终结论如下。'
  const rounds = roundsOf(
    userEntry('逐步推理', 1),
    { entry: { type: 'assistant', message: { content: [{ type: 'text', text: short }], stop_reason: 'end_turn' } } as AnyEntry, lineNo: 2 },
    { entry: { type: 'assistant', message: { content: [{ type: 'text', text: long }], stop_reason: 'end_turn' } } as AnyEntry, lineNo: 3 },
  )
  assert.equal(rounds[0].assistantResponse, long, '包含关系取长者, 不重复拼接')
  console.log('5. 包含去重: passed')
}

// ── 6. Markdown 结构在正文中保留 ──
{
  const md = [
    '## 实现方案',
    '',
    '| 模块 | 状态 |',
    '| --- | --- |',
    '| 前端 | 已完成 |',
    '',
    '- 列表项一',
    '- 列表项二',
    '',
    '```ts',
    'const x: number = 1',
    '```',
    '',
    '行内 `code` 与 $E=mc^2$ 公式。',
  ].join('\n')
  const rounds = roundsOf(
    userEntry('给出方案', 1),
    { entry: { type: 'assistant', message: { content: [{ type: 'text', text: md }], stop_reason: 'end_turn' } } as AnyEntry, lineNo: 2 },
  )
  assert.equal(rounds[0].assistantResponse, md, 'Markdown 表格/列表/代码块/标题/公式逐字保留')
  console.log('6. Markdown 结构保留: passed')
}

// ── 7. 只有 event 镜像时 (无 canonical) 仍能出正文 ──
{
  const rounds = roundsOf(
    userEntry('快速问答', 1),
    { entry: { type: 'event_msg', payload: { type: 'agent_message', message: '镜像正文兜底' } } as AnyEntry, lineNo: 2 },
  )
  assert.equal(rounds[0].assistantResponse, '镜像正文兜底')
  console.log('7. event 镜像兜底: passed')
}

// ── 8. 纯函数直接测试: 最终正文不含 compactText 省略号 ──
{
  const response = buildEasyAssistantResponse([
    { entry: { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(500) }], stop_reason: 'end_turn' } } as AnyEntry, lineNo: 1 },
  ])
  assert.equal(response.length, 500)
  assert.ok(!response.includes('…'))
  console.log('8. 无省略号截断: passed')
}

console.log('easy jsonl model tests passed')
