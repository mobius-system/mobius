/**
 * viewer/entry-extract.ts — 从单条 jsonl entry 抽取结构化数据的纯函数 (无 React 依赖).
 *
 * 从 jsonl-view.tsx 拆出. 这里负责把原始 entry 解析成视图能直接渲染的数据:
 *  - Edit/Write/Bash/Read 等 tool_use 调用 (Claude assistant.message.content 与 codex response_item 两种形态)
 *  - tool_result 回填记录, 以及把 tool_result 合并回发起它的 tool_use entry (mergeBashToolResultItems)
 *  - display_images / 附件图片参数抽取
 *  - 本地命令 (<local-command-*> / <command-*>) 标签解析
 *  - function_call / function_call_output 的命令体与输出体解析
 *
 * 布尔型谓词 (isXxx) 与 tour target 放在 ./entry-classify; 标题摘要放在 ./header-summary.
 */
import {
  extractBashCalls as extractBashCallsFromHelpers,
  isBashToolUseName,
} from '../jsonl-bash-helpers'
import type { BashCall } from '../jsonl-bash-helpers'
import {
  lineCount,
  parseUnifiedHunkHeader,
  parseFunctionCallArguments,
  stringField,
  numberField,
  outputField,
  isNonEmptyString,
  basename,
} from './utils'
import type {
  AnyEntry,
  CodeEdit,
  CodeEditFile,
  WriteToolCall,
  ReadToolCall,
  ReadFileResult,
  BashToolResult,
  JsonlViewItem,
  StringCodeEditFile,
  UnifiedCodeEditFile,
  LocalCommandPart,
  PlanStep,
  PlanStepStatus,
  PlanUpdate,
} from './types'

// re-export: 部分模块 (BashCall 类型 / block 级抽取 / 一行摘要) 直接复用 jsonl-bash-helpers 的实现.
export { extractBashCallFromBlock, bashCallOneLineSummary, isBashToolUseName } from '../jsonl-bash-helpers'
export type { BashCall } from '../jsonl-bash-helpers'

// ── Write tool_use ──────────────────────────────────────────────────────
function normalizeWriteInput(input: any): WriteToolCall | null {
  if (!input || typeof input !== 'object') return null
  const filePath = input.file_path ?? input.filePath ?? input.path
  const content = input.content
  if (!isNonEmptyString(filePath) || !isNonEmptyString(content)) return null
  return {
    filePath: filePath.trim(),
    content,
    lineCount: lineCount(content),
    charCount: content.length,
  }
}

function extractWriteToolCall(entry: AnyEntry): WriteToolCall | null {
  if (entry?.type === 'assistant') {
    const content = entry?.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use' || block?.name !== 'Write') continue
        const writeCall = normalizeWriteInput(block?.input)
        if (writeCall) return writeCall
      }
    }
  }

  if (entry?.type === 'response_item' && entry?.payload?.type === 'function_call' && entry?.payload?.name === 'Write') {
    const args = parseFunctionCallArguments(entry.payload.arguments)
    const writeCall = normalizeWriteInput(entry.payload.input ?? args?.input ?? args)
    if (writeCall) return writeCall
  }

  return null
}

export function summarizeWriteToolInput(input: any): string | null {
  const writeCall = normalizeWriteInput(input)
  if (!writeCall) return null
  return `${basename(writeCall.filePath)} · ${writeCall.lineCount} lines`
}

// ── Edit tool_use / patch_apply_end → 代码编辑差异 ──────────────────────
// 支持两类代码模式:
// 1) Claude Edit tool_use: input.old_string + input.new_string.
// 2) Codex patch_apply_end: payload.changes[path].unified_diff.
function stringEditFile(filePath: string, oldString: string, newString: string): StringCodeEditFile {
  return {
    kind: 'strings',
    filePath,
    oldString,
    newString,
    oldLineCount: lineCount(oldString),
    newLineCount: lineCount(newString),
  }
}

function unifiedEditFile(filePath: string, unifiedDiff: string): UnifiedCodeEditFile {
  let oldLineCount = 0
  let newLineCount = 0
  let addedLineCount = 0
  let removedLineCount = 0
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('@@')) {
      const header = parseUnifiedHunkHeader(line)
      if (header) {
        oldLineCount += header.oldCount
        newLineCount += header.newCount
      }
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) addedLineCount++
    else if (line.startsWith('-') && !line.startsWith('---')) removedLineCount++
  }
  return {
    kind: 'unified',
    filePath,
    unifiedDiff,
    oldLineCount,
    newLineCount,
    addedLineCount,
    removedLineCount,
  }
}

