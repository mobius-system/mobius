/**
 * viewer/header-summary.ts — jsonl 卡片标题栏摘要的构建 (纯函数, 无 React 依赖).
 *
 * 从 jsonl-view.tsx 拆出. 每种 entry type / tool_use 形态都有一条"一行摘要"规则,
 * 供卡片标题栏快扫. full 是不截断版 (精简模式正文), short 是给标题栏一行用的截断版.
 */
import type { AnyEntry, HeaderSummary, LocalCommandPart } from './types'
import {
  escapeMarkdownText,
  compactInlineList,
  codeFence,
  parseFunctionCallArguments,
  isNonEmptyString,
  basename,
} from './utils'
import {
  extractLocalCommandParts,
  summarizeWriteToolInput,
  functionCallCommand,
  functionOutputBody,
  isFunctionCallPayload,
  isFunctionCallOutputPayload,
  isReadToolUseName,
  extractReadCallFromBlock,
  readCallOneLineSummary,
  extractBashCalls,
  extractBashCallFromBlock,
  bashCallOneLineSummary,
  isBashToolUseName,
  extractPlanUpdate,
  extractTaskReminder,
  summarizePlanUpdate,
} from './entry-extract'

// 阈值=80: 一行 summary 在常规桌面宽度下大概 80~100 字就会被 CSS truncate 截断,
// 比 JS slice 阈值低更稳, 否则会出现"视觉上 ... 但 JS 判定没截断 → 没精简模式入口"的脱节.
const HEADER_SHORT_LIMIT = 160
const HEADER_COMPACT_LIMIT = 40
const ENCRYPTED_REASONING_LABEL = 'Reasoning (闭源模型的推理过程被加密，无法解码）'

export function clip(text: string, limit: number = HEADER_SHORT_LIMIT): HeaderSummary {
  const s = text || ''
  // 多行内容一行肯定装不下 → 直接判 truncated, short 把 \n 替换为空格保持单行
  const truncated = s.length > limit || s.includes('\n')
  const canCompact = s.length > HEADER_COMPACT_LIMIT || s.includes('\n')
  const replace_line_break = s.replace(/\s+/g, ' ').trim()
  const short = truncated ? replace_line_break.slice(0, limit) : s
  const shortTail = truncated ? replace_line_break.slice(replace_line_break.length - limit, replace_line_break.length) : s
  return { short, shortTail:shortTail, full: s, truncated, canCompact }
}

function buildTaskReminderSummary(entry: AnyEntry): HeaderSummary | null {
  if (entry?.type !== 'attachment') return null
  const attachment = entry.attachment
  if (!attachment || attachment.type !== 'task_reminder') return null
  const content = attachment.content
  if (!Array.isArray(content) || content.length < 1) return null
  if (!content.every((item: any) => isNonEmptyString(item?.subject) && isNonEmptyString(item?.description))) return null

  const sections = content.map((item: any, index: number) => {
    const lines: string[] = []
    const id = isNonEmptyString(item.id) ? ` \`#${item.id.trim().replace(/`/g, '\\`')}\`` : ''
    lines.push(`**${escapeMarkdownText(item.subject.trim())}**${id}`)
    lines.push('')
    lines.push(escapeMarkdownText(item.description.trim()))
    if (isNonEmptyString(item.activeForm)) {
      lines.push('')
      lines.push(`> ${escapeMarkdownText(item.activeForm.trim())}`)
    }
    if (isNonEmptyString(item.status)) {
      lines.push('')
      lines.push(`状态：\`${item.status.trim().replace(/`/g, '\\`')}\``)
    }
    const dependencies: string[] = []
    if (Array.isArray(item.blocks) && item.blocks.length > 0) {
      const list = compactInlineList(item.blocks)
      if (list) dependencies.push(`blocks ${list}`)
    }
    if (Array.isArray(item.blockedBy) && item.blockedBy.length > 0) {
      const list = compactInlineList(item.blockedBy)
      if (list) dependencies.push(`blockedBy ${list}`)
    }
    if (dependencies.length > 0) {
      lines.push('')
      lines.push(`依赖：${dependencies.join(' · ')}`)
    }
    if (index < content.length - 1) {
      lines.push('')
      lines.push('---')
    }
    return lines.join('\n')
  })

  const shortParts = content.map((item: any) => {
    const subject = String(item.subject || '').trim()
    const status = isNonEmptyString(item.status) ? ` · ${item.status.trim()}` : ''
    const id = isNonEmptyString(item.id) ? ` #${item.id.trim()}` : ''
    return `${subject}${status}${id}`
  })
  const shortSource = `task_reminder · ${shortParts.join(' / ')}`
  const collapsed = shortSource.replace(/\s+/g, ' ').trim()
  const short = collapsed.slice(0, HEADER_SHORT_LIMIT)
  const truncated = shortSource.length > HEADER_SHORT_LIMIT
  return {
    short,
    shortTail: truncated ? collapsed.slice(collapsed.length - HEADER_SHORT_LIMIT) : collapsed,
    full: sections.join('\n'),
    truncated,
    canCompact: true,
  }
}

