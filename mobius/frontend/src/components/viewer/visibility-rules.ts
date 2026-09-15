/**
 * viewer/visibility-rules.ts — 依赖相邻卡片上下文的展示过滤规则（纯逻辑，无 React 依赖）。
 *
 * 单卡噪声继续由 entry-classify.isHiddenJsonlNoiseEntry 处理；这里只处理必须先看到
 * 已过滤可见序列才能判断的规则。
 */
import { isUnreadableEncryptedReasoningEntry } from './entry-classify'
import type { JsonlViewItem } from './types'

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
