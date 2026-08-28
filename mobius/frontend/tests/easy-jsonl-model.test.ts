import assert from 'node:assert/strict'
import { buildEasyJsonlRounds, splitEasyUserPrompt, stripEasyUserImageAttachmentBlocks } from '../src/components/easy-jsonl/easy-jsonl-model'
import { entryUserAttachmentImages, functionOutputBody, stripExecEnvelope } from '../src/components/viewer/entry-extract'
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
assert.deepEqual(result[0].timeline.map(segment => segment.type), ['message', 'burst'], '短进度文案必须像 CodexMonitor 一样切断工具分组')
assert.equal(result[0].timeline[0].type === 'message' ? result[0].timeline[0].text : '', '我先检查页面结构。')
const initialBurst = result[0].timeline[1]
assert.equal(initialBurst.type, 'burst')
if (initialBurst.type === 'burst') {
  assert.equal(initialBurst.toolCount, 3)
  assert.equal(initialBurst.defaultExpanded, false, '3 次及以上成功调用必须默认收起，避免整屏铺开')
  assert.deepEqual(initialBurst.items.map(activity => activity.kind), ['explore', 'command', 'file-change'])
  assert.equal(initialBurst.items.at(-1)?.title, '已编辑 App.tsx')
}

const userEntry = (text = '处理任务'): JsonlViewItem['entry'] => ({ type: 'user', message: { content: text } })
const assistantText = (text: string): JsonlViewItem['entry'] => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const toolEntry = (name: string, input: Record<string, unknown>, id?: string): JsonlViewItem['entry'] => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
})

function buildOne(entries: JsonlViewItem['entry'][]) {
  return buildEasyJsonlRounds(buildRounds(entries.map((entry, index) => ({ entry, lineNo: index + 1 }))).rounds)[0]
}

const assistantBoundary = buildOne([
  userEntry(),
  toolEntry('Read', { file_path: '/workspace/one.ts' }, 'read-1'),
  assistantText('第一部分已经确认，这里是阶段结论。'),
  toolEntry('Bash', { command: 'npm test' }, 'bash-1'),
  assistantText('全部检查完成。'),
])
assert.deepEqual(assistantBoundary.timeline.map(segment => segment.type), ['row', 'message', 'row'], '普通 assistant 文本必须切断相邻工具突发')
assert.equal(assistantBoundary.timeline[0].type === 'row' ? assistantBoundary.timeline[0].activity.kind : '', 'explore')
assert.equal(assistantBoundary.timeline[1].type === 'message' ? assistantBoundary.timeline[1].text : '', '第一部分已经确认，这里是阶段结论。')
assert.equal(assistantBoundary.timeline[2].type === 'row' ? assistantBoundary.timeline[2].activity.kind : '', 'command')

const reasoningBridge = buildOne([
  userEntry(),
  toolEntry('Read', { file_path: '/workspace/one.ts' }, 'read-1'),
  { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '核对调用链\n继续定位引用位置' }] } },
  toolEntry('Bash', { command: 'rg -n "buildOne" src' }, 'bash-1'),
  assistantText('定位完成。'),
])
assert.deepEqual(reasoningBridge.timeline.map(segment => segment.type), ['burst'], 'reasoning 不得切断工具突发')
const reasoningBurst = reasoningBridge.timeline[0]
assert.equal(reasoningBurst.type, 'burst')
if (reasoningBurst.type === 'burst') {
  assert.equal(reasoningBurst.toolCount, 2)
  assert.deepEqual(reasoningBurst.items.map(activity => activity.kind), ['explore', 'reasoning', 'command'])
}
assert.equal(reasoningBridge.workingLabel, '核对调用链')

const singleTool = buildOne([
  userEntry(),
  toolEntry('Read', { file_path: '/workspace/only.ts' }, 'read-1'),
  assistantText('读取完成。'),
])
assert.deepEqual(singleTool.timeline.map(segment => segment.type), ['row'], '孤立单工具不得增加外层分组')

