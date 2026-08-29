import type { AnyEntry, JsonlViewItem, Round } from '../viewer/types'
import {
  entryDisplayImages,
  entryReadImagePaths,
  entryUserAttachmentImages,
  extractBashCalls,
  extractBashToolResultRecords,
  extractCodeEdit,
  extractPlanCard,
  extractReadCalls,
  functionOutputBody,
  functionCallCommand,
  functionCallInput,
  isFunctionCallPayload,
  isFunctionCallOutputPayload,
  parseMcpResultEnvelope,
  stripExecEnvelope,
} from '../viewer/entry-extract'
import { assistantEntryText, isThinkingOnlyAssistantEntry } from '../viewer/entry-classify'
import type { BashToolResult } from '../viewer/types'

export type EasyActivityKind = 'explore' | 'command' | 'file-change' | 'plan' | 'tool' | 'progress' | 'error' | 'image' | 'reasoning'

export type EasyActivity = {
  id: string
  kind: EasyActivityKind
  title: string
  summary?: string
  details: string[]
  imageUrls?: string[]
  outputTail?: string
  state: 'success' | 'error'
  lineNos: number[]
  hidden?: boolean
}

export type EasyTimelineBurst = {
  type: 'burst'
  id: string
  title: string
  toolCount: number
  items: EasyActivity[]
  hasError: boolean
  defaultExpanded: boolean
}

export type EasyTimelineRow = {
  type: 'row'
  id: string
  activity: EasyActivity
}

export type EasyTimelineMessage = {
  type: 'message'
  id: string
  text: string
  lineNos: number[]
}

export type EasyTimelineSegment = EasyTimelineBurst | EasyTimelineRow | EasyTimelineMessage

export type EasyJsonlRound = {
  id: string
  roundNum: number
  userPrompt: string
  userAttachmentImages: string[]
  activities: EasyActivity[]
  timeline: EasyTimelineSegment[]
  assistantResponse: string
  workingLabel?: string
  lineNos: number[]
  startedAt?: string
  completedAt?: string
  hasError: boolean
}

export type EasyUserPromptParts = {
  visible: string
  hidden: string
  hiddenKind: 'none' | 'session-context' | 'system-prompt'
}

const LEGACY_ATTACHMENT_LINE_RE = /^\s*[-*]\s*\[(图片|文件)\]\s+(.+?)\s*$/
const STRUCTURED_ATTACHMENT_LINE_RE = /^\s*\d+\.\s*\[(图片|文件)\]\s+(.+?)\s*$/

function removeAttachmentBlockLines(
  lines: string[],
  headerIndex: number,
  linePattern: RegExp,
): { lines: string[]; changed: boolean } {
  let end = headerIndex + 1
  const retained: string[] = []
  let matched = false
  let removedImage = false
  while (end < lines.length) {
    const match = lines[end].match(linePattern)
    if (!match) break
    matched = true
    if (match[1] === '图片') removedImage = true
    else retained.push(lines[end])
    end += 1
  }
  if (!matched || !removedImage) return { lines, changed: false }

  const replacement = retained.length > 0 ? [lines[headerIndex], ...retained] : []
  return {
    lines: [...lines.slice(0, headerIndex), ...replacement, ...lines.slice(end)],
    changed: true,
  }
}

/**
 * 附件路径属于 Agent prompt，不应原样占据用户正文。图片由气泡右上方的缩略图
 * 单独展示；非图片文件行仍保留为可点击文件引用。
 */