export function extractCodeEdit(entry: AnyEntry): CodeEdit | null {
  const files: CodeEditFile[] = []

  if (entry?.type === 'assistant') {
    const c = entry?.message?.content
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block?.type !== 'tool_use' || block?.name !== 'Edit') continue
        const input = block?.input
        if (typeof input?.old_string !== 'string' || typeof input?.new_string !== 'string') continue
        files.push(stringEditFile(
          typeof input.file_path === 'string' ? input.file_path : '',
          input.old_string,
          input.new_string,
        ))
      }
    }
  }

  const changes = entry?.type === 'event_msg' && entry?.payload?.type === 'patch_apply_end'
    ? entry?.payload?.changes
    : null
  if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
    for (const [filePath, change] of Object.entries(changes)) {
      const unifiedDiff = (change as any)?.unified_diff
      if (typeof unifiedDiff === 'string' && unifiedDiff.trim()) {
        files.push(unifiedEditFile(filePath, unifiedDiff))
      }
    }
  }

  if (files.length === 0) return null
  const sourceLength = files.reduce((sum, file) => {
    if (file.kind === 'strings') return sum + file.oldString.length + file.newString.length
    return sum + file.unifiedDiff.length
  }, 0)
  const displayPath = files.length === 1
    ? files[0].filePath
    : `${files.length} files`
  return { files, displayPath, sourceLength }
}

// ── Bash tool_use ───────────────────────────────────────────────────────
// 从 assistant.message.content 抽出全部 Bash tool_use 调用 (保序, 含同一条 entry 多个 Bash).
export function extractBashCalls(entry: AnyEntry): BashCall[] {
  const claudeCalls = extractBashCallsFromHelpers(entry)
  if (claudeCalls.length > 0) return claudeCalls

  if (entry?.type === 'response_item' && entry?.payload?.type === 'function_call') {
    const payload = entry.payload
    const cmd = functionCallCommand(payload)
    if (!cmd) return []
    const args = parseFunctionCallArguments(payload?.arguments) || {}
    const name = typeof payload?.name === 'string' ? payload.name : ''
    if (name && name !== 'exec_command' && name !== 'bash' && name !== 'shell') return []

    const cwd = stringField(args.workdir) || stringField(args.cwd) || stringField(args?.input?.workdir) || stringField(args?.input?.cwd) || stringField(entry?.cwd)
    let commandSource: BashCall['commandSource'] = 'command'
    if (typeof args.cmd === 'string') commandSource = 'cmd'
    else if (typeof args.script === 'string' || typeof args?.input?.script === 'string') commandSource = 'script'

    return [{
      id: stringField(payload?.call_id) || undefined,
      description: '',
      cwd,
      command: cmd,
      commandSource,
    }]
  }

  return []
}

export function isBashToolUse(entry: AnyEntry): boolean {
  return extractBashCalls(entry).length > 0
}

// 该 entry 是否为 "assistant 发起的 Bash tool_use 且 input.command 包含 'start.py'"
// (即触发了产品构建的 shell 调用).
// 走 isBashToolUseName 让大小写兼容与 BashCall 卡片渲染对齐, 避免 'bash' 时主题/识别脱节.
export function isStartPyToolUse(entry: AnyEntry): boolean {
  return extractBashCalls(entry).some((call) => call.command.includes('start.py'))
}

// ── Read tool_use ───────────────────────────────────────────────────────
export function isReadToolUseName(name: unknown): boolean {
  return typeof name === 'string' && name.toLowerCase() === 'read'
}

export function extractReadCallFromBlock(block: any): ReadToolCall | null {
  if (!block || block.type !== 'tool_use' || !isReadToolUseName(block.name)) return null
  const input = block?.input && typeof block.input === 'object' ? block.input : {}
  const filePath = stringField(input.file_path) || stringField(input.filePath) || stringField(input.path)
  if (!filePath.trim()) return null
  return {
    id: stringField(block.id) || undefined,
    filePath: filePath.trim(),
    offset: numberField(input.offset),
    limit: numberField(input.limit),
  }
}

