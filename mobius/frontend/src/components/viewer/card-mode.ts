/**
 * viewer/card-mode.ts — 卡片展开视图 (mode) 的取值策略.
 *
 * 从 EntryCard 拆出的纯函数, 供组件与回归测试共用:
 *  - pickCardMode:        首选视图链 计划 > 初始 > 代码 > 图片 > 精简 > 字段;
 *  - isCardModeAvailable: 当前视图的数据是否还在 (字段模式是原始 JSON 兜底, 恒可用).
 *
 * 为什么需要 isCardModeAvailable: 计划视图的数据不在卡片自己手里 — 它来自 JsonlView
 * 顶层的 taskPlans 映射 (任务推进簇去重会把计划只留给簇尾那张卡)。卡片先到货时可能是
 * 簇尾 (有计划), 后一张到货就被摘走 — 此时必须能察觉并回落, 否则卡在 'plan' 会一路
 * 跌到最后的原始 JSON 字段树.
 */
import type { CardMode } from './types'

// 各专属视图的数据是否在手 (字段模式不参与, 见下).
export type CardModeAvailability = {
  plan: boolean
  initial: boolean
  code: boolean
  image: boolean
  compact: boolean
}

// 字段模式恒可用: 它铺的就是原始 entry, 任何卡片兜底都有得渲染.
export function isCardModeAvailable(mode: CardMode, availability: CardModeAvailability): boolean {
  if (mode === 'field') return true
  return availability[mode]
}

// 首选视图链 (与 EntryCard 的展开默认一致): 计划 > 初始 > 代码 > 图片 > 精简 > 字段.
export function pickCardMode(availability: CardModeAvailability): CardMode {
  if (availability.plan) return 'plan'
  if (availability.initial) return 'initial'
  if (availability.code) return 'code'
  if (availability.image) return 'image'
  if (availability.compact) return 'compact'
  return 'field'
}

/**
 * 单卡 open 的"系统期望值" — 所有展开/折叠条件合并到此一处判定, 优先级 (高 → 低):
 *   ① 字段模式       始终默认折叠 — 字段树不能被任何自动展开信号掀开.
 *   ② forceOpen       搜索命中        — 用户显式查看, 压过 parentOrderedCollapse.
 *   ③ parentOrderedCollapse    上下文折叠规则 (forgotten-flag / 加密 reasoning) — 默认折叠; 压过本地展开条件.
 *   ③' taskToolCardWithoutPlan 无计划可铺的任务工具卡 — 只剩一行 tool_use JSON, 不自动展开.
 *   ④ 本地展开条件     patch_apply / 计划(canPlan) / 纯文本卡(可精简·可图片·error 类型, 且非代码卡).
 *   ⑤ toolError       工具失败        — "折叠不藏错误"; 被 ①抑制.
 *   ⑥ 兜底            折叠.
 * 这是"系统期望"的单向判定; 实际 open 还受用户手动 onToggle 锁定 (见 EntryCard 的 userToggledRef).
 * 自动信号只"掀开"(ratchet, 不自动折回) — 字段模式保持折叠, 其它折叠仅来自初值 ③/③' 或用户手动.
 */
export function resolveDesiredOpen(opts: {
  mode: CardMode
  forceOpen: boolean
  parentOrderedCollapse: boolean
  isPatchApply: boolean
  canPlan: boolean
  canInitial: boolean
  canCode: boolean
  canCompact: boolean
  canImage: boolean
  isErrorType: boolean
  toolError: boolean
  // 没有计划可铺的任务工具卡 (计划被簇去重摘走): 只剩一行 tool_use JSON, 不自动展开.
  taskToolCardWithoutPlan: boolean
}): boolean {
  if (opts.forceOpen) return true       // 搜索命中是显式查看, 压过字段模式与其它折叠规则
  if (opts.mode === 'field') return false       // 字段模式永远不自动展开
  if (opts.parentOrderedCollapse) return false   // ② 上下文折叠规则
  if (opts.taskToolCardWithoutPlan) return false // 任务工具卡没有计划可铺 → 默认收起
  // ③ 本地展开条件: patch_apply / 计划 / 初始 / 纯文本卡(可精简·可图片·error 类型, 且非代码卡)
  if (opts.isPatchApply || opts.canPlan || opts.canInitial || (!opts.canCode && (opts.canCompact || opts.canImage || opts.isErrorType))) return true
  if (opts.toolError) return true       // ④ 工具失败
  return false                          // ⑤ 兜底折叠
}
