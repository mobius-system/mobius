/**
 * jsonl entry → renderable view (TUI).
 *
 * 对齐 mobius web viewer (frontend/src/components/viewer/) 的过滤/合并/折叠思想,
 * 但适配终端线性渲染 (无卡片点击展开):
 *   - 隐藏: 对齐 web entry-classify.ts isHiddenJsonlNoiseEntry 的 7 类噪声.
 *   - 合并: tool_use + 其 tool_result 按 call_id 配对成一个 block (借鉴 web
 *     mergeBashToolResultItems, 简化版), 命令与结果不再分两行.
 *   - 折叠/展开分流: web 用卡片 open state + 点击展开; TUI 改成 —— web 默认"折叠"
 *     的卡 (普通命令/Read/reasoning/system) 压成 ≤2 行摘要 (见 Chat.tsx clampLines),
 *     "展开"的卡 (assistant 文本/代码修改/error) 完整展示.
 *   - 不引入 web entry-extract.ts 的重机器 (diff/plan 卡片渲染); 代码修改只完整
 *     显示 old_str→new_str / content 原文, 不渲染红绿 diff.
 *
 * 同时处理 Claude SDK entry 形态 (type:'user'|'assistant'|'system', message.content[])
 * 与两种 Codex SDK 形态 (function_call/function_call_output 和
 * custom_tool_call/custom_tool_call_output).
 */
import type { AnyEntry } from '../types.js'

// compact (≤2 行): tool_call / reasoning / system
// full (完整):     user / assistant / code_edit / write_file / error
export type EntryView =
  | { kind: 'skip' }
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool_call'; toolName: string; summary: string; result?: ToolResultView }
  | { kind: 'tool_result'; text: string; isError: boolean }
  | { kind: 'code_edit'; filePath: string; oldString: string; newString: string }
  | { kind: 'write_file'; filePath: string; content: string }
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string }

export interface ToolResultView {
  text: string
  isError: boolean
}

/**
 * 配对合并后的渲染单元. mergeToolCalls 把 entries 序列合并:
 *   - tool_use entry → 'tool' block, 带上按 call_id 配对到的 result.
 *   - 纯 tool_result entry (内容已并入发起方) → 丢弃.
 *   - 其余 entry → 'entry' block.
 */
export type Block =
  | { kind: 'entry'; entry: AnyEntry }
  | { kind: 'tool'; entry: AnyEntry; results: Map<string, ToolResultView> }

// ── copied verbatim from frontend entry-classify.ts (文本抽取) ──────────────
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

export function assistantEntryText(entry: AnyEntry): string {
  if (entry?.type === 'assistant') return assistantResponseText(entry?.message?.content)
  if (entry?.type === 'response_item' && entry?.payload?.type === 'message' && entry?.payload?.role === 'assistant') {
    return assistantResponseText(entry?.payload?.content)
  }
  return ''
}

function entryUserText(entry: AnyEntry): string {
  if (entry?.type === 'response_item' && entry?.payload?.type === 'message' && entry?.payload?.role === 'user') {
    const c = entry?.payload?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map((b: any) => (typeof b === 'string' ? b : (b?.text ?? b?.input_text ?? ''))).filter(Boolean).join('\n')
    return ''
  }
  if (entry?.type === 'user') {
    const c = entry?.message?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map((b: any) => (typeof b === 'string' ? b : (b?.text ?? ''))).filter(Boolean).join('\n')
    return ''
  }
  return ''
}

const ENV_CONTEXT_RE = /<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/gi

/**
 * 整卡隐藏的噪声: 对齐 web entry-classify.ts isHiddenJsonlNoiseEntry 的 7 类
 *   - token_count         : codex 每轮 token 用量统计 (event_msg)
 *   - environment_context : codex 每轮注入的 <environment_context> 纯系统 user 消息
 *   - session_meta        : codex 会话首条元数据
 *   - turn_context        : codex 每轮注入的本轮上下文元数据
 *   - turn_duration       : Claude Code 每轮结束注入的 system 耗时统计
 *   - skill_listing       : Claude Code 注入的可用 Skill 清单
 *   - agent_listing_delta : Claude Code 注入的可用 subagent 清单
 * 注: context_compacted 不在此列 (对齐 web — 它保留为可见事件, TUI 显示成 system 行).
 */