const reasoningAndOne = buildOne([
  userEntry(),
  { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '核对调用链\n继续定位引用位置' }] } },
  toolEntry('Bash', { command: 'npm test' }, 'bash-1'),
  assistantText('完成。'),
])
assert.deepEqual(reasoningAndOne.timeline.map(segment => segment.type), ['row', 'row'], '一次真实调用即使夹着思考也不得出现「1 次工具调用」分组头')
assert.deepEqual(
  reasoningAndOne.timeline.map(segment => segment.type === 'row' ? segment.activity.kind : ''),
  ['reasoning', 'command'],
)

const repeatedCalls = buildOne([
  userEntry(),
  toolEntry('Read', { file_path: '/workspace/same.ts' }, 'read-1'),
  toolEntry('Read', { file_path: '/workspace/same.ts' }, 'read-2'),
  assistantText('读取完成。'),
])
const repeatedBurst = repeatedCalls.timeline[0]
assert.equal(repeatedBurst.type, 'burst')
if (repeatedBurst.type === 'burst') {
  assert.equal(repeatedBurst.toolCount, 2, '重复同参仍须按两次实际调用计数')
  assert.equal(repeatedBurst.items.length, 2)
}

const finalReply = buildOne([
  userEntry(),
  toolEntry('Bash', { command: 'npm test' }, 'bash-1'),
  assistantText('正在处理的任务已经完成。'),
])
assert.equal(finalReply.assistantResponse, '正在处理的任务已经完成。')
assert.equal(finalReply.activities.some(activity => activity.kind === 'progress'), false, '最后一条 assistant 永远不得进入 progress')

const progressThenSingle = buildOne([
  userEntry(),
  assistantText('我先查看本项目指定的 mobius-self-iter 规则，确认本次回答完成后的收尾要求。'),
  toolEntry('Bash', { command: "sed -n '1,240p' .mobius/skills/mobius-self-iter/SKILL.md" }, 'sed-1'),
  assistantText('强化学习是一种从反馈中学习的方法。'),
])
assert.deepEqual(progressThenSingle.timeline.map(segment => segment.type), ['message', 'row'], '短进度 + 单工具不得再包一层「1 次工具调用」')
assert.equal(progressThenSingle.timeline[1].type === 'row' ? progressThenSingle.timeline[1].activity.title : '', "sed -n '1,240p' .mobius/skills/mobius-self-iter/SKILL.md")

const longCommand = 'rm -- /Users/boyin.liu/PycharmProjects/mobius-nutshell/.mobius/flags/38d08977/running.flag && test ! -e /Users/boyin.liu/PycharmProjects/mobius-nutshell/.mobius/flags/38d08977/running.flag'
const longCommandRound = buildOne([
  userEntry(),
  toolEntry('Bash', { command: longCommand }, 'rm-long'),
  assistantText('清理完成。'),
])
assert.equal(longCommandRound.timeline[0].type === 'row' ? longCommandRound.timeline[0].activity.title.length <= 72 : false, true, '折叠标题必须是短摘要，不能整段 curl/rm 铺满')
assert.equal(longCommandRound.timeline[0].type === 'row' ? longCommandRound.timeline[0].activity.details[0] : '', longCommand)

const curlCommand = `curl --http1.1 -sS -X POST --max-time 30 --fail --header 'Content-Type: application/json' --data-binary @- 'http://127.0.0.1:8787/internal/harness/complete'`
const curlRound = buildOne([
  userEntry(),
  toolEntry('Bash', { command: curlCommand }, 'curl-1'),
  assistantText('已上报。'),
])
assert.equal(curlRound.timeline[0].type === 'row' ? curlRound.timeline[0].activity.title : '', 'curl POST /internal/harness/complete')
assert.match(curlRound.timeline[0].type === 'row' ? curlRound.timeline[0].activity.details[0] || '' : '', /--data-binary/)

