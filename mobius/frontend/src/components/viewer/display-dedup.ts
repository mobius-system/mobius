/**
 * viewer/display-dedup.ts — 展示层序列去重 (纯函数, 无 React 依赖).
 *
 * 旧"次要条目过滤" (session-jsonl-filter.ts) 里的类型判定已并入
 * entry-classify 的 isHiddenJsonlNoiseEntry (统一为无开关的一层);
 * 这里只保留其中需要序列上下文的展示规则, 作为常驻去重:
 *
 * 开轮卡优先 (最高优先级, 压过下面全部规则): 开轮卡 (Mobius 发送链路写的 user 卡, 见
 * utils.isRoundOpenerEntry) 是"这一轮在问什么"的权威载体, 与其它形态同文冲突时一律保它、
 * 藏对方 —— 否则用户看到的首卡会退化成 agent 侧的原生副本.
 *
 * 其余三条:
 *   1. 连续重复条目折叠 (claude-code 偶发逐字节重写)
 *   2. codex event_msg.user_message 镜像已见过的 user 卡 → 藏镜像
 *   3. 非开轮的 mobius 原文卡 (系统提醒等) 与原生 user 卡同文 → 藏 mobius 卡
 */
import type { AnyEntry } from './types'
import { isRoundOpenerEntry } from './utils'

// 序号类字段不参与重复判定 (行号每次读取都变).
const JSONL_SEQUENCE_KEYS = new Set(['line_no', 'lineNo', '_line_no', '_lineNo', '__line_no', '__lineNo'])

/*
 * Recursively normalise a value for duplicate comparison: keys sorted, volatile keys dropped.
 * Two entries equal after this pass are byte-identical as far as the viewer is concerned.
 */
function normalizeForDuplicateCheck(value: any, depth = 0): any {
  // 标量直接返回，下面只处理对象与数组
  // Scalars are returned as-is, only objects and arrays need normalising below
  if (value === null || typeof value !== 'object') return value
  // 数组逐项规范化，保持元素顺序
  // Arrays normalise element by element, order preserved
  if (Array.isArray(value)) return value.map((item) => normalizeForDuplicateCheck(item, depth + 1))
  const out: Record<string, any> = {}
  // 键排序后再递归，保证同内容不同书写顺序产出同一签名
  // Keys are sorted before recursing so the same content always yields the same signature
  for (const key of Object.keys(value).sort()) {
    // 只剥顶层的序号键，嵌套在同名键下的真实内容照常参与比较
    // Sequence keys are dropped at the top level only, nested same-named keys still count
    if (depth === 0 && JSONL_SEQUENCE_KEYS.has(key)) continue
    out[key] = normalizeForDuplicateCheck(value[key], depth + 1)
  }
  return out
}

/*
 * Stable string identity of an entry, used to collapse consecutive byte-identical rows.
 * Never throws: an unserialisable entry falls back to String(entry).
 */
function duplicateSignature(entry: any): string {
  try {
    const encoded = JSON.stringify(normalizeForDuplicateCheck(entry))
    return typeof encoded === 'string' ? encoded : String(entry)
  } catch {
    // 循环引用等无法序列化的条目退回对象字符串，宁可漏折叠也不抛错
    // An unserialisable entry (cycles) falls back to String(entry) instead of throwing
    return String(entry)
  }
}

/*
 * Plain-string user text of an entry, or null when the entry is not a user card or carries
 * structured content (arrays / image blocks are not compared by text).
 */
function userContentOf(entry: any): string | null {
  // 非 user 卡不参与文本比较
  // Anything that is not a user card takes no part in text comparison
  if (entry?.type !== 'user') return null
  const content = entry?.message?.content
  // 只有纯字符串正文才算可比文本，数组（含 tool_result / 图片块）一律跳过
  // Only plain-string content compares; arrays (tool_result, image blocks) are skipped
  return typeof content === 'string' ? content : null
}

/*
 * True when the entry was written by the Mobius send path (it carries the "mobius" block),
 * which distinguishes the sidecar original from the agent's own copy of the same message.
 */
function entryHasMobiusField(entry: any): boolean {
  // 必须用 hasOwnProperty："mobius" 出现在原型链上不算，且空 mobius 块视为没有
  // Requires hasOwnProperty: inherited "mobius" does not count and an empty block is falsy
  return Boolean(entry && Object.prototype.hasOwnProperty.call(entry, 'mobius') && entry.mobius)
}

/*
 * Returns the ordered entries with display-level duplicates removed.
 * The round-opener card wins every collision: when another form of the same user input exists
 * (native copy, codex mirror, rewritten row) the opener is kept and the other form is hidden.
 * Callers: the standard viewer runs it once per group window, the easy viewer once per window.
 */
export function filterDisplayDuplicates(entries: AnyEntry[]): AnyEntry[] {
  // 先全量收集文本，双卡可能乱序到达
  // Collect the texts up front, the twin cards may arrive in either order
  const openerContents = new Set<string>()
  const plainUserContents = new Set<string>()
  for (const entry of entries) {
    if (entry?.type !== 'user') continue
    const content = userContentOf(entry)
    if (content === null) continue
    // 开轮卡文本优先级最高，其余算作原生卡文本
    // Opener texts rank first, every other user card counts as a native card
    if (isRoundOpenerEntry(entry)) openerContents.add(content)
    else if (!entryHasMobiusField(entry)) plainUserContents.add(content)
  }

  const out: AnyEntry[] = []
  const seenUserMessages = new Set<string>()
  let prevSignature: string | null = null
  for (const entry of entries) {
    const signature = duplicateSignature(entry)
    // 同签名必然同 kind，开轮状态也相同，直接折叠留第一条
    // One signature implies one kind and one opener status, so the first row simply wins
    if (signature === prevSignature) continue
    prevSignature = signature

    // codex 镜像复述了开轮卡或已见文本，整条藏掉
    // A codex mirror repeating an opener or an already-seen text is hidden
    if (entry?.type === 'event_msg') {
      const message = entry?.payload?.message
      if (typeof message === 'string' && (openerContents.has(message) || seenUserMessages.has(message))) continue
    }
    // 与开轮卡同文的其它 user 卡一律让位，Web 与 TUI 保持同一优先级
    // Every other user card sharing the opener's text gives way, matching the TUI rule
    if (entry?.type === 'user' && !isRoundOpenerEntry(entry)) {
      const content = userContentOf(entry)
      if (content !== null && openerContents.has(content)) continue
    }
    // 非开轮的 mobius 卡（系统提醒等）沿用旧规则：同文则藏它
    // A non-opener mobius card (system reminders) still hides itself on a text twin
    if (entry?.type === 'user' && entryHasMobiusField(entry) && !isRoundOpenerEntry(entry)) {
      const content = userContentOf(entry)
      if (content !== null && plainUserContents.has(content)) continue
    }

    const userMessage = userContentOf(entry)
    if (userMessage !== null) seenUserMessages.add(userMessage)
    // ✨ 核心：通过全部规则后输出这一条，保持原顺序
    // ✨ Core: emit the entry once every rule lets it through, order preserved
    out.push(entry)
  }
  return out
}