export function isHiddenNoise(entry: AnyEntry): boolean {
  if (entry?.type === 'event_msg' && entry?.payload?.type === 'token_count') return true
  if (entry?.type === 'session_meta') return true
  if (entry?.type === 'turn_context') return true
  if (entry?.type === 'system' && entry?.subtype === 'turn_duration') return true
  if (entry?.type === 'attachment' && (entry?.attachment?.type === 'skill_listing' || entry?.attachment?.type === 'agent_listing_delta')) return true
  // 纯 <environment_context> 注入: 剥掉后无任何人类提问文本才隐藏.
  const t = entryUserText(entry)
  if (t) {
    const stripped = t.replace(ENV_CONTEXT_RE, '')
    if (stripped.trim().length === 0 && stripped !== t) return true
  }
  return false
}

// ── 字段提取 (轻量版, 不引入 web entry-extract.ts 重机器) ───────────────────
const EDIT_NAMES = ['Edit', 'edit_file', 'StrReplace', 'str_replace', 'apply_patch']
const WRITE_NAMES = ['Write', 'write_file', 'create_file']

function pickString(input: any, keys: string[]): string {
  if (!input || typeof input !== 'object') return ''
  for (const k of keys) {
    const v = input[k]
    if (typeof v === 'string') return v
  }
  return ''
}

/** Edit 代码修改: Claude tool_use.old_string/new_string, 或 Codex patch_apply_end.unified_diff. */
function extractEdit(entry: AnyEntry): { filePath: string; oldString: string; newString: string } | null {
  if (entry?.type === 'assistant') {
    const c = entry?.message?.content
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== 'tool_use') continue
        const name = typeof b.name === 'string' ? b.name : ''
        if (!EDIT_NAMES.includes(name)) continue
        const input = b.input && typeof b.input === 'object' ? b.input : {}
        const oldS = pickString(input, ['old_string', 'old_str'])
        const newS = pickString(input, ['new_string', 'new_str'])
        const fp = pickString(input, ['file_path', 'path'])
        if (oldS || newS) return { filePath: fp, oldString: oldS, newString: newS }
      }
    }
  }
  // Codex: event_msg patch_apply_end.changes[path].unified_diff (作为 newString 完整展示).
  if (entry?.type === 'event_msg' && entry?.payload?.type === 'patch_apply_end') {
    const changes = entry?.payload?.changes
    if (changes && typeof changes === 'object' && !Array.isArray(changes)) {
      for (const [fp, ch] of Object.entries(changes as any)) {
        const diff = (ch as any)?.unified_diff
        if (typeof diff === 'string' && diff.trim()) return { filePath: fp, oldString: '', newString: diff }
      }
    }
  }
  return null
}

/** Write 文件写入: tool_use.file_path + content (Claude / Codex). */
function extractWrite(entry: AnyEntry): { filePath: string; content: string } | null {
  const fromInput = (input: any): { filePath: string; content: string } | null => {
    const fp = pickString(input, ['file_path', 'path', 'filePath'])
    const content = pickString(input, ['content'])
    if (!fp || !content) return null
    return { filePath: fp, content }
  }
  if (entry?.type === 'assistant') {
    const c = entry?.message?.content
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== 'tool_use') continue
        const name = typeof b.name === 'string' ? b.name : ''
        if (!WRITE_NAMES.includes(name)) continue
        const r = fromInput(b.input)
        if (r) return r
      }
    }
  }
  if (entry?.type === 'response_item') {
    const p = entry.payload
    if ((p?.type === 'function_call' || p?.type === 'custom_tool_call') && WRITE_NAMES.includes(p?.name)) {
      let input = p?.input
      if (typeof input === 'string') { try { input = JSON.parse(input) } catch { input = null } }
      return fromInput(input)
    }
  }
  return null
}

