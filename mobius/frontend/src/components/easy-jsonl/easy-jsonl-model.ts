import type { AnyEntry, Round } from '../viewer/types'
import {
  entryDisplayImages,
  entryUserAttachmentImages,
  extractBashCalls,
  extractCodeEdit,
  extractPlanCard,
  extractReadCalls,
  functionCallCommand,
  isFunctionCallPayload,
} from '../viewer/entry-extract'
import { assistantEntryText } from '../viewer/entry-classify'

export type EasyActivityKind = 'explore' | 'command' | 'file-change' | 'plan' | 'tool' | 'progress' | 'error' | 'image'

export type EasyActivity = {
  id: string
  kind: EasyActivityKind
  title: string
  summary?: string
  details: string[]
  imageUrls?: string[]
  state: 'success' | 'error'
  lineNos: number[]
  defaultExpanded?: boolean
}

export type EasyJsonlRound = {
  id: string
  roundNum: number
  userPrompt: string
  activities: EasyActivity[]
  assistantResponse: string
  lineNos: number[]
  startedAt?: string
  completedAt?: string
  hasError: boolean
}

type ActivityBucket = {
  kind: EasyActivityKind
  firstIndex: number
  details: string[]
  lineNos: number[]
  imageUrls: string[]
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

function easyAssistantText(entry: AnyEntry): string {
  const direct = assistantEntryText(entry).trim()
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

function toolBlocks(entry: AnyEntry): any[] {
  if (entry?.type === 'assistant' && Array.isArray(entry?.message?.content)) {
    return entry.message.content.filter((block: any) => block?.type === 'tool_use')
  }
  const payload = entry?.payload
  if (entry?.type === 'response_item' && isFunctionCallPayload(payload)) {
    return [{ type: 'tool_use', name: payload?.name || '工具', input: payload?.arguments, payload }]
  }
  return []
}

function toolInputObject(block: any): any {
  if (block?.input && typeof block.input === 'object') return block.input
  const raw = block?.payload?.arguments ?? block?.input
  if (typeof raw !== 'string') return {}
  try { return JSON.parse(raw) } catch { return {} }
}

function genericToolDetail(block: any): string {
  const name = String(block?.name || '工具')
  const payload = block?.payload
  const command = payload ? functionCallCommand(payload) : null
  if (command) return `${name} · ${compactText(command, 160)}`
  const input = toolInputObject(block)
  const hint = input.query || input.pattern || input.path || input.file_path || input.command || input.url || ''
  return hint ? `${name} · ${compactText(hint, 160)}` : name
}

function isExploreTool(name: string): boolean {
  return /^(read|glob|grep|search|websearch|web_search|list|find)/i.test(name)
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

function activityTitle(kind: EasyActivityKind, details: string[], images: string[]): string {
  if (kind === 'explore') return details.length === 1 ? '探索了 1 项上下文' : `探索了 ${details.length} 项上下文`
  if (kind === 'command') return details.length === 1 ? '运行了 1 条命令' : `运行了 ${details.length} 条命令`
  if (kind === 'file-change') {
    const files = new Set(details.map(detail => detail.split(' · ')[0]).filter(Boolean))
    return files.size === 1 ? '修改了 1 个文件' : `修改了 ${files.size || details.length} 个文件`
  }
  if (kind === 'plan') return '更新了执行计划'
  if (kind === 'progress') return details.length === 1 ? '发布了 1 条进度' : `发布了 ${details.length} 条进度`
  if (kind === 'error') return details.length === 1 ? '有 1 个步骤需要注意' : `有 ${details.length} 个步骤需要注意`
  if (kind === 'image') return images.length === 1 ? '生成了 1 张图片' : `生成了 ${images.length} 张图片`
  return details.length === 1 ? '使用了 1 个工具' : `使用了 ${details.length} 个工具`
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)))
}

