/**
 * jsonl-view.tsx — 展示当前 agent backend JSONL 里的原始 entries.
 *
 * 设计:
 *  - 每条 entry 一张卡片. 卡片顶端: 类型徽章 + 时间戳 + 行号.
 *  - 卡片内部递归渲染每个 key. 容器(object/array) 用 <details>, primitive 一行.
 *  - EXPAND_KEYS 列表里的 key 默认展开; COLLAPSE_KEYS 默认折叠;
 *    其他容器默认折叠 (避免噪音淹没); primitive 总是直接显示.
 *  - 顶层 type 字段决定卡片整体配色, 方便快扫;
 *    特例: assistant 里 name:"Edit" 的 tool_use 卡片用专属 indigo 色 (文件改动易扫);
 *    特例: assistant 里 Bash tool_use 且 command 包含 "start.py" 的卡片用专属 gold 色 (产品构建易扫).
 *    特例: assistant 响应文本命中关键词时用专属 gold 色 (关键回复易扫).
 *  - 卡片整体默认折叠, 唯独"第一张 user 卡片"(会话起始 prompt) 与"最后一张
 *    assistant 卡片"(最新回复) 默认展开 — 一头一尾最值得先看;
 *    展开态受控于卡片本地 state, 用户手动折叠后保持折叠, 不被实时轮询重渲染强制掀开.
 *
 * 不新增第三方包. 100% Tailwind + headless React, 跟项目其他组件配色一致.
 */
import { Fragment, Suspense, lazy, memo, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { diffLines } from 'diff'

type AnyEntry = Record<string, any>
type CardMode = 'compact' | 'field' | 'code'
type CodeEditFile =
  | {
    kind: 'strings'
    filePath: string
    oldString: string
    newString: string
    oldLineCount: number
    newLineCount: number
  }
  | {
    kind: 'unified'
    filePath: string
    unifiedDiff: string
    oldLineCount: number
    newLineCount: number
    addedLineCount: number
    removedLineCount: number
  }
type CodeEdit = {
  files: CodeEditFile[]
  displayPath: string
  sourceLength: number
}
type WriteToolCall = {
  filePath: string
  content: string
  lineCount: number
  charCount: number
}
type BashToolResult = {
  entry: AnyEntry
  lineNo: number
  toolUseId?: string
  parentUuid?: string
  sourceAssistantUuid?: string
  stdout: string
  stderr: string
  content: string
  isError: boolean
  interrupted: boolean
  isImage: boolean
  imageUrls?: string[]
  noOutputExpected: boolean
  readFile?: ReadFileResult
}
type ReadToolCall = {
  id?: string
  filePath: string
  offset?: number
  limit?: number
}
type ReadFileResult = {
  filePath: string
  content: string
  numLines?: number
  startLine?: number
  totalLines?: number
}
type JsonlViewItem = {
  entry: AnyEntry
  lineNo: number
  bashResults?: BashToolResult[]
  readResults?: BashToolResult[]
}
type DiffRow = {
  key: string
  kind: 'added' | 'removed' | 'same' | 'hunk'
  oldLine: number | ''
  newLine: number | ''
  text: string
}
type UnifiedHunkHeader = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}
type StringCodeEditFile = Extract<CodeEditFile, { kind: 'strings' }>
type UnifiedCodeEditFile = Extract<CodeEditFile, { kind: 'unified' }>

const CompactMarkdown = lazy(() => import('./jsonl-compact-markdown'))

// 顶层 type → 卡片色调 (Tailwind class fragments)
const TYPE_THEME: Record<string, { dot: string; border: string; bg: string; text: string; label: string }> = {
  user:                   { dot: 'bg-slate-400',  border: 'border-slate-500/30', bg: 'bg-slate-500/[0.04]',  text: 'text-slate-300',  label: 'user' },
  assistant:              { dot: 'bg-blue-400',   border: 'border-blue-500/30',  bg: 'bg-blue-500/[0.04]',   text: 'text-blue-300',   label: 'assistant' },
  attachment:             { dot: 'bg-purple-400', border: 'border-purple-500/30',bg: 'bg-purple-500/[0.04]', text: 'text-purple-300', label: 'attachment' },
  system:                 { dot: 'bg-amber-400',  border: 'border-amber-500/30', bg: 'bg-amber-500/[0.04]',  text: 'text-amber-300',  label: 'system' },
  'queue-operation':      { dot: 'bg-zinc-500',   border: 'border-zinc-600/30',  bg: 'bg-zinc-700/[0.04]',   text: 'text-zinc-400',   label: 'queue' },
  'last-prompt':          { dot: 'bg-cyan-400',   border: 'border-cyan-500/30',  bg: 'bg-cyan-500/[0.04]',   text: 'text-cyan-300',   label: 'last-prompt' },
  'permission-mode':      { dot: 'bg-pink-400',   border: 'border-pink-500/30',  bg: 'bg-pink-500/[0.04]',   text: 'text-pink-300',   label: 'permission' },
  'file-history-snapshot':{ dot: 'bg-emerald-400',border: 'border-emerald-500/30',bg:'bg-emerald-500/[0.04]',text: 'text-emerald-300',label: 'fs-snap' },
  'custom-title':         { dot: 'bg-zinc-400',   border: 'border-zinc-500/30',  bg: 'bg-zinc-700/[0.04]',   text: 'text-zinc-300',   label: 'title' },
  'agent-name':           { dot: 'bg-zinc-400',   border: 'border-zinc-500/30',  bg: 'bg-zinc-700/[0.04]',   text: 'text-zinc-300',   label: 'agent-name' },
  session_meta:           { dot: 'bg-zinc-400',   border: 'border-zinc-500/30',  bg: 'bg-zinc-700/[0.04]',   text: 'text-zinc-300',   label: 'session' },
  turn_context:           { dot: 'bg-amber-400',  border: 'border-amber-500/30', bg: 'bg-amber-500/[0.04]',  text: 'text-amber-300',  label: 'turn' },
  event_msg:              { dot: 'bg-cyan-400',   border: 'border-cyan-500/30',  bg: 'bg-cyan-500/[0.04]',   text: 'text-cyan-300',   label: 'event' },
  response_item:          { dot: 'bg-blue-400',   border: 'border-blue-500/55',  bg: 'bg-blue-500/[0.12]',   text: 'text-blue-200',   label: 'response' },
  error:                  { dot: 'bg-red-500',    border: 'border-red-500/50',   bg: 'bg-red-500/[0.10]',    text: 'text-red-200',    label: 'error' },
}
const DEFAULT_THEME = { dot: 'bg-gray-500', border: 'border-gray-500/30', bg: 'bg-gray-500/[0.04]', text: 'text-gray-400', label: 'entry' }
// 特例: assistant 里带 name:"Edit" 的 tool_use 卡片 — 用 indigo (与 assistant 蓝相邻但可区分),
// 边框/底色比常规 type 稍重一点, 方便在长列表里一眼扫到文件改动.
const EDIT_TOOL_THEME = { dot: 'bg-indigo-400', border: 'border-indigo-500/40', bg: 'bg-indigo-500/[0.07]', text: 'text-indigo-300', label: 'file·edit' }

// 特例: assistant 里带 name:"Bash" 且 input.command 包含 "start.py" 的 tool_use 卡片 —
// 用 gold (yellow), 提示这是触发了产品构建的 shell 调用, 在长列表里一眼可扫.
// 用 yellow 与 system/turn 的 amber 拉开, 避免和已有暖色调混淆.
const START_PY_THEME = { dot: 'bg-yellow-400', border: 'border-yellow-500/40', bg: 'bg-yellow-500/[0.07]', text: 'text-yellow-300', label: 'start.py' }

// 特例: assistant 里带 name:"Bash" 的 tool_use 卡片 (Claude Code shell 调用).
// 用 cyan, 呼应终端/控制台意象, 与 Edit indigo、start.py yellow 都拉开, 长列表里可识别.
const BASH_TOOL_THEME = { dot: 'bg-cyan-400', border: 'border-cyan-500/40', bg: 'bg-cyan-500/[0.06]', text: 'text-cyan-300', label: 'bash' }

// 特例: assistant 里带 name:"Read" 的 tool_use 卡片.
// 用 sky, 与 Bash cyan / Edit indigo 近邻但可区分, 方便扫文件读取操作.
const READ_TOOL_THEME = { dot: 'bg-sky-400', border: 'border-sky-500/40', bg: 'bg-sky-500/[0.06]', text: 'text-sky-300', label: 'read' }

// 特例: event_msg.payload.type === 'context_compacted' 的卡片 — 一次上下文压缩事件,
// 在长列表里需要一眼可扫, 复用 yellow (gold) 与 start.py 同色但 label 区分.
const CONTEXT_COMPACTED_THEME = { ...START_PY_THEME, label: 'ctx·compact' }

// 特例: assistant 响应文本命中这些关键词时整卡复用 gold 主题.
// 只检查 assistant 文本响应, 不把 tool_use/input.command 当作本规则的命中范围.
const ASSISTANT_RESPONSE_GOLD_KEYWORDS = ['根因', 'start.py']
const ASSISTANT_RESPONSE_KEYWORD_THEME = { ...START_PY_THEME, label: 'assistant·keyword' }