// 提取 entry 内所有 tool_use 的 call_id (Claude tool_use.id / Codex function_call.call_id).
function extractToolUseIds(entry: AnyEntry): string[] {
  const ids: string[] = []
  if (entry?.type === 'assistant') {
    const c = entry?.message?.content
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'tool_use' && typeof b.id === 'string') ids.push(b.id)
      }
    }
  }
  if (entry?.type === 'response_item') {
    const p = entry.payload
    if ((p?.type === 'function_call' || p?.type === 'custom_tool_call') && typeof p?.call_id === 'string') ids.push(p.call_id)
  }
  return ids
}

// 提取 entry 内所有 tool_result 记录 (Claude user.tool_result / Codex function_call_output).
function extractToolResults(entry: AnyEntry): Array<ToolResultView & { toolUseId?: string }> {
  const out: Array<ToolResultView & { toolUseId?: string }> = []
  if (entry?.type === 'user') {
    const c = entry?.message?.content
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== 'tool_result') continue
        const { text, isError } = extractToolResult(b)
        out.push({ text, isError, toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined })
      }
    }
  }
  if (entry?.type === 'response_item') {
    const p = entry.payload
    if (p?.type === 'function_call_output' || p?.type === 'custom_tool_call_output') {
      const { text } = extractToolResult({ content: p?.output, is_error: false })
      out.push({ text, isError: p?.status === 'failed' || p?.is_error === true, toolUseId: typeof p?.call_id === 'string' ? p.call_id : undefined })
    }
  }
  return out
}

function isPureToolResultEntry(entry: AnyEntry): boolean {
  if (entry?.type === 'response_item') {
    const p = entry.payload
    return p?.type === 'function_call_output' || p?.type === 'custom_tool_call_output'
  }
  if (entry?.type !== 'user') return false
  const c = entry?.message?.content
  return Array.isArray(c) && c.length > 0 && c.every((b: any) => b?.type === 'tool_result')
}

/**
 * 把 entries 序列合并成 Block 序列: tool_use 按 call_id 配对其 tool_result,
 * 纯 tool_result entry (已并入发起方) 丢弃. 返回的 Block 序列与卡片渲染同序.
 */
export function mergeToolCalls(entries: AnyEntry[]): Block[] {
  // call_id → tool_use 发起方 entry 的下标.
  const useIndexById = new Map<string, number>()
  entries.forEach((entry, index) => {
    for (const id of extractToolUseIds(entry)) {
      if (!useIndexById.has(id)) useIndexById.set(id, index)
    }
  })

  // tool_use entry 下标 → (call_id → result).
  const resultsByUseIndex = new Map<number, Map<string, ToolResultView>>()
  const pureResultIndexes = new Set<number>()
  entries.forEach((entry, index) => {
    const records = extractToolResults(entry)
    if (records.length === 0) return
    let matched = 0
    for (const r of records) {
      const useIdx = r.toolUseId ? useIndexById.get(r.toolUseId) : undefined
      if (useIdx == null) continue
      const m = resultsByUseIndex.get(useIdx) || new Map<string, ToolResultView>()
      m.set(r.toolUseId!, { text: r.text, isError: r.isError })
      resultsByUseIndex.set(useIdx, m)
      matched += 1
    }
    // 该 entry 是纯 tool_result 且全部配对成功 → 整条丢弃 (内容已并入发起方).
    if (matched > 0 && matched === records.length && isPureToolResultEntry(entry)) pureResultIndexes.add(index)
  })

  const out: Block[] = []
  entries.forEach((entry, index) => {
    if (pureResultIndexes.has(index)) return
    if (extractToolUseIds(entry).length > 0) {
      out.push({ kind: 'tool', entry, results: resultsByUseIndex.get(index) || new Map<string, ToolResultView>() })
    } else {
      out.push({ kind: 'entry', entry })
    }
  })
  return out
}

// ── TUI-side projection ─────────────────────────────────────────────────────
function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

