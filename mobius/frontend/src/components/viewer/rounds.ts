/**
 * viewer/rounds.ts — 对话轮次分组的纯逻辑 (无 React 依赖).
 *
 * 从 jsonl-view.tsx 拆出. 每条 user entry 开启一个新"轮次"; 其后的 assistant/tool
 * 条目属于该轮的回复. "是否开新轮" 的核心判断复用 jsonl-round-helpers 的 isNewRound,
 * 这里只做"开篇用户文本去重"与"把 JsonlViewItem 装进 Round".
 */
import type { AnyEntry, JsonlViewItem, Round, RoundItem } from './types'
import { isNewRound } from '../jsonl-round-helpers'

const USER_QUESTION_MARKERS = [
  /(?:^|\n)\s*【?\s*##\s*用户的问题\s*】?\s*(?:\r?\n|$)/,
  /(?:^|\n)\s*【用户的问题】\s*(?:\r?\n|$)/,
  /(?:^|\n)\s*【?\s*##\s*User'?s Question\s*】?\s*(?:\r?\n|$)/i,
  /(?:^|\n)\s*【User'?s Question】\s*(?:\r?\n|$)/i,
]

// 提取一个"开新轮"候选条目里实际呈现给用户的原文, 三种格式对应同一次输入:
// mobius type:user / codex response_item.message[role=user] / codex event_msg.user_message.
function userTextOf(e: AnyEntry): string {
  if (e?.type === 'event_msg' && e?.payload?.type === 'user_message') {
    return String(e?.payload?.message || e?.payload?.content || '').trim()
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

function findUserQuestionMarker(text: string): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null
  for (const marker of USER_QUESTION_MARKERS) {
    const match = text.match(marker)
    if (match && match.index != null && (!best || match.index < best.index)) {
      best = { index: match.index, length: match[0].length }
    }
  }
  return best
}

function stripUserFraming(text: string): string {
  if (!text) return text
  const marker = findUserQuestionMarker(text)
  if (!marker) return text
  const after = text.slice(marker.index + marker.length).trim()
  return after || text
}

function canonicalUserText(text: string): string {
  return stripUserFraming(text).replace(/\s+/g, ' ').trim()
}

function isFramedUserText(text: string): boolean {
  return !!findUserQuestionMarker(text)
}

// 上一轮是否已经开始真正回复. developer / system 指令不算, 否则 wrapUserMessage
// 前的 Codex 系统消息会把「裸原文 + 带框架原文」拆成两轮.
function isAssistantOutput(e: AnyEntry): boolean {
  if (e?.type === 'assistant') return true
  if (e?.type === 'event_msg' && e?.payload?.type === 'agent_message') return true
  if (e?.type === 'response_item') {
    const pt = e?.payload?.type
    if (pt === 'function_call' || pt === 'function_call_output' || pt === 'custom_tool_call' || pt === 'custom_tool_call_output' || pt === 'reasoning') return true
    if (pt === 'message') return e?.payload?.role === 'assistant'
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
      // 去重: 同一次用户输入会以多种形态出现 (裸原文 / wrapUserMessage 框架 /
      // response_item.message[role=user] / event_msg.user_message). 用剥掉
      // 「## 用户的问题」之后的正文比较; 若相同且上一轮还没有 agent 输出, 视为同一轮.
      // 有框架的那条优先留下, 这样界面能折叠系统上下文, 而不是只剩一张裸气泡.
      const raw = userTextOf(e)
      const text = canonicalUserText(raw)
      const prev = rounds[rounds.length - 1]
      const prevRaw = prev ? userTextOf(prev.items[0]?.entry) : ''
      const prevText = canonicalUserText(prevRaw)
      const prevHasAssistant = !!prev && prev.items.some((it) => isAssistantOutput(it.entry))
      if (text && prev && text === prevText && !prevHasAssistant) {
        if (isFramedUserText(raw) && !isFramedUserText(prevRaw) && prev.items[0]) {
          prev.items[0] = { ...(item as RoundItem), relIdx: 0 }
        }
        continue
      }
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