// 对话轮次分组的纯逻辑 (BLACKBOARD_MARKER / isBlackboardReminder / isNewRound) 抽到了
// ./jsonl-round-helpers.ts, 这样 Node 单元测试可以无 React 直接 import 同一份实现.
// 组件层只在这里再封装使用, 其它渲染路径不重复实现.
import { BLACKBOARD_MARKER, isNewRound } from './jsonl-round-helpers'

// 醒目主题: blackboard 相关消息用 fuchsia, 边框/底色比常规 type 重很多, 在长列表里一眼可见.
const BLACKBOARD_THEME = { dot: 'bg-fuchsia-400', border: 'border-fuchsia-500/30', bg: 'bg-fuchsia-500/[0.05]', text: 'text-fuchsia-200', label: 'blackboard' }

// 该 entry 是否为 "assistant 发起的 Edit tool_use" (即 message.content 里有 type==='tool_use' 且 name==='Edit').
function isEditToolUse(entry: AnyEntry): boolean {
  if (entry?.type !== 'assistant') return false
  const c = entry?.message?.content
  return Array.isArray(c) && c.some((b: any) => b?.type === 'tool_use' && b?.name === 'Edit')
}

function lineCount(text: string): number {
  if (!text) return 0
  return text.split('\n').length
}

function basename(path: string): string {
  const parts = String(path || '').split(/[\\/]/)
  return parts[parts.length - 1] || path || 'unknown'
}

function parseCount(raw: string | undefined): number {
  if (!raw || raw === '') return 1
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 1
}

function parseUnifiedHunkHeader(line: string): UnifiedHunkHeader | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
  if (!match) return null
  return {
    oldStart: Number.parseInt(match[1], 10),
    oldCount: parseCount(match[2]),
    newStart: Number.parseInt(match[3], 10),
    newCount: parseCount(match[4]),
  }
}

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

function parseFunctionCallArguments(raw: any): Record<string, any> | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

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