export function buildEasyJsonlRounds(rounds: Round[]): EasyJsonlRound[] {
  return rounds.map((round) => {
    const buckets = new Map<EasyActivityKind, ActivityBucket>()
    const assistantMessages: Array<{ text: string; lineNo: number; index: number }> = []
    const lineNos = round.items.map(item => item.lineNo)

    const add = (kind: EasyActivityKind, detail: string, lineNo: number, index: number, imageUrls: string[] = []) => {
      let bucket = buckets.get(kind)
      if (!bucket) {
        bucket = { kind, firstIndex: index, details: [], lineNos: [], imageUrls: [] }
        buckets.set(kind, bucket)
      }
      if (detail) bucket.details.push(detail)
      bucket.lineNos.push(lineNo)
      bucket.imageUrls.push(...imageUrls)
    }

    round.items.forEach((item, index) => {
      const entry = item.entry
      if (index > 0) {
        const response = easyAssistantText(entry)
        if (response) assistantMessages.push({ text: response, lineNo: item.lineNo, index })
      }

      const plan = extractPlanCard(entry)
      if (plan) {
        plan.steps.forEach(step => add('plan', `${step.status === 'completed' ? '已完成' : step.status === 'in_progress' ? '进行中' : '待处理'} · ${compactText(step.step)}`, item.lineNo, index))
      }

      const edits = extractCodeEdit(entry)
      if (edits) {
        edits.files.forEach(file => add('file-change', `${file.filePath} · +${file.newLineCount} -${file.oldLineCount}`, item.lineNo, index))
      }

      const reads = extractReadCalls(entry)
      reads.forEach(call => add('explore', call.filePath || '读取上下文', item.lineNo, index))

      const commands = extractBashCalls(entry)
      commands.forEach(call => add('command', compactText(call.command, 260), item.lineNo, index))

      for (const result of [...(item.bashResults || []), ...(item.readResults || [])]) {
        if (result.isError) add('error', compactText(result.stderr || result.content || '工具执行失败'), result.lineNo || item.lineNo, index)
      }

      for (const block of toolBlocks(entry)) {
        const name = String(block?.name || '工具')
        const input = toolInputObject(block)
        if (isExploreTool(name)) {
          if (reads.length === 0) add('explore', compactText(input.file_path || input.path || input.query || input.pattern || genericToolDetail(block)), item.lineNo, index)
        } else if (isCommandTool(name)) {
          if (commands.length === 0) add('command', compactText(input.command || genericToolDetail(block), 260), item.lineNo, index)
        } else if (isFileChangeTool(name)) {
          if (!edits) add('file-change', `${input.file_path || input.path || name} · 已更新`, item.lineNo, index)
        } else if (!isPlanTool(name) || !plan) {
          add(isPlanTool(name) ? 'plan' : 'tool', genericToolDetail(block), item.lineNo, index)
        }
      }

      const images = unique([...entryDisplayImages(entry), ...entryUserAttachmentImages(entry)])
      if (images.length) add('image', '', item.lineNo, index, images)

      const error = errorText(entry)
      if (error) add('error', error, item.lineNo, index)
    })

    const finalMessage = assistantMessages[assistantMessages.length - 1]
    assistantMessages.slice(0, -1).forEach(message => add('progress', compactText(message.text, 320), message.lineNo, message.index))

    const activities = Array.from(buckets.values())
      .sort((a, b) => a.firstIndex - b.firstIndex)
      .map((bucket, index): EasyActivity => {
        const details = unique(bucket.details)
        const imageUrls = unique(bucket.imageUrls)
        return {
          id: `${round.roundNum}:${bucket.kind}:${index}`,
          kind: bucket.kind,
          title: activityTitle(bucket.kind, details, imageUrls),
          summary: details[details.length - 1],
          details,
          imageUrls: imageUrls.length ? imageUrls : undefined,
          state: bucket.kind === 'error' ? 'error' : 'success',
          lineNos: Array.from(new Set(bucket.lineNos)),
          defaultExpanded: bucket.kind === 'error',
        }
      })

    const firstEntry = round.items[0]?.entry
    const lastEntry = round.items[round.items.length - 1]?.entry
    return {
      id: String(firstEntry?.uuid || firstEntry?.id || round.items[0]?.lineNo || round.roundNum),
      roundNum: round.roundNum,
      userPrompt: easyUserText(firstEntry),
      activities,
      assistantResponse: finalMessage?.text || '',
      lineNos,
      startedAt: entryTimestamp(firstEntry),
      completedAt: entryTimestamp(lastEntry),
      hasError: activities.some(activity => activity.state === 'error'),
    }
  })
}
