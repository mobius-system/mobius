/**
 * Screen-text model for the transcript: reproduces the exact rows Ink renders
 * so mouse coordinates can be mapped to (entry, line, char) for tmux-style
 * drag selection, and so selected rows can be re-rendered with a highlight.
 *
 * Alignment strategy: Ink wraps `<Text wrap="wrap">` with `wrap-ansi` using
 * `{ trim: false, hard: true }` at the Text's available width. The transcript
 * lives under the root Box whose `paddingX={1}` leaves `columns - 2` columns,
 * so every visible line is wrapped/truncated at `columns - 2`. The same width
 * and the same wrap call are used here, so the model's rows match the rendered
 * frame (verified by tests/scroll.test.tsx).
 */
import wrapAnsi from 'wrap-ansi'
import { renderMarkdownLines } from '../markdown.js'
import { toolLabel, viewsForEntry, type EntryView } from './entry-view.js'
import type { AnyEntry } from '../types.js'

// ── shared text helpers (mirrored from Chat.tsx, kept here to avoid a cycle) ─
export function displayWidth(str: string): number {
  let width = 0
  for (const ch of Array.from(str)) {
    const code = ch.codePointAt(0)!
    // Zero-width / combining marks.
    if (code === 0x200d) continue
    if ((code >= 0x0300 && code <= 0x036f) || (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0x1ab0 && code <= 0x1aff)) continue
    // Narrow: halfwidth katakana, Hangul jamo, Latin-1-ish control-ish.
    if (code < 0x100 && !(code >= 0x1100 && code <= 0x115f)) width += 1
    else if (code >= 0xff61 && code <= 0xffdc) width += 1
    else if (code >= 0x1100 && code <= 0x115f) width += 2
    else if (code >= 0x2e80 && code <= 0x303e) width += 2
    else if (code >= 0x3040 && code <= 0xa4cf) width += 2
    else if (code >= 0xac00 && code <= 0xd7a3) width += 2
    else if (code >= 0xf900 && code <= 0xfaff) width += 2
    else if (code >= 0xfe30 && code <= 0xfe4f) width += 2
    else if (code >= 0xff00 && code <= 0xff60) width += 2
    else if (code >= 0xffe0 && code <= 0xffe6) width += 2
    else if (code >= 0x1f300 && code <= 0x1faff) width += 2
    else width += 1
  }
  return width
}

export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x1b]*?(?:\x07|\x1b\\)/g, '')
}

/** Hard-wrap at `width` display columns, exactly as Ink does for wrap="wrap". */
export function wrapText(text: string, width: number): string[] {
  return wrapAnsi(text, Math.max(1, width), { trim: false, hard: true }).split('\n')
}

/** Truncate to `width` display columns (cli-truncate style, trailing …). */
export function truncateText(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  let acc = 0
  let out = ''
  for (const ch of Array.from(text)) {
    const w = displayWidth(ch)
    if (acc + w > width - 1) break
    out += ch
    acc += w
  }
  return out + '…'
}

/** Hard-slice a string into `width`-display-column chunks (compacts ≤ maxLines). */
export function clampLines(text: string, width: number, maxLines: number): string[] {
  if (!text) return ['']
  const paras = text.replace(/\r\n/g, '\n').split('\n')
  const wrapped: string[] = []
  for (const para of paras) {
    if (para === '') { wrapped.push(''); continue }
    for (let i = 0; i < para.length; i += width) wrapped.push(para.slice(i, i + width))
  }
  if (wrapped.length <= maxLines) return wrapped
  const trimmed = wrapped.slice(0, maxLines)
  const last = trimmed[maxLines - 1]
  trimmed[maxLines - 1] = last.length >= width ? last.slice(0, width - 1) + '…' : last + '…'
  return trimmed
}