/** Build a one-line summary of a tool call from its name + input. */
export function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  name = normalizeToolName(name)   // mcp__aimux__remote_exec_command → remote_exec_command
  const cmd = (s?: string) => truncate(s ?? '', 120)
  switch (name) {
    case 'Bash':
    case 'shell':
    case 'bash':
    case 'exec':
    case 'exec_command':
    case 'remote_exec_command':
    case 'shell_command':
    case 'run_terminal_cmd':
      return cmd(input.cmd ?? input.command ?? input.script)
    case 'Read':
    case 'read_file':
      return input.file_path ?? input.path ?? ''
    case 'Write':
    case 'write_file':
    case 'create_file':
      return input.file_path ?? input.path ?? ''
    case 'Edit':
    case 'StrReplace':
    case 'edit_file':
    case 'update_plan':
      return input.file_path ?? input.path ?? ''
    case 'Glob':
    case 'list_files':
      return input.pattern ?? input.path ?? ''
    case 'Grep':
    case 'grep':
    case 'search_file_content':
      return input.pattern ?? input.query ?? ''
    case 'Task':
    case 'launch_subagent':
      return input.description ?? ''
    case 'WebFetch':
    case 'web_fetch':
      return input.url ?? input.prompt ?? ''
    case 'WebSearch':
    case 'web_search':
      return input.query ?? ''
    case 'TodoWrite':
    case 'update_plan_plan':
      return ''
    default: {
      const keys = Object.keys(input)
      if (keys.length === 0) return ''
      const k = keys[0]
      return truncate(`${k}: ${typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k])}`, 100)
    }
  }
}

/** Extract readable text + error flag from a tool_result block content. */
function extractToolResult(content: any): { text: string; isError: boolean } {
  const isError = !!content?.is_error
  let body = content?.content
  let text = ''
  if (typeof body === 'string') text = body
  else if (Array.isArray(body)) {
    text = body
      .map((b: any) => (typeof b === 'string' ? b : (b?.text ?? '')))
      .filter(Boolean)
      .join('\n')
  } else if (typeof body === 'object' && body) {
    text = body.text ?? body.output ?? JSON.stringify(body)
  }
  // claude MCP 工具(如 aimux remote_exec_command)的结果是 JSON 串 {"output":"...","exit_code":0}
  // 解包出 output, 与 codex exec 的纯文本输出对齐; 再清掉终端标题/退出码探针等 shell 噪声.
  return { text: cleanShellNoise(unwrapExecOutput(text)), isError }
}

/**
 * aimux remote_exec_command 等 MCP 工具把命令输出包成 {"output":"...","exit_code":0,...}
 * JSON 串。解包出 output 字段，使 claude-code 的命令结果与 codex 的纯文本输出一致。
 * 仅当整体是 JSON 对象且含字符串 output 字段时才解包（避免误吞本身就是 JSON 的文件内容）。
 */
function unwrapExecOutput(text: string): string {
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) return text
  try {
    const obj = JSON.parse(trimmed)
    if (obj && typeof obj === 'object' && typeof obj.output === 'string') return obj.output
  } catch { /* 不是 JSON, 原样返回 */ }
  return text
}

/**
 * 清掉 aimux 交互式 shell 捕获里的纯噪声 (claude-code 与 codex 经 aimux 执行命令时都会产生):
 *   - OSC 终端标题序列  \x1b]0;root@host: cwd\x07   (最刺眼的乱码)
 *   - CSI 控制序列      \x1b[...m 等
 *   - aimux 退出码探针  __AIMUX_EXIT_<hex>__:<code>  及其 echo 回显
 */
function cleanShellNoise(text: string): string {
  if (!text) return text
  return text
    .replace(/\x1b\][^\x1b]*?(?:\x07|\x1b\\)/g, '')   // OSC 终端标题
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')            // CSI 控制序列
    .replace(/__AIMUX_EXIT_[0-9a-fA-F]+__(:\d+)?/g, '') // aimux 退出码标记
    .replace(/[ \t]*\r?\n[ \t]*\r?\n[ \t]*\r?\n+/g, '\n\n') // 压连续空行
    .trim()
}

/** 还原 claude MCP 工具长名: mcp__<server>__<tool> → <tool>, 与 codex 短名对齐。 */
function normalizeToolName(name: string): string {
  const m = /^mcp__[a-zA-Z0-9_-]+__(.+)$/.exec(name)
  return m ? m[1] : name
}