export function extractReadCalls(entry: AnyEntry): ReadToolCall[] {
  if (entry?.type !== 'assistant') return []
  const content = entry?.message?.content
  if (!Array.isArray(content)) return []
  const out: ReadToolCall[] = []
  for (const block of content) {
    const call = extractReadCallFromBlock(block)
    if (call) out.push(call)
  }
  return out
}

export function readCallOneLineSummary(call: ReadToolCall): string {
  const parts = [basename(call.filePath)]
  const range = [
    call.offset != null ? `offset ${call.offset}` : '',
    call.limit != null ? `limit ${call.limit}` : '',
  ].filter(Boolean).join(' · ')
  if (range) parts.push(range)
  return parts.join(' · ')
}

// ── tool_result 回填 ────────────────────────────────────────────────────
function normalizeReadFileResult(file: any): ReadFileResult | undefined {
  if (!file || typeof file !== 'object') return undefined
  const filePath = stringField(file.filePath) || stringField(file.file_path) || stringField(file.path)
  const content = stringField(file.content)
  if (!filePath && !content) return undefined
  return {
    filePath,
    content,
    numLines: numberField(file.numLines ?? file.num_lines),
    startLine: numberField(file.startLine ?? file.start_line),
    totalLines: numberField(file.totalLines ?? file.total_lines),
  }
}