/** head + ellipsis + tail truncation (mirrors Chat.tsx headTailLines). */
export function headTailLines(text: string, width: number, maxLines: number): string[] {
  if (!text) return ['']
  const paras = text.replace(/\r\n/g, '\n').split('\n')
  const wrapped: string[] = []
  for (const para of paras) {
    if (para === '') { wrapped.push(''); continue }
    for (let i = 0; i < para.length; i += width) wrapped.push(para.slice(i, i + width))
  }
  if (wrapped.length <= maxLines) return wrapped.slice(0, maxLines)
  const budget = maxLines - 1
  const head = Math.max(1, Math.ceil(budget / 2))
  const tail = Math.max(1, budget - head)
  const omitted = wrapped.length - head - tail
  if (omitted <= 0) return wrapped.slice(0, maxLines)
  return [...wrapped.slice(0, head), `… +${omitted} 行`, ...wrapped.slice(wrapped.length - tail)]
}

// ── transcript row model ─────────────────────────────────────────────────────
export interface ScreenRows {
  /** Whether this view renders with a leading blank row (its Box has marginTop). */
  marginTop: boolean
  /** Full screen rows: a plain layout/copy projection plus its styled ANSI text. */
  rows: ScreenRow[]
}

export type ScreenRowTone =
  | 'normal'
  | 'user'
  | 'tool'
  | 'tool_result'
  | 'tool_error'
  | 'edit_header'
  | 'edit_old'
  | 'edit_new'
  | 'reasoning'
  | 'system'
  | 'error'

export interface ScreenRow {
  /** Visible text used for geometry, hit-testing, and clipboard extraction. */
  plain: string
  /** Same row with Markdown/syntax ANSI styling preserved for terminal output. */
  styled: string
  tone: ScreenRowTone
}

const textWidth = (columns: number) => Math.max(8, columns - 4)
const fullWidth = (columns: number) => Math.max(1, columns - 2) // root paddingX=1

/** Reproduce the visible screen rows for one EntryView (mirrors ViewLine). */
export function viewScreenRows(view: EntryView, columns: number): ScreenRows {
  const width = textWidth(columns)
  const full = fullWidth(columns)
  const row = (styled: string, tone: ScreenRowTone = 'normal'): ScreenRow => ({
    plain: stripAnsi(styled),
    styled,
    tone,
  })
  // Keep the original styled string and let Ink perform its ANSI-aware
  // truncate-end rendering. The plain projection mirrors the visible row.
  const fit = (rows: string[], tone: ScreenRowTone = 'normal'): ScreenRow[] => rows.map((styled) => ({
    plain: truncateText(stripAnsi(styled), full),
    styled,
    tone,
  }))
  const wrap = (styled: string, tone: ScreenRowTone = 'normal'): ScreenRow[] => (
    wrapAnsi(styled, full, { trim: false, hard: true }).split('\n').map(text => row(text, tone))
  )
  switch (view.kind) {
    case 'skip':
      return { marginTop: false, rows: [] }
    case 'user': {
      const rows = view.text.split('\n').map((l, i) => (i === 0 ? `› ${l}` : `  ${l}`))
      return { marginTop: true, rows: fit(rows, 'user') }
    }
    case 'assistant': {
      const md = renderMarkdownLines(view.text)
      const rows: ScreenRow[] = []
      md.forEach((line, i) => {
        const prefix = i === 0 ? '• ' : '  '
        const fullLine = prefix + (line.text || ' ')
        if (line.code) rows.push(...fit([fullLine]))
        else rows.push(...wrap(fullLine))
      })
      return { marginTop: true, rows }
    }
    case 'tool_call': {
      const head = clampLines(`${toolLabel(view.toolName)} ${view.summary}`.trim(), width - 2, 1)[0]
      const rows = fit([`• ${head}`], 'tool')
      if (view.result) rows.push(...fit(
        [`  └ ${clampLines(view.result.text, width - 4, 1)[0] || '(无输出)'}`],
        view.result.isError ? 'tool_error' : 'tool_result',
      ))
      return { marginTop: true, rows }
    }
    case 'tool_result': {
      const lines = headTailLines(view.text, width - 4, 5)
      return { marginTop: false, rows: fit(
        lines.map((l, i) => `${i === 0 ? '  └ ' : '    '}${l}`),
        view.isError ? 'tool_error' : 'tool_result',
      ) }
    }
    case 'code_edit': {
      const rows = fit([`✎ 编辑 ${view.filePath || '(未指定文件)'}`], 'edit_header')
      if (view.oldString) rows.push(...fit(view.oldString.split('\n').map((l) => `  − ${l}`), 'edit_old'))
      if (view.newString) rows.push(...fit(view.newString.split('\n').map((l) => `  + ${l}`), 'edit_new'))
      return { marginTop: true, rows }
    }
    case 'write_file': {
      const rows = fit([`✎ 写入 ${view.filePath || '(未指定文件)'}`], 'edit_header')
      rows.push(...fit(view.content.split('\n').map((l) => `  + ${l}`), 'edit_new'))
      return { marginTop: true, rows }
    }
    case 'reasoning': {
      const lines = clampLines(view.text, width - 4, 2)
      return { marginTop: true, rows: fit(lines.map((l, i) => `${i === 0 ? '  ◇ ' : '    '}${l}`), 'reasoning') }
    }
    case 'system':
      return { marginTop: false, rows: fit([`  ${clampLines(view.text, width - 2, 2)[0]}`], 'system') }
    case 'error': {
      const rows = view.text.split('\n').map((l, i) => `${i === 0 ? '⚠ ' : '  '}${l}`)
      return { marginTop: true, rows: fit(rows, 'error') }
    }
    default:
      return { marginTop: false, rows: [] }
  }
}

