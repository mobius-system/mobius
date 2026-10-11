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
  isAimuxCommandToolUseName,
  isAimuxRemoteApplyPatchToolUseName,
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
  BashResultMeta,
  JsonlViewItem,
  StringCodeEditFile,
  UnifiedCodeEditFile,
  LocalCommandPart,
  PlanStep,
  PlanStepStatus,
  PlanUpdate,
} from './types'

// re-export: 部分模块 (BashCall 类型 / block 级抽取 / 一行摘要) 直接复用 jsonl-bash-helpers 的实现.
export { extractBashCallFromBlock, bashCallOneLineSummary, isAimuxCommandToolUseName, isAimuxRemoteApplyPatchToolUseName, isBashToolUseName } from '../jsonl-bash-helpers'
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

  if (entry?.type === 'response_item' && isFunctionCallPayload(entry?.payload) && entry?.payload?.name === 'Write') {
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

// remote_apply_patch 把标准 apply_patch 文本放在 input.input 中。它不是标准 unified
// diff，但其内容段保留 @@ / + / - 语义，现有 CodeDiff 可以直接可靠呈现。
export function extractAimuxRemoteApplyPatchFiles(block: any): UnifiedCodeEditFile[] {
  if (!block || block?.type !== 'tool_use' || !isAimuxRemoteApplyPatchToolUseName(block?.name)) return []
  const input = block?.input
  const patch = typeof input?.input === 'string' ? input.input
    : typeof input?.patch === 'string' ? input.patch
      : ''
  if (!patch.includes('*** Begin Patch') || !patch.includes('*** End Patch')) return []

  const files: UnifiedCodeEditFile[] = []
  let filePath = ''
  let lines: string[] = []
  const commitFile = () => {
    if (!filePath || lines.length === 0) return
    files.push(unifiedEditFile(filePath, lines.join('\n')))
  }

  for (const line of patch.split(/\r?\n/)) {
    const target = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line)
    if (target) {
      commitFile()
      filePath = target[1].trim()
      lines = []
      continue
    }
    if (line === '*** Begin Patch' || line === '*** End Patch' || line === '*** End of File') continue
    if (filePath) lines.push(line)
  }
  commitFile()
  return files
}

export function isAimuxRemoteApplyPatchToolUse(entry: AnyEntry): boolean {
  if (entry?.type !== 'assistant') return false
  const content = entry?.message?.content
  return Array.isArray(content) && content.some((block: any) => extractAimuxRemoteApplyPatchFiles(block).length > 0)
}