// 支持两类代码模式:
// 1) Claude Edit tool_use: input.old_string + input.new_string.
// 2) Codex patch_apply_end: payload.changes[path].unified_diff.
function extractCodeEdit(entry: AnyEntry): CodeEdit | null {
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

// 该 entry 是否为 "assistant 发起的 Bash tool_use 且 input.command 包含 'start.py'"
// (即触发了产品构建的 shell 调用).
// 走 isBashToolUseName 让大小写兼容与 BashCall 卡片渲染对齐, 避免 'bash' 时主题/识别脱节.
function isStartPyToolUse(entry: AnyEntry): boolean {
  return extractBashCalls(entry).some((call) => call.command.includes('start.py'))
}

// Claude Code Bash tool_use 卡片的纯逻辑 (BashCall 类型, extract*, summary) 抽到了
// ./jsonl-bash-helpers.ts, 这样 Node 单元测试可以无 React 直接 import 同一份实现.
// 组件层只在这里再封装一个 entry 级谓词, 其他地方一律用 helpers 的导出.
import {
  extractBashCalls as extractBashCallsFromHelpers,
  extractBashCallFromBlock,
  bashCallOneLineSummary,
  isBashToolUseName,
} from './jsonl-bash-helpers'
import type { BashCall } from './jsonl-bash-helpers'

// 从 assistant.message.content 抽出全部 Bash tool_use 调用 (保序, 含同一条 entry 多个 Bash).
function extractBashCalls(entry: AnyEntry): BashCall[] {
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

function isBashToolUse(entry: AnyEntry): boolean {
  return extractBashCalls(entry).length > 0
}

function isReadToolUseName(name: unknown): boolean {
  return typeof name === 'string' && name.toLowerCase() === 'read'
}

function numberField(value: any): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function extractReadCallFromBlock(block: any): ReadToolCall | null {
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

function extractReadCalls(entry: AnyEntry): ReadToolCall[] {
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

function readCallOneLineSummary(call: ReadToolCall): string {
  const parts = [basename(call.filePath)]
  const range = [
    call.offset != null ? `offset ${call.offset}` : '',
    call.limit != null ? `limit ${call.limit}` : '',
  ].filter(Boolean).join(' · ')
  if (range) parts.push(range)
  return parts.join(' · ')
}

function stringField(value: any): string {
  return typeof value === 'string' ? value : ''
}

function outputField(value: any): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

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

function isPureToolResultEntry(entry: AnyEntry): boolean {
  if (entry?.type === 'response_item' && entry?.payload?.type === 'function_call_output') return true
  const content = entry?.message?.content
  return entry?.type === 'user'
    && Array.isArray(content)
    && content.length > 0
    && content.every((block: any) => block?.type === 'tool_result')
}

function extractBashToolResultRecords(entry: AnyEntry, lineNo: number): BashToolResult[] {
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

function mergeBashToolResultItems(visibleEntries: AnyEntry[], windowOffset: number): JsonlViewItem[] {
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

function isContextCompactedEvent(entry: AnyEntry): boolean {
  return entry?.type === 'event_msg' && entry?.payload?.type === 'context_compacted'
}

function assistantResponseText(content: any): string {
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

// 该 entry 是否为 "assistant 响应文本命中重点关键词".
function isAssistantResponseGoldKeyword(entry: AnyEntry): boolean {
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

function assistantEntryText(entry: AnyEntry): string {
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

function jsonEntryTourTarget(entry: AnyEntry): string | undefined {
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

// ── display_images 解析 ──────────────────────────────────────────────
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
function entryDisplayImages(entry: AnyEntry): string[] {
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
function entryUserAttachmentImages(entry: AnyEntry): string[] {
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

// 默认展开的 key (内容向, 用户关心)
const EXPAND_KEYS = new Set([
  'type', 'message', 'attachment', 'lastPrompt', 'toolUseResult', 'operation',
  'content', 'role',
  'text', 'thinking', 'name', 'input',
  'result', 'stdout', 'stderr', 'output',
  'hookInfos', 'hookCount', 'subtype',
])

// 默认折叠的 key (元数据 / 噪音, 用户基本不看)
const COLLAPSE_KEYS = new Set([
  'uuid', 'parentUuid', 'sessionId', 'requestId', 'promptId', 'messageId', 'id',
  'version', 'gitBranch', 'cwd', 'entrypoint', 'userType', 'isSidechain',
  'timestamp', 'usage', 'signature', 'stop_details', 'stop_reason',
  'model', 'snapshot', 'caller', 'sourceToolAssistantUUID',
])

function isPrimitive(v: any): boolean {
  return v === null || typeof v !== 'object'
}

// "MM-DD HH:MM:SS" 本地时间, 失败返回 null
function formatTs(raw: any): string | null {
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function previewPrimitive(v: any): string {
  if (v === null) return 'null'
  if (typeof v === 'string') {
    // 单行预览, 超长截断
    const oneLine = v.replace(/\n/g, '⏎')
    return `"${oneLine.length > 200 ? oneLine.slice(0, 200) + '…' : oneLine}"`
  }
  return String(v)
}

function summarize(v: any, key?: string): string {
  if (isPrimitive(v)) return previewPrimitive(v)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    if (key === 'content' && typeof v[0] === 'object') {
      // content 数组通常装 text/thinking/tool_use/tool_result, 列 type
      const types = v.map((x: any) => x?.type || typeof x).slice(0, 4)
      return `[${v.length}] ${types.join(', ')}${v.length > 4 ? ', …' : ''}`
    }
    return `[${v.length}]`
  }
  const keys = Object.keys(v)
  return `{${keys.length}}` + (keys.length ? ` ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}` : '')
}

// 单个 key:value 节点. 递归.
function KeyNode({ k, v, depth, parentKey }: { k: string; v: any; depth: number; parentKey?: string }) {
  // primitive: 一行紧凑
  if (isPrimitive(v)) {
    // 多行字符串: 也用 details 折叠
    if (typeof v === 'string' && v.includes('\n') && v.length > 80) {
      const defaultOpen = EXPAND_KEYS.has(k)
      return (
        <details open={defaultOpen} className="ml-3 my-0.5">
          <summary className="cursor-pointer text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] select-text">
            <span className="text-amber-300/80 font-mono">{k}</span>
            <span className="text-gray-500"> : </span>
            <span className="italic">"…" ({v.split('\n').length} lines)</span>
          </summary>
          <pre className="mt-1 ml-3 px-2 py-1.5 text-[11px] font-mono whitespace-pre-wrap break-words rounded border border-[var(--border-color)] bg-[var(--prose-bg)] text-[var(--text-secondary)] max-h-96 overflow-auto">{v}</pre>
        </details>
      )
    }
    return (
      <div className="ml-3 my-0.5 text-[11px] font-mono leading-snug">
        <span className="text-amber-300/80">{k}</span>
        <span className="text-gray-500"> : </span>
        <span className={typeof v === 'string' ? 'text-emerald-300/90 break-words' : 'text-cyan-300/90'}>
          {previewPrimitive(v)}
        </span>
      </div>
    )
  }

  // container (object / array)
  const defaultOpen = depth === 0 ? true : (EXPAND_KEYS.has(k) && !COLLAPSE_KEYS.has(k))
  return (
    <details open={defaultOpen} className="ml-3 my-0.5 group">
      <summary className="cursor-pointer text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] select-text font-mono">
        <span className="text-amber-300/80">{k}</span>
        <span className="text-gray-500"> : </span>
        <span className="text-violet-300/70">{summarize(v, k)}</span>
      </summary>
      <div className="ml-1 border-l border-[var(--border-color)]/60">
        {Array.isArray(v)
          ? v.map((item, i) => <KeyNode key={i} k={String(i)} v={item} depth={depth + 1} parentKey={k} />)
          : Object.entries(v).map(([ck, cv]) => <KeyNode key={ck} k={ck} v={cv} depth={depth + 1} parentKey={k} />)
        }
      </div>
    </details>
  )
}

function CompactPlainTextFallback({ text }: { text: string }) {
  return (
    <pre className="text-[11px] leading-relaxed whitespace-pre-wrap break-words font-mono px-2 py-1.5 rounded bg-[var(--prose-bg)] text-[var(--text-secondary)] select-text">{text}</pre>
  )
}

function splitDiffValue(value: string): string[] {
  if (!value) return []
  const hasTrailingNewline = value.endsWith('\n')
  const lines = value.split('\n')
  if (hasTrailingNewline) lines.pop()
  return lines
}

function buildStringDiffRows(file: StringCodeEditFile): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 1
  let newLine = 1
  diffLines(file.oldString, file.newString, { newlineIsToken: true }).forEach((change, changeIdx) => {
    const kind = change.added ? 'added' : change.removed ? 'removed' : 'same'
    splitDiffValue(change.value).forEach((line, lineIdx) => {
      rows.push({
        key: `${changeIdx}-${lineIdx}`,
        kind,
        oldLine: kind === 'added' ? '' : oldLine++,
        newLine: kind === 'removed' ? '' : newLine++,
        text: line,
      })
    })
  })
  return rows
}

function buildUnifiedDiffRows(file: UnifiedCodeEditFile): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 1
  let newLine = 1
  file.unifiedDiff.split('\n').forEach((rawLine, idx) => {
    if (rawLine === '') return
    if (rawLine.startsWith('---') || rawLine.startsWith('+++')) return
    if (rawLine.startsWith('@@')) {
      const header = parseUnifiedHunkHeader(rawLine)
      if (header) {
        oldLine = header.oldStart
        newLine = header.newStart
      }
      rows.push({
        key: `h-${idx}`,
        kind: 'hunk',
        oldLine: '',
        newLine: '',
        text: rawLine,
      })
      return
    }
    if (rawLine.startsWith('+')) {
      rows.push({ key: `a-${idx}`, kind: 'added', oldLine: '', newLine: newLine++, text: rawLine.slice(1) })
      return
    }
    if (rawLine.startsWith('-')) {
      rows.push({ key: `r-${idx}`, kind: 'removed', oldLine: oldLine++, newLine: '', text: rawLine.slice(1) })
      return
    }
    rows.push({
      key: `s-${idx}`,
      kind: 'same',
      oldLine: oldLine++,
      newLine: newLine++,
      text: rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine,
    })
  })
  return rows
}

function CodeDiffRows({ rows }: { rows: DiffRow[] }) {
  return (
    <>
      {rows.map((row) => {
        const rowClass =
          row.kind === 'added'
            ? 'code-diff-line--added'
            : row.kind === 'removed'
              ? 'code-diff-line--removed'
              : row.kind === 'hunk'
                ? 'code-diff-line--hunk'
                : 'code-diff-line'
        const markerClass =
          row.kind === 'added'
            ? 'code-diff-marker--added'
            : row.kind === 'removed'
              ? 'code-diff-marker--removed'
              : row.kind === 'hunk'
                ? 'code-diff-marker--hunk'
                : 'code-diff-line-number'
        return (
          <div key={row.key} className={`grid grid-cols-[3rem_3rem_1.5rem_minmax(0,1fr)] ${rowClass}`}>
            <span className="code-diff-line-number select-none border-r border-[var(--border-color)]/50 px-2 text-right">
              {row.oldLine}
            </span>
            <span className="code-diff-line-number select-none border-r border-[var(--border-color)]/50 px-2 text-right">
              {row.newLine}
            </span>
            <span className={`select-none px-1.5 text-center ${markerClass}`}>
              {row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : row.kind === 'hunk' ? '@' : ''}
            </span>
            <code className="whitespace-pre px-2 text-inherit">{row.text || ' '}</code>
          </div>
        )
      })}
    </>
  )
}

function JsonEntryCodeDiff({ edit }: { edit: CodeEdit }) {
  const fileRows = useMemo(
    () => edit.files.map((file) => ({
      file,
      rows: file.kind === 'strings' ? buildStringDiffRows(file) : buildUnifiedDiffRows(file),
    })),
    [edit],
  )

  return (
    <div className="overflow-hidden rounded bg-[var(--prose-bg)] ring-1 ring-[var(--border-color)]/70">
      {fileRows.map(({ file, rows }, index) => (
        <div key={`${file.filePath || index}-${index}`} className={index > 0 ? 'border-t border-[var(--border-color)]' : ''}>
          <div className="flex min-w-0 items-center gap-2 border-b border-[var(--border-color)] px-2.5 py-1.5 text-[10px]">
            <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-secondary)]" title={file.filePath || undefined}>
              {file.filePath ? basename(file.filePath) : 'Edit'}
            </span>
            <span className="flex-shrink-0 font-mono text-red-700 dark:text-red-300">-{file.kind === 'unified' ? file.removedLineCount : file.oldLineCount}</span>
            <span className="flex-shrink-0 font-mono text-emerald-700 dark:text-emerald-300">+{file.kind === 'unified' ? file.addedLineCount : file.newLineCount}</span>
          </div>
          <div className="max-h-[34rem] overflow-auto">
            <div className="min-w-max py-1 font-mono text-[11px] leading-[1.45]">
              <CodeDiffRows rows={rows} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function CodePreviewRows({ lines, startLine = 1 }: { lines: string[]; startLine?: number }) {
  return (
    <>
      {lines.map((line, idx) => (
        <div key={`${startLine + idx}-${idx}`} className="grid grid-cols-[3rem_minmax(0,1fr)] code-diff-line">
          <span className="code-diff-line-number select-none border-r border-[var(--border-color)]/50 px-2 text-right">
            {startLine + idx}
          </span>
          <code className="whitespace-pre px-2 text-inherit">{line || ' '}</code>
        </div>
      ))}
    </>
  )
}

function JsonEntryWritePreview({ writeCall }: { writeCall: WriteToolCall }) {
  const lines = useMemo(() => splitDiffValue(writeCall.content), [writeCall.content])
  const previewLines = lines.slice(0, WRITE_PREVIEW_LINE_LIMIT)
  const restLines = lines.slice(WRITE_PREVIEW_LINE_LIMIT)

  return (
    <div className="overflow-hidden rounded bg-[var(--prose-bg)] ring-1 ring-[var(--border-color)]/70">
      <div className="flex min-w-0 items-start gap-2 border-b border-[var(--border-color)] px-2.5 py-1.5 text-[10px]">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] font-semibold text-[var(--text-secondary)]" title={writeCall.filePath}>
            {basename(writeCall.filePath)}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-muted)]" title={writeCall.filePath}>
            {writeCall.filePath}
          </div>
        </div>
        <span className="flex-shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
          {writeCall.lineCount} lines
        </span>
      </div>
      <div className="max-h-[34rem] overflow-auto">
        <div className="min-w-max py-1 font-mono text-[11px] leading-[1.45]">
          <CodePreviewRows lines={previewLines} />
          {restLines.length > 0 && (
            <details className="border-t border-[var(--border-color)]/60">
              <summary className="cursor-pointer px-2 py-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                展开剩余 {restLines.length} 行
              </summary>
              <CodePreviewRows lines={restLines} startLine={WRITE_PREVIEW_LINE_LIMIT + 1} />
            </details>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Claude Code Bash tool_use 命令卡片.
 * - 同一条 assistant entry 可能含多个 Bash 调用 → 渲染为多张并列卡片, 共享 cyan 主题.
 * - 每条单独的 Bash 卡片三段式: 顶部 header (description + cwd + 行/字符数 + 复制按钮)
 *   + 命令体 (终端色 pre + bash 高亮, 长/多行命令可滚).
 * - 命令文本严格按原样展示 (引号 / && / | / 重定向 / 换行全部保留), 不执行不重写.
 */
function JsonEntryBashCommands({ calls, results = [] }: { calls: BashCall[]; results?: BashToolResult[] }) {
  return (
    <div className="flex flex-col gap-2">
      {calls.map((call, idx) => {
        const callResults = results.filter((result) => {
          if (result.toolUseId && call.id) return result.toolUseId === call.id
          return calls.length === 1
        })
        return (
          <BashCallCard
            key={(call.id || `bash-${idx}`) + idx}
            call={call}
            index={calls.length > 1 ? idx + 1 : null}
            results={callResults}
          />
        )
      })}
    </div>
  )
}

function BashCallCard({ call, index, results = [] }: { call: BashCall; index: number | null; results?: BashToolResult[] }) {
  const [copied, setCopied] = useState<boolean>(false)
  const lines = useMemo(() => splitDiffValue(call.command), [call.command])
  // 多行脚本首屏只露前 N 行, 余下 details 折叠, 与 Write 预览行为一致.
  const previewLines = lines.slice(0, WRITE_PREVIEW_LINE_LIMIT)
  const restLines = lines.slice(WRITE_PREVIEW_LINE_LIMIT)
  const markdownSource = useMemo(() => codeFence(call.command, 'bash'), [call.command])
  const hasDescription = !!call.description
  const hasCwd = !!call.cwd

  return (
    <div className="overflow-hidden rounded bg-[var(--prose-bg)] ring-1 ring-[var(--border-color)]/70">
      <div className="flex min-w-0 items-start gap-2 border-b border-[var(--border-color)] px-2.5 py-1.5 text-[10px]">
        <div className="min-w-0 flex-1">
          {index != null && (
            <div className="font-mono text-[10px] text-[var(--text-muted)]">#{index}</div>
          )}
          {hasDescription && (
            <div className="truncate font-mono text-[12px] font-semibold text-[var(--text-secondary)]" title={call.description}>
              {call.description}
            </div>
          )}
          {hasCwd && (
            <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-muted)]" title={call.cwd}>
              cwd: {call.cwd}
            </div>
          )}
        </div>
        <span className="flex-shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
          {lines.length} lines
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            navigator.clipboard.writeText(call.command).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1000)
            })
          }}
          className="flex-shrink-0 text-[10px] px-2 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] transition-colors"
          title="复制完整命令到剪贴板"
        >
          {copied ? '已复制 ✓' : '复制'}
        </button>
      </div>
      <div className="max-h-[34rem] overflow-auto">
        {/* 多行命令首屏截断预览 (纯文本带行号), 折叠区里仍给完整高亮版; 单行/短命令直接全量高亮. */}
        {restLines.length > 0 ? (
          <div className="min-w-max py-1 font-mono text-[11px] leading-[1.45]">
            <CodePreviewRows lines={previewLines} />
            <details className="border-t border-[var(--border-color)]/60">
              <summary className="cursor-pointer px-2 py-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                展开剩余 {restLines.length} 行 (含高亮)
              </summary>
              <div className="jsonl-compact-md !text-[11px]">
                <Suspense fallback={<CompactPlainTextFallback text={call.command} />}>
                  <CompactMarkdown text={markdownSource} />
                </Suspense>
              </div>
            </details>
          </div>
        ) : (
          <div className="jsonl-compact-md !text-[11px]">
            <Suspense fallback={<CompactPlainTextFallback text={call.command} />}>
              <CompactMarkdown text={markdownSource} />
            </Suspense>
          </div>
        )}
      </div>
      {results.length > 0 && (
        <div className="border-t border-[var(--border-color)] bg-black/5 dark:bg-white/[0.02]">
          {results.map((result, idx) => (
            <BashResultPanel key={`${result.toolUseId || 'result'}-${result.lineNo}-${idx}`} result={result} />
          ))}
        </div>
      )}
    </div>
  )
}

function ResultTextPreview({ text, startLine = 1 }: { text: string; startLine?: number }) {
  const lines = useMemo(() => splitDiffValue(text), [text])
  const previewLines = lines.slice(0, WRITE_PREVIEW_LINE_LIMIT)
  const restLines = lines.slice(WRITE_PREVIEW_LINE_LIMIT)
  if (!text) return null
  return (
    <div className="min-w-max py-1 font-mono text-[11px] leading-[1.45]">
      <CodePreviewRows lines={previewLines} startLine={startLine} />
      {restLines.length > 0 && (
        <details className="border-t border-[var(--border-color)]/60">
          <summary className="cursor-pointer px-2 py-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
            展开剩余 {restLines.length} 行
          </summary>
          <CodePreviewRows lines={restLines} startLine={startLine + WRITE_PREVIEW_LINE_LIMIT} />
        </details>
      )}
    </div>
  )
}

function JsonEntryReadCalls({ calls, results = [] }: { calls: ReadToolCall[]; results?: BashToolResult[] }) {
  return (
    <div className="flex flex-col gap-2">
      {calls.map((call, idx) => {
        const callResults = results.filter((result) => {
          if (result.toolUseId && call.id) return result.toolUseId === call.id
          return calls.length === 1
        })
        return (
          <ReadCallCard
            key={(call.id || `read-${idx}`) + idx}
            call={call}
            index={calls.length > 1 ? idx + 1 : null}
            results={callResults}
          />
        )
      })}
    </div>
  )
}

function ReadCallCard({ call, index, results = [] }: { call: ReadToolCall; index: number | null; results?: BashToolResult[] }) {
  const [copied, setCopied] = useState<boolean>(false)
  const meta = [
    call.offset != null ? `offset ${call.offset}` : '',
    call.limit != null ? `limit ${call.limit}` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div className="overflow-hidden rounded bg-[var(--prose-bg)] ring-1 ring-[var(--border-color)]/70">
      <div className="flex min-w-0 items-start gap-2 border-b border-[var(--border-color)] px-2.5 py-1.5 text-[10px]">
        <div className="min-w-0 flex-1">
          {index != null && (
            <div className="font-mono text-[10px] text-[var(--text-muted)]">#{index}</div>
          )}
          <div className="truncate font-mono text-[12px] font-semibold text-[var(--text-secondary)]" title={call.filePath}>
            {basename(call.filePath)}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-muted)]" title={call.filePath}>
            {call.filePath}
          </div>
        </div>
        {meta && (
          <span className="flex-shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
            {meta}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            navigator.clipboard.writeText(call.filePath).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1000)
            })
          }}
          className="flex-shrink-0 rounded border border-[var(--border-color)] px-2 py-0.5 text-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-secondary)]"
          title="复制文件路径到剪贴板"
        >
          {copied ? '已复制 ✓' : '复制路径'}
        </button>
      </div>
      {results.length > 0 ? (
        <div>
          {results.map((result, idx) => (
            <ReadResultPanel key={`${result.toolUseId || 'read-result'}-${result.lineNo}-${idx}`} result={result} fallbackPath={call.filePath} />
          ))}
        </div>
      ) : (
        <div className="px-2.5 py-2 text-[11px] font-mono text-[var(--text-muted)]">
          等待读取结果
        </div>
      )}
    </div>
  )
}

function ReadResultPanel({ result, fallbackPath }: { result: BashToolResult; fallbackPath: string }) {
  const [copied, setCopied] = useState<boolean>(false)
  const readFile = result.readFile
  const filePath = readFile?.filePath || fallbackPath
  const text = readFile?.content || result.content
  const startLine = readFile?.startLine || 1
  const lines = splitDiffValue(text)
  const stateLabel = result.isError ? 'error' : 'ok'
  const stateClass = result.isError ? 'text-red-300' : 'text-emerald-300'

  return (
    <div className="border-t border-[var(--border-color)]/70 first:border-t-0">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[10px]">
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-secondary)]" title={filePath}>
          读取结果
          <span className="ml-1 text-[var(--text-muted)]">#{result.lineNo}</span>
        </span>
        <span className={`flex-shrink-0 font-mono ${stateClass}`}>{stateLabel}</span>
        <span className="flex-shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
          {lines.length} lines
        </span>
        {readFile?.totalLines != null && (
          <span className="flex-shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
            total {readFile.totalLines}
          </span>
        )}
        {text && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              navigator.clipboard.writeText(text).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1000)
              })
            }}
            className="flex-shrink-0 rounded border border-[var(--border-color)] px-2 py-0.5 text-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-secondary)]"
            title="复制读取内容到剪贴板"
          >
            {copied ? '已复制 ✓' : '复制内容'}
          </button>
        )}
      </div>
      {text ? (
        <div className="max-h-[34rem] overflow-auto">
          <ResultTextPreview text={text} startLine={startLine} />
        </div>
      ) : (
        <div className="px-2.5 pb-2 text-[11px] font-mono text-[var(--text-muted)]">
          无内容
        </div>
      )}
    </div>
  )
}