const TOOL_LABEL: Record<string, string> = {
  Bash: '运行命令', bash: '运行命令', shell: '运行命令', exec: '运行命令',
  exec_command: '运行命令', remote_exec_command: '运行命令', shell_command: '运行命令', run_terminal_cmd: '运行命令',
  result: '结果',
  write_stdin: '输入命令',
  Read: '读取文件', read_file: '读取文件',
  Write: '写入文件', write_file: '写入文件', create_file: '创建文件',
  Edit: '编辑文件', StrReplace: '编辑文件', edit_file: '编辑文件', apply_patch: '编辑文件',
  Glob: '搜索文件', list_files: '列出文件',
  Grep: '搜索内容', grep: '搜索内容', search_file_content: '搜索内容',
  Task: '子任务', launch_subagent: '子任务',
  WebFetch: '抓取网页', web_fetch: '抓取网页',
  WebSearch: '网络搜索', web_search: '网络搜索',
  TodoWrite: '更新计划', update_plan: '更新计划',
}

// Mirrors the web viewer (header-summary.ts): encrypted reasoning gets a fixed
// label; otherwise show the summary text if any.
const ENCRYPTED_REASONING_LABEL = 'Reasoning (闭源模型的推理过程被加密，无法解码)'

function reasoningSummaryText(p: any): string {
  const s = p?.summary
  if (Array.isArray(s)) return s.map((x: any) => (typeof x === 'string' ? x : (x?.text ?? ''))).filter(Boolean).join('\n')
  if (typeof s === 'string') return s
  return ''
}

/**
 * Newer Codex versions wrap tool calls in a custom `exec` transport. Its
 * payload.input is JavaScript such as:
 *
 *   const r = await tools.exec_command({ cmd: "rg -n ...", workdir: "/repo" })
 *
 * Extract the nested tool name and its object argument so the TUI can render
 * the same command summary as the web viewer. JSON is the common case; the
 * small quoted-field fallback also handles JavaScript object keys and strings.
 */
