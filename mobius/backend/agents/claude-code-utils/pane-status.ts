/**
 * claude-code-utils/pane-status.ts — Read the claude TUI's state off a pane
 * capture or a transcript entry.
 *
 * Pure functions only: no tmux call, no file read, no cache. The callers that
 * own those (tmux-window.ts, jsonl-tail.ts) hand the text in, which is what
 * makes every rule here unit-testable against a frozen screen.
 */
import {
  ANSI_ESCAPE_RE,
  CLAUDE_DANGER_OPERATION_RE,
  CLAUDE_RETRYING_LINE_RE,
  CLAUDE_STATUS_LINE_RE,
} from './constants'

/*
 * Whether a jsonl user entry is the completion receipt of a /compact, the
 * "<local-command-stdout>Compacted ...</local-command-stdout>" record.
 * Claude Code encodes the whole compact bookkeeping as synthetic
 * type:user records, so without this check a finished compact looks like
 * a fresh user turn and an idle TUI stays "working" forever; this receipt
 * is what proves the compact is over, and isWorking / containDequeueEvent
 * both rely on that reading.
 * Deliberately narrow: only this receipt matches, so a compact still in
 * flight keeps reading as working until its acknowledgement is written.
 */
export function isCompactCompletionUserEvent(entry: any) {
  if (!entry || entry.type !== 'user') return false
  // content可能是字符串或文本块数组，先统一取纯文本
  // content is a string or text blocks, reduce it to plain text first
  const content = entry.message?.content
  const text = Array.isArray(content)
    ? content
      .filter((block) => block && typeof block === 'object' && block.type === 'text')
      .map((block) => block.text || '')
      .join('\n')
    : content
  // 先剥掉ANSI转义再匹配，暗色码会夹在标签和单词之间
  // Strip ANSI before matching, the dim code sits between tag and word
  return typeof text === 'string'
    && /<local-command-stdout>\s*Compacted\b/i.test(String(text).replace(ANSI_ESCAPE_RE, ''))
}

/*
 * Pick claude's current status line out of a captured pane, or "" when
 * there is none. Scan from the bottom: the TUI renders only the newest
 * status, so the first match is the live one and the older scrollback
 * lines that also match are ignored.
 * Either shape counts, the elapsed-time status group or the API-retry line
 * (see the two regexes above). The whole line is returned on purpose, so
 * the UI keeps the spinner, the task description and the token counters
 * that surround the matched group.
 */
export function findClaudeRealTimeInfo(paneText: string) {
  const lines = String(paneText || '').split('\n')
  // 自下往上扫，最近的一行才是当前状态
  // Scan bottom-up, the nearest line is the current state
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line && (CLAUDE_STATUS_LINE_RE.test(line) || CLAUDE_RETRYING_LINE_RE.test(line))) {
      return line.trim()
    }
  }
  return ''
}

/*
 * Whether the claude TUI is stuck on the dangerous-operation permission
 * box, and which command it warns about: { pending, warning }, warning
 * being the full "Dangerous <kind> operation on <reason>: <target>" line,
 * or null.
 *
 * All three traits must be on screen at once (the danger line, "Do you
 * want to proceed?" and "Esc to cancel"), so a stale danger sentence left
 * in the scrollback, or printed by ordinary output, cannot fake a dialog.
 */
export function detectDangerPermission(text: string): { pending: boolean; warning: string | null } {
  if (!text) return { pending: false, warning: null }
  const m = text.match(CLAUDE_DANGER_OPERATION_RE)
  // 没有危险命令行就不是这个框
  // No danger line means this is not that dialog
  if (!m) return { pending: false, warning: null }
  // 三个特征必须同时在屏，缺一个就不认
  // All three traits must be on screen at once, one missing means no dialog
  if (!/Do you want to proceed\?/.test(text) || !/Esc to cancel/.test(text)) {
    return { pending: false, warning: null }
  }
  // 返回整行警告，自愈提示词要原样引用它
  // Return the whole warning line, the heal quotes it back verbatim
  return { pending: true, warning: m[0].trim() }
}