function BashResultPanel({ result }: { result: BashToolResult }) {
  const [copied, setCopied] = useState(false)
  const stdout = result.stdout || (!result.stderr ? result.content : '')
  const stderr = result.stderr
  const copyText = [
    stdout ? `stdout:\n${stdout}` : '',
    stderr ? `stderr:\n${stderr}` : '',
  ].filter(Boolean).join('\n\n')
  const displayText = stdout || stderr || result.content
  const displayLines = splitDiffValue(displayText)
  const stateLabel = result.interrupted
    ? 'interrupted'
    : result.isError
      ? 'error'
      : result.noOutputExpected && !displayText
        ? 'no output expected'
        : 'ok'
  const stateClass = result.isError || result.interrupted
    ? 'text-red-300'
    : 'text-emerald-300'

  return (
    <div className="border-t border-[var(--border-color)]/70 first:border-t-0">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[10px]">
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-secondary)]">
          返回结果
          <span className="ml-1 text-[var(--text-muted)]">#{result.lineNo}</span>
        </span>
        <span className={`flex-shrink-0 font-mono ${stateClass}`}>{stateLabel}</span>
        {displayText && (
          <>
            <span className="flex-shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
              {displayLines.length} lines
            </span>
          </>
        )}
        {copyText && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              navigator.clipboard.writeText(copyText).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1000)
              })
            }}
            className="flex-shrink-0 rounded border border-[var(--border-color)] px-2 py-0.5 text-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-secondary)]"
            title="复制完整返回结果到剪贴板"
          >
            {copied ? '已复制 ✓' : '复制结果'}
          </button>
        )}
      </div>
      {result.imageUrls && result.imageUrls.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-2.5 py-2">
          {result.imageUrls.map((url, i) => (
            <a key={i} href={url} target="_blank" rel="noreferrer" className="block">
              <img
                src={url}
                alt={`output image ${i + 1}`}
                className="max-h-48 max-w-full rounded border border-[var(--border-color)] object-contain"
              />
            </a>
          ))}
        </div>
      ) : displayText ? (
        <div className="max-h-[34rem] overflow-auto">
          {stdout && stderr ? (
            <div>
              <div className="border-y border-[var(--border-color)]/60 px-2.5 py-1 text-[10px] font-mono text-emerald-300/90">stdout</div>
              <ResultTextPreview text={stdout} />
              <div className="border-y border-[var(--border-color)]/60 px-2.5 py-1 text-[10px] font-mono text-red-300/90">stderr</div>
              <ResultTextPreview text={stderr} />
            </div>
          ) : (
            <ResultTextPreview text={displayText} />
          )}
        </div>
      ) : (
        <div className="px-2.5 pb-2 text-[11px] font-mono text-[var(--text-muted)]">
          无输出
        </div>
      )}
    </div>
  )
}

