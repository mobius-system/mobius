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

export type BuildRoundsOptions = {
  preferFramedUser?: boolean
}

// 提取一个"开新轮"候选条目里实际呈现给用户的文本, 仅用于 buildRounds 内部去重比较.
// 三种格式对应同一次输入: mobius type:user / codex response_item.message[role=user] / codex event_msg.user_message.
function userTextOf(e: AnyEntry, preferFramedUser: boolean): string {
  if (e?.type === 'event_msg' && e?.payload?.type === 'user_message') {
    return String(e?.payload?.message || (preferFramedUser ? e?.payload?.content : '') || '').trim()
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

function canonicalUserText(text: string): string {
  if (!text) return text
  const marker = findUserQuestionMarker(text)
  const unframed = marker
    ? text.slice(marker.index + marker.length).trim() || text
    : text
  return unframed.replace(/\s+/g, ' ').trim()
}

function isFramedUserText(text: string): boolean {
  return !!findUserQuestionMarker(text)
}

// 该 entry 是否承载 agent 侧输出 — 用来判断上一轮"是否已经开始接收回复"(用以拒绝把真正的二次提问误判为重复入口).
function isAssistantOutput(e: AnyEntry, preferFramedUser: boolean): boolean {
  if (e?.type === 'assistant') return true
  if (e?.type === 'event_msg' && e?.payload?.type === 'agent_message') return true
  if (e?.type === 'response_item') {
    const pt = e?.payload?.type
    if (pt === 'function_call' || pt === 'function_call_output' || pt === 'custom_tool_call' || pt === 'custom_tool_call_output' || pt === 'reasoning') return true
    if (pt === 'message') {
      const role = e?.payload?.role
      return preferFramedUser ? role === 'assistant' : !!role && role !== 'user'
    }
  }
  return false
}

export function buildRounds(
  visibleItems: JsonlViewItem[],
  options: BuildRoundsOptions = {},
): { preItems: JsonlViewItem[]; rounds: Round[] } {
  const preferFramedUser = options.preferFramedUser === true
  const preItems: JsonlViewItem[] = []
  const rounds: Round[] = []
  for (const item of visibleItems) {
    const e = item.entry
    if (isNewRound(e)) {
      // 默认沿用正常模式的原文全等去重。Easy 模式显式打开 preferFramedUser 后，
      // 则剥掉「## 用户的问题」框架比较正文，并优先保留带框架的条目，供界面折叠注入上下文。
      const raw = userTextOf(e, preferFramedUser)
      const text = preferFramedUser ? canonicalUserText(raw) : raw
      const prev = rounds[rounds.length - 1]
      const prevRaw = prev ? userTextOf(prev.items[0]?.entry, preferFramedUser) : ''
      const prevText = preferFramedUser ? canonicalUserText(prevRaw) : prevRaw
      const prevHasAssistant = !!prev && prev.items.some((it) => isAssistantOutput(it.entry, preferFramedUser))
      // 首条消息常见顺序: Codex 先写下裸原文, 中间夹 reasoning / 401 agent_message,
      // Mobius 稍后才补上 wrapUserMessage 框架。这类 "framed 覆盖同题裸原文" 是同一轮,
      // 不能因为中间噪声就被拆成两张用户气泡。
      const upgradeToFramed = preferFramedUser && isFramedUserText(raw) && !isFramedUserText(prevRaw)
      if (text && prev && text === prevText && (!prevHasAssistant || upgradeToFramed)) {
        if (upgradeToFramed && prev.items[0]) {
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
