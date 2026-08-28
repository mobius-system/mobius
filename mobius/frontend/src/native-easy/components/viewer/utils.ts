/**
 * viewer/utils.ts — jsonl 视图各模块共享的叶子级纯函数 (无 React 依赖).
 *
 * 从 jsonl-view.tsx 拆出. 这里只放"被多个模块用到"的小工具: 字符串/数值解析、
 * 行号/路径处理、JSON 节点预览等. 领域专属的辅助 (各类 extract/build 函数) 放在各自
 * 的 entry-extract / header-summary 等文件里, 不堆在这里.
 */
import type { UnifiedHunkHeader } from './types'

export function lineCount(text: string): number {
  if (!text) return 0
  return text.split('\n').length
}

export function basename(path: string): string {
  const parts = String(path || '').split(/[\\/]/)
  return parts[parts.length - 1] || path || 'unknown'
}

export function parseCount(raw: string | undefined): number {
  if (!raw || raw === '') return 1
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 1
}

export function parseUnifiedHunkHeader(line: string): UnifiedHunkHeader | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
  if (!match) return null
  return {
    oldStart: Number.parseInt(match[1], 10),
    oldCount: parseCount(match[2]),
    newStart: Number.parseInt(match[3], 10),
    newCount: parseCount(match[4]),
  }
}

export function parseFunctionCallArguments(raw: any): Record<string, any> | null {
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

export function stringField(value: any): string {
  return typeof value === 'string' ? value : ''
}

export function numberField(value: any): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

export function outputField(value: any): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function isNonEmptyString(value: any): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function splitDiffValue(value: string): string[] {
  if (!value) return []
  const hasTrailingNewline = value.endsWith('\n')
  const lines = value.split('\n')
  if (hasTrailingNewline) lines.pop()
  return lines
}

export function codeFence(text: string, language = ''): string {
  const ticks = text.match(/`{3,}/g)
  const longest = ticks ? Math.max(...ticks.map(s => s.length)) : 2
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const opener = language ? `${fence}${language}` : fence
  return `${opener}\n${text}\n${fence}`
}

export function escapeMarkdownText(value: any): string {
  return String(value ?? '').replace(/[\\`*_\[\]]/g, '\\$&')
}

export function compactInlineList(values: any[]): string {
  return values
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .map((value) => `\`${value.replace(/`/g, '\\`')}\``)
    .join(' ')
}

// "MM-DD HH:MM:SS" 本地时间, 失败返回 null
export function formatTs(raw: any): string | null {
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 沉默时长格式化: 0~59s → "Ns", 1~59m → "Xm Ys", 1h+ → "Xh Ym"
export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}m ${s}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function isPrimitive(v: any): boolean {
  return v === null || typeof v !== 'object'
}

export function previewPrimitive(v: any): string {
  if (v === null) return 'null'
  if (typeof v === 'string') {
    // 单行预览, 超长截断
    const oneLine = v.replace(/\n/g, '⏎')
    return `"${oneLine.length > 200 ? oneLine.slice(0, 200) + '…' : oneLine}"`
  }
  return String(v)
}

export function summarize(v: any, key?: string): string {
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