export function stripEasyUserImageAttachmentBlocks(text: string): string {
  let lines = String(text || '').replace(/\r\n/g, '\n').split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].trim()
    if (header === '[附件]') {
      const result = removeAttachmentBlockLines(lines, index, LEGACY_ATTACHMENT_LINE_RE)
      if (result.changed) {
        lines = result.lines
        // 仍有普通文件时 header 会被保留；此时继续向后扫描，避免反复处理
        // 同一个只含 [文件] 的块。header 被整个移除时则回退一格接住后移内容。
        if (lines[index]?.trim() !== header) index = Math.max(-1, index - 1)
      }
      continue
    }

    if (header.startsWith('用户随本轮消息上传了以下附件。')) {
      const result = removeAttachmentBlockLines(lines, index, STRUCTURED_ATTACHMENT_LINE_RE)
      if (result.changed) {
        lines = result.lines
        if (lines[index]?.trim() !== header) index = Math.max(-1, index - 1)
      }
      continue
    }

    // 小莫面板的历史格式：该块只包含图片路径，无需保留任何一行。
    if (header === '[图片附件]') {
      let end = index + 1
      let matched = false
      while (end < lines.length && /^\s*[-*]\s+\S.*$/.test(lines[end])) {
        matched = true
        end += 1
      }
      if (matched) {
        lines = [...lines.slice(0, index), ...lines.slice(end)]
        index = Math.max(-1, index - 1)
      }
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

const USER_QUESTION_MARKERS = [
  /(?:^|\n)\s*【?\s*##\s*用户的问题\s*】?\s*(?:\r?\n|$)/,
  /(?:^|\n)\s*【用户的问题】\s*(?:\r?\n|$)/,
  /(?:^|\n)\s*【?\s*##\s*User'?s Question\s*】?\s*(?:\r?\n|$)/i,
  /(?:^|\n)\s*【User'?s Question】\s*(?:\r?\n|$)/i,
]

const SYSTEM_ONLY_PREFIXES = [
  'Mobius Main/Sub Harness Context',
  'Harness result notification',
  'Dispatch receipt marker',
  '以下信息描述了你正在协助的用户',
  '【以下信息描述了你正在协助的用户】',
  'The following describes the user you are assisting',
  '【The following describes the user you are assisting',
  'Forced System Skill',
  '必要 Skill',
  'Required Skills',
  '持久 Memory',
  'Persistent Memory',
  '<environment_context>',
  '[A message that comes from the system, not the user]',
]

function normalizePromptStart(text: string): string {
  return text.trimStart().replace(/^(?:#{1,6}\s+)+/, '')
}

function looksLikeInjectedPrompt(text: string): boolean {
  if (!text.trim()) return false
  const start = normalizePromptStart(text)
  return SYSTEM_ONLY_PREFIXES.some(prefix => start.startsWith(prefix))
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

/** 把 wrapUserMessage / Harness / Skill 注入从用户自己输入里拆出来，供界面默认折叠。 */
export function splitEasyUserPrompt(text: string): EasyUserPromptParts {
  const raw = String(text || '').replace(/\r\n/g, '\n')
  if (!raw.trim()) return { visible: '', hidden: '', hiddenKind: 'none' }

  const marker = findUserQuestionMarker(raw)
  if (marker) {
    const before = raw.slice(0, marker.index).replace(/(?:\n+---\s*)+$/g, '').trim()
    const after = raw.slice(marker.index + marker.length).trim()
    if (after && before && !looksLikeInjectedPrompt(after)) {
      return {
        visible: after,
        hidden: before,
        hiddenKind: looksLikeInjectedPrompt(before) ? 'system-prompt' : 'session-context',
      }
    }
    if (after && !before && !looksLikeInjectedPrompt(after)) {
      return { visible: after, hidden: '', hiddenKind: 'none' }
    }
    if (before || looksLikeInjectedPrompt(after) || looksLikeInjectedPrompt(raw)) {
      return { visible: '', hidden: raw.trim(), hiddenKind: 'system-prompt' }
    }
  }

  if (looksLikeInjectedPrompt(raw)) {
    return { visible: '', hidden: raw.trim(), hiddenKind: 'system-prompt' }
  }

  return { visible: raw.trim(), hidden: '', hiddenKind: 'none' }
}

function contentText(content: unknown, acceptedTypes: string[]): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block: any) => {
      if (typeof block === 'string') return block
      if (!block || !acceptedTypes.includes(block.type)) return ''
      return typeof block.text === 'string' ? block.text : (typeof block.input_text === 'string' ? block.input_text : '')
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

export function easyUserText(entry: AnyEntry): string {
  if (entry?.type === 'event_msg' && entry?.payload?.type === 'user_message') {
    return String(entry.payload.message || entry.payload.content || '').trim()
  }
  if (entry?.type === 'response_item' && entry?.payload?.type === 'message' && entry?.payload?.role === 'user') {
    return contentText(entry.payload.content, ['text', 'input_text'])
  }
  if (entry?.type === 'user') return contentText(entry?.message?.content, ['text', 'input_text'])
  return ''
}

function visibleEasyUserQuestion(text: string): string {
  return (splitEasyUserPrompt(text).visible || '').replace(/\s+/g, ' ').trim()
}

function isFramedEasyUserPrompt(text: string): boolean {
  return !!findUserQuestionMarker(text)
}

function pickEasyUserPrompt(items: Array<{ entry: AnyEntry }>): string {
  const texts = items.map(item => easyUserText(item.entry)).filter(Boolean)
  return texts.find(isFramedEasyUserPrompt) || texts[0] || ''
}

function collapseEasyDuplicateUserRounds(rounds: EasyJsonlRound[]): EasyJsonlRound[] {
  const merged: EasyJsonlRound[] = []
  for (const round of rounds) {
    const prev = merged[merged.length - 1]
    const currentQuestion = visibleEasyUserQuestion(round.userPrompt)
    const previousQuestion = prev ? visibleEasyUserQuestion(prev.userPrompt) : ''
    const upgradeToFramed = !!prev
      && !!currentQuestion
      && currentQuestion === previousQuestion
      && isFramedEasyUserPrompt(round.userPrompt)
      && !isFramedEasyUserPrompt(prev.userPrompt)
    if (!upgradeToFramed || !prev) {
      merged.push(round)
      continue
    }
    prev.userPrompt = round.userPrompt
    prev.userAttachmentImages = unique([...prev.userAttachmentImages, ...round.userAttachmentImages])
    prev.activities = prev.activities.concat(round.activities)
    prev.timeline = prev.timeline.concat(round.timeline)
    prev.assistantResponse = round.assistantResponse || prev.assistantResponse
    prev.workingLabel = round.workingLabel || prev.workingLabel
    prev.lineNos = prev.lineNos.concat(round.lineNos)
    prev.completedAt = round.completedAt || prev.completedAt
    prev.hasError = prev.hasError || round.hasError
  }
  return merged
}

type ProviderToolWrapperKind = 'input' | 'output'

function providerToolWrapperKind(text: string): ProviderToolWrapperKind | null {
  const normalized = String(text || '').trim()
  if (
    /^\*\*[^\n*]*Built-in Tool:\s*[^\n*]+\*\*/i.test(normalized)
    && /\*\*Input:\*\*/i.test(normalized)
    && /Executing on server/i.test(normalized)
  ) return 'input'
  if (
    /^\*\*Output:\*\*/i.test(normalized)
    && /\*\*[^\n*]+_result_summary:\*\*/i.test(normalized)
  ) return 'output'
  return null
}

function easyAssistantText(entry: AnyEntry): string {
  const direct = assistantEntryText(entry).trim()
  // Some providers emit a human-readable Markdown mirror immediately around a
  // structured server_tool_use/tool_result pair. The mirror is transport UI,
  // not assistant prose; showing both leaks raw arguments and duplicates output.
  if (providerToolWrapperKind(direct)) return ''
  if (direct) return direct
  if (entry?.type === 'event_msg' && entry?.payload?.type === 'agent_message') {
    return String(entry.payload.message || entry.payload.content || '').trim()
  }
  return ''
}

function entryTimestamp(entry: AnyEntry): string | undefined {
  const value = entry?.timestamp || entry?.created_at
  return typeof value === 'string' && value ? value : undefined
}

function compactText(value: unknown, limit = 220): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function toolInputObject(block: any): any {
  if (block?.input && typeof block.input === 'object') return block.input
  const fromPayload = functionCallInput(block?.payload)
  if (Object.keys(fromPayload).length) return fromPayload
  const raw = block?.payload?.arguments ?? block?.input
  if (typeof raw !== 'string') return {}
  try { return JSON.parse(raw) } catch { return {} }
}

function genericToolDetail(block: any): string {
  const name = String(block?.name || '工具')
  const payload = block?.payload
  const command = payload ? functionCallCommand(payload) : null
  if (command && !looksLikeToolSource(command)) return commandTitle(command)
  const input = toolInputObject(block)
  const hint = input.search_query || input.query || input.pattern || input.path || input.file_path || input.command || input.url || ''
  return hint ? compactText(String(hint), 72) : name
}

function isExploreTool(name: string): boolean {
  return /(?:^|__)(?:read|glob|grep|search|websearch|web_search|web__run|list|find)/i.test(name)
}

function looksLikeToolSource(text: string): boolean {
  return /(?:const\s+\w+\s*=\s*)?await\s+tools\.\w+\s*\(/.test(text) || /^(?:tools\.)?\w+\s*\(\s*\{/.test(text)
}

function isCommandTool(name: string): boolean {
  return /^(bash|shell|exec|exec_command|run_command)$/i.test(name)
}

function isFileChangeTool(name: string): boolean {
  return /^(edit|write|apply_patch|patch)/i.test(name)
}

function isPlanTool(name: string): boolean {
  return /^(update_plan|todo|task)/i.test(name)
}

function errorText(entry: AnyEntry): string {
  if (entry?.type === 'error') return compactText(entry?.message || entry?.error || entry?.payload?.message || '执行出现错误')
  if (entry?.payload?.type === 'error') return compactText(entry.payload.message || entry.payload.error || '执行出现错误')
  return ''
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)))
}

function pathBasename(value: string): string {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized || '文件'
}

function unwrapQuoted(value: string): string {
  const text = value.trim()
  if (text.length < 2) return text
  const quote = text[0]
  return (quote === '"' || quote === "'") && text[text.length - 1] === quote
    ? text.slice(1, -1)
    : text
}

/** 只清理展示副本；标准 JSONL 仍保留原始命令。 */
function cleanCommand(command: string): string {
  let text = String(command || '').trim()
  const shell = /^(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:(?:ba|z|)sh|shell)\s+(?:-[a-z]*c|--command)\s+([\s\S]+)$/i.exec(text)
  if (shell) text = unwrapQuoted(shell[1])
  for (let index = 0; index < 3; index += 1) {
    const cd = /^cd\s+(?:"[^"]+"|'[^']+'|[^;&|]+?)\s*(?:&&|;)\s*([\s\S]+)$/i.exec(text)
    if (!cd) break
    text = cd[1].trim()
  }
  return text
}

function commandBinary(command: string): string {
  const token = command.trim().split(/\s+/, 1)[0] || ''
  return token.replace(/\\/g, '/').split('/').pop() || token
}

function commandHeadline(command: string): string {
  const cleaned = cleanCommand(command)
  if (!cleaned || looksLikeToolSource(cleaned)) return '命令'
  const name = commandBinary(cleaned)
  if (/^curl$/i.test(name)) {
    const method = /\s-X\s+(\w+)/i.exec(cleaned)?.[1]?.toUpperCase()
      || (/\s(?:-d|--data|--data-raw|--data-binary|-F|--form)\b/i.test(cleaned) ? 'POST' : 'GET')
    const rawUrl = cleaned.match(/https?:\/\/[^\s'"]+/)?.[0]
      || cleaned.match(/'(https?:\/\/[^']+)'/)?.[1]
      || cleaned.match(/"(https?:\/\/[^"]+)"/)?.[1]
      || ''
    let path = rawUrl
    try {
      if (/^https?:\/\//i.test(rawUrl)) path = new URL(rawUrl).pathname
    } catch { /* keep raw */ }
    return path ? `curl ${method} ${path}` : `curl ${method}`
  }
  if (/^jq$/i.test(name)) {
    const filter = cleaned.match(/jq\s+(?:-[^\s]+\s+)*('(?:\\.|[^'])*'|"(?:\\.|[^"])*"|\S+)/)?.[1]
    const hint = filter ? unwrapQuoted(filter) : ''
    return hint ? compactText(`jq ${hint}`, 64) : 'jq'
  }
  const firstLine = cleaned.split(/\r?\n/, 1)[0]
  return firstLine.length <= 72 ? firstLine : compactText(firstLine, 72)
}

function commandTitle(command: string): string {
  return commandHeadline(command)
}

function commandDetails(command: string, cwd?: string): string[] {
  const cleaned = cleanCommand(command)
  if (!cleaned || looksLikeToolSource(cleaned)) return unique([cwd ? `cwd · ${cwd}` : ''])
  const headline = commandHeadline(command)
  return unique([
    cleaned && cleaned !== headline ? cleaned : '',
    cwd ? `cwd · ${cwd}` : '',
  ])
}

function burstTitle(items: EasyActivity[], toolCount: number, hasError: boolean): string {
  const visible = items.filter(item => !item.hidden)
  const kinds = new Set(visible.map(item => item.kind))
  const parts: string[] = []
  if (visible.some(item => item.kind === 'explore' && item.title.startsWith('正在读取'))) parts.push('已读取文件')
  if (visible.some(item => item.kind === 'explore' && item.title.startsWith('正在搜索'))) parts.push('已完成搜索')
  if (kinds.has('command')) parts.push('运行了命令')
  if (kinds.has('file-change')) parts.push('编辑了文件')
  if (kinds.has('plan')) parts.push('更新了计划')
  if (kinds.has('tool')) parts.push('调用了工具')
  if (kinds.has('image')) parts.push('处理了图片')
  if (parts.length === 0) parts.push(toolCount > 0 ? '调用了工具' : '完成了思考')
  const summary = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join('、')}并${parts.at(-1)}`
  return hasError ? `${summary} · 含失败` : summary
}

function burstDefaultExpanded(): boolean {
  // 工具过程统一默认折叠。失败状态仍展示在摘要上，但不能主动掀开详情。
  return false
}

function prettyCommandOutput(value: string): string {
  const envelope = parseMcpResultEnvelope(value)
  const stripped = stripExecEnvelope(envelope ? envelope.output : value)
  const trimmed = stripped.trim()
  if (!trimmed) return ''
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    const jsonish = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/)
    if (jsonish && jsonish.index != null) {
      try {
        const pretty = JSON.stringify(JSON.parse(jsonish[1]), null, 2)
        const prefix = trimmed.slice(0, jsonish.index).trimEnd()
        return (prefix ? `${prefix}\n${pretty}` : pretty).trim()
      } catch { /* keep raw */ }
    }
    return stripped
  }
}

function limitedOutputTail(value: string, maxLines = 160, maxChars = 16000): string | undefined {
  const normalized = prettyCommandOutput(value)
  if (!normalized) return undefined
  const lines = normalized.split('\n')
  let tail = lines.slice(-maxLines).join('\n')
  if (tail.length > maxChars) tail = tail.slice(-maxChars)
  return lines.length > maxLines || normalized.length > tail.length ? `…\n${tail}` : tail
}

function reasoningText(entry: AnyEntry, block?: any): string {
  if (block?.type === 'thinking') return String(block.thinking || '').trim()
  if (entry?.type !== 'response_item' || entry?.payload?.type !== 'reasoning') return ''
  const summary = entry.payload.summary
  if (Array.isArray(summary)) {
    return summary
      .map((part: any) => typeof part === 'string' ? part : String(part?.text || ''))
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return typeof summary === 'string' ? summary.trim() : ''
}

function reasoningParts(text: string): { title: string; details: string[]; hidden: boolean } | null {
  const normalized = String(text || '').trim()
  if (!normalized) return null
  const lines = normalized.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines.length === 0) return null
  const title = compactText(lines[0], 80)
  const details = lines.length > 1 ? lines.slice(1) : (lines[0].length > 80 ? [normalized] : [])
  return { title, details, hidden: details.length === 0 }
}

function outputText(result: BashToolResult): string {
  return stripExecEnvelope([result.stdout, result.stderr].filter(Boolean).join('\n') || result.content || '')
}

function toolResultBlockText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((part: any) => {
      if (typeof part === 'string') return part
      return typeof part?.text === 'string' ? part.text : (typeof part?.content === 'string' ? part.content : '')
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

function toolResultFailed(block: any, output: string): boolean {
  if (block?.is_error === true || block?.status === 'failed') return true
  return /(?:MCP\s+error|bad request|\b(?:error|failed|failure)\b|错误|失败)/i.test(output)
}

function entryHasToolProtocol(entry: AnyEntry): boolean {
  if (entry?.type === 'response_item') {
    return isFunctionCallPayload(entry?.payload) || isFunctionCallOutputPayload(entry?.payload)
  }
  const content = entry?.message?.content
  return Array.isArray(content) && content.some((block: any) => (
    block?.type === 'tool_use'
    || block?.type === 'server_tool_use'
    || block?.type === 'tool_result'
  ))
}

function attachResult(activity: EasyActivity, result?: BashToolResult): void {
  if (!result) return
  activity.lineNos = unique([...activity.lineNos.map(String), String(result.lineNo)]).map(Number)
  activity.outputTail = limitedOutputTail(outputText(result))
  if (result.isError) {
    activity.state = 'error'
    activity.summary = '执行失败'
    const detail = compactText(result.stderr || result.content || result.stdout || '工具执行失败', 360)
    if (detail) activity.details = unique([...activity.details, detail])
  }
}

function matchingResult(results: BashToolResult[], id: string | undefined, index: number): BashToolResult | undefined {
  if (id) {
    const exact = results.find(result => result.toolUseId === id)
    if (exact) return exact
  }
  return results[index]
}

type PendingActivity = { activity: EasyActivity; toolCount: number; callId?: string }

export function buildEasyJsonlRounds(rounds: Round[], leadingItems: JsonlViewItem[] = []): EasyJsonlRound[] {
  // The backend initially returns only the JSONL tail. If that window starts in
  // the middle of a turn, buildRounds() puts every leading entry in preItems.
  // Keep those entries as a continuation round instead of rendering a blank view.
  const displayRounds: Round[] = leadingItems.length > 0
    ? [{
        roundNum: 0,
        items: leadingItems.map((item, relIdx) => ({ ...item, relIdx })),
      }, ...rounds]
    : rounds

  return collapseEasyDuplicateUserRounds(displayRounds.map((round) => {
    const timeline: EasyTimelineSegment[] = []
    const pending: PendingActivity[] = []
    const activitiesByCallId = new Map<string, EasyActivity[]>()
    const lineNos = round.items.map(item => item.lineNo)
    let activityIndex = 0
    let assistantResponse = ''
    let workingLabel: string | undefined

    const makeActivity = (
      kind: EasyActivityKind,
      title: string,
      lineNo: number,
      options: Partial<Omit<EasyActivity, 'id' | 'kind' | 'title' | 'state' | 'lineNos'>> & { state?: EasyActivity['state'] } = {},
    ): EasyActivity => ({
      id: `${round.roundNum}:activity:${lineNo}:${activityIndex++}`,
      kind,
      title,
      summary: options.summary,
      details: options.details || [],
      imageUrls: options.imageUrls,
      outputTail: options.outputTail,
      state: options.state || 'success',
      lineNos: [lineNo],
      hidden: options.hidden,
    })

    const append = (activity: EasyActivity, toolCount: number, callId?: string) => {
      pending.push({ activity, toolCount, callId })
      if (callId) {
        const registered = activitiesByCallId.get(callId) || []
        registered.push(activity)
        activitiesByCallId.set(callId, registered)
      }
    }

    const flush = () => {
      if (pending.length === 0) return
      const visible = pending.filter(item => !item.activity.hidden)
      const toolCount = visible.reduce((sum, item) => sum + item.toolCount, 0)
      if (toolCount > 1) {
        const items = visible.map(item => item.activity)
        const hasError = items.some(item => item.state === 'error')
        timeline.push({
          type: 'burst',
          id: `${visible[0].activity.id}:burst`,
          title: burstTitle(items, toolCount, hasError),
          toolCount,
          items,
          hasError,
          defaultExpanded: burstDefaultExpanded(),
        })
      } else {
        visible.forEach(item => timeline.push({ type: 'row', id: `${item.activity.id}:row`, activity: item.activity }))
      }
      pending.length = 0
    }

    const addMessage = (text: string, lineNo: number) => {
      flush()
      timeline.push({
        type: 'message',
        id: `${round.roundNum}:message:${lineNo}`,
        text: text.trim(),
        lineNos: [lineNo],
      })
    }

    const addReasoning = (entry: AnyEntry, lineNo: number, block?: any) => {
      const parsed = reasoningParts(reasoningText(entry, block))
      if (!parsed) return
      workingLabel = parsed.title
      append(makeActivity('reasoning', parsed.title, lineNo, {
        details: parsed.details,
        hidden: parsed.hidden,
      }), 0)
    }

    const assistantIndexes = round.items
      .map((item, index) => easyAssistantText(item.entry) ? index : -1)
      .filter(index => index >= 0)
    const finalAssistantCandidate = assistantIndexes[assistantIndexes.length - 1] ?? -1
    // A prose update followed by another tool call is progress, not the final
    // answer. This matters when provider wrapper messages are intentionally hidden.
    const finalAssistantIndex = finalAssistantCandidate >= 0
      && !round.items.slice(finalAssistantCandidate + 1).some(item => entryHasToolProtocol(item.entry))
      ? finalAssistantCandidate
      : -1

    round.items.forEach((item, index) => {
      const entry = item.entry
      if (index > 0 && easyUserText(entry)) flush()

      if (entry?.type === 'response_item' && isFunctionCallOutputPayload(entry?.payload)) {
        const callId = String(entry.payload.call_id || '')
        const registered = callId ? activitiesByCallId.get(callId) : undefined
        if (registered?.length) {
          const output = functionOutputBody(entry.payload.output)
          const failed = entry.payload.status === 'failed' || entry.payload.is_error === true
          registered.forEach(activity => attachResult(activity, {
            entry,
            lineNo: item.lineNo,
            toolUseId: callId,
            stdout: output,
            stderr: '',
            content: output,
            isError: failed,
            interrupted: false,
            isImage: false,
            noOutputExpected: false,
          }))
        }
        return
      }

      const unmergedResults = extractBashToolResultRecords(entry, item.lineNo)
      if (unmergedResults.length > 0 && !item.bashResults?.length && !item.readResults?.length) {
        let handled = 0
        unmergedResults.forEach(result => {
          const registered = result.toolUseId ? activitiesByCallId.get(result.toolUseId) : undefined
          if (registered?.length) {
            registered.forEach(activity => attachResult(activity, result))
            handled += 1
          } else if (result.isError) {
            const detail = compactText(result.stderr || result.content || result.stdout || '工具执行失败', 360)
            append(makeActivity('error', '工具调用失败', item.lineNo, {
              summary: detail,
              details: detail ? [detail] : [],
              outputTail: limitedOutputTail(outputText(result)),
              state: 'error',
            }), 0)
            handled += 1
          }
        })
        if (handled > 0) return
      }

      let commandResultIndex = 0
      let readResultIndex = 0
      const processTool = (block: any, sourceEntry: AnyEntry) => {
        const name = String(block?.name || sourceEntry?.payload?.name || '工具')
        const input = toolInputObject(block)
        const callId = String(block?.id || block?.payload?.call_id || sourceEntry?.payload?.call_id || '') || undefined
        const plan = extractPlanCard(sourceEntry)
        if (isPlanTool(name) && plan) {
          const current = plan.currentStep ? `正在处理 ${compactText(plan.currentStep, 100)}` : '已更新执行计划'
          const activity = makeActivity('plan', current, item.lineNo, {
            details: plan.steps.map(step => `${step.status === 'completed' ? '已完成' : step.status === 'in_progress' ? '进行中' : '待处理'} · ${compactText(step.step)}`),
          })
          append(activity, 1, callId)
          return
        }

        const edits = extractCodeEdit(sourceEntry)
        if (isFileChangeTool(name) && edits?.files.length) {
          edits.files.forEach((file, fileIndex) => {
            append(makeActivity('file-change', `已编辑 ${pathBasename(file.filePath)}`, item.lineNo, {
              summary: file.filePath,
              details: [`${file.filePath} · +${file.newLineCount} -${file.oldLineCount}`],
            }), fileIndex === 0 ? 1 : 0, callId)
          })
          return
        }

        const reads = extractReadCalls(sourceEntry)
        if (reads.length > 0) {
          reads.forEach(call => {
            const activity = makeActivity('explore', `正在读取 ${pathBasename(call.filePath)}`, item.lineNo, {
              summary: call.filePath,
              details: [call.filePath],
            })
            attachResult(activity, matchingResult(item.readResults || [], call.id, readResultIndex++))
            append(activity, 1, call.id || callId)
          })
          return
        }

        const commands = extractBashCalls(sourceEntry)
        if (commands.length > 0) {
          commands.forEach(call => {
            const activity = makeActivity('command', commandTitle(call.command), item.lineNo, {
              details: commandDetails(call.command, call.cwd),
            })
            attachResult(activity, matchingResult(item.bashResults || [], call.id, commandResultIndex++))
            append(activity, 1, call.id || callId)
          })
          return
        }

        if (isFileChangeTool(name)) {
          const filePath = String(input.file_path || input.filePath || input.path || name)
          append(makeActivity('file-change', `已编辑 ${pathBasename(filePath)}`, item.lineNo, {
            summary: filePath,
            details: filePath ? [filePath] : [],
          }), 1, callId)
          return
        }
        const query = String(input.search_query || input.query || input.pattern || input.file_path || input.path || input.url || '').trim()
        const innerName = String(input.__toolName || name)
        if (isExploreTool(name) || isExploreTool(innerName) || !!input.search_query) {
          const searching = /(?:grep|search|find|web__?run)/i.test(innerName) || !!input.search_query
          append(makeActivity('explore', `${searching ? '正在搜索' : '正在读取'}${query ? ` ${compactText(query, 72)}` : ''}`, item.lineNo, {
            details: [],
          }), 1, callId)
          return
        }
        if (isCommandTool(name) || isCommandTool(innerName)) {
          const command = functionCallCommand(block?.payload || sourceEntry?.payload) || input.cmd || input.command || ''
          if (command && !looksLikeToolSource(command)) {
            append(makeActivity('command', commandTitle(command), item.lineNo, {
              details: commandDetails(command),
            }), 1, callId)
            return
          }
        }
        append(makeActivity(isPlanTool(name) ? 'plan' : 'tool', genericToolDetail(block), item.lineNo, {
          details: [],
        }), 1, callId)
      }

      if (entry?.type === 'response_item' && entry?.payload?.type === 'reasoning') {
        addReasoning(entry, item.lineNo)
      } else if (entry?.type === 'response_item' && isFunctionCallPayload(entry?.payload)) {
        processTool({
          type: 'tool_use',
          id: entry.payload.call_id,
          name: entry.payload.name || '工具',
          input: entry.payload.arguments,
          payload: entry.payload,
        }, entry)
      } else if (entry?.type === 'assistant' && Array.isArray(entry?.message?.content)) {
        const finalText = index === finalAssistantIndex ? easyAssistantText(entry) : ''
        let finalHandled = false
        entry.message.content.forEach((block: any) => {
          if (block?.type === 'thinking') {
            addReasoning(entry, item.lineNo, block)
          } else if (block?.type === 'tool_use' || block?.type === 'server_tool_use') {
            processTool(block, { ...entry, message: { ...entry.message, content: [block] } })
          } else if (block?.type === 'tool_result') {
            const callId = String(block?.tool_use_id || '')
            const output = toolResultBlockText(block?.content)
            const registered = callId ? activitiesByCallId.get(callId) : undefined
            if (registered?.length) {
              registered.forEach(activity => attachResult(activity, {
                entry,
                lineNo: item.lineNo,
                toolUseId: callId,
                stdout: output,
                stderr: '',
                content: output,
                isError: toolResultFailed(block, output),
                interrupted: false,
                isImage: false,
                noOutputExpected: false,
              }))
            }
          } else if ((block?.type === 'text' || block?.type === 'output_text') && typeof block.text === 'string' && block.text.trim()) {
            if (providerToolWrapperKind(block.text)) return
            if (finalText) {
              if (!finalHandled) {
                flush()
                assistantResponse = finalText
                finalHandled = true
              }
            } else {
              addMessage(block.text, item.lineNo)
            }
          }
        })
        if (isThinkingOnlyAssistantEntry(entry) && !entry.message.content.some((block: any) => reasoningText(entry, block))) {
          // 加密或空 thinking 不伪造可见内容，也不切断相邻工具。
        }
      } else {
        // A continuation window can begin with an assistant entry because its
        // user prompt is outside the loaded tail. Do not discard that response.
        const response = easyAssistantText(entry)
        if (response) {
          if (index === finalAssistantIndex) {
            flush()
            assistantResponse = response
          } else {
            addMessage(response, item.lineNo)
          }
        } else {
          const plan = extractPlanCard(entry)
          const edits = extractCodeEdit(entry)
          const reads = extractReadCalls(entry)
          const commands = extractBashCalls(entry)
          if (plan) {
            append(makeActivity('plan', plan.currentStep ? `正在处理 ${compactText(plan.currentStep, 100)}` : '已更新执行计划', item.lineNo, {
              details: plan.steps.map(step => `${step.status === 'completed' ? '已完成' : step.status === 'in_progress' ? '进行中' : '待处理'} · ${compactText(step.step)}`),
            }), 1)
          } else if (edits?.files.length) {
            edits.files.forEach((file, fileIndex) => append(makeActivity('file-change', `已编辑 ${pathBasename(file.filePath)}`, item.lineNo, {
              summary: file.filePath,
              details: [`${file.filePath} · +${file.newLineCount} -${file.oldLineCount}`],
            }), fileIndex === 0 ? 1 : 0))
          } else {
            reads.forEach(call => append(makeActivity('explore', `正在读取 ${pathBasename(call.filePath)}`, item.lineNo, {
              summary: call.filePath,
              details: [call.filePath],
            }), 1, call.id))
            commands.forEach(call => append(makeActivity('command', commandTitle(call.command), item.lineNo, {
              details: commandDetails(call.command, call.cwd),
            }), 1, call.id))
          }
        }
      }

      // 用户上传图固定展示在问题气泡右上方，不再混入下面的执行轨迹。
      const images = unique([...entryDisplayImages(entry), ...entryReadImagePaths(entry)])
      if (images.length) {
        const imageOwner = [...pending]
          .reverse()
          .find(candidate => candidate.activity.lineNos.includes(item.lineNo) && !['progress', 'reasoning'].includes(candidate.activity.kind))
        if (imageOwner) imageOwner.activity.imageUrls = unique([...(imageOwner.activity.imageUrls || []), ...images])
        else append(makeActivity('image', images.length === 1 ? '生成了 1 张图片' : `生成了 ${images.length} 张图片`, item.lineNo, {
          imageUrls: images,
        }), 0)
      }

      const error = errorText(entry)
      if (error) append(makeActivity('error', '工具调用失败', item.lineNo, {
        summary: error,
        details: [error],
        state: 'error',
      }), 0)
    })

    flush()

    timeline.forEach(segment => {
      if (segment.type !== 'burst') return
      segment.hasError = segment.items.some(activity => activity.state === 'error')
      segment.defaultExpanded = burstDefaultExpanded()
      segment.title = burstTitle(segment.items, segment.toolCount, segment.hasError)
    })

    const activities = timeline.flatMap(segment => {
      if (segment.type === 'burst') return segment.items
      if (segment.type === 'row') return [segment.activity]
      return []
    })

    const firstEntry = round.items[0]?.entry
    const lastEntry = round.items[round.items.length - 1]?.entry
    const userAttachmentImages = unique(round.items.flatMap(item => entryUserAttachmentImages(item.entry)))
    return {
      id: String(firstEntry?.uuid || firstEntry?.id || round.items[0]?.lineNo || round.roundNum),
      roundNum: round.roundNum,
      userPrompt: pickEasyUserPrompt(round.items),
      userAttachmentImages,
      activities,
      timeline,
      assistantResponse,
      workingLabel,
      lineNos,
      startedAt: entryTimestamp(firstEntry),
      completedAt: entryTimestamp(lastEntry),
      hasError: activities.some(activity => activity.state === 'error'),
    }
  }))
}