function parseCustomToolCall(raw: any): { name: string; input: Record<string, any> } | null {
  if (typeof raw !== 'string') return null
  // Prefer the first tools.<name>(...) invocation. A custom wrapper may call
  // Promise.all(...) or another helper before it, which is transport code and
  // must not become the displayed tool name.
  const call = /tools\.([A-Za-z_$][\w$]*)\s*\(/g.exec(raw)
    || /\b(exec_command|write_stdin|apply_patch)\s*\(/g.exec(raw)
  if (!call) return null
  const objectStart = raw.indexOf('{', call.index + call[0].length)
  if (objectStart < 0) return { name: call[1], input: {} }

  let quote = ''
  let escaped = false
  let depth = 0
  let objectEnd = -1
  for (let index = objectStart; index < raw.length; index++) {
    const ch = raw[index]
    if (quote) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) { objectEnd = index; break }
  }
  if (objectEnd < 0) return { name: call[1], input: {} }

  const source = raw.slice(objectStart, objectEnd + 1)
  try {
    const parsed = JSON.parse(source)
    if (parsed && typeof parsed === 'object') return { name: call[1], input: parsed }
  } catch { /* JavaScript object syntax falls through to quoted-field parsing. */ }

  const input: Record<string, any> = {}
  const patterns = [
    /(?:^|[,{])\s*(cmd|command|script|workdir|cwd|path|file_path|query|pattern)\s*:\s*"((?:\\.|[^"\\])*)"/g,
    /(?:^|[,{])\s*(cmd|command|script|workdir|cwd|path|file_path|query|pattern)\s*:\s*'((?:\\.|[^'\\])*)'/g,
  ]
  for (const pattern of patterns) {
    let field: RegExpExecArray | null
    while ((field = pattern.exec(source))) {
      try { input[field[1]] = JSON.parse(`"${field[2].replace(/"/g, '\\"')}"`) }
      catch { input[field[1]] = field[2].replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\([\\"'])/g, '$1') }
    }
  }
  return { name: call[1], input }
}

/** Project one block into zero or more renderable views. */
export function viewsForBlock(block: Block): EntryView[] {
  const entry = block.entry
  if (!entry || typeof entry !== 'object') return [{ kind: 'skip' }]
  if (isHiddenNoise(entry)) return [{ kind: 'skip' }]
  const type = entry.type

  // ── Claude SDK shapes ───────────────────────────────────────────────────
  if (type === 'assistant') {
    const content = entry.message?.content
    if (!Array.isArray(content)) {
      const text = assistantResponseText(content)
      return text ? [{ kind: 'assistant', text }] : [{ kind: 'skip' }]
    }
    const out: EntryView[] = []
    const textParts: string[] = []
    const thinkingParts: string[] = []
    let hasThinking = false
    const flushText = () => {
      if (textParts.length) { out.push({ kind: 'assistant', text: textParts.join('\n') }); textParts.length = 0 }
    }
    for (const b of content) {
      if (!b) continue
      if (b.type === 'text' || b.type === 'output_text') {
        if (b.text) textParts.push(b.text)
      } else if (b.type === 'tool_use') {
        const name = typeof b.name === 'string' ? b.name : ''
        const input = b.input && typeof b.input === 'object' ? b.input : {}
        if (EDIT_NAMES.includes(name)) {
          // 代码修改 → full (完整展示 old→new)
          flushText()
          out.push({
            kind: 'code_edit',
            filePath: pickString(input, ['file_path', 'path']),
            oldString: pickString(input, ['old_string', 'old_str']),
            newString: pickString(input, ['new_string', 'new_str']),
          })
        } else if (WRITE_NAMES.includes(name)) {
          // 文件写入 → full (完整展示 content)
          flushText()
          out.push({ kind: 'write_file', filePath: pickString(input, ['file_path', 'path', 'filePath']), content: pickString(input, ['content']) })
        } else {
          // 普通工具 → compact (带配对的 result)
          flushText()
          const id = typeof b.id === 'string' ? b.id : ''
          const result = block.kind === 'tool' && id ? block.results.get(id) : undefined
          out.push({ kind: 'tool_call', toolName: name, summary: summarizeToolInput(name, b.input), result })
        }
      } else if (b.type === 'thinking') {
        hasThinking = true
        if (typeof b.thinking === 'string' && b.thinking) thinkingParts.push(b.thinking)
      }
    }
    flushText()
    if (thinkingParts.length) out.push({ kind: 'reasoning', text: thinkingParts.join('\n').trim() })
    else if (hasThinking) out.push({ kind: 'reasoning', text: '思考内容被隐藏' })
    return out.length ? out : [{ kind: 'skip' }]
  }

  if (type === 'user') {
    const content = entry.message?.content
    // tool_result wrapper (assistant's tool output fed back).
    if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) {
      const out: EntryView[] = []
      for (const b of content) {
        if (b?.type === 'tool_result') {
          const { text, isError } = extractToolResult(b)
          out.push({ kind: 'tool_result', text, isError })
        }
      }
      return out
    }
    const text = entryUserText(entry)
    return text ? [{ kind: 'user', text: stripUserFraming(text) }] : [{ kind: 'skip' }]
  }

  if (type === 'system') {
    if (entry.subtype === 'init') return [{ kind: 'skip' }]
    const text = entry.content || entry.message?.content || entry.subtype
    return text ? [{ kind: 'system', text: truncate(typeof text === 'string' ? text : JSON.stringify(text), 160) }] : [{ kind: 'skip' }]
  }

  // ── Codex SDK shapes (response_item) ────────────────────────────────────
  if (type === 'response_item') {
    const p = entry.payload
    if (!p) return [{ kind: 'skip' }]
    if (p.type === 'message') {
      const text = assistantResponseText(p.content)
      if (!text) return [{ kind: 'skip' }]
      return [{ kind: p.role === 'user' ? 'user' : 'assistant', text: p.role === 'user' ? stripUserFraming(text) : text }]
    }
    if (p.type === 'reasoning') {
      const enc = p.encrypted_content
      const text = typeof enc === 'string' && enc.length > 0
        ? ENCRYPTED_REASONING_LABEL
        : (reasoningSummaryText(p) || 'reasoning')
      return [{ kind: 'reasoning', text }]
    }
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      // Write → full
      const write = extractWrite(entry)
      if (write) return [{ kind: 'write_file', filePath: write.filePath, content: write.content }]
      let name = p.name || 'tool'
      let input: any = p.arguments
      if (typeof input === 'string') { try { input = JSON.parse(input) } catch { /* keep string */ } }
      if (p.type === 'custom_tool_call') {
        const nested = parseCustomToolCall(p.input)
        if (nested) { name = nested.name; input = nested.input }
      }
      const id = typeof p.call_id === 'string' ? p.call_id : ''
      const result = block.kind === 'tool' && id ? block.results.get(id) : undefined
      return [{ kind: 'tool_call', toolName: name, summary: summarizeToolInput(name, input), result }]
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      // 累积模式: tool 结果单独成行 (发起的 tool_use 命令行已在前一条 entry 累积).
      const { text } = extractToolResult({ content: p.output, is_error: false })
      return [{ kind: 'tool_result', text, isError: p?.status === 'failed' || p?.is_error === true }]
    }
    return [{ kind: 'skip' }]
  }

  if (type === 'event_msg') {
    const ptype = entry.payload?.type
    if (ptype === 'error') return [{ kind: 'error', text: truncate(entry.payload?.message || '错误', 200) }]
    if (ptype === 'context_compacted') return [{ kind: 'system', text: '◇ 上下文已压缩' }]
    if (ptype === 'patch_apply_end') {
      // Codex 代码修改完成 → full (完整展示 unified_diff)
      const edit = extractEdit(entry)
      if (edit) return [{ kind: 'code_edit', filePath: edit.filePath, oldString: edit.oldString, newString: edit.newString }]
    }
    return [{ kind: 'skip' }]
  }

  return [{ kind: 'skip' }]
}

