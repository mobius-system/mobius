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

// 2) 前端兜底累积: TaskCreate → TaskUpdate 跨条目
{
  const plans = taskProgress.buildTaskPlans([
    { entry: taskCreateEntry(), lineNo: 1 },
    { entry: taskUpdateEntry(), lineNo: 2 },
  ])
  const planA = plans.get(uuidA)
  const planB = plans.get(uuidB)
  assert.ok(planA, 'TaskCreate 卡应有计划')
  assert.ok(planB, 'TaskUpdate 卡应有计划')
  assert.equal(planA.steps.length, 1)
  assert.equal(planA.steps[0].step, '迁移 agents 为 TS')
  assert.equal(planA.steps[0].status, 'pending', 'TaskCreate 时刻任务尚 pending')
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
  const plans = taskProgress.buildTaskPlans([
    { entry: taskCreateEntry(), lineNo: 1 },
    { entry: taskUpdateEntry(), lineNo: 2 },
    { entry: snapshotEntry, lineNo: 3 },
  ])
  const planB = plans.get(uuidB)
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
  const plans = taskProgress.buildTaskPlans([
    { entry: reminderEntry, lineNo: 1 },
    { entry: taskUpdateEntry(), lineNo: 2 },
  ])
  // TaskUpdate taskId=1 在 reminder 表 (只有 id=5) 中不存在 → 宽松建条
  const planB = plans.get(uuidB)
  assert.ok(planB)
  assert.equal(planB.steps.length, 2)
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