export function compactCodeSummary(text: string, language = ''): HeaderSummary {
  const body = String(text || '').replace(/\s+$/, '')
  if (!body) return clip('')
  const clipped = clip(body, HEADER_SHORT_LIMIT)
  return { short: clipped.short, shortTail: clipped.shortTail, full: codeFence(body, language), truncated: true, canCompact: true }
}

function contentBlocksText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b: any) => {
    if (!b || typeof b !== 'object') return String(b ?? '')
    if (typeof b.text === 'string') return b.text
    if (typeof b.input_text === 'string') return b.input_text
    if (typeof b.output_text === 'string') return b.output_text
    if (typeof b.thinking === 'string') return b.thinking
    return b.type ? `[${b.type}]` : ''
  }).filter(Boolean).join('\n')
}

function normalizeHeaderSummaryForGrouping(text: string): string {
  return String(text || '')
    .replace(/^`{3,}[^\n]*\n/, '')
    .replace(/\n`{3,}\s*$/, '')
    .replace(/^(assistant|user|message)\s*·\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function jsonlEntrySummaryKey(entry: AnyEntry): string {
  const summary = buildHeaderSummary(entry)
  return normalizeHeaderSummaryForGrouping(summary.full || summary.short)
}

// 根据提取的标签生成一行干净的标题摘要 (不含原始 <…> 标签). 优先级: compact > goal-set > command-name > stdout > caveat > 兜底.
function summarizeLocalCommandForHeader(parts: LocalCommandPart[]): string {
  const stdout = parts.find((p) => p.tag === 'local-command-stdout')
  if (stdout && /^compacted/i.test(stdout.body)) return `已压缩对话 · ${stdout.body}`
  if (stdout && /^goal\s*set/i.test(stdout.body)) {
    const goal = stdout.body.replace(/^goal\s*set:?\s*/i, '').trim()
    return goal ? `目标已设置 · ${goal}` : '目标已设置 · Goal Set'
  }
  const name = parts.find((p) => p.tag === 'command-name')
  if (name) {
    const argsBody = parts.filter((p) => p.tag === 'command-args' && p.body).map((p) => p.body).join(' ')
    return argsBody ? `本地命令 · ${name.body || '(空)'} ${argsBody}` : `本地命令 · ${name.body || '(空)'}`
  }
  if (stdout) return `命令输出 · ${stdout.body.replace(/\n+/g, ' ')}`
  if (parts.some((p) => p.tag === 'local-command-caveat')) return '本地命令提示 · 系统注入, 无需响应'
  return parts.map((p) => p.body).filter(Boolean).join(' · ') || '本地命令'
}

// patch_apply_end 的 changes 对象 -> 一行文件名列表 (move 显示 src -> dst). 无 changes 返回 null.
function summarizePatchApplyFiles(changes: any): string | null {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null
  const entries = Object.entries(changes) as [string, any][]
  if (entries.length === 0) return null
  const names = entries.map(([filePath, change]) => {
    if (change?.type === 'move' && typeof change?.move_path === 'string' && change.move_path) {
      return `${basename(filePath)} -> ${basename(change.move_path)}`
    }
    return basename(filePath)
  })
  return names.join(', ')
}

export function buildHeaderSummary(entry: AnyEntry): HeaderSummary {
  const t = entry?.type
  const msg = entry?.message
  const payload = entry?.payload

  if (t === 'session_meta') {
    const p = payload || {}
    return clip(`${p.id || ''} · ${p.cwd || ''}`, HEADER_SHORT_LIMIT)
  }
  if (t === 'turn_context') {
    return clip(`${payload?.model || ''} · ${payload?.cwd || ''}`, HEADER_SHORT_LIMIT)
  }
  if (t === 'event_msg') {
    const pt = payload?.type || 'event'
    if (pt === 'agent_message') return clip(String(payload?.message || ''), HEADER_SHORT_LIMIT)
    if (pt === 'user_message') return clip(String(payload?.message || ''), HEADER_SHORT_LIMIT)
    if (pt === 'task_complete') return clip(`task_complete · ${payload?.duration_ms || 0}ms`, HEADER_SHORT_LIMIT)
    if (pt === 'token_count') {
      const usage = payload?.info?.last_token_usage || payload?.info?.total_token_usage
      return clip(usage ? `${pt} · ${usage.total_tokens || 0} tokens` : pt, HEADER_SHORT_LIMIT)
    }
    // patch_apply_end: 摘要展示被修改的文件名 (changes 的 key), 失败时标 "失败". move 显示 src -> dst.
    if (pt === 'patch_apply_end') {
      const files = summarizePatchApplyFiles(payload?.changes)
      const prefix = payload?.success === false ? 'patch_apply 失败' : 'patch_apply'
      return clip(files ? `${prefix} · ${files}` : prefix, HEADER_SHORT_LIMIT)
    }
    return clip(pt, HEADER_SHORT_LIMIT)
  }
  if (t === 'response_item') {
    const pt = payload?.type || 'response_item'
    if (pt === 'message') {
      const body = contentBlocksText(payload?.content)
      return clip(`${payload?.role || 'message'}${body ? ` · ${body}` : ''}`, HEADER_SHORT_LIMIT)
    }
    if (isFunctionCallPayload(payload)) {
      if (payload?.name === 'update_plan') {
        const plan = extractPlanUpdate(entry)
        if (plan) return clip(summarizePlanUpdate(plan), HEADER_SHORT_LIMIT)
      }
      if (payload?.name === 'Write') {
        const args = parseFunctionCallArguments(payload?.arguments)
        const writeSummary = summarizeWriteToolInput(payload?.input ?? args?.input ?? args)
        if (writeSummary) return clip(`Write · ${writeSummary}`, HEADER_SHORT_LIMIT)
      }
      const cmd = functionCallCommand(payload)
      if (cmd) return compactCodeSummary(cmd, 'bash')
      return clip(`tool_call · ${payload?.name || ''} ${payload?.arguments || ''}`, HEADER_SHORT_LIMIT)
    }
    if (isFunctionCallOutputPayload(payload)) return compactCodeSummary(functionOutputBody(payload?.output))
    if (pt === 'reasoning') {
      const encryptedContent = payload?.encrypted_content
      return clip(typeof encryptedContent === 'string' && encryptedContent.length > 0 ? ENCRYPTED_REASONING_LABEL : 'reasoning', HEADER_SHORT_LIMIT)
    }
    return clip(pt, HEADER_SHORT_LIMIT)
  }

  if (t === 'user') {
    // Claude Code 本地命令产物 (<local-command-*> / <command-*> 标签): 展示干净文案, 不暴露原始标签 (避免乱码).
    const lcParts = extractLocalCommandParts(entry)
    if (lcParts.length > 0) return clip(summarizeLocalCommandForHeader(lcParts), HEADER_SHORT_LIMIT)
    const c = msg?.content
    if (typeof c === 'string') return clip(c, HEADER_SHORT_LIMIT)
    if (Array.isArray(c)) {
      const txt = c.find((x: any) => x?.type === 'text')?.text
      if (txt) return clip(String(txt), HEADER_SHORT_LIMIT)
      const tr = c.find((x: any) => x?.type === 'tool_result')
      if (tr) {
        const body = typeof tr.content === 'string' ? tr.content
          : Array.isArray(tr.content) ? tr.content.map((b: any) => b?.text || '').join('') : ''
        const head = `tool_result ← ${tr.tool_use_id?.slice(0, 8)}…`
        if (!body) return clip(head, HEADER_SHORT_LIMIT)
        return clip(`${body}`, HEADER_SHORT_LIMIT)
      }
    }
  }
  if (t === 'assistant' && Array.isArray(msg?.content)) {
    const parts: string[] = []
    const bashPartIndices: number[] = []
    for (const item of msg.content) {
      if (item.type === 'text') parts.push(String(item.text || ''))
      else if (item.type === 'tool_use') {
        if (item.name === 'Write') {
          const writeSummary = summarizeWriteToolInput(item?.input)
          if (writeSummary) {
            parts.push(`Write ${writeSummary}`)
            continue
          }
        }
        if (isReadToolUseName(item.name)) {
          const call = extractReadCallFromBlock(item)
          if (call) {
            parts.push(`Read · ${readCallOneLineSummary(call)}`)
            continue
          }
        }
        // Bash tool_use 单独摘要: 显示 "Bash · <description|$cmd>" 而非整段 JSON,
        // 多条 Bash 显示数量. 字段模式里仍保留原始 input JSON.
        if (isBashToolUseName(item.name)) {
          const entryCwd = typeof entry?.cwd === 'string' ? entry.cwd.trim() : ''
          const call = extractBashCallFromBlock(item, entryCwd)
          if (call) {
            const oneLine = bashCallOneLineSummary(call)
            bashPartIndices.push(parts.length)
            parts.push(oneLine ? `Bash · ${oneLine}` : 'Bash')
            continue
          }
        }
        const inputStr = item.input ? JSON.stringify(item.input) : ''
        parts.push(`${item.name}${inputStr ? ` ${inputStr}` : ''}`)
      }
      else if (item.type === 'thinking') parts.push(String(item.thinking || ''))
    }
    // 同一条 entry 含多个 Bash tool_use 时, 把每条单条摘要折成一条合并摘要
    // "Bash · N calls · <第一条预览>"; 其他 text/thinking 块保留. 单条 Bash 走原摘要.
    if (bashPartIndices.length > 1) {
      const bashCalls = extractBashCalls(entry)
      const first = bashCalls.length > 0 ? bashCallOneLineSummary(bashCalls[0]) : ''
      const bashSummary = first
        ? `Bash · ${bashPartIndices.length} calls · ${first}`
        : `Bash · ${bashPartIndices.length} calls`
      const dropSet = new Set(bashPartIndices)
      const filtered = parts.filter((_, idx) => !dropSet.has(idx))
      filtered.push(bashSummary)
      return clip(filtered.join('\n\n'), HEADER_SHORT_LIMIT)
    }
    return clip(parts.join('\n\n'), HEADER_SHORT_LIMIT)
  }
  if (t === 'attachment') {
    // Claude Code task_reminder (计划模式): 走统一计划摘要 "计划 · X/N · 进行中: 步骤".
    const taskPlan = extractTaskReminder(entry)
    if (taskPlan) return clip(summarizePlanUpdate(taskPlan), HEADER_SHORT_LIMIT)
    const taskReminderSummary = buildTaskReminderSummary(entry)
    if (taskReminderSummary) return taskReminderSummary
    const a = entry.attachment
    if (typeof a === 'string') return clip(a, HEADER_SHORT_LIMIT)
    if (a?.type) return clip(`${a.type}`, HEADER_SHORT_LIMIT)
  }
  if (t === 'queue-operation') return clip(entry.operation || '', HEADER_SHORT_LIMIT)
  if (t === 'system') return clip(entry.subtype || '', HEADER_SHORT_LIMIT)
  if (t === 'last-prompt') return clip(String(entry.lastPrompt || ''), HEADER_SHORT_LIMIT)
  if (t === 'error') return clip(String(msg?.content || ''), HEADER_SHORT_LIMIT)
  return clip('', HEADER_SHORT_LIMIT)
}
