/**
 * jsonl entry → renderable view.
 *
 * The pure helpers (assistantResponseText / assistantEntryText / entryUserText
 * and the "hidden noise" predicates) are copied from the mobius web frontend's
 * frontend/src/components/viewer/entry-classify.ts. The frontend's full
 * entry-extract.ts (diff/plan machinery) is far heavier than a chat TUI needs,
 * so instead we project each entry into a small EntryView union that the
 * Transcript renders — handling BOTH the Claude SDK entry shape (type:
 * 'user'|'assistant'|'system', message.content[]) and the Codex SDK shape
 * (type: 'response_item', payload.type: message|function_call|function_call_output).
 */
import type { AnyEntry } from '../types.js'

export type EntryView =
  | { kind: 'skip' }
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_call'; toolName: string; summary: string }
  | { kind: 'tool_result'; summary: string; isError: boolean }
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string }

// ── copied verbatim from frontend entry-classify.ts ──────────────────────────
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

// Noise entries that carry no conversational value (system injections / metadata).
export function isHiddenNoise(entry: AnyEntry): boolean {
  if (entry?.type === 'event_msg' && (entry?.payload?.type === 'token_count' || entry?.payload?.type === 'context_compacted')) return true
  if (entry?.type === 'session_meta') return true
  if (entry?.type === 'system' && entry?.subtype === 'turn_duration') return true
  if (entry?.type === 'attachment' && (entry?.attachment?.type === 'skill_listing' || entry?.attachment?.type === 'agent_listing_delta')) return true
  // pure <environment_context> injection
  const t = entryUserText(entry)
  if (t) {
    const stripped = t.replace(ENV_CONTEXT_RE, '')
    if (stripped.trim().length === 0 && stripped !== t) return true
  }
  return false
}

// ── TUI-side projection ──────────────────────────────────────────────────────
function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

/** Build a one-line summary of a tool call from its name + input. */
export function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  const cmd = (s?: string) => truncate(s ?? '', 120)
  switch (name) {
    case 'Bash':
    case 'shell':
      return cmd(input.command)
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
  if (typeof body === 'string') return { text: body, isError }
  if (Array.isArray(body)) {
    const t = body
      .map((b: any) => (typeof b === 'string' ? b : (b?.text ?? '')))
      .filter(Boolean)
      .join('\n')
    return { text: t, isError }
  }
  if (typeof body === 'object' && body) {
    return { text: body.text ?? body.output ?? JSON.stringify(body), isError }
  }
  return { text: '', isError }
}

const TOOL_LABEL: Record<string, string> = {
  Bash: '运行命令', shell: '运行命令',
  Read: '读取文件', read_file: '读取文件',
  Write: '写入文件', write_file: '写入文件', create_file: '创建文件',
  Edit: '编辑文件', StrReplace: '编辑文件', edit_file: '编辑文件',
  Glob: '搜索文件', list_files: '列出文件',
  Grep: '搜索内容', grep: '搜索内容', search_file_content: '搜索内容',
  Task: '子任务', launch_subagent: '子任务',
  WebFetch: '抓取网页', web_fetch: '抓取网页',
  WebSearch: '网络搜索', web_search: '网络搜索',
  TodoWrite: '更新计划', update_plan: '更新计划',
}

/** Project one entry into zero or more renderable views. */
export function viewsForEntry(entry: AnyEntry): EntryView[] {
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
    for (const b of content) {
      if (!b) continue
      if (b.type === 'text' || b.type === 'output_text') {
        if (b.text) textParts.push(b.text)
      } else if (b.type === 'tool_use') {
        if (textParts.length) { out.push({ kind: 'assistant', text: textParts.join('\n') }); textParts.length = 0 }
        out.push({ kind: 'tool_call', toolName: b.name, summary: summarizeToolInput(b.name, b.input) })
      }
      // 'thinking' blocks are skipped (reduce noise)
    }
    if (textParts.length) out.push({ kind: 'assistant', text: textParts.join('\n') })
    return out.length ? out : [{ kind: 'skip' }]
  }

  if (type === 'user') {
    const content = entry.message?.content
    // tool_result wrapper (assistant's tool output fed back)
    if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) {
      const out: EntryView[] = []
      for (const b of content) {
        if (b?.type === 'tool_result') {
          const { text, isError } = extractToolResult(b)
          out.push({ kind: 'tool_result', summary: truncate(text, 160), isError })
        }
      }
      return out
    }
    const text = entryUserText(entry)
    return text ? [{ kind: 'user', text }] : [{ kind: 'skip' }]
  }

  if (type === 'system') {
    const subtype = entry.subtype
    if (subtype === 'init') return [{ kind: 'skip' }]
    const text = entry.content || entry.message?.content || subtype
    return text ? [{ kind: 'system', text: truncate(typeof text === 'string' ? text : JSON.stringify(text), 160) }] : [{ kind: 'skip' }]
  }

  // ── Codex SDK shapes (response_item) ────────────────────────────────────
  if (type === 'response_item') {
    const p = entry.payload
    if (!p) return [{ kind: 'skip' }]
    if (p.type === 'message') {
      const text = assistantResponseText(p.content)
      if (!text) return [{ kind: 'skip' }]
      return [{ kind: p.role === 'user' ? 'user' : 'assistant', text }]
    }
    if (p.type === 'reasoning') return [{ kind: 'skip' }] // thinking — skipped
    if (p.type === 'function_call') {
      let name = p.name || 'tool'
      let input: any = p.arguments
      if (typeof input === 'string') { try { input = JSON.parse(input) } catch { /* keep string */ } }
      return [{ kind: 'tool_call', toolName: name, summary: summarizeToolInput(name, input) }]
    }
    if (p.type === 'function_call_output') {
      const { text } = extractToolResult({ content: p.output, is_error: false })
      return [{ kind: 'tool_result', summary: truncate(text, 160), isError: false }]
    }
    return [{ kind: 'skip' }]
  }

  if (type === 'event_msg') {
    const ptype = entry.payload?.type
    if (ptype === 'error') return [{ kind: 'error', text: truncate(entry.payload?.message || '错误', 200) }]
    return [{ kind: 'skip' }]
  }

  return [{ kind: 'skip' }]
}

export function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name
}
