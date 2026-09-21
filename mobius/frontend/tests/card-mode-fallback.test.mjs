/**
 * 卡片视图回落回归测试: 计划被上游摘走时不再卡在 'plan' 而铺原始 JSON.
 *
 * 背景 (2026-09-21): 任务推进簇去重 (task-progress ①) 只把计划留给簇尾那张卡,
 * 连发的 TaskCreate 中间仅隔工具回执 → 同一簇 → 先到货的卡计划被摘走。卡片当时的
 * mode 是挂载时取的一次性初值 ('plan'), 计划没了也不会回落, 渲染分支
 * `mode === 'plan' && planUpdate` 不成立 → 一路跌到最后的 `Object.entries(renderEntry)`,
 * 把原始 JSON 字段树铺出来 (且卡片仍是展开态)。
 *
 * 断言两层:
 *   ① task-progress: 连发任务调用只给簇尾留计划 (既有设计, 不在本次改动范围);
 *   ② card-mode: 被摘走计划的那张卡可检测出当前视图数据已消失, 且回落到精简摘要.
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

const cardMode = await bundle('card-mode.ts')
const taskProgress = await bundle('task-progress.ts')
const summaries = await bundle('header-summary.ts')

function taskCreate(uuid, subject) {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_' + uuid, name: 'TaskCreate', input: { subject, description: subject + ' 的详细说明', activeForm: '正在' + subject } }],
    },
  }
}

// 1) 首选链: 计划 > 初始 > 代码 > 图片 > 精简 > 字段
{
  assert.equal(cardMode.pickCardMode({ plan: true, initial: true, code: true, image: true, compact: true }), 'plan')
  assert.equal(cardMode.pickCardMode({ plan: false, initial: false, code: false, image: false, compact: true }), 'compact')
  assert.equal(cardMode.pickCardMode({ plan: false, initial: false, code: false, image: false, compact: false }), 'field')
  // 字段模式是原始 entry 兜底, 恒可用; 其它视图必须在数据到手时才算可用
  assert.equal(cardMode.isCardModeAvailable('field', { plan: false, initial: false, code: false, image: false, compact: false }), true)
  assert.equal(cardMode.isCardModeAvailable('plan', { plan: false, initial: false, code: false, image: false, compact: true }), false)
  assert.equal(cardMode.isCardModeAvailable('compact', { plan: false, initial: false, code: false, image: false, compact: true }), true)
}

// 2) 连发 TaskCreate (中间只隔回执) → 只有簇尾那张持有计划
{
  const { plans } = taskProgress.buildTaskPlans([
    { entry: taskCreate('tk1', '任务一'), lineNo: 1 },
    { entry: { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_tk1', content: 'ok' }] } }, lineNo: 2 },
    { entry: taskCreate('tk2', '任务二'), lineNo: 3 },
  ])
  assert.deepEqual([...plans.keys()], ['tk2'], '同簇只留簇尾一张计划卡')
  assert.equal(plans.get('tk1'), undefined, '先出现的卡计划被摘走')
}

// 3) 摘走计划的卡: 视图数据消失 → 回落到精简摘要 (而非停在 plan 铺 JSON)
{
  const head = taskCreate('tk1', '任务一')
  const headSummary = summaries.buildHeaderSummary(head)
  // 计划在手时 (刚挂载) 视图是计划模式
  const withPlan = { plan: true, initial: false, code: false, image: false, compact: headSummary.canCompact }
  assert.equal(cardMode.pickCardMode(withPlan), 'plan')
  // 下一张卡到货后计划被摘走: 同一张卡重新计算可用性
  const planGone = { plan: false, initial: false, code: false, image: false, compact: headSummary.canCompact }
  assert.equal(cardMode.isCardModeAvailable('plan', planGone), false, '计划视图数据已消失 → 必须回落')
  assert.equal(cardMode.pickCardMode(planGone), 'compact', '回落到精简摘要')
  // 短输入卡没有可精简的摘要 → 兜底字段模式 (始终折叠, 不再铺展开的 JSON 树)
  const noSummary = { plan: false, initial: false, code: false, image: false, compact: false }
  assert.equal(cardMode.isCardModeAvailable('plan', noSummary), false)
  assert.equal(cardMode.pickCardMode(noSummary), 'field')
}

// 4) 计划一直在手时不回落 (簇尾那张卡保持计划视图)
{
  const tail = taskCreate('tk2', '任务二')
  const tailSummary = summaries.buildHeaderSummary(tail)
  const availability = { plan: true, initial: false, code: false, image: false, compact: tailSummary.canCompact }
  assert.equal(cardMode.isCardModeAvailable('plan', availability), true)
  assert.equal(cardMode.pickCardMode(availability), 'plan')
}

// 5) 展开判定的折叠优先级: 无计划可铺的任务工具卡默认收起, 但搜索命中仍强制掀开
{
  const base = { mode: 'compact', forceOpen: false, parentOrderedCollapse: false, isPatchApply: false, canPlan: false, canInitial: false, canCode: false, canCompact: true, canImage: false, isErrorType: false, toolError: false }
  // 普通可精简卡: 默认展开 (既有规则)
  assert.equal(cardMode.resolveDesiredOpen({ ...base, taskToolCardWithoutPlan: false }), true)
  // 任务工具卡计划被摘走: 只有一行 tool_use JSON → 默认收起, 不再自动铺开
  assert.equal(cardMode.resolveDesiredOpen({ ...base, taskToolCardWithoutPlan: true }), false)
  // 搜索命中是显式查看, 压过该规则
  assert.equal(cardMode.resolveDesiredOpen({ ...base, forceOpen: true, taskToolCardWithoutPlan: true }), true)
  // 有计划的任务工具卡走计划视图 (默认展开)
  assert.equal(cardMode.resolveDesiredOpen({ ...base, canPlan: true, taskToolCardWithoutPlan: false }), true)
  // 工具失败"折叠不藏错误"仍是本地展开条件, 但无计划任务工具卡优先收起
  assert.equal(cardMode.resolveDesiredOpen({ ...base, toolError: true, taskToolCardWithoutPlan: false }), true)
  assert.equal(cardMode.resolveDesiredOpen({ ...base, toolError: true, taskToolCardWithoutPlan: true }), false)
}

console.log('card-mode-fallback: all assertions passed')
