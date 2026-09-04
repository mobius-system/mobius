/**
 * Task tool (TaskCreate/TaskUpdate) plan-card rendering regression tests.
 * Bundles the production extractors + accumulator so this checks the same
 * parsing path the UI uses.
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(__dirname, '../src/components/viewer')

async function bundle(moduleName) {
  const result = await build({
    entryPoints: [path.join(sourceRoot, moduleName)],
    bundle: true,
    format: 'esm',
    target: 'node18',
    write: false,
    logLevel: 'silent',
  })
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
  return import(dataUrl)
}

const extractors = await bundle('entry-extract.ts')
const taskProgress = await bundle('task-progress.ts')
const classify = await bundle('entry-classify.ts')
const summaries = await bundle('header-summary.ts')

const uuidA = 'anchor-task-create'
const uuidB = 'anchor-task-update'

function taskCreateEntry() {
  return {
    type: 'assistant',
    uuid: uuidA,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_create', name: 'TaskCreate', input: { subject: '迁移 agents 为 TS', description: '10 个文件', activeForm: '迁移中' } }],
    },
  }
}

function taskUpdateEntry() {
  return {
    type: 'assistant',
    uuid: uuidB,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_update', name: 'TaskUpdate', input: { status: 'completed', taskId: '1' } }],
    },
  }
}

// 1) 单条目抽取
{
  const calls = extractors.extractTaskToolCalls(taskCreateEntry())
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'TaskCreate')
  assert.equal(calls[0].toolUseId, 'call_create')
  assert.equal(extractors.isTaskToolUseEntry(taskUpdateEntry()), true)
  assert.equal(extractors.isTaskToolUseEntry({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }), false)
}

// 2) 前端兜底累积: TaskCreate → TaskUpdate 跨条目 (同簇只留最后一张)
{
  const { plans } = taskProgress.buildTaskPlans([
    { entry: taskCreateEntry(), lineNo: 1 },
    { entry: taskUpdateEntry(), lineNo: 2 },
  ])
  // 簇规则: 两个调用背靠背 (只隔空) → 只留最后一张 (TaskUpdate, 含簇内累积)
  assert.equal(plans.size, 1, '同簇任务调用只留最后一张')
  const planB = plans.get(uuidB)
  assert.ok(planB, 'TaskUpdate (簇尾) 应有计划')
  assert.equal(planB.steps.length, 1)
  assert.equal(planB.steps[0].step, '迁移 agents 为 TS')
  assert.equal(planB.steps[0].status, 'completed', 'TaskUpdate 时刻任务 completed')
  assert.equal(planB.completed, 1)
}

// 3) sidecar task_state 快照 (权威) 覆盖兜底推断
{
  const snapshotEntry = {
    type: 'task_state',
    uuid: 'sidecar-1',
    timestamp: '2026-09-01T00:00:00.000Z',
    mobius: {
      anchor_uuid: uuidB,
      tasks: [{ id: '1', subject: '迁移 agents 为 TS', status: 'completed' }, { id: '2', subject: '补全类型', status: 'in_progress' }],
    },
  }
  const text = { type: 'assistant', uuid: 'tx', message: { role: 'assistant', content: [{ type: 'text', text: '正文切断簇' }] } }
  const { plans } = taskProgress.buildTaskPlans([
    { entry: taskCreateEntry(), lineNo: 1 },
    { entry: text, lineNo: 2 },
    { entry: taskUpdateEntry(), lineNo: 3 },
    { entry: snapshotEntry, lineNo: 4 },
  ])
  // 正文切簇: TaskCreate 簇 + TaskUpdate 簇 (sidecar 快照挂在 uuidB 同簇尾)
  const planB = plans.get(uuidB)
  assert.ok(planB, 'TaskUpdate 卡应有计划')
  assert.equal(planB.steps.length, 2, 'sidecar 快照应覆盖单任务兜底推断')
  assert.equal(planB.steps[1].status, 'in_progress')
  assert.equal(planB.completed, 1)
}

// 4) task_reminder 附件作为权威累积基底
{
  const reminderEntry = {
    type: 'attachment',
    attachment: { type: 'task_reminder', content: [{ id: '5', subject: '来自提醒', status: 'pending' }] },
  }
  const { plans } = taskProgress.buildTaskPlans([
    { entry: reminderEntry, lineNo: 1 },
    { entry: taskUpdateEntry(), lineNo: 2 },
  ])
  // TaskUpdate taskId=1 在 reminder 表 (只有 id=5) 中不存在 → 宽松建条
  const planB = plans.get(uuidB)
  assert.ok(planB)
  assert.equal(planB.steps.length, 2)
}

// 4b) 连续去重: 同状态 reminder 连续注入只显示最后一个
{
  const reminder = (uuid, id, subject, status) => ({
    type: 'attachment',
    uuid,
    attachment: { type: 'task_reminder', content: [{ id, subject, status }] },
  })
  const { plans, suppressed } = taskProgress.buildTaskPlans([
    { entry: reminder('r1', '1', '任务X', 'in_progress'), lineNo: 1 },
    { entry: reminder('r2', '1', '任务X', 'in_progress'), lineNo: 2 },
    { entry: reminder('r3', '1', '任务X', 'in_progress'), lineNo: 3 },
    { entry: reminder('r4', '1', '任务X', 'in_progress'), lineNo: 4 },
  ])
  assert.equal(plans.size, 1, '同签名连续段只留一张')
  assert.ok(plans.has('r4'), '保留段尾 (最后一个)')
  assert.equal(suppressed.size, 3, '其余 reminder 载体进 suppressed')
  assert.ok(suppressed.has('r1') && suppressed.has('r2') && suppressed.has('r3'))
}

// 4c) 状态变化分段: in_progress → completed 各段保留
{
  const reminder = (uuid, status) => ({
    type: 'attachment',
    uuid,
    attachment: { type: 'task_reminder', content: [{ id: '1', subject: '任务X', status }] },
  })
  // 无实质内容隔开时全部 reminder 同簇 → 只留最后一张 (completed)
  {
    const { plans, suppressed } = taskProgress.buildTaskPlans([
      { entry: reminder('r1', 'in_progress'), lineNo: 1 },
      { entry: reminder('r2', 'in_progress'), lineNo: 2 },
      { entry: reminder('r3', 'completed'), lineNo: 3 },
      { entry: reminder('r4', 'completed'), lineNo: 4 },
    ])
    assert.equal(plans.size, 1, '同簇 (无实质内容隔开) 只留最后一张')
    assert.ok(plans.has('r4'))
    assert.equal(suppressed.size, 3)
  }
  // 有正文隔开 → 各簇各留一张
  {
    const text = { type: 'assistant', uuid: 'tx', message: { role: 'assistant', content: [{ type: 'text', text: '干活' }] } }
    const { plans } = taskProgress.buildTaskPlans([
      { entry: reminder('r1', 'in_progress'), lineNo: 1 },
      { entry: reminder('r2', 'in_progress'), lineNo: 2 },
      { entry: text, lineNo: 3 },
      { entry: reminder('r3', 'completed'), lineNo: 4 },
      { entry: reminder('r4', 'completed'), lineNo: 5 },
    ])
    assert.equal(plans.size, 2, '正文切开的两簇各留一张')
    assert.ok(plans.has('r2'), 'in_progress 簇留段尾')
    assert.ok(plans.has('r4'), 'completed 簇留段尾')
  }
}

// 4d) 段内混合 tool 卡与 reminder: 计划挂到 (段内最后的) 工具卡, reminder 全隐藏
{
  const reminder = (uuid) => ({
    type: 'attachment',
    uuid,
    attachment: { type: 'task_reminder', content: [{ id: '1', subject: '任务X', status: 'in_progress' }] },
  })
  const update = (uuid) => ({
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }] },
  })
  // 无实质内容隔开: r1/t1/r2 同簇, 只留簇尾 r2 (reminder 也可是簇尾载体)
  {
    const { plans, suppressed } = taskProgress.buildTaskPlans([
      { entry: reminder('r1'), lineNo: 1 },
      { entry: update('t1'), lineNo: 2 },
      { entry: reminder('r2'), lineNo: 3 },
    ])
    assert.equal(plans.size, 1)
    assert.ok(plans.has('r2'), '簇尾 reminder 携带最终快照')
    assert.ok(suppressed.has('r1'), '簇内其余 reminder 隐藏')
    assert.ok(!plans.has('t1'), '簇内 tool 卡退回普通卡')
  }
  // 簧尾是 tool 卡 (reminder 在前): 计划挂 tool 卡, reminder 隐藏
  {
    const { plans, suppressed } = taskProgress.buildTaskPlans([
      { entry: reminder('r1'), lineNo: 1 },
      { entry: update('t1'), lineNo: 2 },
    ])
    assert.equal(plans.size, 1)
    assert.ok(plans.has('t1'), '簇尾 tool 卡挂计划')
    assert.ok(suppressed.has('r1'))
  }
}

// 4e) 任务推进簇: 连发 TaskCreate (中间只隔回执) 只显示最后一个
{
  const receipt = (uuid) => ({
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
  })
  const create = (uuid, subject) => ({
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'TaskCreate', input: { subject } }] },
  })
  const { plans } = taskProgress.buildTaskPlans([
    { entry: create('c1', '任务1'), lineNo: 1 },
    { entry: receipt('k1'), lineNo: 2 },
    { entry: create('c2', '任务2'), lineNo: 3 },
    { entry: receipt('k2'), lineNo: 4 },
    { entry: create('c3', '任务3'), lineNo: 5 },
    { entry: receipt('k3'), lineNo: 6 },
  ])
  // 簇内只留最后一张 (c3, 含 3 个任务); c1/c2 退回普通工具卡 (无计划但可见)
  assert.equal(plans.size, 1, '连发 TaskCreate 簇只留最后一张')
  assert.ok(plans.has('c3'))
  assert.equal(plans.get('c3').steps.length, 3, '最后一张含簇内累积的全部任务')
}

// 4f) 簇被实质内容切断: TaskCreate → 正文 → TaskUpdate 各自成簇各留一张
{
  const create = (uuid) => ({
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'TaskCreate', input: { subject: '任务1' } }] },
  })
  const text = { type: 'assistant', uuid: 'tx', message: { role: 'assistant', content: [{ type: 'text', text: '开始干活' }] } }
  const update = (uuid) => ({
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c2', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] },
  })
  const { plans } = taskProgress.buildTaskPlans([
    { entry: create('c1'), lineNo: 1 },
    { entry: text, lineNo: 2 },
    { entry: update('u1'), lineNo: 3 },
  ])
  assert.equal(plans.size, 2, '正文切断推进簇, 两簇各留一张')
  assert.ok(plans.has('c1') && plans.has('u1'))
  assert.equal(plans.get('u1').steps[0].status, 'completed')
}

// 4g) 背靠背 TaskUpdate (51 completed + 52 in_progress, 只隔回执): 只留最后一张
{
  const update = (uuid, taskId, status) => ({
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'TaskUpdate', input: { taskId, status } }] },
  })
  const reminder = (uuid) => ({
    type: 'attachment',
    uuid,
    attachment: { type: 'task_reminder', content: [{ id: '51', subject: '写测试', status: 'completed' }, { id: '52', subject: '构建镜像', status: 'pending' }] },
  })
  const receipt = { type: 'user', uuid: 'k', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }
  const { plans } = taskProgress.buildTaskPlans([
    { entry: reminder('r1'), lineNo: 1 },
    { entry: update('t1', '51', 'completed'), lineNo: 2 },
    { entry: receipt, lineNo: 3 },
    { entry: update('t2', '52', 'in_progress'), lineNo: 4 },
  ])
  assert.equal(plans.size, 1, '背靠背 TaskUpdate 只留最后一张')
  assert.ok(plans.has('t2'), '计划挂在簇尾 TaskUpdate 卡上')
  const plan = plans.get('t2')
  assert.equal(plan.steps[1].status, 'in_progress')
}

// 5) 噪声过滤: task_state 载体与空 task_reminder 整卡隐藏
{
  assert.equal(classify.isHiddenJsonlNoiseEntry({ type: 'task_state', mobius: {} }), true)
  assert.equal(classify.isHiddenJsonlNoiseEntry({ type: 'attachment', attachment: { type: 'task_reminder', content: [] } }), true)
  assert.equal(classify.isHiddenJsonlNoiseEntry({ type: 'attachment', attachment: { type: 'task_reminder', content: [{ id: '1', subject: 'x', status: 'pending' }] } }), false)
  assert.equal(classify.isHiddenJsonlNoiseEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } }), false)
}

// 6) 摘要增强: "计划 · X/N · 标题"
{
  const plan = { steps: [{ step: '迁移 agents 为 TS', status: 'completed', id: '1' }], completed: 1, inProgress: 0, pending: 0 }
  const summary = summaries.resolveTaskHeaderSummary(taskUpdateEntry(), plan)
  assert.ok(summary)
  assert.ok(summary.short.includes('计划 · 1/1'), `summary=${summary.short}`)
  assert.ok(summary.short.includes('迁移 agents 为 TS'))
  assert.equal(summaries.resolveTaskHeaderSummary(taskUpdateEntry(), null), null)
  // 非任务卡不受影响
  assert.equal(summaries.resolveTaskHeaderSummary({ type: 'user', message: { content: 'hi' } }, plan), null)
}

console.log('task-progress-cards: all tests passed')