/**
 * 单条 entry 卡片. type 决定颜色, 摘要行展示关键内容 (供快速扫).
 */
function JsonEntryCardInner({ entry, lineNo, defaultExpanded, showMeta = true, bashResults = [], readResults = [] }: {
  entry: AnyEntry
  lineNo?: number
  defaultExpanded?: boolean
  showMeta?: boolean
  bashResults?: BashToolResult[]
  readResults?: BashToolResult[]
}) {
  const type = entry?.type || 'unknown'
  const headerSummary = useMemo(() => buildHeaderSummary(entry), [entry])
  const codeEdit = useMemo(() => extractCodeEdit(entry), [entry])
  const writeCall = useMemo(() => extractWriteToolCall(entry), [entry])
  const bashCalls = useMemo(() => extractBashCalls(entry), [entry])
  const readCalls = useMemo(() => extractReadCalls(entry), [entry])
  // canCode 覆盖代码视图: Edit diff / Write 文件预览 / Bash 命令卡片 / Read 文件读取卡片.
  // 字段模式仍是入口的兜底, 让用户随时切回看原始 JSON.
  const canCode = !!codeEdit || !!writeCall || bashCalls.length > 0 || readCalls.length > 0
  // 正文含 blackboard 标记 → 视作 Research Blackboard 相关消息.
  const isBlackboard = headerSummary.full.includes(BLACKBOARD_MARKER)
  // 配色优先级: blackboard 相关 (最醒目) > assistant 文本关键词 (gold) > name:"Edit" 的 tool_use (indigo) > Bash command 含 "start.py" (gold) > 普通 Bash tool_use (cyan) > event_msg.context_compacted (gold) > 顶层 type.
  // start.py 必须排在 Bash 之前: 它本身也是 Bash, 但语义更具体, 不能被 cyan 普通主题盖掉.
  const theme = isBlackboard
    ? BLACKBOARD_THEME
    : isAssistantResponseGoldKeyword(entry)
    ? ASSISTANT_RESPONSE_KEYWORD_THEME
    : isEditToolUse(entry)
    ? EDIT_TOOL_THEME
    : isStartPyToolUse(entry)
    ? START_PY_THEME
    : bashCalls.length > 0
    ? BASH_TOOL_THEME
    : readCalls.length > 0
    ? READ_TOOL_THEME
    : isContextCompactedEvent(entry)
    ? CONTEXT_COMPACTED_THEME
    : (TYPE_THEME[type] || DEFAULT_THEME)
  const ts = entry?.timestamp ? formatTs(entry.timestamp) : null
  // 仅 summary 被截断时才提供"精简模式"入口; 没截断的卡片只有字段模式
  const canCompact = headerSummary.canCompact
  // 展开后默认: 可代码 → 代码模式; 可精简 → 精简模式; 其它 → 字段模式
  const [mode, setMode] = useState<CardMode>(canCode ? 'code' : canCompact ? 'compact' : 'field')

  // 卡片展开态受控于本地 state, 跨父组件重渲染 (实时轮询追加 entry) 保持不变.
  // 能精简/能代码化的卡片总是默认展开, error 卡片 (TUI 扫描发现的 agent 错误) 也强制展开,
  // 父组件 defaultExpanded 仍能强制展开其它卡片.
  // 用户手动折叠 → onToggle 写回 state, 此后重渲染不再强制掀开.
  const [open, setOpen] = useState<boolean>(
    (canCompact || canCode || type === 'error') || !!defaultExpanded
  )
  // 精简模式复制按钮反馈: 点击后短暂显示「已复制 ✓」约 1 秒后还原
  const [copied, setCopied] = useState<boolean>(false)
  const tourTarget = jsonEntryTourTarget(entry)

  // 默认折叠 (第一张 user 卡片除外). summary 可选中: select-text 显式覆盖某些浏览器/OS 默认禁选.
  //
  // a11y 注意: <button> 不能嵌套在 <summary> 里 (HTML 规范禁止 interactive content 作为
  // summary 后代 — Chrome DevTools Issues tab 会标 "InteractiveContentSummaryDescendant").
  // 旧版把「复制」和「切换模式」两个按钮塞进 summary, 每张展开的卡片都会触发 1 条 a11y issue,
  // 用户在 F12 Issues 里看到"卡片数 ≈ 错误数". 现在把按钮 absolute 到 details 右上角,
  // 视觉位置不变, 但 DOM 上 button 是 details 的直接子元素而非 summary 后代, 规范合规.
  const hasHeaderAction = open && ((mode === 'compact') || canCompact || canCode)
  return (
    <details
      data-tour={tourTarget}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className={`relative mb-2 rounded-2xl border card-enter ${theme.border} ${theme.bg}`}>
      <summary className={`cursor-pointer px-3 py-1.5 flex items-center gap-2 text-[12px] select-text${hasHeaderAction ? ' pr-[120px]' : ''}`}>
        {showMeta && typeof lineNo === 'number' && <span className="text-[10px] text-[var(--text-muted)] font-mono flex-shrink-0">#{lineNo}</span>}
        {showMeta && ts && <span className="text-[10px] text-[var(--text-muted)] font-mono flex-shrink-0">{ts}</span>}
        <span className={`w-1.5 h-1.5 rounded-full ${theme.dot} flex-shrink-0`}></span>
        <span className={`font-mono font-semibold ${theme.text} flex-shrink-0`}>{theme.label}</span>
        {headerSummary.short && <span className="text-[11px] text-[var(--text-muted)] truncate flex-1">{headerSummary.short}</span>}
      </summary>
      {hasHeaderAction && (
        <div className="absolute top-1 right-2 flex items-center gap-1.5 z-[5]">
          {open && mode === 'compact' && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                navigator.clipboard.writeText(headerSummary.full).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1000)
                })
              }}
              className="text-[10px] px-2 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] transition-colors"
              title="复制渲染前的原始 markdown 源"
            >
              {copied ? '已复制 ✓' : '复制'}
            </button>
          )}
          {open && (canCompact || canCode) && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMode(m => {
                  if (canCode) return m === 'code' ? 'field' : 'code'
                  return m === 'compact' ? 'field' : 'compact'
                })
              }}
              className="text-[10px] px-2 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] transition-colors"
              title={canCode
                ? (mode === 'code' ? '切换到字段模式 (按 key 展开 JSON)' : writeCall ? '切换到代码模式 (显示 Write 文件预览)' : codeEdit ? '切换到代码模式 (显示 old_string → new_string 的编辑差异)' : readCalls.length > 0 && bashCalls.length > 0 ? '切换到代码模式 (显示工具调用)' : readCalls.length > 0 ? '切换到代码模式 (显示 Read 文件读取)' : '切换到代码模式 (显示 Bash 命令)')
                : (mode === 'compact' ? '切换到字段模式 (按 key 展开 JSON)' : '切换到精简模式 (显示完整摘要文本)')}>
              {canCode
                ? (mode === 'code' ? '字段模式' : '代码模式')
                : (mode === 'compact' ? '字段模式' : '精简模式')}
            </button>
          )}
        </div>
      )}
      {open && (
        <div className="px-3 pb-2 pt-1">
          {mode === 'code' && codeEdit ? (
            <JsonEntryCodeDiff edit={codeEdit} />
          ) : mode === 'code' && writeCall ? (
            <JsonEntryWritePreview writeCall={writeCall} />
          ) : mode === 'code' && (bashCalls.length > 0 || readCalls.length > 0) ? (
            <div className="flex flex-col gap-2">
              {bashCalls.length > 0 && (
                <JsonEntryBashCommands calls={bashCalls} results={bashResults} />
              )}
              {readCalls.length > 0 && (
                <JsonEntryReadCalls calls={readCalls} results={readResults} />
              )}
            </div>
          ) : mode === 'compact' && canCompact && !canCode ? (
            <div className="max-h-[60vh] overflow-y-auto pr-1">
              <Suspense fallback={<CompactPlainTextFallback text={headerSummary.full} />}>
                <CompactMarkdown text={headerSummary.full} />
              </Suspense>
            </div>
          ) : (
            Object.entries(entry).map(([k, v]) => <KeyNode key={k} k={k} v={v} depth={0} />)
          )}
        </div>
      )}
    </details>
  )
}

export const JsonEntryCard = memo(
  JsonEntryCardInner,
  (prev, next) => prev.entry === next.entry && prev.lineNo === next.lineNo && prev.showMeta === next.showMeta && prev.bashResults === next.bashResults && prev.readResults === next.readResults,
)