export function extractCodeEdit(entry: AnyEntry): CodeEdit | null {
  const files: CodeEditFile[] = []

  if (entry?.type === 'assistant') {
    const c = entry?.message?.content
    if (Array.isArray(c)) {
      for (const block of c) {
        if (block?.type !== 'tool_use') continue
        if (block?.name === 'Edit') {
          const input = block?.input
          if (typeof input?.old_string !== 'string' || typeof input?.new_string !== 'string') continue
          files.push(stringEditFile(
            typeof input.file_path === 'string' ? input.file_path : '',
            input.old_string,
            input.new_string,
          ))
          continue
        }
        files.push(...extractAimuxRemoteApplyPatchFiles(block))
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

  if (entry?.type === 'response_item' && isFunctionCallPayload(entry?.payload)) {
    const payload = entry.payload
    const cmd = functionCallCommand(payload)
    if (!cmd) return []
    const args = functionCallArguments(payload) || {}
    const name = typeof payload?.name === 'string' ? payload.name : ''
    if (name && name !== 'exec' && name !== 'exec_command' && name !== 'bash' && name !== 'shell') return []

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

export function isAimuxCommandToolUse(entry: AnyEntry): boolean {
  if (entry?.type !== 'assistant') return false
  const content = entry?.message?.content
  if (!Array.isArray(content)) return false
  return content.some((block: any) => {
    if (block?.type !== 'tool_use' || !isAimuxCommandToolUseName(block?.name)) return false
    const input = block?.input
    return !!input && typeof input === 'object' && [input.cmd, input.command, input.script].some((value) => typeof value === 'string' && value.length > 0)
  })
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

// 读取图片时，工具调用本身只给出 file_path，不会像 display_images 那样显式请求
// 展示。为避免用户只看到“Read /tmp/foo.png”而无法检查图片，按浏览器可预览的扩展名
// 派生图片卡。真正的 src 仍由 DisplayImages 经受鉴权的 /api/download 取得。
const IMAGE_FILE_PATH_RE = /\.(?:apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i

export function entryReadImagePaths(entry: AnyEntry): string[] {
  return Array.from(new Set(
    extractReadCalls(entry)
      .map((call) => call.filePath.trim())
      .filter((filePath) => IMAGE_FILE_PATH_RE.test(filePath)),
  ))
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
  if (entry?.type === 'response_item' && isFunctionCallOutputPayload(entry?.payload)) return true
  const content = entry?.message?.content
  return entry?.type === 'user'
    && Array.isArray(content)
    && content.length > 0
    && content.every((block: any) => block?.type === 'tool_result')
}

export function extractBashToolResultRecords(entry: AnyEntry, lineNo: number): BashToolResult[] {
  if (entry?.type === 'response_item' && isFunctionCallOutputPayload(entry?.payload)) {
    const output = functionOutputBody(entry.payload?.output)
    const imageUrls = functionOutputImageUrls(entry.payload?.output)
    // codex exec 路径同样可能是 aimux 信封 (functionOutputBody 已把数组块摊平成文本):
    // 命中即解包, 与 claude type:user 路径同一观感.
    const envelope = parseMcpResultEnvelope(output)
    if (envelope) {
      return [{
        entry,
        lineNo,
        toolUseId: stringField(entry.payload?.call_id) || undefined,
        stdout: envelope.output,
        stderr: '',
        content: envelope.output,
        isError: entry.payload?.status === 'failed' || entry.payload?.is_error === true || (envelope.raw.exit_code !== undefined && envelope.raw.exit_code !== 0),
        interrupted: false,
        isImage: imageUrls.length > 0,
        imageUrls,
        noOutputExpected: false,
        meta: mcpEnvelopeMeta(envelope.raw),
      }]
    }
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
    // ✨ 图片载荷 (原生 image 块 / 字符串化信封) 单独抽出, 正文不再铺 base64
    // Image payloads (native blocks / stringified envelopes) are extracted; the body never shows base64
    const blockImages = toolResultBlockImages(block?.content)
    // aimux exec 信封: block 正文是 {"output":..., "wall_time_seconds":..., "exit_code":...} JSON 串.
    // 直接把信封当 stdout 会渲染成一整行转义 JSON (\n 字面量, 引号全被转义, 换行全部失效 —
    // 用户报告的问题). 命中信封时解包: stdout/content = output 正文, meta 带执行元信息.
    const envelope = parseMcpResultEnvelope(blockContent)
    if (envelope) {
      return {
        entry,
        lineNo,
        toolUseId: stringField(block?.tool_use_id) || undefined,
        parentUuid: parentUuid || undefined,
        sourceAssistantUuid: sourceAssistantUuid || undefined,
        stdout: envelope.output,
        stderr: '',
        content: envelope.output,
        isError: block?.is_error === true || envelope.raw.exit_code !== undefined && envelope.raw.exit_code !== 0,
        interrupted,
        isImage: isImage || blockImages.length > 0,
        imageUrls: blockImages,
        noOutputExpected,
        readFile,
        meta: mcpEnvelopeMeta(envelope.raw),
      }
    }
    const fallbackContent = [readFile?.content, stdout, stderr].filter(Boolean).join('\n')
    return {
      entry,
      lineNo,
      toolUseId: stringField(block?.tool_use_id) || undefined,
      parentUuid: parentUuid || undefined,
      sourceAssistantUuid: sourceAssistantUuid || undefined,
      stdout,
      stderr,
      content: blockImages.length > 0 ? '' : (blockContent || fallbackContent),
      isError: block?.is_error === true || toolUseResult.is_error === true || !!toolUseResult.error,
      interrupted,
      isImage: isImage || blockImages.length > 0,
      imageUrls: blockImages,
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

// ── function_call / custom_tool_call 解析 ──────────────────────────────
// Codex 新版把 exec 调用写成 custom_tool_call/custom_tool_call_output，
// 其中 input 是一段 tools.exec_command({...}) JavaScript，而不是旧版 JSON arguments。
// 统一在这里归一化，调用方无需区分协议版本。
export function isFunctionCallPayload(payload: any): boolean {
  return payload?.type === 'function_call' || payload?.type === 'custom_tool_call'
}

export function isFunctionCallOutputPayload(payload: any): boolean {
  return payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output'
}

// 从 reasoning payload 提取可读思考正文 (response_item.payload.type === 'reasoning').
// OpenAI Responses / Codex 的 reasoning 常同时带 content[] 明文 (reasoning_text/summary_text)
// 与 encrypted_content 引用; 只有 content 无可读文本时才真算"加密不可解". 返回空串 = 无可读正文.
export function reasoningText(payload: any): string {
  const content = payload?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((b: any) => {
      if (!b || typeof b !== 'object') return ''
      if (typeof b.text === 'string') return b.text
      if (typeof b.reasoning === 'string') return b.reasoning
      if (typeof b.summary === 'string') return b.summary
      return ''
    })
    .filter((t: string) => t.trim())
    .join('\n')
    .trim()
}

function decodeJsString(raw: string): string {
  try { return JSON.parse(`"${raw}"`) }
  catch { return raw.replace(/\\([\\"'nrt])/g, (_m, c) => ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[c] || c) }
}

function parseCustomToolInput(raw: any): Record<string, any> | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  const marker = /(?:tools\.)?exec_command\s*\(/g
  const match = marker.exec(raw)
  if (!match) return null
  const objectStart = raw.indexOf('{', match.index + match[0].length)
  if (objectStart < 0) return null
  let quote = ''
  let escaped = false
  let depth = 0
  let objectEnd = -1
  for (let i = objectStart; i < raw.length; i++) {
    const ch = raw[i]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) { objectEnd = i; break }
  }
  if (objectEnd < 0) return null
  const source = raw.slice(objectStart, objectEnd + 1)
  try {
    const parsed = JSON.parse(source)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    const out: Record<string, any> = {}
    const patterns = [
      /(?:^|[,{])\s*(cmd|command|script|workdir|cwd)\s*:\s*"((?:\\.|[^"\\])*)"/g,
      /(?:^|[,{])\s*(cmd|command|script|workdir|cwd)\s*:\s*'((?:\\.|[^'\\])*)'/g,
    ]
    for (const fieldPattern of patterns) {
      let field: RegExpExecArray | null
      while ((field = fieldPattern.exec(source))) out[field[1]] = decodeJsString(field[2])
    }
    return Object.keys(out).length > 0 ? out : null
  }
}

function functionCallArguments(payload: any): Record<string, any> | null {
  return parseFunctionCallArguments(payload?.arguments)
    || parseCustomToolInput(payload?.input)
}

export function functionCallCommand(payload: any): string | null {
  const args = functionCallArguments(payload)
  const cmd = args?.cmd ?? args?.command ?? args?.input?.cmd ?? args?.input?.command
  if (typeof cmd === 'string' && cmd.trim()) return cmd
  // 新版 Codex 的 custom_tool_call(name="exec") 不只包装 exec_command，也会包装
  // write_stdin / apply_patch 等工具。它们没有 shell cmd，但仍必须成为一个可按 call_id
  // 接收 custom_tool_call_output 的调用卡片；否则调用与结果会再次拆成两张字段卡。
  if (payload?.type === 'custom_tool_call' && payload?.name === 'exec') {
    const input = stringField(payload?.input).trim()
    if (input) return input
  }
  return null
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
      // custom_tool_call_output 使用 input_text；空文本块表示没有新增输出，不能落入
      // JSON.stringify 兜底显示成 {"type":"input_text","text":""} 伪内容。
      if (btype === 'input_text' && typeof block.text === 'string') {
        if (block.text) parts.push(block.text)
        continue
      }
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

// ── Claude tool_result 内嵌图片 (MCP 图像返回) 解析 ──────────────────────
// Claude Code 的 MCP 图像工具 (如 analyze_image) 把图片包进 tool_result 回填, 两种形态:
//  1) text 块正文是一段字符串化 JSON: {"detail":"high","image_url":"data:image/png;base64,…"}
//     (OpenAI images 形态, image_url 也可能是 {"url": "data:…"} 嵌套);
//  2) 原生 image 块: {type:'image', source:{type:'base64', media_type:'image/png', data:'<裸base64>'}}.
// 与 functionOutputImageUrls (codex 路径) 同理: 抽出 data url 交给 <img> 渲染, 不进字段模式
// 递归展开 base64. 图片信封整块消费; 其余 text 块作为文字说明附在图片下方.

// image_url 引用 (字符串直给或 OpenAI {url} 嵌套) → 合法图片 url, 否则空串.
function imageRefUrl(ref: any): string {
  const url = typeof ref === 'string' ? ref : typeof ref?.url === 'string' ? ref.url : ''
  return /^(?:data:image\/|https?:\/\/)/i.test(url) ? url : ''
}

// text 正文若是字符串化 JSON (对象或内容块数组) → 抽出其中全部图片 url. 覆盖:
//  {"image_url":"data:…"} / {"image_url":{"url":"data:…"}} (OpenAI images 信封);
//  [{"type":"text","text":"{\"image_url\":…}"}] (内容块数组的字符串化 — 工具原始返回/用户粘贴卡的形态);
//  [{"type":"image","source":{…base64…}}] (原生 image 块的字符串化).
// 只认 image_url 键与 image/input_image 块 (不认裸 url 键), 避免把普通 JSON 误判成图片.
function jsonTextImageUrls(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return []
  let parsed: any
  try { parsed = JSON.parse(trimmed) } catch { return [] }
  return jsonValueImageUrls(parsed, 0)
}

function jsonValueImageUrls(value: any, depth: number): string[] {
  if (depth > 4 || value == null) return []
  const out: string[] = []
  if (Array.isArray(value)) {
    for (const item of value) out.push(...jsonValueImageUrls(item, depth + 1))
    return out
  }
  if (typeof value !== 'object') return []
  if (value.type === 'image' || value.type === 'input_image') {
    const url = nativeImageBlockUrl(value) || imageRefUrl(value.image_url) || imageRefUrl(value.url)
    if (url) out.push(url)
  }
  const refUrl = imageRefUrl(value.image_url)
  if (refUrl) out.push(refUrl)
  // {"type":"text","text":"…"} 里的嵌套信封再解一层
  // A nested envelope inside a text block gets one more level of unwrapping
  if (typeof value.text === 'string') out.push(...jsonTextImageUrls(value.text))
  return out
}

// 原生 image 块 (source.type === 'base64') → data url.
function nativeImageBlockUrl(block: any): string | null {
  const source = block?.source
  if (!source || source?.type !== 'base64') return null
  const data = typeof source?.data === 'string' ? source.data : ''
  if (!data) return null
  const mime = typeof source?.media_type === 'string' && source.media_type ? source.media_type : 'image/png'
  return `data:${mime};base64,${data}`
}

// 单个 tool_result 的 content (数组块或字符串) → 图片 url 列表. 与 claudeToolResultImageOutput
// 同源逻辑的"无 callId"版, 供 extractBashToolResultRecords 给合并结果记录挂 imageUrls.
function toolResultBlockImages(content: any): string[] {
  const out: string[] = []
  if (Array.isArray(content)) {
    for (const sub of content) {
      if (typeof sub === 'string') { out.push(...jsonTextImageUrls(sub)); continue }
      if (!sub || typeof sub !== 'object') continue
      if (sub.type === 'image' || sub.type === 'input_image') {
        const url = nativeImageBlockUrl(sub) || imageRefUrl(sub.image_url) || imageRefUrl(sub.url)
        if (url) out.push(url)
        continue
      }
      if (typeof sub.text === 'string') out.push(...jsonTextImageUrls(sub.text))
    }
  } else if (typeof content === 'string') {
    out.push(...jsonTextImageUrls(content))
  }
  return out
}

// <persisted-output> 存根: CC 把超大 tool result 落盘, jsonl 里只剩 2KB 预览.
// 预览出现图片信封特征 (image_url + data:image/) 时该结果实为一张大图 — 返回落盘
// 文件路径, 图片字节由前端经 /api/sessions/tool-result-media 按需取回.
// image_url 不带引号匹配: 预览里的引号是转义形态 (\"image_url\"), 带引号会漏.
function persistedImageStubPath(text: string): string | null {
  if (!text.includes('<persisted-output>')) return null
  const match = /Full output saved to:\s*(\S+)/.exec(text)
  if (!match) return null
  const isImageEnvelope = text.includes('image_url') && text.includes('data:image/')
  return isImageEnvelope ? match[1] : null
}

// claudeToolResultImageOutput 的返回: imageUrls 是可直接渲染的 data url;
// deferred 标记存根场景 (原图在落盘文件里, 卡片只有 2KB 预览), 两者互斥.
export type ClaudeToolResultImages = {
  imageUrls: string[]
  textBody: string
  deferred?: { callId: string; savedPath: string }
}

// 从 tool_result entry (user 回填 / assistant 承载的 server_tool_result) 抽内嵌图片
// (内联信封 / 原生 image 块 / 字符串化数组 / 落盘存根). 都不是图片载体时返回 null.
export function claudeToolResultImageOutput(entry: AnyEntry): ClaudeToolResultImages | null {
  if (entry?.type !== 'user' && entry?.type !== 'assistant') return null
  const content = entry?.message?.content
  if (!Array.isArray(content)) return null
  const imageUrls: string[] = []
  const textParts: string[] = []
  let deferred: ClaudeToolResultImages['deferred'] | undefined
  let sawToolResult = false

  // 单个 content 载体 (数组块或整段字符串) 的图片抽取, 命中返回 true 表示已消费.
  const consumeBlockText = (text: string, callId: unknown): boolean => {
    const urls = jsonTextImageUrls(text)
    if (urls.length > 0) { imageUrls.push(...urls); return true }
    const stubPath = persistedImageStubPath(text)
    if (stubPath && typeof callId === 'string' && callId && !deferred) {
      deferred = { callId, savedPath: stubPath }
      return true
    }
    return false
  }

  for (const block of content) {
    if (!block || typeof block !== 'object' || block?.type !== 'tool_result') continue
    sawToolResult = true
    const callId = typeof block?.tool_use_id === 'string' ? block.tool_use_id : undefined
    if (Array.isArray(block?.content)) {
      for (const sub of block.content) {
        if (typeof sub === 'string') {
          if (!consumeBlockText(sub, callId)) textParts.push(sub)
          continue
        }
        if (!sub || typeof sub !== 'object') continue
        if (sub?.type === 'image') {
          const url = nativeImageBlockUrl(sub)
          if (url) { imageUrls.push(url); continue }
        }
        if (typeof sub?.text === 'string') {
          // ✨ 图片信封/存根命中即整块消费, 不再把 base64 原文混进文字正文
          // A matched envelope or stub is consumed whole; its base64 never leaks into the text body
          if (!consumeBlockText(sub.text, callId)) textParts.push(sub.text)
        }
      }
    } else if (typeof block?.content === 'string') {
      if (!consumeBlockText(block.content, callId)) textParts.push(block.content)
    }
  }
  if (!sawToolResult || (imageUrls.length === 0 && !deferred)) return null
  return { imageUrls: Array.from(new Set(imageUrls)), textBody: textParts.filter(Boolean).join('\n').trim(), deferred }
}

// ── update_plan (codex 计划模式) ─────────────────────────────────────────
// codex 执行任务时会通过 update_plan function_call 发布/更新一个分步计划,
// arguments 是 JSON 字符串 {"plan":[{"step": "...", "status": "completed|in_progress|pending"}, ...]}.
// 这里把它解析成 PlanUpdate 供计划卡片渲染, 并给标题栏一行摘要.
function normalizePlanStepStatus(raw: any): PlanStepStatus {
  return raw === 'completed' || raw === 'in_progress' || raw === 'pending' ? raw : 'pending'
}

// 从已归一的 steps 数组汇总 completed/inProgress/pending 计数与当前进行中步骤.
function buildPlanUpdate(steps: PlanStep[]): PlanUpdate {
  const completed = steps.filter((s) => s.status === 'completed').length
  const inProgress = steps.filter((s) => s.status === 'in_progress').length
  const pending = steps.filter((s) => s.status === 'pending').length
  const currentStep = steps.find((s) => s.status === 'in_progress')?.step ?? null
  return { steps, completed, inProgress, pending, currentStep }
}

// codex update_plan function_call → PlanUpdate.
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
  return buildPlanUpdate(steps)
}

// Claude Code 的 task_reminder 附件 (type:attachment, attachment.type:task_reminder,
// attachment.content:[{id,subject,description,activeForm,status,blocks,blockedBy},...]).
// 它和 codex update_plan 是同一类东西 (分步计划/待办), 这里也归一成 PlanUpdate,
// 让两种计划源共用同一张可视化卡片: subject→step, status 归一, 其余字段挂可选属性.
export function extractTaskReminder(entry: AnyEntry): PlanUpdate | null {
  if (entry?.type !== 'attachment') return null
  const attachment = entry?.attachment
  if (!attachment || attachment?.type !== 'task_reminder') return null
  const content = attachment?.content
  if (!Array.isArray(content) || content.length === 0) return null

  const steps: PlanStep[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const subject = typeof item.subject === 'string' ? item.subject.trim() : ''
    const description = typeof item.description === 'string' ? item.description.trim() : ''
    if (!subject && !description) continue
    const activeForm = typeof item.activeForm === 'string' && item.activeForm.trim() ? item.activeForm.trim() : ''
    const blocks = Array.isArray(item.blocks) ? item.blocks.map((b: any) => String(b)).filter(Boolean) : undefined
    const blockedBy = Array.isArray(item.blockedBy) ? item.blockedBy.map((b: any) => String(b)).filter(Boolean) : undefined
    steps.push({
      step: subject || description.slice(0, 80) || '(空任务)',
      status: normalizePlanStepStatus(item.status),
      id: item.id == null ? undefined : String(item.id),
      description: description || undefined,
      activeForm: activeForm && activeForm !== subject ? activeForm : undefined,
      blocks: blocks && blocks.length > 0 ? blocks : undefined,
      blockedBy: blockedBy && blockedBy.length > 0 ? blockedBy : undefined,
    })
  }
  if (steps.length === 0) return null
  return buildPlanUpdate(steps)
}

// 统一计划卡片数据入口: codex update_plan 优先, 其次 Claude task_reminder.
export function extractPlanCard(entry: AnyEntry): PlanUpdate | null {
  return extractPlanUpdate(entry) ?? extractTaskReminder(entry)
}

// ── Claude 任务工具 (TaskCreate/TaskUpdate) 的计划卡片渲染 ────────────────
// 任务工具调用是增量语义: TaskCreate 只带 subject, TaskUpdate 只带 {taskId,status},
// 单条 entry 无法自渲染完整任务列表 (标题在更早的 TaskCreate 里)。跨条目累积在
// ./task-progress (JsonlView 顶层, 前端兜底) 与 backend task-state-reducer
// (sidecar task_state 快照, 权威) 完成; 这里只负责单条目的识别与形态抽取。
export function isTaskToolUseName(name: unknown): boolean {
  return typeof name === 'string' && (name === 'TaskCreate' || name === 'TaskUpdate')
}

// assistant entry 里的任务工具调用 (保序)。无则空数组。
export function extractTaskToolCalls(entry: AnyEntry): Array<{ name: string; toolUseId?: string; input: Record<string, any> }> {
  if (entry?.type !== 'assistant') return []
  const content = entry?.message?.content
  if (!Array.isArray(content)) return []
  const out: Array<{ name: string; toolUseId?: string; input: Record<string, any> }> = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || block?.type !== 'tool_use') continue
    if (!isTaskToolUseName(block?.name)) continue
    out.push({
      name: String(block.name),
      toolUseId: typeof block?.id === 'string' && block.id ? block.id : undefined,
      input: block?.input && typeof block.input === 'object' ? block.input : {},
    })
  }
  return out
}

// 该 entry 是否携带任务工具调用 (决定卡片可走计划视图)。
export function isTaskToolUseEntry(entry: AnyEntry): boolean {
  return extractTaskToolCalls(entry).length > 0
}

// task_reminder 附件 (attachment.type === 'task_reminder' 且 content 非空) 是 TUI 自产的
// 全量任务快照。extractTaskReminder (上方) 把它归一成 PlanUpdate 渲染计划卡; 这里按
// 原始任务记录返回 (含 description/blocks 等全部字段), 供跨条目累积器作权威覆盖。
export type TaskReminderRecord = { id: string; subject: string; description?: string; activeForm?: string; status: string; blocks?: string[]; blockedBy?: string[] }

export function extractTaskReminderSnapshot(entry: AnyEntry): TaskReminderRecord[] | null {
  if (entry?.type !== 'attachment') return null
  const attachment = entry?.attachment
  if (!attachment || attachment?.type !== 'task_reminder') return null
  const content = attachment?.content
  if (!Array.isArray(content) || content.length === 0) return null
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const strList = (v: unknown) => {
    if (!Array.isArray(v)) return undefined
    const out = v.map((x) => String(x)).filter(Boolean)
    return out.length > 0 ? out : undefined
  }
  const tasks: TaskReminderRecord[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const id = str(item.id)
    if (!id) continue
    tasks.push({
      id,
      subject: str(item.subject) || `任务 #${id}`,
      description: str(item.description),
      activeForm: str(item.activeForm),
      status: item.status === 'completed' || item.status === 'in_progress' || item.status === 'pending' ? item.status : 'pending',
      blocks: strList(item.blocks),
      blockedBy: strList(item.blockedBy),
    })
  }
  return tasks.length > 0 ? tasks : null
}

// ── Claude 任务工具 (TaskCreate/TaskUpdate) 的计划卡片渲染 ────────────────
// 任务快照 (sidecar task_state 的 tasks 数组 / 前端累积表) → PlanUpdate,
// 让任务卡与 update_plan / task_reminder 共用同一张计划卡片。
export function taskSnapshotToPlanUpdate(tasks: any): PlanUpdate | null {
  if (!Array.isArray(tasks) || tasks.length === 0) return null
  const steps: PlanStep[] = []
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue
    const id = task.id == null ? undefined : String(task.id)
    const subject = typeof task.subject === 'string' && task.subject.trim() ? task.subject.trim() : ''
    if (!id && !subject) continue
    steps.push({
      step: subject || (id ? `任务 #${id}` : '(空任务)'),
      status: task.status === 'completed' || task.status === 'in_progress' || task.status === 'pending' ? task.status : 'pending',
      id,
      description: typeof task.description === 'string' && task.description.trim() ? task.description.trim() : undefined,
      activeForm: typeof task.activeForm === 'string' && task.activeForm.trim() ? task.activeForm.trim() : undefined,
      blocks: Array.isArray(task.blocks) ? task.blocks.map((b: any) => String(b)).filter(Boolean) : undefined,
      blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map((b: any) => String(b)).filter(Boolean) : undefined,
    })
  }
  if (steps.length === 0) return null
  return buildPlanUpdate(steps)
}

// sidecar task_state 载体条目 (type: 'task_state', mobius.tasks 为全量快照)。
export function extractTaskStateSnapshot(entry: AnyEntry): PlanUpdate | null {
  if (entry?.type !== 'task_state') return null
  return taskSnapshotToPlanUpdate(entry?.mobius?.tasks)
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

  if (entry?.type === 'response_item' && isFunctionCallPayload(entry?.payload)) {
    const args = functionCallArguments(entry.payload)
    collectDisplayImagesFromCommand(args?.cmd ?? args?.command ?? args?.input?.command, out)
  }

  return Array.from(new Set(out))
}

export type DisplayFileRef = { path: string; remote?: string; root?: string }

/*
 * Tokenize one shell command only through its argv prefix. Unquoted control operators and
 * redirects terminate argv, while quoted or escaped operator characters stay in file names.
 */
function tokenizeCommandArgv(seg: string): string[] {
  const toks: string[] = []
  let cur = ''
  let started = false
  let quoted = false
  let quote: '"' | "'" | null = null
  const push = () => {
    if (started) toks.push(cur)
    cur = ''
    started = false
    quoted = false
  }
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < seg.length) { cur += seg[i + 1]; i++ }
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; quoted = true; continue }
    if (ch === '\\' && i + 1 < seg.length) { cur += seg[i + 1]; i++; started = true; quoted = true; continue }
    if (ch === ' ' || ch === '\t') { push(); continue }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&' || ch === '<' || ch === '>') {
      // 未加引号并紧贴重定向符的纯数字是 fd，不是 display-files 的路径参数
      // An unquoted digit run attached to a redirect is an fd, not a display-files path
      if (!((ch === '<' || ch === '>') && started && !quoted && /^\d+$/.test(cur))) push()
      return toks
    }
    cur += ch
    started = true
  }
  push()
  return toks
}

function collectDisplayFiles(command: string, depth: number, out: DisplayFileRef[]): void {
  if (depth > 3) return
  for (const seg of splitShellSegments(command)) {
    const toks = tokenizeCommandArgv(seg.trim())
    if (toks.length === 0) continue
    const base = toks[0].split('/').pop() || toks[0]
    if (base === 'display-files') {
      let remote = ''
      let root = ''
      const paths: string[] = []
      for (let i = 1; i < toks.length; i++) {
        const token = toks[i]
        if (token === '--') { paths.push(...toks.slice(i + 1)); break }
        if (token === '--remote' || token === '--root') {
          const value = toks[++i]
          if (value && !value.startsWith('--')) {
            if (token === '--remote') remote = value
            else root = value
          }
          continue
        }
        if (token.startsWith('--remote=')) { remote = token.slice(9); continue }
        if (token.startsWith('--root=')) { root = token.slice(7); continue }
        if (token.startsWith('-')) continue
        paths.push(token)
      }
      for (const path of paths) if (path) out.push({ path, ...(remote ? { remote } : {}), ...(root ? { root } : {}) })
      continue
    }
    if (base === 'bash' || base === 'sh' || base === 'zsh') {
      const ci = toks.findIndex((tok) => tok === '-c' || /^-[^-]\S*c\S*$/.test(tok))
      if (ci >= 0 && toks[ci + 1]) collectDisplayFiles(toks[ci + 1], depth + 1, out)
    }
  }
}

export function entryDisplayFiles(entry: AnyEntry): DisplayFileRef[] {
  const commands: string[] = []
  if (entry?.type === 'assistant' && Array.isArray(entry?.message?.content)) {
    for (const block of entry.message.content) {
      if (block?.type === 'tool_use' && isBashToolUseName(block?.name) && typeof block?.input?.command === 'string') commands.push(block.input.command)
    }
  }
  if (entry?.type === 'response_item' && isFunctionCallPayload(entry?.payload)) {
    const name = typeof entry?.payload?.name === 'string' ? entry.payload.name.toLowerCase() : ''
    if (!['exec', 'exec_command', 'bash', 'shell'].includes(name)) return []
    const args = functionCallArguments(entry.payload)
    const command = args?.cmd ?? args?.command ?? args?.input?.command
    if (typeof command === 'string') commands.push(command)
  }
  const found = commands.flatMap(command => {
    const rows: DisplayFileRef[] = []
    if (command.includes('display-files')) collectDisplayFiles(command, 0, rows)
    return rows
  })
  const seen = new Set<string>()
  return found.filter(item => {
    const key = `${item.remote || ''}\0${item.root || ''}\0${item.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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

// ── MCP 工具返回信封解析 ────────────────────────────────────────────────
// 部分 MCP 工具 (如外置 exec/shell MCP) 把命令返回包成统一信封:
//   {"output": "<命令 stdout/终端文本>", "original_token_count": N, "wall_time_seconds": N, "session_id": N}
// 这种 tool_result 若按字段模式铺开, 整张卡全是元数据 JSON, 真正有用的 output 淹没在嵌套里.
// 这里识别该信封, 抽出 output 文本 + 执行元信息, 供卡片以"代码模式"渲染 (终端式 pre + 行号 + 折叠),
// 与 Bash 返回结果面板观感一致.

export type McpToolResultMeta = { label: string; value: string }

export type McpToolResult = {
  output: string
  meta: McpToolResultMeta[]
  toolUseId?: string
  isError: boolean
}

// 判定一段文本是否为 MCP 工具返回信封: 解析为 JSON 对象, 含字符串 output 且至少带一个
// 执行元信息字段 (wall_time_seconds / original_token_count). 单凭 output 字段不够 --
// 普通工具也可能返回 {"output": "..."} 结构化数据会被误判; 元信息字段是 exec 信封的强特征.
// 解析失败 / 不匹配一律返回 null, 调用方回退到原字段模式.
export function parseMcpResultEnvelope(text: unknown): { output: string; raw: Record<string, any> } | null {
  if (typeof text !== 'string' || text.length === 0) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  let parsed: any
  try { parsed = JSON.parse(trimmed) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (typeof parsed.output !== 'string') return null
  const hasExecMeta =
    typeof parsed.wall_time_seconds === 'number' ||
    typeof parsed.original_token_count === 'number'
  if (!hasExecMeta) return null
  return { output: parsed.output, raw: parsed }
}

// aimux exec 信封解包后的执行元信息徽章: 耗时 / tokens / 退出码 (exit_code 非 0 标 error).
// 与 extractMcpToolResult 的 meta 同源逻辑, 供合并进代码模式卡片的返回结果面板展示.
function mcpEnvelopeMeta(raw: Record<string, any>): BashResultMeta[] {
  const meta: BashResultMeta[] = []
  if (typeof raw.wall_time_seconds === 'number') {
    meta.push({ label: '耗时', value: `${raw.wall_time_seconds}s` })
  }
  if (typeof raw.original_token_count === 'number') {
    meta.push({ label: 'tokens', value: String(raw.original_token_count) })
  }
  if (raw.exit_code !== undefined && raw.exit_code !== null && String(raw.exit_code) !== '') {
    meta.push({ label: 'exit', value: String(raw.exit_code) })
  }
  return meta
}

// 从 type:user 的纯 tool_result entry 抽出 MCP 返回信封 (若有). 命中即返回首个; 不命中返回 null.
// 读 message.content 里的 tool_result 文本块 (与 extractBashToolResultRecords 同源), 不依赖 toolUseResult.
export function extractMcpToolResult(entry: AnyEntry): McpToolResult | null {
  if (entry?.type !== 'user') return null
  const content = entry?.message?.content
  if (!Array.isArray(content)) return null
  const blocks = content.filter((b: any) => b?.type === 'tool_result')
  if (blocks.length === 0) return null
  for (const block of blocks) {
    const text = toolResultContentText(block?.content)
    const env = parseMcpResultEnvelope(text)
    if (!env) continue
    const meta: McpToolResultMeta[] = mcpEnvelopeMeta(env.raw)
    if (env.raw.session_id != null && env.raw.session_id !== '') {
      meta.push({ label: 'session', value: String(env.raw.session_id) })
    }
    return {
      output: env.output,
      meta,
      toolUseId: stringField(block?.tool_use_id) || undefined,
      isError: block?.is_error === true || env.raw.is_error === true || env.raw.status === 'failed',
    }
  }
  return null
}
