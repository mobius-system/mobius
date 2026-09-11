/**
 * viewer/rounds.ts — 对话轮次分组的纯逻辑 (无 React 依赖). [已弃用]
 *
 * ⚠️ 前端不再分组: 组结构来自后端协议 ① (agent-history-store), 普通视图已迁组驱动.
 * 本文件只剩简易视图 (EasyJsonlView) 在用 — 简易视图迁组后整个文件删除,
 * jsonl-round-helpers.ts 的排除串常量同步退场 (后端两处副本一并清理).
 *
 * 从 jsonl-view.tsx 拆出. 每条 user entry 开启一个新"轮次"; 其后的 assistant/tool
 * 条目属于该轮的回复. "是否开新轮" 的核心判断复用 jsonl-round-helpers 的 isNewRound,
 * 这里只做"开篇用户文本去重"与"把 JsonlViewItem 装进 Round".
 */
import type { AnyEntry, JsonlViewItem, Round, RoundItem } from './types'
import { isNewRound } from '../jsonl-round-helpers'
import { QuestionTitle } from '../../../../backend/services/session-context-sections'

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

// 该 entry 是否为 mobius 边车写入的"干净原始输入"卡 (见 services/mobius-jsonl.ts 双轨记录):
// 边车存未经 context 包装的原文, 原生 jsonl 存包装后的全文.
function isMobiusSidecarUserEntry(e: AnyEntry): boolean {
  return e?.entrypoint === 'mobius' || e?.mobius?.kind === 'user_input'
}

// 判断 text 是否为 prevText 的"首轮 context 包装版" — wrapUserMessage (session-context.ts) 固定形态:
// <上下文正文>\n\n---\n\n## 用户的问题\n<原文> (英文为 User's Question, 文案唯一事实源在 session-context-sections).
// 原文之后可能还接 @提及的 <agent_reference> 等尾巴, 故用包含关系而非 endWith 判断.
function isWrappedVariant(text: string, prevText: string): boolean {
  if (!text || !prevText) return false
  return text.includes(`${QuestionTitle.zh}\n${prevText}`) || text.includes(`${QuestionTitle.en}\n${prevText}`)
}

/** @deprecated 读时内容推断分组已被后端"写入即开组"取代; 仅简易视图过渡使用. */
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
      // 首轮 context 包装去重: 同一条首条输入被双轨记录 (mobius 边车记"原始文本",
      // Claude Code 原生 jsonl 记"包装全文"). 包装全文出现且期间无 agent 输出 →
      // 以包装卡作首条消息、隐藏前面的原始文本卡; 包装全文从未出现则保留原始文本卡 (不变).
      const prevIsSidecar = !!prev && !!prev.items[0] && isMobiusSidecarUserEntry(prev.items[0].entry)
      if (text && prev && !prevHasAssistant && prevIsSidecar && isWrappedVariant(text, prevText)) {
        prev.items[0] = { ...(item as RoundItem), relIdx: 0 }
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