// 卡片标题栏摘要: full 是不截断版, short 是给标题栏一行用的截断版.
// truncated = full 比 short 长 → 表示"还有更多"内容值得看, 启用精简模式入口.
type HeaderSummary = { short: string; full: string; truncated: boolean; canCompact: boolean }

// 阈值=80: 一行 summary 在常规桌面宽度下大概 80~100 字就会被 CSS truncate 截断,
// 比 JS slice 阈值低更稳, 否则会出现"视觉上 ... 但 JS 判定没截断 → 没精简模式入口"的脱节.
const HEADER_SHORT_LIMIT = 160
const HEADER_COMPACT_LIMIT = 40
const WRITE_PREVIEW_LINE_LIMIT = 40
const ENCRYPTED_REASONING_LABEL = 'Reasoning (闭源模型的推理过程被加密，无法解码）'

function clip(text: string, limit: number = HEADER_SHORT_LIMIT): HeaderSummary {
  const s = text || ''
  // 多行内容一行肯定装不下 → 直接判 truncated, short 把 \n 替换为空格保持单行
  const truncated = s.length > limit || s.includes('\n')
  const canCompact = s.length > HEADER_COMPACT_LIMIT || s.includes('\n')
  const short = truncated ? s.replace(/\s+/g, ' ').trim().slice(0, limit) : s
  return { short, full: s, truncated, canCompact }
}

function isNonEmptyString(value: any): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function escapeMarkdownText(value: any): string {
  return String(value ?? '').replace(/[\\`*_\[\]]/g, '\\$&')
}

function compactInlineList(values: any[]): string {
  return values
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .map((value) => `\`${value.replace(/`/g, '\\`')}\``)
    .join(' ')
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
  const short = shortSource.replace(/\s+/g, ' ').trim().slice(0, HEADER_SHORT_LIMIT)
  return {
    short,
    full: sections.join('\n'),
    truncated: shortSource.length > HEADER_SHORT_LIMIT,
    canCompact: true,
  }
}

