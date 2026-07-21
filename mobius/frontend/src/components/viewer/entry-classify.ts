/**
 * viewer/entry-classify.ts — entry 的布尔型分类谓词 + tour target + assistant 文本抽取.
 *
 * 从 jsonl-view.tsx 拆出. 这里只回答"这条 entry 是不是 X" (Edit/Bash/start.py/Read/
 * context_compacted/end_turn/本地命令/关键词命中…), 以及给引导路线用的 data-tour 目标.
 * 数据抽取 (返回结构化对象) 在 ./entry-extract; 标题摘要文本在 ./header-summary.
 */
import type { AnyEntry } from './types'
import { extractLocalCommandParts, functionCallCommand, functionOutputBody, extractPlanUpdate } from './entry-extract'

// 该 entry 是否为 "assistant 发起的 Edit tool_use" (即 message.content 里有 type==='tool_use' 且 name==='Edit').
export function isEditToolUse(entry: AnyEntry): boolean {
  if (entry?.type !== 'assistant') return false
  const c = entry?.message?.content
  return Array.isArray(c) && c.some((b: any) => b?.type === 'tool_use' && b?.name === 'Edit')
}

export function isContextCompactedEvent(entry: AnyEntry): boolean {
  return entry?.type === 'event_msg' && entry?.payload?.type === 'context_compacted'
}

export function isTokenCountEvent(entry: AnyEntry): boolean {
  return entry?.type === 'event_msg' && entry?.payload?.type === 'token_count'
}

export function isAssistantEndTurnEntry(entry: AnyEntry): boolean {
  return entry?.type === 'assistant' && entry?.message?.stop_reason === 'end_turn'
}

// codex 计划模式: response_item payload.type==='function_call' && payload.name==='update_plan',
// 且 arguments 能解析出非空 plan 数组.
export function isPlanUpdateEntry(entry: AnyEntry): boolean {
  return extractPlanUpdate(entry) !== null
}

export function assistantResponseText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b: any) => {
      if (!b || typeof b !== 'object') return ''
      if (typeof b.text !== 'string') return ''
      return b.type === 'text' || b.type === 'output_text' ? b.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

// 特例: assistant 响应文本命中这些关键词时整卡复用 gold 主题.
// 只检查 assistant 文本响应, 不把 tool_use/input.command 当作本规则的命中范围.
export const ASSISTANT_RESPONSE_GOLD_KEYWORDS = ['根因', 'start.py']

// 该 entry 是否为 "assistant 响应文本命中重点关键词".
export function isAssistantResponseGoldKeyword(entry: AnyEntry): boolean {
  let text = ''
  if (entry?.type === 'assistant') {
    text = assistantResponseText(entry?.message?.content)
  } else if (
    entry?.type === 'response_item' &&
    entry?.payload?.type === 'message' &&
    entry?.payload?.role === 'assistant'
  ) {
    text = assistantResponseText(entry?.payload?.content)
  }
  return !!text && ASSISTANT_RESPONSE_GOLD_KEYWORDS.some((keyword) => text.includes(keyword))
}

export function assistantEntryText(entry: AnyEntry): string {
  if (entry?.type === 'assistant') return assistantResponseText(entry?.message?.content)
  if (
    entry?.type === 'response_item' &&
    entry?.payload?.type === 'message' &&
    entry?.payload?.role === 'assistant'
  ) {
    return assistantResponseText(entry?.payload?.content)
  }
  return ''
}

export function jsonEntryTourTarget(entry: AnyEntry): string | undefined {
  const type = entry?.type
  const payload = entry?.payload
  const assistantText = assistantEntryText(entry)

  if (
    assistantText &&
    assistantText.includes('dot-logo-3d') &&
    (
      assistantText.includes('/extension/dot-logo-3d/') ||
      assistantText.includes('extension.json') ||
      assistantText.includes('拓展插件') ||
      assistantText.includes('特殊应用')
    )
  ) {
    return 'session-log-logo-extension-answer-card'
  }

  if (type === 'user') return 'session-log-user-card'
  if (type === 'assistant') return 'session-log-assistant-card'
  if (type === 'session_meta') return 'session-log-session-meta-card'
  if (type === 'turn_context') return 'session-log-turn-context-card'

  if (type === 'event_msg') {
    if (payload?.type === 'token_count') return 'session-log-event-token-count-card'
    if (payload?.type === 'user_message') return 'session-log-event-user-card'
    if (payload?.type === 'agent_message') return 'session-log-event-agent-card'
    return 'session-log-event-card'
  }

  if (type === 'response_item') {
    const payloadType = payload?.type
    if (payloadType === 'reasoning') return 'session-log-response-reasoning-card'
    if (payloadType === 'message') {
      if (payload?.role === 'assistant') return 'session-log-response-assistant-card'
      if (payload?.role === 'user') return 'session-log-response-user-card'
      return 'session-log-response-message-card'
    }
    if (payloadType === 'function_call') {
      if (payload?.name === 'update_plan') return 'session-log-response-plan-card'
      const commandText = functionCallCommand(payload) || String(payload?.arguments || '')
      if (commandText.includes('extension.json') || commandText.includes('AGENT_OUTPUT_GUIDE.md')) {
        return 'session-log-logo-file-tool-call-card'
      }
      return 'session-log-response-tool-call-card'
    }
    if (payloadType === 'function_call_output') {
      const outputText = functionOutputBody(payload?.output)
      if (outputText.includes('dot-logo-3d') || outputText.includes('extension.json') || outputText.includes('AGENT_OUTPUT_GUIDE.md')) {
        return 'session-log-logo-file-tool-result-card'
      }
      return 'session-log-response-tool-result-card'
    }
    return 'session-log-response-card'
  }

  return undefined
}

// ── 本地命令谓词 (compact 完成 / goal 设置 / 其它本地命令) ──────────────
// compact 完成信号: local-command-stdout 正文以 "Compacted" 开头 (一次对话上下文压缩完成). 返回其正文或 null.
function extractCompactDone(entry: AnyEntry): string | null {
  const stdout = extractLocalCommandParts(entry).find((p) => p.tag === 'local-command-stdout')
  return stdout && /^compacted/i.test(stdout.body) ? stdout.body : null
}

export function isCompactDoneEntry(entry: AnyEntry): boolean {
  return extractCompactDone(entry) !== null
}

// /goal 命令的输出信号: local-command-stdout 正文以 "Goal set" 开头 (用户设了新目标). 返回去掉前缀的目标内容 (或原文) 或 null.
function extractGoalSet(entry: AnyEntry): string | null {
  const stdout = extractLocalCommandParts(entry).find((p) => p.tag === 'local-command-stdout')
  if (!stdout || !/^goal\s*set/i.test(stdout.body)) return null
  const goal = stdout.body.replace(/^goal\s*set:?\s*/i, '').trim()
  return goal || stdout.body
}

export function isGoalSetEntry(entry: AnyEntry): boolean {
  return extractGoalSet(entry) !== null
}

export function isLocalCommandEntry(entry: AnyEntry): boolean {
  return extractLocalCommandParts(entry).length > 0
}