assert.equal(stripExecEnvelope('Script completed\nWall time 0.1 seconds\nOutput:'), '')
assert.equal(functionOutputBody([{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:' }]), '')
assert.equal(functionOutputBody('Script completed\nWall time 0.2 seconds\nOutput:\n---\nname: demo'), '---\nname: demo')
assert.equal(functionOutputBody('Script completed\nWall time 0.1 seconds\nOutput:\n{"ok":true,"percent":60}'), '{"ok":true,"percent":60}')
assert.match(functionOutputBody('---\nname: keep\nOutput: later'), /Output: later/, '正文中间的 Output: 不得被当成信封剥掉')

const emptyEnvelope = buildEasyJsonlRounds([{
  roundNum: 1,
  items: [
    { entry: userEntry(), lineNo: 1, relIdx: 0 },
    { entry: toolEntry('Bash', { command: 'rm -- /tmp/running.flag' }, 'rm-1'), lineNo: 2, relIdx: 1 },
    { entry: { type: 'response_item', payload: { type: 'function_call_output', call_id: 'rm-1', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:' }] } }, lineNo: 3, relIdx: 2 },
  ],
}])[0]
const emptyRow = emptyEnvelope.timeline[0]
assert.equal(emptyRow.type, 'row')
if (emptyRow.type === 'row') {
  assert.equal(emptyRow.activity.outputTail, undefined, '只有 Script completed / Wall time / Output: 时不得渲染空输出块')
}

const jsonEnvelope = buildEasyJsonlRounds([{
  roundNum: 1,
  items: [
    { entry: userEntry(), lineNo: 1, relIdx: 0 },
    { entry: toolEntry('Bash', { command: 'curl -X POST http://127.0.0.1:8787/internal/x' }, 'curl-json'), lineNo: 2, relIdx: 1 },
    { entry: { type: 'response_item', payload: { type: 'function_call_output', call_id: 'curl-json', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n{"ok":true,"percent":60}' }] } }, lineNo: 3, relIdx: 2 },
  ],
}])[0]
const jsonRow = jsonEnvelope.timeline[0]
assert.equal(jsonRow.type, 'row')
if (jsonRow.type === 'row') {
  assert.doesNotMatch(jsonRow.activity.outputTail || '', /Script completed|Wall time|Output:/)
  assert.match(jsonRow.activity.outputTail || '', /"ok": true/)
  assert.equal(jsonRow.activity.defaultExpanded, undefined)
}

const customExec = buildEasyJsonlRounds([{
  roundNum: 1,
  items: [
    { entry: userEntry(), lineNo: 1, relIdx: 0 },
    { entry: { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-js', input: 'const r = await tools.exec_command({\n  cmd: "curl -X POST http://127.0.0.1:8787/internal/harness/complete"\n})' } }, lineNo: 2, relIdx: 1 },
    { entry: { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'exec-js', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n{"ok":true,"data":{"verified_product_groups":6,"representative_products":22}}' }] } }, lineNo: 3, relIdx: 2 },
  ],
}])[0]
const customExecRow = customExec.timeline[0]
assert.equal(customExecRow.type, 'row')
if (customExecRow.type === 'row') {
  assert.equal(customExecRow.activity.title, 'curl POST /internal/harness/complete')
  assert.doesNotMatch(customExecRow.activity.title, /const r = await/)
  assert.doesNotMatch(customExecRow.activity.outputTail || '', /Script completed|Wall time|^Output:/)
  assert.match(customExecRow.activity.outputTail || '', /"verified_product_groups": 6/)
}

const customSearch = buildEasyJsonlRounds([{
  roundNum: 1,
  items: [
    { entry: userEntry(), lineNo: 1, relIdx: 0 },
    { entry: { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'web-1', input: 'const r = await tools.web__run({search_query:["paired premium couples"]})' } }, lineNo: 2, relIdx: 1 },
  ],
}])[0]
assert.equal(customSearch.timeline[0].type === 'row' ? customSearch.timeline[0].activity.kind : '', 'explore')
assert.match(customSearch.timeline[0].type === 'row' ? customSearch.timeline[0].activity.title : '', /正在搜索.*paired premium couples/)

const titleReasoning = buildOne([
  userEntry(),
  toolEntry('Read', { file_path: '/workspace/one.ts' }, 'read-1'),
  { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '扫描相关测试' }] } },
  toolEntry('Bash', { command: 'shell -lc \'cd /workspace && rg -n "timeline" src\'' }, 'bash-1'),
  assistantText('完成。'),
])
const titleReasoningBurst = titleReasoning.timeline[0]
assert.equal(titleReasoningBurst.type, 'burst')
if (titleReasoningBurst.type === 'burst') {
  assert.deepEqual(titleReasoningBurst.items.map(activity => activity.kind), ['explore', 'command'], '仅标题 reasoning 只驱动 Working，不重复渲染空详情行')
  assert.match(titleReasoningBurst.items[1].title, /^rg -n/)
}
assert.equal(titleReasoning.workingLabel, '扫描相关测试')

const commandWithResult = buildEasyJsonlRounds([{
  roundNum: 1,
  items: [
    { entry: userEntry(), lineNo: 1, relIdx: 0 },
    {
      entry: toolEntry('Bash', { command: 'npm test' }, 'bash-result'),
      lineNo: 2,
      relIdx: 1,
      bashResults: [{
        entry: {}, lineNo: 3, toolUseId: 'bash-result', stdout: Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join('\n'), stderr: '', content: '', isError: true, interrupted: false, isImage: false, noOutputExpected: false,
      }],
    },
  ],
}])[0]
const failedRow = commandWithResult.timeline[0]
assert.equal(failedRow.type, 'row')
if (failedRow.type === 'row') {
  assert.equal(failedRow.activity.state, 'error')
  assert.equal(failedRow.activity.defaultExpanded, true)
  assert.match(failedRow.activity.outputTail || '', /^line 1/)
  assert.match(failedRow.activity.outputTail || '', /line 24$/)
}

const failedBurstRound = buildEasyJsonlRounds([{
  roundNum: 1,
  items: [
    { entry: userEntry(), lineNo: 1, relIdx: 0 },
    {
      entry: toolEntry('Bash', { command: 'npm test' }, 'failed-command'), lineNo: 2, relIdx: 1,
      bashResults: [{ entry: {}, lineNo: 3, toolUseId: 'failed-command', stdout: '', stderr: 'tests failed', content: 'tests failed', isError: true, interrupted: false, isImage: false, noOutputExpected: false }],
    },
    { entry: toolEntry('Read', { file_path: '/workspace/report.txt' }, 'read-report'), lineNo: 4, relIdx: 2 },
  ],
}])[0]
const failedBurst = failedBurstRound.timeline[0]
assert.equal(failedBurst.type, 'burst')
if (failedBurst.type === 'burst') {
  assert.equal(failedBurst.hasError, true)
  assert.equal(failedBurst.defaultExpanded, true)
  assert.equal(failedBurst.title, '已读取文件并运行了命令 · 含失败')
}

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

const imageAttachmentPrompt = '[附件]\n- [图片] /tmp/screenshot.png\n\n检查这张截图'
const imageAttachmentRound = buildOne([
  userEntry(imageAttachmentPrompt),
  assistantText('已检查。'),
])
assert.deepEqual(imageAttachmentRound.userAttachmentImages, ['/tmp/screenshot.png'])
assert.equal(imageAttachmentRound.timeline.some(segment => segment.type === 'row' && segment.activity.kind === 'image'), false, '用户附件图不得在执行轨迹中重复出现')
assert.equal(stripEasyUserImageAttachmentBlocks(imageAttachmentPrompt), '检查这张截图')
assert.equal(
  stripEasyUserImageAttachmentBlocks('[附件]\n- [图片] /tmp/screenshot.png\n- [文件] /tmp/report.pdf\n\n检查附件'),
  '[附件]\n- [文件] /tmp/report.pdf\n\n检查附件',
  '非图片文件仍保留为正文文件引用',
)

const structuredAttachmentPrompt = '用户随本轮消息上传了以下附件。你可以直接读取这些本机绝对路径来理解内容；图片需要向用户展示时可使用 `display_images <图片路径>`。\n1. [图片] /tmp/shot.webp (原图.webp)\n\n请分析'
assert.deepEqual(entryUserAttachmentImages({ type: 'user', content: structuredAttachmentPrompt }), ['/tmp/shot.webp'])
assert.equal(stripEasyUserImageAttachmentBlocks(structuredAttachmentPrompt), '请分析')
assert.deepEqual(entryUserAttachmentImages({ attachments: [{ type: 'image', path: '/tmp/structured.png' }] }), ['/tmp/structured.png'])

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