/** 旧接口保留: 单 entry 投射 (无合并), 给 useChat 的 entryMatchesPendingUser 等用. */
export function viewsForEntry(entry: AnyEntry): EntryView[] {
  return viewsForBlock({ kind: 'entry', entry })
}

export function toolLabel(name: string): string {
  const n = normalizeToolName(name)   // mcp__aimux__remote_exec_command → remote_exec_command → 运行命令
  return TOOL_LABEL[n] ?? n
}

// ── 用户输入去重 (对齐 web viewer/rounds.ts buildRounds) ──────────────────────
// codex 一次用户输入在 jsonl 里以 3 种形态出现 (type:user / response_item.message[role=user]
// / event_msg.user_message), 文本相同. 若与上一条用户输入文本相同, 且之间还没出现任何
// agent 输出, 则视为同一次输入的重复入口 → 丢弃, 避免 TUI 把同一条提问显示多次.
export function userTextOf(e: AnyEntry): string {
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

// mobius 给 agent 的用户消息会注入一大段上下文框架: 从 "以下信息描述了你正在协助的
// 用户、当前Project、Issue/Research 与 Session" 到 "## 用户的问题" 之前都是 framing
// (用户/项目/Issue/Session/Research/Memory 等描述), 之后才是真实提问. TUI 显示用户
// 消息时隐藏 framing, 只显示 "## 用户的问题" 之后的内容 (兼容 【## 用户的问题】 写法).
const USER_QUESTION_MARKER = /(?:^|\n)\s*【?\s*##\s*用户的问题\s*】?\s*\r?\n/

export function stripUserFraming(text: string): string {
  if (!text) return text
  const m = text.match(USER_QUESTION_MARKER)
  if (!m || m.index == null) return text
  const after = text.slice(m.index + m[0].length).trim()
  return after || text
}

export function isAssistantOutput(e: AnyEntry): boolean {
  if (e?.type === 'assistant') return true
  if (e?.type === 'event_msg' && e?.payload?.type === 'agent_message') return true
  if (e?.type === 'response_item') {
    const pt = e?.payload?.type
    if (pt === 'function_call' || pt === 'function_call_output' || pt === 'custom_tool_call' || pt === 'custom_tool_call_output' || pt === 'reasoning') return true
    if (pt === 'message') {
      const role = e?.payload?.role
      return !!role && role !== 'user'
    }
  }
  return false
}

export function dedupeUserEntries(entries: AnyEntry[]): AnyEntry[] {
  let lastUserText = ''
  let seenAssistantAfter = false
  return entries.filter((e) => {
    const text = userTextOf(e)
    if (text) {
      if (text === lastUserText && !seenAssistantAfter) return false
      lastUserText = text
      seenAssistantAfter = false
      return true
    }
    if (isAssistantOutput(e)) seenAssistantAfter = true
    return true
  })
}
