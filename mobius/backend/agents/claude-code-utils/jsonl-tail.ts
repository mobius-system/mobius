/**
 * claude-code-utils/jsonl-tail.ts — Read the tail of a claude transcript and
 * turn it into "is the turn still running" / "what is still queued".
 *
 * Both questions are answered from the same trailing window, so the window
 * size and the read itself live here once instead of being copied into each
 * caller. Reading is a plain file read (no tmux), and the window is bounded,
 * so a 100MB transcript costs the same as a small one.
 */
import fs from 'fs'

import { CLAUDE_WORKING_TAIL_BYTES, MAX_PENDING_SCAN_ENTRIES } from './constants'
import { isCompactCompletionUserEvent } from './pane-status'

/** One enqueued request that has not been consumed yet. */
export interface PendingRequest {
  content: string
  enqueuedAt: string | null
}

/*
 * Read the last `maxBytes` of a jsonl file and split it into non-empty lines.
 * The first line is possibly cut in half; every caller skips it by failing
 * to JSON.parse it.
 * Returns null when the file is missing, empty or unreadable, which every
 * caller reads as "nothing to say".
 */
export function readJsonlTail(filePath: string, maxBytes: number = CLAUDE_WORKING_TAIL_BYTES): string[] | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const stat = fs.statSync(filePath)
    if (stat.size === 0) return null
    // 只读尾部若干字节，首行被截断就靠解析跳过
    // Read the tail only; a cut first line is skipped by the parse
    const len = Math.min(stat.size, maxBytes)
    const buf = Buffer.alloc(len)
    const fd = fs.openSync(filePath, 'r')
    try { fs.readSync(fd, buf, 0, len, stat.size - len) } finally { fs.closeSync(fd) }
    return buf.toString('utf8').split('\n').filter(Boolean)
  } catch {
    return null
  }
}

/*
 * Whether the transcript's tail proves a turn is still running.
 *
 * The scan is a whitelist, deliberately not "skip the types we know are
 * noise": only
 *   - assistant — no stop_reason or 'tool_use' still running; end_turn /
 *     max_tokens / stop_sequence done
 *   - user — a human turn arrived and has not been answered yet
 *   - system — only init / hook_started / hook_response, i.e. a turn is starting
 * decide the state, and every other type (attachment, last-prompt,
 * custom-title, permission-mode, file-history-snapshot, queue-operation, plus
 * whatever metadata the TUI or gateway adds later) is ignored, so a new
 * metadata type can no longer break the check.
 *
 * One trap inside the user case: /compact is bookkeeping written as synthetic
 * user records, so its completion receipt must be read as an end_turn (see
 * isCompactCompletionUserEvent) or an idle TUI stays "working" forever.
 *
 * Returns null when no record decides the question. The caller then falls
 * back to the pane, because the jsonl cannot express "waiting for background
 * agents".
 */
export function turnRunningFromTail(lines: string[]): boolean | null {
  // 自下往上扫，最近的一条白名单记录才代表当前状态
  // Scan bottom-up, the nearest whitelisted record is the current state
  for (let i = lines.length - 1; i >= 0; i--) {
    let e
    try { e = JSON.parse(lines[i]) } catch { continue }
    if (e.type === 'assistant') {
      // 缺stop_reason或tool_use即未结束
      // Missing stop_reason or tool_use means still running
      const sr = e.message?.stop_reason
      return !sr || sr === 'tool_use'
    }
    if (e.type === 'user') {
      // compact完成回执要当作结束
      // The compact completion receipt counts as an end
      if (isCompactCompletionUserEvent(e)) return false
      return true
    }
    if (e.type === 'system') {
      const sub = e.subtype
      // 只认这三个子类型，其余一律跳过
      // Only these three subtypes count, every other is skipped
      if (sub === 'init' || sub === 'hook_started' || sub === 'hook_response') return true
    }
  }
  return null
}

/*
 * Normalize request text into a comparison-stable form: collapse every whitespace run to a single
 * space and trim the ends. Claude Code rewrites a prompt when it persists it to the jsonl
 * transcript (re-wrapping lines, adding indentation), so the text read back never matches the
 * bytes we sent — comparing the normalized forms is what makes "same request" decidable at all.
 */