function codeFence(text: string, language = ''): string {
  const ticks = text.match(/`{3,}/g)
  const longest = ticks ? Math.max(...ticks.map(s => s.length)) : 2
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const opener = language ? `${fence}${language}` : fence
  return `${opener}\n${text}\n${fence}`
}

function compactCodeSummary(text: string, language = ''): HeaderSummary {
  const body = String(text || '').replace(/\s+$/, '')
  if (!body) return clip('')
  const clipped = clip(body, HEADER_SHORT_LIMIT)
  return { short: clipped.short, full: codeFence(body, language), truncated: true, canCompact: true }
}

function functionCallCommand(payload: any): string | null {
  const args = parseFunctionCallArguments(payload?.arguments)
  const cmd = args?.cmd ?? args?.command ?? args?.input?.cmd ?? args?.input?.command
  return typeof cmd === 'string' && cmd.trim() ? cmd : null
}

function summarizeWriteToolInput(input: any): string | null {
  const writeCall = normalizeWriteInput(input)
  if (!writeCall) return null
  return `${basename(writeCall.filePath)} · ${writeCall.lineCount} lines`
}

function functionOutputBody(output: any): string {
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
function functionOutputImageUrls(output: any): string[] {
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

function buildHeaderSummary(entry: AnyEntry): HeaderSummary {
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
    return clip(pt, HEADER_SHORT_LIMIT)
  }
  if (t === 'response_item') {
    const pt = payload?.type || 'response_item'
    if (pt === 'message') {
      const body = contentBlocksText(payload?.content)
      return clip(`${payload?.role || 'message'}${body ? ` · ${body}` : ''}`, HEADER_SHORT_LIMIT)
    }
    if (pt === 'function_call') {
      if (payload?.name === 'Write') {
        const args = parseFunctionCallArguments(payload?.arguments)
        const writeSummary = summarizeWriteToolInput(payload?.input ?? args?.input ?? args)
        if (writeSummary) return clip(`Write · ${writeSummary}`, HEADER_SHORT_LIMIT)
      }
      const cmd = functionCallCommand(payload)
      if (cmd) return compactCodeSummary(cmd, 'bash')
      return clip(`tool_call · ${payload?.name || ''} ${payload?.arguments || ''}`, HEADER_SHORT_LIMIT)
    }
    if (pt === 'function_call_output') return compactCodeSummary(functionOutputBody(payload?.output))
    if (pt === 'reasoning') {
      const encryptedContent = payload?.encrypted_content
      return clip(typeof encryptedContent === 'string' && encryptedContent.length > 0 ? ENCRYPTED_REASONING_LABEL : 'reasoning', HEADER_SHORT_LIMIT)
    }
    return clip(pt, HEADER_SHORT_LIMIT)
  }

  if (t === 'user') {
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

/**
 * 顶层视图. props.entries 是 jsonl 全部已读 entries.
 */
// 沉默时长格式化: 0~59s → "Ns", 1~59m → "Xm Ys", 1h+ → "Xh Ym"
function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// 实时尾部卡: agent 进程活着但 jsonl 没新内容时显示, 计算沉默时长.
// 也是用户判断 "agent 卡死了 vs 还在 thinking" 的唯一可信号.
//   0~30s   绿  正常生成中
//   30~120s 琥珀 沉默较久, API 可能长尾
//   120s+   红  长时间没输出, 建议终止重试
export function JsonlLiveTailCard({ lastTimestamp, pid }: { lastTimestamp: string | null | undefined; pid: number | null | undefined }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const lastMs = lastTimestamp ? new Date(lastTimestamp).getTime() : null
  const silenceSec = lastMs ? Math.max(0, Math.floor((now - lastMs) / 1000)) : null
  // 还没有任何 jsonl entry → 不出 LIVE 卡片 (不再显示 "等首条 entry..." 占位).
  if (silenceSec == null) return null
  const sev: 'normal' | 'warn' | 'stale' =
    silenceSec < 30 ? 'normal'
    : silenceSec < 120 ? 'warn'
    : 'stale'
  const theme =
    sev === 'normal' ? { border: 'border-emerald-500/30', bg: 'bg-emerald-500/[0.05]', dot: 'bg-emerald-400', text: 'text-emerald-300' }
    : sev === 'warn'   ? { border: 'border-amber-500/30',   bg: 'bg-amber-500/[0.05]',   dot: 'bg-amber-400',   text: 'text-amber-300' }
    :                    { border: 'border-red-500/40',     bg: 'bg-red-500/[0.06]',     dot: 'bg-red-400',     text: 'text-red-300' }

  return (
    <div className={`mb-2 rounded-2xl border card-enter ${theme.border} ${theme.bg} px-3 py-2 flex items-center gap-2 text-[12px]`}>
      <span className="relative inline-flex w-2 h-2 flex-shrink-0">
        <span className={`absolute inset-0 rounded-full ${theme.dot} animate-ping opacity-75`} />
        <span className={`relative inline-flex rounded-full w-2 h-2 ${theme.dot}`} />
      </span>
      <span className={`font-mono font-semibold ${theme.text} flex-shrink-0`}>LIVE</span>
      {pid != null && (
        <span className="text-[10px] text-[var(--text-muted)] font-mono flex-shrink-0">pid {pid}</span>
      )}
      <span className="flex-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        {sev === 'normal' ? `生成中 · 距上条 entry ${formatDuration(silenceSec)}`
          : sev === 'warn'   ? `沉默 ${formatDuration(silenceSec)} — API 可能长尾, 继续等等`
          :                    `⚠ 沉默 ${formatDuration(silenceSec)} — API 可能长尾, 请耐心等待`
        }
      </span>
    </div>
  )
}

function displayImageSrc(src: string): { isUrl: boolean; finalSrc: string } {
  const isUrl = /^https?:\/\//i.test(src)
  const token = typeof window !== 'undefined' ? localStorage.getItem('cc-token') || '' : ''
  return {
    isUrl,
    finalSrc: isUrl ? src : `/api/download?path=${encodeURIComponent(src)}&token=${encodeURIComponent(token)}`,
  }
}

// 单张图片: URL 直出; 绝对路径走后端 /api/download (与 FileManager 同款, token 走 query).
function DisplayImageItem({ src, onOpen }: { src: string; onOpen: (src: string) => void }) {
  const [err, setErr] = useState(false)
  const { isUrl, finalSrc } = displayImageSrc(src)
  return (
    <figure className="m-0 flex flex-col gap-1">
      {err ? (
        <div className="flex items-center justify-center h-32 rounded border border-dashed border-[var(--border-color)] bg-[var(--prose-bg)] text-[11px] text-[var(--text-muted)] px-3 text-center">
          图片加载失败 / 无法访问
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(src)}
          className="group block w-full h-44 cursor-zoom-in overflow-hidden rounded border border-[var(--border-color)] bg-[var(--prose-bg)] focus:outline-none focus:ring-2 focus:ring-teal-400/60"
          title="点击放大查看"
          data-testid="display-image-thumb">
          <img
            src={finalSrc}
            alt={src}
            loading="lazy"
            onError={() => setErr(true)}
            className="h-full w-full object-contain transition-transform duration-150 group-hover:scale-[1.02]"
          />
        </button>
      )}
      <figcaption className="text-[10px] font-mono text-[var(--text-muted)] break-all select-text">
        {isUrl ? 'URL · ' : '本地 · '}{src}
      </figcaption>
    </figure>
  )
}

function DisplayImagePreviewModal({ src, onClose }: { src: string; onClose: () => void }) {
  const { isUrl, finalSrc } = displayImageSrc(src)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="display_images 放大图"
      data-testid="display-image-modal">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" />
      <div
        className="relative flex max-h-[92vh] w-full max-w-[96vw] flex-col overflow-hidden rounded-2xl shadow-2xl"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b px-4 py-2.5" style={{ borderColor: 'var(--border-color)' }}>
          <span className="min-w-0 flex-1 truncate text-[12px] font-mono" style={{ color: 'var(--text-secondary)' }}>
            {isUrl ? 'URL' : '本地文件'} · {src}
          </span>
          <a
            href={finalSrc}
            target="_blank"
            rel="noreferrer"
            className="h-7 rounded-xl border px-2.5 py-1 text-[11px] transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color-strong)' }}>
            打开原图
          </a>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-xl border text-[18px] leading-none transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color-strong)' }}
            aria-label="关闭放大图"
            title="关闭">
            ×
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/20 p-3">
          <img
            src={finalSrc}
            alt={src}
            className="max-h-[calc(92vh-92px)] max-w-full object-contain"
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}

// 紧跟在 Bash(display_images) 卡片之后的图像卡片. 默认展开.
// 行号渲染成 "↳#N" 表示"由第 N 条 entry 派生", 而非真实 jsonl 行.
const IMAGES_THEME = { dot: 'bg-teal-400', border: 'border-teal-500/40', bg: 'bg-teal-500/[0.06]', text: 'text-teal-300', label: 'images' }
export function DisplayImagesCard({ images, lineNo, sourceLabel = 'display_images' }: { images: string[]; lineNo?: number; sourceLabel?: string }) {
  const [open, setOpen] = useState<boolean>(true)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const theme = IMAGES_THEME
  return (
    <>
      <details
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        className={`mb-2 rounded-2xl border card-enter ${theme.border} ${theme.bg}`}>
        <summary className="cursor-pointer px-3 py-1.5 flex items-center gap-2 text-[12px] select-text">
          {typeof lineNo === 'number' && <span className="text-[10px] text-[var(--text-muted)] font-mono flex-shrink-0">↳#{lineNo}</span>}
          <span className={`w-1.5 h-1.5 rounded-full ${theme.dot} flex-shrink-0`}></span>
          <span className={`font-mono font-semibold ${theme.text} flex-shrink-0`}>{theme.label}</span>
          <span className="text-[11px] text-[var(--text-muted)] truncate flex-1">{sourceLabel} · {images.length} 张</span>
        </summary>
        <div className="px-3 pb-3 pt-1 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          {images.map((src, i) => <DisplayImageItem key={i + '·' + src} src={src} onOpen={setPreviewSrc} />)}
        </div>
      </details>
      {previewSrc && <DisplayImagePreviewModal src={previewSrc} onClose={() => setPreviewSrc(null)} />}
    </>
  )
}

// ── 对话轮次分组 ──────────────────────────────────────────────────────────
// 每条 user entry 开启一个新"轮次"; 其后的 assistant/tool 条目属于该轮的回复.
// 轮次内编号: X.0 = 用户问题, X.1/X.2/... = agent 逐步回复.
// 最新轮次默认展开; 上一轮在下一轮出现时自动折叠.

interface RoundItem {
  entry: AnyEntry
  bashResults?: BashToolResult[]
  readResults?: BashToolResult[]
  relIdx: number  // 0 = 该轮用户问题, 1+ = agent 回复
  lineNo: number  // 全局行号 (1-based)
}

interface Round {
  roundNum: number  // 可见窗口内 1-based 编号
  items: RoundItem[]
}

// 判断是否为真正的用户问题 (而非 tool_result 回调 / Blackboard 系统提醒).
// 实现已抽到 ./jsonl-round-helpers.ts, 这里直接复用导出的 isNewRound, 让 Node 测试与
// 渲染层共享同一份实现. Blackboard 提醒 (event_msg.user_message / type:user /
// response_item.message[role=user]) 在 helper 里已排除, 不会触发新轮.
// Claude API 把 tool result 也包在 type==="user" 的 message 里 — 只有含 text 块的才算新一轮.

// 提取一个"开新轮"候选条目里实际呈现给用户的归一化文本, 仅用于 buildRounds 内部去重比较.
// 三种格式对应同一次输入: mobius type:user / codex response_item.message[role=user] / codex event_msg.user_message.
function userTextOf(e: AnyEntry): string {
  if (e?.type === 'event_msg' && e?.payload?.type === 'user_message') {
    return String(e?.payload?.message || '').trim()
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

// 该 entry 是否承载 agent 侧输出 — 用来判断上一轮"是否已经开始接收回复"(用以拒绝把真正的二次提问误判为重复入口).
function isAssistantOutput(e: AnyEntry): boolean {
  if (e?.type === 'assistant') return true
  if (e?.type === 'event_msg' && e?.payload?.type === 'agent_message') return true
  if (e?.type === 'response_item') {
    const pt = e?.payload?.type
    if (pt === 'function_call' || pt === 'function_call_output' || pt === 'reasoning') return true
    if (pt === 'message') {
      const role = e?.payload?.role
      return !!role && role !== 'user'
    }
  }
  return false
}

function buildRounds(
  visibleItems: JsonlViewItem[],
): { preItems: JsonlViewItem[]; rounds: Round[] } {
  const preItems: JsonlViewItem[] = []
  const rounds: Round[] = []
  for (const item of visibleItems) {
    const e = item.entry
    if (isNewRound(e)) {
      // 去重: 同一次用户输入会以多种形态出现 (mobius type:user 写一条, codex 紧接着写
      // response_item.message[role=user] + event_msg.user_message). 若上一轮的"开篇用户
      // 文本"与当前候选相同, 且上一轮还没出现任何 agent 输出, 则视为同一轮的重复入口,
      // 直接丢弃而不开新轮 — 既避免生成中出现 10.0 / 11.0 重复条目, 也不会误合并真正的二次提问.
      const text = userTextOf(e)
      const prev = rounds[rounds.length - 1]
      const prevText = prev ? userTextOf(prev.items[0]?.entry) : ''
      const prevHasAssistant = !!prev && prev.items.some((it) => isAssistantOutput(it.entry))
      if (text && prev && text === prevText && !prevHasAssistant) continue
      rounds.push({ roundNum: rounds.length + 1, items: [] })
    }
    if (rounds.length === 0) {
      preItems.push(item)
    } else {
      const cur = rounds[rounds.length - 1]
      cur.items.push({ ...item, relIdx: cur.items.length })
    }
  }
  return { preItems, rounds }
}

function EntryCardWithImages({ entry, lineNo, bashResults = [], readResults = [], defaultExpanded = false, showMeta = true }: {
  entry: AnyEntry
  lineNo: number
  bashResults?: BashToolResult[]
  readResults?: BashToolResult[]
  defaultExpanded?: boolean
  showMeta?: boolean
}) {
  const displayImages = entryDisplayImages(entry)
  const attachmentImages = entryUserAttachmentImages(entry)
  const imgs = Array.from(new Set([...displayImages, ...attachmentImages]))
  const sourceLabel = displayImages.length > 0 && attachmentImages.length > 0
    ? 'display_images / 附件图片'
    : attachmentImages.length > 0
      ? '附件图片'
      : 'display_images'
  return (
    <>
      <JsonEntryCard entry={entry} lineNo={lineNo} defaultExpanded={defaultExpanded} showMeta={showMeta} bashResults={bashResults} readResults={readResults} />
      {imgs.length > 0 && <DisplayImagesCard images={imgs} lineNo={lineNo} sourceLabel={sourceLabel} />}
    </>
  )
}

function ContinuationGroup({ items, onlyGroup, showMeta = true }: { items: JsonlViewItem[]; onlyGroup: boolean; showMeta?: boolean }) {
  // 只有一组时强制展开, 禁止折叠; 其它场景保留原默认折叠行为
  const [open, setOpen] = useState(onlyGroup)
  useEffect(() => { if (onlyGroup) setOpen(true) }, [onlyGroup])
  const firstSummary = items[0] ? buildHeaderSummary(items[0].entry).short : ''

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onlyGroup ? undefined : () => setOpen(o => !o)}
        disabled={onlyGroup}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-xl transition-colors text-left group ${onlyGroup ? 'cursor-default' : 'hover:bg-[var(--bg-card-hover)]'}`}
      >
        <span className="font-mono text-[10px] font-bold text-amber-400/75 flex-shrink-0 w-8">
          ...
        </span>
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
        <span className="text-[11px] text-[var(--text-secondary)] truncate flex-1 min-w-0">
          上文续接{firstSummary ? ` · ${firstSummary}` : ''}
        </span>
        <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 font-mono">
          +{items.length}
        </span>
        {!onlyGroup && (
          <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 opacity-50 group-hover:opacity-100 transition-opacity">
            {open ? '▲' : '▼'}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-0.5 pl-2 border-l border-[var(--border-color)]/40 ml-2">
          {items.map(({ entry, lineNo, bashResults, readResults }) => (
            <div key={(entry?.uuid || entry?.id || entry?.timestamp || '') + '#' + lineNo} className="flex items-start gap-1.5">
              <span className="font-mono text-[9px] text-[var(--text-dimmed)] flex-shrink-0 mt-2.5 w-7 text-right leading-none select-none">
                ...
              </span>
              <div className="flex-1 min-w-0">
                <EntryCardWithImages entry={entry} lineNo={lineNo} bashResults={bashResults} readResults={readResults} showMeta={showMeta} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RoundGroup({ round, isLast, onlyGroup, showMeta = true }: { round: Round; isLast: boolean; onlyGroup: boolean; showMeta?: boolean }) {
  // onlyGroup 时强制展开, 禁止折叠; 其它场景保留"最新轮展开, 其余折叠"原行为
  const [open, setOpen] = useState(isLast || onlyGroup)

  // 当本轮不再是最新轮时自动折叠; 用户手动展开后不再受后续轮次影响
  // onlyGroup 时永远保持展开, 不再被后续轮次"挤"折叠
  useEffect(() => {
    if (onlyGroup) setOpen(true)
    else if (!isLast) setOpen(false)
  }, [isLast, onlyGroup])

  const userItem = round.items[0]
  const agentCount = round.items.length - 1
  const userSummary = userItem ? buildHeaderSummary(userItem.entry).short : ''

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={onlyGroup ? undefined : () => setOpen(o => !o)}
        disabled={onlyGroup}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-xl transition-colors text-left group ${onlyGroup ? 'cursor-default' : 'hover:bg-[var(--bg-card-hover)]'}`}
      >
        <span className="font-mono text-[10px] font-bold text-blue-400/70 flex-shrink-0 w-8">
          {round.roundNum}.0
        </span>
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400 flex-shrink-0" />
        <span className="text-[11px] text-[var(--text-secondary)] truncate flex-1 min-w-0">
          {userSummary || '(空)'}
        </span>
        {!open && agentCount > 0 && (
          <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 font-mono">
            +{agentCount}
          </span>
        )}
        {!onlyGroup && (
          <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 opacity-50 group-hover:opacity-100 transition-opacity">
            {open ? '▲' : '▼'}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-0.5 pl-2 border-l border-[var(--border-color)]/40 ml-2">
          {round.items.map((item, idx) => {
            const isUserItem = item.relIdx === 0
            const isLastEntry = isLast && idx === round.items.length - 1
            return (
              <Fragment key={(item.entry?.uuid || '') + '#' + item.lineNo}>
                <div className="flex items-start gap-1.5">
                  <span className="font-mono text-[9px] text-[var(--text-dimmed)] flex-shrink-0 mt-2.5 w-7 text-right leading-none select-none">
                    {/* 用户问题已在 header 显示 1.0，展开内容里不重复打标签 */}
                    {isUserItem ? '' : `${round.roundNum}.${item.relIdx}`}
                  </span>
                  <div className="flex-1 min-w-0">
                    <EntryCardWithImages
                      entry={item.entry}
                      lineNo={item.lineNo}
                      bashResults={item.bashResults}
                      readResults={item.readResults}
                      showMeta={showMeta}
                    />
                  </div>
                </div>
              </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function JsonlView({
  entries,
  title,
  emptyLoadingText,
  total,
  onLoadMore,
  loadingMore,
  showMeta = true,
}: {
  entries: AnyEntry[]
  title?: string
  emptyLoadingText?: string
  // count-then-tail: 后端先发 cheap total (jsonl_meta), 然后只回灌末尾 200 条.
  // 没传 total 时回退到 entries.length 旧行为, 老页面不破.
  total?: number
  // 点 "加载全部" 时调用; 上层负责 REST 拉剩余条目并 set entries.
  onLoadMore?: () => void
  loadingMore?: boolean
  // false 时 jsonl 卡片标题里不再显示 "#序号" 和 "MM-DD HH:MM:SS" 时间戳前缀.
  showMeta?: boolean
}) {
  const [showAll, setShowAll] = useState(false)
  const recent = useMemo(() => entries.slice(-(showAll ? entries.length : 200)), [entries, showAll])
  const windowOffset = entries.length - recent.length
  const headerTitle = title === undefined ? 'JSONL' : title
  const visibleItems = useMemo(() => mergeBashToolResultItems(recent, windowOffset), [recent, windowOffset])
  const { preItems, rounds } = useMemo(() => buildRounds(visibleItems), [visibleItems])
  // 总数显示: 优先用后端给的 total (服务器侧 count, 比前端 entries.length 准)
  const displayTotal = typeof total === 'number' && total > entries.length ? total : entries.length
  const hasRemoteMore = typeof total === 'number' && total > entries.length
  const hasOmittedHead = hasRemoteMore || windowOffset > 0
  // 当整个 JSONL 视图处于"少组"场景时, 强制展开唯一的组且禁止折叠.
  // 涵盖:
  //   - 0 RoundGroup + 1 ContinuationGroup (无新轮, 只有上文接续, totalGroups=1)
  //   - 1 RoundGroup + 0 ContinuationGroup (1 轮对话, totalGroups=1)
  //   - 1 RoundGroup + 1 ContinuationGroup (1 轮对话 + 上下文接续, totalGroups=2 但 rounds=1)
  // 0 轮且无截断, 或 2+ 轮时, 沿用原"上文折叠 / 最新轮展开"默认行为.
  const hasContinuationGroup = preItems.length > 0 && hasOmittedHead
  const totalGroups = rounds.length + (hasContinuationGroup ? 1 : 0)
  const onlyGroup = totalGroups === 1 || rounds.length === 1
  // 末轮用户摘要: 最后一组 RoundGroup 的用户问题一句话, 展示在 header 右侧, 让用户在
  // "只显示尾部 / 加载全部" 时无需展开就能知道当前最末一轮在问什么. 与 RoundGroup 内
  // buildHeaderSummary(userItem.entry).short 同源, 视觉一致.
  const lastRoundUserSummary = useMemo(() => {
    if (rounds.length === 0) return ''
    const userItem = rounds[rounds.length - 1].items[0]
    return userItem ? buildHeaderSummary(userItem.entry).short : ''
  }, [rounds])

  if (entries.length === 0) {
    if (emptyLoadingText) {
      return (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.05] px-4 py-4 text-[12px] text-amber-200 card-enter" aria-live="polite">
          <div className="flex items-center gap-3">
            <span className="relative inline-flex w-4 h-4 flex-shrink-0">
              <span className="absolute inset-0 rounded-full border-2 border-amber-300/20" />
              <span className="absolute inset-0 rounded-full border-2 border-transparent border-t-amber-300 animate-spin" />
            </span>
            <span className="font-medium">{emptyLoadingText}</span>
          </div>
        </div>
      )
    }
    return (
      <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)] italic px-3 py-4" aria-live="polite" role="status">
        <span className="relative inline-flex h-3.5 w-3.5 flex-shrink-0 not-italic" aria-hidden="true">
          <span className="absolute inset-0 rounded-full border-2 border-[var(--text-muted)] opacity-20" />
          <span className="absolute inset-0 rounded-full border-2 border-transparent border-t-[var(--text-muted)] animate-spin" />
        </span>
        <span>暂无数据，请稍等</span>
      </div>
    )
  }

  return (
    <div className="text-[12px]">
      <div className="flex items-center gap-2 px-1 py-2 sticky top-0 z-10 backdrop-blur-sm bg-[var(--bg-page)]/80">
        {headerTitle && <span className="text-[var(--text-secondary)] font-semibold">{headerTitle}</span>}
        <span className="text-[var(--text-muted)] text-[11px]">{displayTotal} entries</span>
        {rounds.length > 0 && <span className="text-[var(--text-muted)] text-[11px]">· {rounds.length} 轮</span>}
        {hasOmittedHead && <span className="text-[var(--text-muted)] text-[11px]">· 已显示尾部</span>}
        {hasRemoteMore && !!onLoadMore && (
          <button
            onClick={() => { if (!loadingMore) onLoadMore() }}
            disabled={!!loadingMore}
            className="text-[11px] px-2 py-0.5 rounded border border-[var(--border-color)] hover:bg-[var(--bg-hover)] text-[var(--text-muted)] disabled:opacity-50"
          >
            {loadingMore ? '加载中…' : `加载全部 (共 ${displayTotal} 条)`}
          </button>
        )}
        {!hasRemoteMore && entries.length > 200 && !showAll && (
          <button onClick={() => setShowAll(true)} className="text-[11px] px-2 py-0.5 rounded border border-[var(--border-color)] hover:bg-[var(--bg-hover)] text-[var(--text-muted)]">
            展开全部 ({entries.length})
          </button>
        )}
        {lastRoundUserSummary && (
          <span
            className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]"
            title={lastRoundUserSummary}
          >
            <span className="opacity-60">末轮 ·</span> {lastRoundUserSummary}
          </span>
        )}
      </div>
      {preItems.length > 0 && hasOmittedHead ? (
        <ContinuationGroup items={preItems} onlyGroup={onlyGroup} showMeta={showMeta} />
      ) : (
        preItems.map(({ entry, lineNo, bashResults, readResults }) => (
          <Fragment key={(entry?.uuid || entry?.id || entry?.timestamp || '') + '#' + lineNo}>
            <EntryCardWithImages entry={entry} lineNo={lineNo} bashResults={bashResults} readResults={readResults} showMeta={showMeta} />
          </Fragment>
        ))
      )}
      {rounds.map((round, i) => (
        <RoundGroup
          key={round.items[0]?.entry?.uuid ?? String(round.roundNum)}
          round={round}
          isLast={i === rounds.length - 1}
          onlyGroup={onlyGroup}
          showMeta={showMeta}
        />
      ))}
    </div>
  )
}
