/**
 * viewer/visibility-rules.ts — 依赖相邻卡片上下文的展示过滤规则（纯逻辑，无 React 依赖）。
 *
 * 单卡噪声继续由 entry-classify.isHiddenJsonlNoiseEntry 处理；这里只处理必须先看到
 * 已过滤可见序列才能判断的规则。常规对话视图与概览浮窗都从这里取规则，避免两套筛选口径。
 */
import { isUnreadableEncryptedReasoningEntry } from './entry-classify'
import { extractInitialContext } from './initial-context'
import type { AnyEntry, JsonlViewItem } from './types'

/**
 * 连续出现的不可读加密 reasoning 卡片只保留最后一张。
 *
 * 输入必须是已经完成基础噪声过滤的可见卡片序列，因此被隐藏的生命周期事件不会
 * 错误地切断用户实际看到的连续段。普通卡片、可读 reasoning 或单独出现的加密
 * reasoning 会原样保留；每遇到一张其他可见卡片，下一段重新计算。
 */
export function hideRepeatedEncryptedReasoning(items: JsonlViewItem[]): JsonlViewItem[] {
  return items.filter((item, index) => {
    if (!isUnreadableEncryptedReasoningEntry(item.entry)) return true
    return !isUnreadableEncryptedReasoningEntry(items[index + 1]?.entry)
  })
}

/**
 * 返回"初始模式"卡片在序列中的下标；没有则返回 -1。
 *
 * 首轮用户消息被后端 session-context.ts 包装成大字符串，之前还会落一堆启动期 setup 卡片
 * （skills 清单 / 多智能体角色 / 环境上下文 / 边车原文卡）。这些卡片不命中
 * isHiddenJsonlNoiseEntry，只能靠"初始卡片之前一律不展示"这条序列规则拿掉。
 */
export function initialContextIndex(entries: AnyEntry[]): number {
  return entries.findIndex((entry) => extractInitialContext(entry) !== null)
}

/**
 * 截掉首轮"初始模式"卡片之前的全部卡片（该卡片本身保留）。
 *
 * 输入是已过滤可见序列；找不到初始卡片（非首轮、或初始卡片尚未加载）时原样返回。
 * 第一轮之后的轮次天然排在初始卡片之后，因此对全量摊平序列同样适用。
 */
export function trimBeforeInitialContext(entries: AnyEntry[]): AnyEntry[] {
  const index = initialContextIndex(entries)
  return index > 0 ? entries.slice(index) : entries
}