/** Flatten a whole entry into stable rows, with margins represented explicitly. */
export function entryScreenRows(views: EntryView[], columns: number): ScreenRow[] {
  const lines: ScreenRow[] = []
  for (const v of views) {
    const { marginTop, rows } = viewScreenRows(v, columns)
    if (marginTop) lines.push({ plain: '', styled: '', tone: 'normal' })
    lines.push(...rows)
  }
  return lines
}

/** Plain projection used by fitting, geometry, hit-testing, and copying. */
export function entryScreenLines(views: EntryView[], columns: number): string[] {
  return entryScreenRows(views, columns).map(row => row.plain)
}

// ── vertical geometry ────────────────────────────────────────────────────────
export interface TranscriptGeometry {
  /** Screen row where the transcript box's top edge sits. */
  boxTop: number
  /** Transcript box height in rows. */
  boxH: number
}

/**
 * Mirror the ChatScreen layout so a screen (row, col) can be mapped into the
 * transcript. The bottom section (activity + composer + status) is fixed height
 * (`flexShrink=0`); the middle column holds header + hint + transcript (flexGrow)
 * + tip + help. Margins that render as extra rows are counted explicitly.
 */
export function computeTranscriptGeometry(opts: {
  viewportRows: number
  composerRows: number
  statusRows: number
  activityRows: number
  helpRows: number
  showWelcome: boolean
  welcomeRows: number
  olderHintShown: boolean
  tipShown: boolean
}): TranscriptGeometry {
  // The composer's reported height already includes its marginTop; the status
  // area and working indicator rows are already folded into statusRows and
  // activityRows. No extra +1 here — calibrated against the rendered frame.
  const bottomH = opts.activityRows + opts.composerRows + opts.statusRows
  const midH = opts.viewportRows - bottomH
  const headerH = opts.showWelcome ? opts.welcomeRows : 1
  const hintH = opts.olderHintShown ? 1 : 0
  const tipH = opts.tipShown ? 2 : 0 // marginTop 1 + content 1
  const helpH = opts.helpRows > 0 ? opts.helpRows + 1 : 0 // +1 marginTop
  const boxTop = headerH + hintH + tipH + helpH
  return { boxTop, boxH: Math.max(0, midH - boxTop) }
}

// ── selection mapping ────────────────────────────────────────────────────────
export interface SelPoint {
  entry: number // index into the fitted entries
  row: number   // index into that entry's screen lines
  col: number   // char offset into the screen line
}

export interface TranscriptModel {
  entries: string[][] // per fitted entry, its screen lines (margins as '')
  totalRows: number
}

export function buildTranscriptModel(fittedEntries: AnyEntry[], columns: number): TranscriptModel {
  const entries = fittedEntries.map((e) => entryScreenLines(viewsForEntry(e), columns))
  return { entries, totalRows: entries.reduce((sum, l) => sum + l.length, 0) }
}

