/**
 * viewer/rounds.ts — 对话轮次分组的纯逻辑 (无 React 依赖).
 *
 * 从 jsonl-view.tsx 拆出. 每条 user entry 开启一个新"轮次"; 其后的 assistant/tool
 * 条目属于该轮的回复. "是否开新轮" 的核心判断复用 jsonl-round-helpers 的 isNewRound,
 * 这里只做"开篇用户文本去重"与"把 JsonlViewItem 装进 Round".
 */
import type { AnyEntry, JsonlViewItem, Round, RoundItem } from './types'
import { isNewRound } from '../jsonl-round-helpers'

// 提取一个"开新轮"候选条目里实际呈现给用户的归一化文本, 仅用于 buildRounds 内部去重比较.
// 三种格式对应同一次输入: mobius type:user / codex response_item.message[role=user] / codex event_msg.user_message.
function userTextOf(e: AnyEntry): string {
  if (e?.type === 'event_msg' && e?.payload?.type === 'user_message') {
    return String(e?.payload?.message || '').trim()
  }
  if (e?.type === 'response_item' && e?.payload?.type === 'message' && e?.payload?.role === 'user') {
    const c = e?.payload?.content
    if (typeof c === 'string') return c.trim()
    if (Array.isArray(c)) return c.map((b: any) => b?.text || b?.input_text || '').filter(Boolean).join('\n').trim()
    return ''
  }
  if (e?.type === 'user') {
    const c = e?.message?.content
    if (typeof c === 'string') return c.trim()
    if (Array.isArray(c)) return c.filter((b: any) => b?.type === 'text').map((b: any) => b?.text || '').join('\n').trim()
    return ''
  }
  return ''
}

// 该 entry 是否承载 agent 侧输出 — 用来判断上一轮"是否已经开始接收回复"(用以拒绝把真正的二次提问误判为重复入口).
function isAssistantOutput(e: AnyEntry): boolean {
  if (e?.type === 'assistant') return true
  if (e?.type === 'event_msg' && e?.payload?.type === 'agent_message') return true
  if (e?.type === 'response_item') {
    const pt = e?.payload?.type
    if (pt === 'function_call' || pt === 'function_call_output' || pt === 'reasoning') return true
    if (pt === 'message') {
      const role = e?.payload?.role
      return !!role && role !== 'user'
    }
  }
  return false
}

export function buildRounds(
  visibleItems: JsonlViewItem[],
): { preItems: JsonlViewItem[]; rounds: Round[] } {
  const preItems: JsonlViewItem[] = []
  const rounds: Round[] = []
  for (const item of visibleItems) {
    const e = item.entry
    if (isNewRound(e)) {
      // 去重: 同一次用户输入会以多种形态出现 (mobius type:user 写一条, codex 紧接着写
      // response_item.message[role=user] + event_msg.user_message). 若上一轮的"开篇用户
      // 文本"与当前候选相同, 且上一轮还没出现任何 agent 输出, 则视为同一轮的重复入口,
      // 直接丢弃而不开新轮 — 既避免生成中出现 10.0 / 11.0 重复条目, 也不会误合并真正的二次提问.
      const text = userTextOf(e)
      const prev = rounds[rounds.length - 1]
      const prevText = prev ? userTextOf(prev.items[0]?.entry) : ''
      const prevHasAssistant = !!prev && prev.items.some((it) => isAssistantOutput(it.entry))
      if (text && prev && text === prevText && !prevHasAssistant) continue
      rounds.push({ roundNum: rounds.length + 1, items: [] })
    }
    if (rounds.length === 0) {
      preItems.push(item)
    } else {
      const cur = rounds[rounds.length - 1]
      cur.items.push({ ...(item as RoundItem), relIdx: cur.items.length })
    }
  }
  return { preItems, rounds }
}