export function normalizeRequestText(value: unknown) {
  // 非字符串一律当空，防止畸形条目抛出
  // Anything that is not a string becomes empty, so malformed entries cannot throw
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/*
 * Pull the request text out of a jsonl entry that proves a queued request was consumed, so it can
 * be matched against the queue. Only two entry shapes carry the text: type:user (the request was
 * typed while the agent sat idle) and attachment.type:queued_command (it was injected mid-turn
 * while the agent was busy). Everything else returns '' and is read as "no evidence".
 */
export function consumedRequestSignature(entry: any) {
  // 非法输入没有内容可提取
  // A non-object entry has no content to extract
  if (!entry || typeof entry !== 'object') return ''
  if (entry.type === 'user') {
    const c = entry.message?.content
    if (typeof c === 'string') return normalizeRequestText(c)
    if (Array.isArray(c)) {
      // 内容块数组里只有 text 块含请求文本，其余块类型忽略
      // Only text blocks carry the request; other block types are ignored
      const text = c
        .filter((b) => b && typeof b === 'object' && b.type === 'text')
        .map((b) => b.text || '')
        .join('\n')
      return normalizeRequestText(text)
    }
    // 是 user 条目但没有可用 content，同样不算证据
    // A user entry with no usable content proves nothing either
    return ''
  }
  if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
    const a = entry.attachment
    // 三种字段名任一存在即可，兼容不同的写入形状
    // Any one of the three field names may appear; tolerate all write shapes
    return normalizeRequestText(a.content || a.text || a.command || '')
  }
  return ''
}

/*
 * Decide whether a queued request and a consumed entry are the same request: identical full
 * signatures, or one signature fully containing the other (an agent may wrap the prompt it
 * echoes back). Matching on full text instead of a prefix fingerprint is deliberate — many mobius
 * prompts open with the same boilerplate, so prefix matching would collapse distinct tasks into
 * one another and drop live requests.
 */
export function isSameQueuedRequest(sigA: string, sigB: string) {
  // 空签名表示"无证据"，不参与相等判断
  // An empty signature means "no evidence" and never counts as a match
  if (!sigA || !sigB) return false
  if (sigA === sigB) return true
  // 包含关系在短签名上极易误判，容器一侧必须够长
  // Containment is unreliable on short signatures; the container side must be long enough
  if (sigA.length >= 40 && sigB.includes(sigA)) return true
  if (sigB.length >= 40 && sigA.includes(sigB)) return true
  return false
}

/*
 * Prompts enqueued in Claude Code's in-memory queue that have not been consumed
 * yet, in enqueue order; [] means nothing is queued.
 *
 * Guide (issue_knowledge/d1600424): enqueue = enqueued; the same request later
 * appearing as type:user (consumed directly while idle) or
 * attachment.type:queued_command (injected mid-turn while busy) = consumed, no
 * longer pending. dequeue/remove carry no content and cannot serve as a
 * "delivered" ACK, so they never decide it.
 *
 * The scan runs backwards because pending requests sit at the tail and a
 * consumption always follows its enqueue: an in-window consumption is
 * therefore already recorded before its enqueue is examined, and a consumed
 * request can never be misread as pending. Truncation can at worst hide a
 * deeply buried pending one, which is accepted as best-effort.
 *
 * Matching is safe from send-mirror pollution: the mobius decoration entries
 * live in .mobius.jsonl, not in this native transcript.
 */
export function parsePendingRequests(tailLines: string[]): PendingRequest[] {
  const recent = tailLines.slice(-MAX_PENDING_SCAN_ENTRIES)
  const consumedSigs: string[] = []
  const pending: PendingRequest[] = []
  for (let i = recent.length - 1; i >= 0; i--) {
    let e
    try { e = JSON.parse(recent[i]) } catch { continue }
    if (!e || typeof e !== 'object') continue

    // 先收消费证据，倒序里它排在对应enqueue之前
    // Collect consumption first: it precedes its enqueue in reverse
    const consumedSig = consumedRequestSignature(e)
    if (consumedSig) { consumedSigs.push(consumedSig); continue }

    if (e.type === 'queue-operation' && e.operation === 'enqueue') {
      const content = typeof e.content === 'string' ? e.content : null
      if (!content) continue
      const sig = normalizeRequestText(content)
      if (!consumedSigs.some((cs) => isSameQueuedRequest(sig, cs))) {
        pending.push({ content, enqueuedAt: e.timestamp || null })
      }
    }
  }
  // 倒序收集，翻回入队顺序（最早排队的在前）
  // Collected in reverse, flip back to enqueue order (oldest pending first)
  pending.reverse()
  return pending
}