/** Convert a screen (row, col) into a SelPoint, or null if outside the transcript. */
export function screenToSelPoint(
  screenRow: number,
  screenCol: number,
  model: TranscriptModel,
  geo: TranscriptGeometry,
): SelPoint | null {
  if (screenRow < geo.boxTop || screenRow >= geo.boxTop + geo.boxH) return null
  let local = screenRow - geo.boxTop
  const startOffset = geo.boxH - model.totalRows
  if (local < startOffset) return null
  local -= startOffset
  let acc = 0
  for (let e = 0; e < model.entries.length; e++) {
    const n = model.entries[e].length
    if (local < acc + n) {
      const line = model.entries[e][local - acc]
      const colOff = screenCol - 1 // root paddingX=1
      return { entry: e, row: local - acc, col: charAtDisplayWidth(line, colOff) }
    }
    acc += n
  }
  return null
}

/** Char index under display column `col` (clamped), so selection lands on chars. */
function charAtDisplayWidth(line: string, col: number): number {
  if (col <= 0) return 0
  let acc = 0
  let i = 0
  for (const ch of Array.from(line)) {
    const w = displayWidth(ch)
    if (col < acc + w) return i
    acc += w
    i += ch.length
  }
  return i
}

export function compareSel(a: SelPoint, b: SelPoint): number {
  return a.entry - b.entry || a.row - b.row || a.col - b.col
}

/** Char range [start,end) per (entry → row) that the selection covers. */
export function buildSelectionMap(
  model: TranscriptModel,
  anchor: SelPoint,
  end: SelPoint,
): Map<number, Map<number, { start: number; end: number }>> {
  const a = compareSel(anchor, end) <= 0 ? anchor : end
  const b = compareSel(anchor, end) <= 0 ? end : anchor
  const map = new Map<number, Map<number, { start: number; end: number }>>()
  for (let e = a.entry; e <= b.entry; e++) {
    const lines = model.entries[e]
    const rowStart = e === a.entry ? a.row : 0
    const rowEnd = e === b.entry ? b.row : lines.length - 1
    const rows = new Map<number, { start: number; end: number }>()
    for (let r = rowStart; r <= rowEnd; r++) {
      const s = e === a.entry && r === a.row ? a.col : 0
      const en = e === b.entry && r === b.row ? b.col : lines[r].length
      if (s < en) rows.set(r, { start: s, end: en })
    }
    if (rows.size) map.set(e, rows)
  }
  return map
}

// Leading decorators (bullets / indent / diff signs) that are part of the TUI
// chrome, not the content — stripped so copied text is clean (the anchor row is
// usually already after the bullet, but fully-covered middle rows are not).
const DECORATOR_RE = /^(?:• |› |◇ |⚠ |✎ 编辑 |✎ 写入 |  └ |  − |  \+ |    |  )/

function stripDecorator(line: string): string {
  return line.replace(DECORATOR_RE, '')
}

/** Extract the selected plain text (joined by '\n'); blanks and chrome trimmed. */
export function buildSelectionText(model: TranscriptModel, anchor: SelPoint, end: SelPoint): string {
  const a = compareSel(anchor, end) <= 0 ? anchor : end
  const b = compareSel(anchor, end) <= 0 ? end : anchor
  const parts: string[] = []
  for (let e = a.entry; e <= b.entry; e++) {
    const lines = model.entries[e]
    const rowStart = e === a.entry ? a.row : 0
    const rowEnd = e === b.entry ? b.row : lines.length - 1
    for (let r = rowStart; r <= rowEnd; r++) {
      const line = lines[r]
      const s = e === a.entry && r === a.row ? a.col : 0
      const en = e === b.entry && r === b.row ? b.col : line.length
      parts.push(line.slice(s, en))
    }
  }
  return parts
    .map((l) => stripDecorator(l.trimEnd()))
    .filter((l) => l.trim() !== '')
    .join('\n')
}

/** Encode text as an OSC 52 clipboard write (base64); returns the escape. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`
}