function toolResultContentText(content: any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return outputField(content)
  return content
    .map((block: any) => {
      if (typeof block === 'string') return block
      if (!block || typeof block !== 'object') return ''
      if (typeof block.text === 'string') return block.text
      if (typeof block.content === 'string') return block.content
      if (typeof block.output_text === 'string') return block.output_text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function isPureToolResultEntry(entry: AnyEntry): boolean {
  if (entry?.type === 'response_item' && entry?.payload?.type === 'function_call_output') return true
  const content = entry?.message?.content
  return entry?.type === 'user'
    && Array.isArray(content)
    && content.length > 0
    && content.every((block: any) => block?.type === 'tool_result')
}

export function extractBashToolResultRecords(entry: AnyEntry, lineNo: number): BashToolResult[] {
  if (entry?.type === 'response_item' && entry?.payload?.type === 'function_call_output') {
    const output = functionOutputBody(entry.payload?.output)
    const imageUrls = functionOutputImageUrls(entry.payload?.output)
    return [{
      entry,
      lineNo,
      toolUseId: stringField(entry.payload?.call_id) || undefined,
      stdout: output,
      stderr: '',
      content: output,
      isError: entry.payload?.status === 'failed' || entry.payload?.is_error === true,
      interrupted: false,
      isImage: imageUrls.length > 0,
      imageUrls,
      noOutputExpected: false,
    }]
  }

  if (entry?.type !== 'user') return []
  const content = entry?.message?.content
  if (!Array.isArray(content)) return []
  const blocks = content.filter((block: any) => block?.type === 'tool_result')
  if (blocks.length === 0) return []

  const toolUseResult = entry?.toolUseResult && typeof entry.toolUseResult === 'object'
    ? entry.toolUseResult
    : {}
  const stdout = outputField(toolUseResult.stdout)
  const stderr = outputField(toolUseResult.stderr)
  const sourceAssistantUuid = stringField(toolUseResult.sourceToolAssistantUUID)
  const parentUuid = stringField(entry?.parentUuid)
  const interrupted = toolUseResult.interrupted === true
  const isImage = toolUseResult.isImage === true
  const noOutputExpected = toolUseResult.noOutputExpected === true
  const readFile = normalizeReadFileResult(toolUseResult.file)

  return blocks.map((block: any) => {
    const blockContent = toolResultContentText(block?.content)
    const fallbackContent = [readFile?.content, stdout, stderr].filter(Boolean).join('\n')
    return {
      entry,
      lineNo,
      toolUseId: stringField(block?.tool_use_id) || undefined,
      parentUuid: parentUuid || undefined,
      sourceAssistantUuid: sourceAssistantUuid || undefined,
      stdout,
      stderr,
      content: blockContent || fallbackContent,
      isError: block?.is_error === true || toolUseResult.is_error === true || !!toolUseResult.error,
      interrupted,
      isImage,
      noOutputExpected,
      readFile,
    }
  })
}

// 把 tool_result 记录合并回发起它的 tool_use entry:
//  - 按 call_id / parentUuid / sourceAssistantUuid 匹配发起方;
//  - 命中的纯 tool_result entry 整条隐藏 (它的内容已并入发起方卡片);
//  - 返回的 JsonlViewItem 带上 bashResults / readResults, 供卡片渲染.
export function mergeBashToolResultItems(visibleEntries: AnyEntry[], windowOffset: number): JsonlViewItem[] {
  type ToolCallRef = { id?: string; kind: 'bash' | 'read' }
  type ToolSource = { index: number; uuid: string; calls: ToolCallRef[] }
  const sourcesByUuid = new Map<string, ToolSource>()
  const sourceByCallId = new Map<string, ToolSource>()

  visibleEntries.forEach((entry, index) => {
    const calls: ToolCallRef[] = [
      ...extractBashCalls(entry).map((call) => ({ id: call.id, kind: 'bash' as const })),
      ...extractReadCalls(entry).map((call) => ({ id: call.id, kind: 'read' as const })),
    ]
    const uuid = stringField(entry?.uuid)
    if (calls.length === 0) return
    const source = { index, uuid, calls }
    if (uuid) sourcesByUuid.set(uuid, source)
    calls.forEach((call) => {
      if (call.id) sourceByCallId.set(call.id, source)
    })
  })

  const resultsBySourceIndex = new Map<number, BashToolResult[]>()
  const readResultsBySourceIndex = new Map<number, BashToolResult[]>()
  const hiddenResultEntryIndexes = new Set<number>()

  visibleEntries.forEach((entry, index) => {
    const lineNo = windowOffset + index + 1
    const records = extractBashToolResultRecords(entry, lineNo)
    if (records.length === 0) return

    let matchedCount = 0
    for (const record of records) {
      let source: ToolSource | undefined
      let matchedCallId = record.toolUseId

      if (record.toolUseId) {
        source = sourceByCallId.get(record.toolUseId)
      }

      if (!source) {
        const candidateUuids = [record.sourceAssistantUuid, record.parentUuid].filter(Boolean) as string[]
        for (const uuid of candidateUuids) {
          const candidate = sourcesByUuid.get(uuid)
          if (!candidate) continue
          source = candidate
          break
        }
      }

      if (!source) continue

      let matchedCall: ToolCallRef | undefined
      if (record.toolUseId) {
        matchedCall = source.calls.find((call) => call.id === record.toolUseId)
        if (!matchedCall) continue
      } else if (source.calls.length === 1) {
        matchedCall = source.calls[0]
        matchedCallId = matchedCall.id
      } else {
        continue
      }

      const next = { ...record, toolUseId: matchedCallId }
      const targetMap = matchedCall.kind === 'read' ? readResultsBySourceIndex : resultsBySourceIndex
      const existing = targetMap.get(source.index) || []
      existing.push(next)
      targetMap.set(source.index, existing)
      matchedCount += 1
    }

    if (matchedCount > 0 && matchedCount === records.length && isPureToolResultEntry(entry)) {
      hiddenResultEntryIndexes.add(index)
    }
  })

  return visibleEntries.flatMap((entry, index) => {
    if (hiddenResultEntryIndexes.has(index)) return []
    const lineNo = windowOffset + index + 1
    const bashResults = resultsBySourceIndex.get(index)
    const readResults = readResultsBySourceIndex.get(index)
    return [{ entry, lineNo, bashResults, readResults }]
  })
}

// ── function_call / function_call_output 解析 ──────────────────────────
export function functionCallCommand(payload: any): string | null {
  const args = parseFunctionCallArguments(payload?.arguments)
  const cmd = args?.cmd ?? args?.command ?? args?.input?.cmd ?? args?.input?.command
  return typeof cmd === 'string' && cmd.trim() ? cmd : null
}

export function functionOutputBody(output: any): string {
  if (typeof output === 'string') {
    const marker = 'Output:'
    const idx = output.indexOf(marker)
    return idx >= 0 ? output.slice(idx + marker.length).trimStart() : output
  }
  if (output == null) return ''
  // codex 偶尔把 output 写成结构化数组 (例如 [{type:'input_image', image_url:'data:...', detail:'high'}]).
  // 直接 String() 会得到 [object Object]. 这里把每个 block 摊平成可读描述.
  if (Array.isArray(output)) {
    const parts: string[] = []
    for (const block of output) {
      if (block == null) continue
      if (typeof block === 'string') { parts.push(block); continue }
      const btype = block.type
      if (btype === 'input_image' || btype === 'image' || btype === 'image_url') {
        const url = typeof block.image_url === 'string' ? block.image_url
          : typeof block.url === 'string' ? block.url
          : typeof block.src === 'string' ? block.src : ''
        const mime = (url.match(/^data:([^;,]+)/) || [])[1] || 'image'
        const bytes = url.startsWith('data:') ? Math.max(0, Math.floor((url.length - url.indexOf(',') - 1) * 0.75)) : 0
        const sizeStr = bytes > 0 ? ` · ${bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`}` : ''
        parts.push(`[image · ${mime}${sizeStr}]`)
        continue
      }
      if (btype === 'text' && typeof block.text === 'string') { parts.push(block.text); continue }
      if (btype === 'output_text' && typeof block.output_text === 'string') { parts.push(block.output_text); continue }
      const textField = typeof block.text === 'string' ? block.text
        : typeof block.output_text === 'string' ? block.output_text
        : ''
      if (textField) { parts.push(textField); continue }
      try { parts.push(JSON.stringify(block)) } catch { /* ignore */ }
    }
    return parts.filter(Boolean).join('\n')
  }
  if (typeof output === 'object') {
    if (typeof output.text === 'string') return output.text
    if (typeof output.output_text === 'string') return output.output_text
    try { return JSON.stringify(output) } catch { return '' }
  }
  return String(output ?? '')
}

// 从 codex function_call_output 数组里提取第一张图片的 data url, 用于卡片正文直接渲染.
export function functionOutputImageUrls(output: any): string[] {
  const out: string[] = []
  if (!Array.isArray(output)) return out
  for (const block of output) {
    if (!block || typeof block !== 'object') continue
    const btype = block.type
    if (btype !== 'input_image' && btype !== 'image' && btype !== 'image_url') continue
    const url = typeof block.image_url === 'string' ? block.image_url
      : typeof block.url === 'string' ? block.url
      : typeof block.src === 'string' ? block.src : ''
    if (url) out.push(url)
  }
  return out
}

// 从 codex function_call_output 数组里提取"非图片" block 的文本 (图片 block 已由
// functionOutputImageUrls 单独抽出渲染成 <img>, 不再混进文本). 纯图片 output 返回空串,
// 让图片面板只渲染图片; 含文字说明的 output 把文字附在图片下方.
export function functionOutputTextBody(output: any): string {
  if (typeof output === 'string') return output.trim()
  if (!Array.isArray(output)) return ''
  const parts: string[] = []
  for (const block of output) {
    if (block == null) continue
    if (typeof block === 'string') { parts.push(block); continue }
    const btype = block.type
    if (btype === 'input_image' || btype === 'image' || btype === 'image_url') continue
    if (btype === 'text' && typeof block.text === 'string') { parts.push(block.text); continue }
    if (btype === 'output_text' && typeof block.output_text === 'string') { parts.push(block.output_text); continue }
    const textField = typeof block.text === 'string' ? block.text
      : typeof block.output_text === 'string' ? block.output_text : ''
    if (textField) parts.push(textField)
  }
  return parts.filter(Boolean).join('\n').trim()
}

// ── update_plan (codex 计划模式) ─────────────────────────────────────────
// codex 执行任务时会通过 update_plan function_call 发布/更新一个分步计划,
// arguments 是 JSON 字符串 {"plan":[{"step": "...", "status": "completed|in_progress|pending"}, ...]}.
// 这里把它解析成 PlanUpdate 供计划卡片渲染, 并给标题栏一行摘要.
function normalizePlanStepStatus(raw: any): PlanStepStatus {
  return raw === 'completed' || raw === 'in_progress' || raw === 'pending' ? raw : 'pending'
}

export function extractPlanUpdate(entry: AnyEntry): PlanUpdate | null {
  if (entry?.type !== 'response_item') return null
  const payload = entry?.payload
  if (!payload || payload?.type !== 'function_call') return null
  const name = typeof payload?.name === 'string' ? payload.name : ''
  if (name !== 'update_plan') return null

  const args = parseFunctionCallArguments(payload?.arguments)
  const rawPlan = args?.plan ?? args?.input?.plan
  if (!Array.isArray(rawPlan) || rawPlan.length === 0) return null

  const steps: PlanStep[] = []
  for (const item of rawPlan) {
    if (!item || typeof item !== 'object') continue
    const stepText = typeof item.step === 'string' ? item.step.trim() : ''
    if (!stepText && !item.status) continue
    steps.push({ step: stepText || '(空步骤)', status: normalizePlanStepStatus(item.status) })
  }
  if (steps.length === 0) return null

  const completed = steps.filter((s) => s.status === 'completed').length
  const inProgress = steps.filter((s) => s.status === 'in_progress').length
  const pending = steps.filter((s) => s.status === 'pending').length
  const currentStep = steps.find((s) => s.status === 'in_progress')?.step ?? null

  return { steps, completed, inProgress, pending, currentStep }
}

// 计划一行摘要: "计划 · X/N", 有进行中步骤则追加 "· 进行中: <步骤>".
export function summarizePlanUpdate(plan: PlanUpdate): string {
  const parts = [`计划 · ${plan.completed}/${plan.steps.length}`]
  if (plan.currentStep) parts.push(`进行中: ${plan.currentStep}`)
  return parts.join(' · ')
}

// ── display_images / 附件图片解析 ──────────────────────────────────────
// 背景: agent 调 Bash 工具执行 `display_images <图1> [图2 ...]` 时, 我们要在该
// Bash 卡片后追加一张图像卡片. 命令可能被 && / || / ; / | 串接, 也可能套在
// bash -c "..." 里, 故按"顶层分隔符切片 → 引号感知分词 → 取命令字为
// display_images 的片段的参数"来抽取, 并递归一层 bash/sh -c 子命令.

// 按顶层 shell 分隔符 (&& || ; | 换行) 切片, 引号内的分隔符不切.
function splitShellSegments(cmd: string): string[] {
  const segs: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (quote) {
      cur += ch
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) { cur += cmd[i + 1]; i++ }
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if ((ch === '&' && cmd[i + 1] === '&') || (ch === '|' && cmd[i + 1] === '|')) { segs.push(cur); cur = ''; i++; continue }
    if (ch === ';' || ch === '\n' || ch === '|') { segs.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) segs.push(cur)
  return segs
}

// 引号感知分词: "..." / '...' 去引号, \x 取字面, 空白分隔. 单段 (无分隔符) 用.
function tokenizeSegment(seg: string): string[] {
  const toks: string[] = []
  let cur = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < seg.length) { cur += seg[i + 1]; i++ }
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (ch === ' ' || ch === '\t') { if (started) { toks.push(cur); cur = ''; started = false } continue }
    if (ch === '\\' && i + 1 < seg.length) { cur += seg[i + 1]; i++; started = true; continue }
    cur += ch; started = true
  }
  if (started) toks.push(cur)
  return toks
}

// display_images 只接受绝对路径(以 / 开头)或 http(s) URL —— 与命令自身的校验一致.
function isImageArg(tok: string): boolean {
  return tok.startsWith('/') || /^https?:\/\//i.test(tok)
}

function collectDisplayImages(command: string, depth: number, out: string[]): void {
  if (depth > 3) return
  for (const seg of splitShellSegments(command)) {
    const toks = tokenizeSegment(seg.trim())
    if (toks.length === 0) continue
    const base = toks[0].split('/').pop() || toks[0]   // 允许 .../display_images 这种带路径前缀的命令字
    if (base === 'display_images') {
      for (let i = 1; i < toks.length; i++) {
        const a = toks[i]
        if (a.startsWith('-')) continue                // 跳过 -h / --help 等选项
        if (isImageArg(a)) out.push(a)
      }
      continue
    }
    if (base === 'bash' || base === 'sh' || base === 'zsh') {
      const ci = toks.findIndex((tok) => tok === '-c' || /^-[^-]\S*c\S*$/.test(tok))
      if (ci >= 0 && toks[ci + 1]) collectDisplayImages(toks[ci + 1], depth + 1, out)
    }
  }
}

function collectDisplayImagesFromCommand(command: any, out: string[]): void {
  if (typeof command === 'string' && command.indexOf('display_images') !== -1) {
    collectDisplayImages(command, 0, out)
  }
}

function cleanAttachmentImagePath(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^["'`<]+/, '')
    .replace(/[>"'`]+$/, '')
}

function collectAttachmentImagesFromText(text: any, out: string[]): void {
  if (typeof text !== 'string' || text.indexOf('[图片]') === -1) return
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s*\[图片\]\s+(.+?)\s*$/)
    if (!match) continue
    const imagePath = cleanAttachmentImagePath(match[1])
    if (isImageArg(imagePath)) out.push(imagePath)
  }
}

function collectContentBlockTexts(content: any, out: string[]): void {
  if (typeof content === 'string') {
    out.push(content)
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') out.push(block.text)
    if (typeof block.input_text === 'string') out.push(block.input_text)
    if (typeof block.content === 'string') out.push(block.content)
  }
}

// 从单条 entry 抽取所有 Bash/exec_command 调用里 display_images 的图片参数 (去重保序).
export function entryDisplayImages(entry: AnyEntry): string[] {
  const out: string[] = []

  if (entry?.type === 'assistant') {
    const c = entry?.message?.content
    if (Array.isArray(c)) {
      for (const b of c) {
        // 大小写兼容 (与 BashCall 渲染路径一致), 让 'bash' 工具名也能派生图像卡片.
        const cmd = b?.type === 'tool_use' && isBashToolUseName(b?.name) ? b?.input?.command : null
        collectDisplayImagesFromCommand(cmd, out)
      }
    }
  }

  if (entry?.type === 'response_item' && entry?.payload?.type === 'function_call') {
    const args = parseFunctionCallArguments(entry.payload.arguments)
    collectDisplayImagesFromCommand(args?.cmd ?? args?.command ?? args?.input?.command, out)
  }

  return Array.from(new Set(out))
}

// 从用户消息里抽取附件图片行. 当前发送侧把图片附件拼进文本:
// [附件]
// - [图片] /abs/path
export function entryUserAttachmentImages(entry: AnyEntry): string[] {
  const texts: string[] = []

  if (entry?.type === 'event_msg' && entry?.payload?.type === 'user_message') {
    if (typeof entry.payload.message === 'string') texts.push(entry.payload.message)
    if (typeof entry.payload.content === 'string') texts.push(entry.payload.content)
  }

  if (entry?.type === 'response_item' && entry?.payload?.type === 'message' && entry?.payload?.role === 'user') {
    collectContentBlockTexts(entry.payload.content, texts)
  }

  if (entry?.type === 'user') {
    collectContentBlockTexts(entry?.message?.content, texts)
    if (typeof entry?.content === 'string') texts.push(entry.content)
  }

  const out: string[] = []
  for (const text of texts) collectAttachmentImagesFromText(text, out)
  return Array.from(new Set(out))
}

// ── 本地命令 (<local-command-*> / <command-*>) 标签解析 ────────────────
// Claude Code 的 slash command / 本地命令产物会以 user 消息出现, content 被以下标签之一或多个包裹:
//   <local-command-stdout>…</local-command-stdout>   命令输出 (如 /compact 后的 "Compacted …")
//   <local-command-caveat>…</local-command-caveat>   "下面消息由本地命令产生, 无需响应" 提示
//   <command-name>…</command-name> / <command-message> / <command-args>   命令本体描述
// 这些都套了 user 外壳但不是人类提问; content 含 < > 尖括号与可能的控制字符,
// 渲染时必须走特例干净文案, 不能把标签原文或控制字符显示成乱码.
const LOCAL_COMMAND_TAG_PATTERN = /<(local-command-stdout|local-command-caveat|command-name|command-message|command-args)>\s*([\s\S]*?)<\/\1>/gi

// 从 user 消息 content 提取所有 local-command / command 标签 (按出现顺序). 空数组 = 不是此类产物.
// 兼容 content 为字符串或含 text 块的数组. body 已清掉除 \n \t 外的控制字符并 trim.
export function extractLocalCommandParts(entry: AnyEntry): LocalCommandPart[] {
  if (entry?.type !== 'user') return []
  const c = entry?.message?.content
  const text = typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((b: any) => (typeof b === 'string' ? b : (b?.text ?? ''))).join('\n')
      : ''
  if (!text) return []
  const parts: LocalCommandPart[] = []
  LOCAL_COMMAND_TAG_PATTERN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LOCAL_COMMAND_TAG_PATTERN.exec(text))) {
    const body = m[2].replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim()
    parts.push({ tag: m[1].toLowerCase(), body })
  }
  return parts
}

export { extractWriteToolCall }
