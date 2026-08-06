/**
 * Chat screen — a stable, viewport-aware terminal conversation.
 *
 * Ink's <Static> output is intentionally not used here: mixing permanent
 * transcript rows with a dynamic header/composer causes new transcript items to
 * be printed above the header. Keeping the whole screen dynamic gives us the
 * same visual hierarchy as modern coding-agent TUIs: welcome card, conversation,
 * activity, composer, and a persistent context status line.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { useChat } from '../hooks/useChat.js'
import { MobiusClient } from '../api.js'
import { renderMarkdownLines } from '../markdown.js'
import { viewsForEntry, dedupeUserEntries, toolLabel, isAssistantOutput, type EntryView } from '../lib/entry-view.js'
import type { ReadyState } from './PrepScreen.js'
import type { AnyEntry } from '../types.js'
import type { AimuxStatus } from '../aimux.js'
import { AimuxStatusLine, aimuxStatusText } from './AimuxStatus.js'
import { isEscapeKeypress } from './primitives.js'

interface ChatProps {
  client: MobiusClient
  ready: ReadyState
  webUserId: string
  resumeSessionId?: string | null
  onClear: () => void
  onResume: () => void
  onQuit: () => void
  aimuxStatus?: AimuxStatus
}

interface TerminalSize {
  columns: number
  rows: number
  isTty: boolean
}

import { createRequire } from 'node:module'
const VERSION = createRequire(import.meta.url)('../../package.json').version
const DEFAULT_COMPOSER_ROWS = 5
const STATUS_ROWS = 3

const SLASH_COMMANDS = [
  { cmd: '/clear', desc: '清空当前对话，开启新会话' },
  { cmd: '/resume', desc: '恢复一个历史会话' },
  { cmd: '/help', desc: '显示帮助' },
  { cmd: '/quit', desc: '退出 TUI' },
]

export function ChatScreen({ client, ready, webUserId, resumeSessionId, onClear, onResume, onQuit, aimuxStatus }: ChatProps) {
  const chat = useChat({ client, ready, resumeSessionId })
  const [showHelp, setShowHelp] = useState(false)
  const [scrollBack, setScrollBack] = useState(0)
  const [composerRows, setComposerRows] = useState(DEFAULT_COMPOSER_ROWS)
  const [modelLabel, setModelLabel] = useState<string | null>(null)
  const terminal = useTerminalSize()

  const runSlash = useCallback((raw: string) => {
    const [name] = raw.trim().split(/\s+/)
    switch (name) {
      case '/clear': onClear(); return true
      case '/resume': onResume(); return true
      case '/help': setShowHelp(s => !s); return true
      case '/quit': case '/exit': onQuit(); return true
      default: return false
    }
  }, [onClear, onResume, onQuit])

  const onSubmit = useCallback((text: string) => {
    const t = text.trim()
    if (!t) return
    if (t.startsWith('/')) {
      if (!runSlash(t)) setShowHelp(true)
      return
    }
    setShowHelp(false)
    setScrollBack(0)
    void chat.send(t)
  }, [chat, runSlash])

  // First query of a fresh session triggers the full backend bootstrap (lazy
  // session creation, worker spawn, context load) before any output streams.
  // Label that phase "第一个问题，正在初始化+全平台同步中，请稍候" instead of "Working"
  // so it reads as startup rather than a stuck agent. Once the first assistant
  // output is observed (or the session is a resumed one with prior history),
  // the indicator falls back to the normal Working label for every turn.
  const firstQueryInFlight = !resumeSessionId && !chat.entries.some(isAssistantOutput)

  // 用户输入去重 (对齐 web viewer/rounds.ts buildRounds): codex 同一提问的 3 形态
  // (type:user / response_item.message[user] / event_msg.user_message) 合并成 1 条,
  // 避免在累积视图里把同一条提问显示多次.
  const dedupedEntries = useMemo(() => dedupeUserEntries(chat.entries), [chat.entries])
  const viewportRows = terminal.isTty ? Math.max(9, terminal.rows - 1) : terminal.rows
  const activityRows = (chat.typing ? 2 : 0) + (chat.error ? 1 : 0)
  const helpRows = showHelp ? SLASH_COMMANDS.length + 3 : 0
  const transcriptRows = Math.max(1, viewportRows - composerRows - STATUS_ROWS - activityRows - helpRows - 3)
  const fitted = useMemo(
    () => fitTranscript(dedupedEntries, transcriptRows, terminal.columns, scrollBack),
    [dedupedEntries, transcriptRows, terminal.columns, scrollBack],
  )
  const showWelcome = dedupedEntries.length === 0 && chat.pendingUser === null && scrollBack === 0

  // Keep a history page pinned while new events stream in. At the latest page,
  // new output continues to auto-follow as usual.
  const prevLenRef = useRef(dedupedEntries.length)
  useEffect(() => {
    const previous = prevLenRef.current
    const current = dedupedEntries.length
    prevLenRef.current = current
    if (current > previous && scrollBack > 0) {
      setScrollBack(value => value + current - previous)
    } else if (scrollBack > current) {
      setScrollBack(current)
    }
  }, [dedupedEntries.length, scrollBack])

  // Show the model's friendly label (e.g. "GPT-5.6-Sol") in the header/status
  // instead of its opaque key (e.g. "codex:mobiusdefaultaabb").
  useEffect(() => {
    const key = ready.prefs.model
    if (!key) { setModelLabel(null); return }
    let cancelled = false
    client.modelOptions()
      .then(opts => { if (!cancelled) setModelLabel(opts.find(o => o.key === key)?.label ?? null) })
      .catch(() => { if (!cancelled) setModelLabel(null) })
    return () => { cancelled = true }
  }, [client, ready.prefs.model])
  const modelDisplay = modelLabel ?? ready.prefs.model ?? 'default'

  useInput((_input, key) => {
    const step = Math.max(1, fitted.entries.length)
    if (key.pageUp) setScrollBack(value => Math.min(dedupedEntries.length, value + step))
    else if (key.pageDown) setScrollBack(value => Math.max(0, value - step))
  })

  return (
    <Box
      flexDirection="column"
      width={terminal.isTty ? terminal.columns : undefined}
      height={terminal.isTty ? viewportRows : undefined}
      paddingX={1}
      overflowY="hidden"
    >
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflowY="hidden">
        {showWelcome
          ? <WelcomeCard ready={ready} columns={terminal.columns} resumed={Boolean(resumeSessionId)} modelDisplay={modelDisplay} />
          : <CompactHeader ready={ready} sessionId={chat.sessionId} columns={terminal.columns} />}

        <Box flexGrow={1} flexShrink={1} flexDirection="column" justifyContent={showWelcome ? 'flex-start' : 'flex-end'} overflowY="hidden">
          {fitted.hiddenOlder > 0 || scrollBack > 0
            ? <Text dimColor>  ↑ {fitted.hiddenOlder > 0 ? `还有 ${fitted.hiddenOlder} 条较早记录 · PageUp 向上翻页` : '已到最早记录 · PageDown 向下翻页'}</Text>
            : null}
          {fitted.entries.map((entry, index) => (
            <EntryAccum key={entry.__id ?? `entry-${fitted.startIndex + index}`} entry={entry} columns={terminal.columns} />
          ))}
          {chat.pendingUser !== null ? <UserLine text={chat.pendingUser} /> : null}
          {fitted.hiddenRecent > 0
            ? <Text dimColor>  ↓ PageDown 向下翻页 · 较新 {fitted.hiddenRecent} 条</Text>
            : null}
        </Box>

        {dedupedEntries.length === 0 && chat.pendingUser === null && !showHelp
          ? <Box marginTop={1}><Text dimColor>输入问题开始协作，或输入 <Text color="cyan">/</Text> 查看命令。</Text></Box>
          : null}

        {showHelp ? <HelpBlock commands={SLASH_COMMANDS} /> : null}
      </Box>

      <Box flexDirection="column" flexShrink={0}>
        {chat.typing ? <WorkingIndicator firstQuery={firstQueryInFlight} /> : null}
        {chat.error ? <Text color="red">⚠ {chat.error}</Text> : null}

        <Composer
          onSubmit={onSubmit}
          onStop={chat.stop}
          onQuit={onQuit}
          typing={chat.typing}
          commands={SLASH_COMMANDS}
          onHeightChange={setComposerRows}
        />
        <StatusArea
          ready={ready}
          sessionId={chat.sessionId}
          columns={terminal.columns}
          webUrl={buildWebUrl(client.server, webUserId, ready, chat.sessionId)}
          aimuxStatus={aimuxStatus}
          modelDisplay={modelDisplay}
        />
      </Box>
    </Box>
  )
}

function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout()
  const read = useCallback((): TerminalSize => ({
    columns: Math.max(20, stdout.columns ?? 80),
    rows: Math.max(10, stdout.rows ?? 24),
    isTty: Boolean(stdout.isTTY && stdout.columns && stdout.rows),
  }), [stdout])
  const [size, setSize] = useState<TerminalSize>(read)

  useEffect(() => {
    const onResize = () => setSize(read())
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout, read])

  return size
}

function WelcomeCard({ ready, columns, resumed, modelDisplay }: { ready: ReadyState; columns: number; resumed: boolean; modelDisplay: string }) {
  const cwd = compactPath(process.cwd())
  const width = Math.max(18, Math.min(68, columns - 4))
  const labelWidth = 11
  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="gray" borderDimColor width={width} paddingX={1} flexDirection="column">
        <Text>
          <Text dimColor>{'>_ '}</Text>
          <Text bold>Mobius</Text>
          <Text dimColor> (v{VERSION})</Text>
        </Text>
        <Text> </Text>
        <MetaRow label="model:" value={modelDisplay} hint="/help 查看命令" labelWidth={labelWidth} />
        <MetaRow label="project:" value={ready.project.name} labelWidth={labelWidth} />
        <MetaRow label="task:" value={ready.issue.title} labelWidth={labelWidth} />
        <MetaRow label="directory:" value={cwd} labelWidth={labelWidth} />
      </Box>
      <Box marginTop={1} paddingLeft={1}>
        <Text><Text bold>Tip:</Text> {resumed ? '已恢复历史会话；上下文会继续保留。' : '偏好按任务保存；下次进入会自动恢复模型、语言、Skill 与 Memory。'}</Text>
      </Box>
    </Box>
  )
}

function MetaRow({ label, value, hint, labelWidth }: { label: string; value: string; hint?: string; labelWidth: number }) {
  return (
    <Text>
      <Text dimColor>{label.padEnd(labelWidth)}</Text>
      <Text bold>{value}</Text>
      {hint ? <Text dimColor>  {hint}</Text> : null}
    </Text>
  )
}

function CompactHeader({ ready, sessionId, columns }: { ready: ReadyState; sessionId: string | null; columns: number }) {
  const context = `${ready.project.name} › ${ready.issue.title}${sessionId ? ` · ${sessionId.slice(0, 8)}` : ''}`
  return (
    <Box justifyContent="space-between">
      <Text bold><Text dimColor>{'>_ '}</Text>Mobius</Text>
      <Text dimColor>{truncateDisplay(context, columns - 14)}</Text>
    </Box>
  )
}

function EntryAccum({ entry, columns }: { entry: AnyEntry; columns: number }) {
  const views = viewsForEntry(entry)
  return (
    <Box flexDirection="column">
      {views.map((view, index) => <ViewLine key={index} view={view} columns={columns} />)}
    </Box>
  )
}

function ViewLine({ view, columns }: { view: EntryView; columns: number }) {
  const width = Math.max(8, columns - 4)
  switch (view.kind) {
    case 'skip':
      return null
    case 'user':
      return <UserLine text={view.text} />
    case 'assistant': {
      const lines = renderMarkdownLines(view.text)
      return (
        <Box marginTop={1} flexDirection="column">
          {lines.map((line, index) => (
            <Text key={index} wrap={line.code ? 'truncate-end' : 'wrap'}>
              {index === 0 ? '• ' : '  '}{line.text || ' '}
            </Text>
          ))}
        </Box>
      )
    }
    case 'tool_call': {
      // compact (≤2 行): 命令行 + 可选结果行 (已与 tool_result 合并).
      const head = clampLines(`${toolLabel(view.toolName)} ${view.summary}`.trim(), width - 2, 1)[0]
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan">• {head}</Text>
          {view.result ? (
            <Text dimColor color={view.result.isError ? 'red' : undefined}>
              {'  └ '}{clampLines(view.result.text, width - 4, 1)[0] || '(无输出)'}
            </Text>
          ) : null}
        </Box>
      )
    }
    case 'tool_result': {
      // codex 式 head+ellipsis+tail (output_max_lines=5): tool 结果保留头尾,
      // 中间省略行数; DIM 样式 + └/缩进前缀 (对齐 codex exec_cell/render.rs).
      const lines = headTailLines(view.text, width - 4, 5)
      return (
        <Box flexDirection="column">
          {lines.map((l, i) => (
            <Text key={i} dimColor color={view.isError ? 'red' : undefined}>{i === 0 ? '  └ ' : '    '}{l}</Text>
          ))}
        </Box>
      )
    }
    case 'code_edit':
      return <CodeEditView view={view} />
    case 'write_file':
      return <WriteFileView view={view} />
    case 'reasoning': {
      const lines = clampLines(view.text, width - 4, 2)
      return (
        <Box marginTop={1} flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i} dimColor color="magenta">{i === 0 ? '  ◇ ' : '    '}{line}</Text>
          ))}
        </Box>
      )
    }
    case 'system':
      return <Text dimColor color="yellow">  {clampLines(view.text, width - 2, 2)[0]}</Text>
    case 'error':
      return (
        <Box marginTop={1} flexDirection="column">
          {view.text.split('\n').map((line, i) => (
            <Text key={i} color="red">{i === 0 ? '⚠ ' : '  '}{line}</Text>
          ))}
        </Box>
      )
    default:
      return null
  }
}

// 代码修改 (Edit/StrReplace/apply_patch) — full: 完整展示 old(−)/new(+) 改动原文.
function CodeEditView({ view }: { view: { filePath: string; oldString: string; newString: string } }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="magenta">✎ 编辑 {view.filePath || '(未指定文件)'}</Text>
      {view.oldString ? view.oldString.split('\n').map((line, i) => (
        <Text key={`o${i}`} color="red">{'  − '}{line}</Text>
      )) : null}
      {view.newString ? view.newString.split('\n').map((line, i) => (
        <Text key={`n${i}`} color="green">{'  + '}{line}</Text>
      )) : null}
    </Box>
  )
}

// 文件写入 (Write/create_file) — full: 完整展示写入内容原文.
function WriteFileView({ view }: { view: { filePath: string; content: string } }) {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text color="magenta">✎ 写入 {view.filePath || '(未指定文件)'}</Text>
      {view.content.split('\n').map((line, i) => (
        <Text key={i} color="green">{'  + '}{line}</Text>
      ))}
    </Box>
  )
}

// 把文本按宽度硬切成最多 maxLines 行 (超出则在末行加 …), 用于 compact 类的 ≤2 行硬约束.
function clampLines(text: string, width: number, maxLines: number): string[] {
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

// codex 式 head + ellipsis + tail 截断 (参考 codex-rs/tui/src/exec_cell/render.rs
// 的 truncate_lines_middle): 保留输出头尾, 中间省略并报告省略行数. 长输出既能看
// 到结论 (成功/失败常在尾), 又不刷屏. maxLines 含省略行 (如 5 = 头2 + 省1 + 尾2).
function headTailLines(text: string, width: number, maxLines: number): string[] {
  if (!text) return ['']
  const paras = text.replace(/\r\n/g, '\n').split('\n')
  const wrapped: string[] = []
  for (const para of paras) {
    if (para === '') { wrapped.push(''); continue }
    for (let i = 0; i < para.length; i += width) wrapped.push(para.slice(i, i + width))
  }
  if (wrapped.length <= maxLines) return wrapped.slice(0, maxLines)
  const budget = maxLines - 1 // 留 1 行给省略标记
  const head = Math.max(1, Math.ceil(budget / 2))
  const tail = Math.max(1, budget - head)
  const omitted = wrapped.length - head - tail
  if (omitted <= 0) return wrapped.slice(0, maxLines)
  return [...wrapped.slice(0, head), `… +${omitted} 行`, ...wrapped.slice(wrapped.length - tail)]
}

function UserLine({ text }: { text: string }) {
  const lines = text.split('\n')
  if (lines[0] !== undefined) lines[0] = `› ${lines[0]}`
  for (let i = 1; i < lines.length; i++) lines[i] = `  ${lines[i]}`
  return <Box marginTop={1}><Text bold>{lines.join('\n')}</Text></Box>
}

function WorkingIndicator({ firstQuery }: { firstQuery: boolean }) {
  const startedAt = useRef(Date.now())
  const [animationFrame, setAnimationFrame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setAnimationFrame(frame => frame + 1), 80)
    return () => clearInterval(id)
  }, [])
  const secs = Math.floor((Date.now() - startedAt.current) / 1000)
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`
  const label = firstQuery
    ? `• 第一个问题，正在初始化+全平台同步中，请稍候 (${elapsed})`
    : `• Working (${elapsed} · esc to interrupt)`
  return (
    <Box marginTop={1}>
      <Text>{shimmerText(label, animationFrame)}</Text>
    </Box>
  )
}

// A soft highlight travels through the status text, matching the moving
// brightness cue used by Codex while keeping the elapsed time readable.
const SHIMMER_SHADES = ['#ffffff', '#d0d0d0', '#ababab', '#8c8c8c', '#747474', '#666666']

export function shimmerText(label: string, frame: number): React.ReactNode[] {
  const chars = Array.from(label)
  const head = chars.length > 0 ? frame % chars.length : 0
  return chars.map((char, index) => {
    const directDistance = Math.abs(index - head)
    const distance = Math.min(directDistance, chars.length - directDistance)
    const shade = SHIMMER_SHADES[Math.min(distance, SHIMMER_SHADES.length - 1)]
    return <Text key={`${index}-${char}`} color={shade}>{char}</Text>
  })
}

function HelpBlock({ commands }: { commands: { cmd: string; desc: string }[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" borderDimColor paddingX={1} marginTop={1}>
      {commands.map(command => (
        <Text key={command.cmd}>
          <Text color="cyan" bold>{command.cmd.padEnd(10)}</Text>
          <Text>{command.desc}</Text>
        </Text>
      ))}
    </Box>
  )
}

interface ComposerProps {
  onSubmit: (text: string) => void
  onStop: () => void
  onQuit: () => void
  typing: boolean
  commands: { cmd: string; desc: string }[]
  onHeightChange?: (rows: number) => void
}

export function Composer({ onSubmit, onStop, onQuit, typing, commands, onHeightChange }: ComposerProps) {
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [popupIdx, setPopupIdx] = useState(0)
  const [popupDismissed, setPopupDismissed] = useState(false)
  const historyRef = useRef<string[]>([])
  const [histIdx, setHistIdx] = useState<number | null>(null)
  const valueRef = useRef(value)
  const cursorRef = useRef(cursor)
  const pasteRef = useRef<ComposerPasteState>({
    bracketed: false,
    bracketedBuffer: '',
    burstActive: false,
    consecutivePlain: 0,
    lastChunkAt: 0,
    lastChunkLength: 0,
    timer: null,
  })
  const { stdout } = useStdout()

  const filtered = useMemo(() => {
    const match = /^(\w*)$/.exec(value.slice(1))
    if (!value.startsWith('/') || match === null) return []
    const prefix = value.slice(1)
    return commands.filter(command => command.cmd.slice(1).startsWith(prefix))
  }, [value, commands])

  useEffect(() => { setPopupIdx(0); setPopupDismissed(false) }, [value])
  const popupOpen = !popupDismissed && value.startsWith('/') && filtered.length > 0 && value.trim() !== filtered[popupIdx]?.cmd

  function edit(next: string, nextCursor: number) {
    valueRef.current = next
    cursorRef.current = nextCursor
    setValue(next)
    setCursor(nextCursor)
  }

  function insertText(text: string) {
    if (!text) return
    const current = valueRef.current
    const at = clampCursor(current, cursorRef.current)
    const normalized = normalizeComposerPaste(text)
    edit(current.slice(0, at) + normalized + current.slice(at), at + normalized.length)
  }

  function schedulePasteBurstReset() {
    const state = pasteRef.current
    if (state.timer) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.burstActive = false
      state.consecutivePlain = 0
      state.lastChunkLength = 0
      state.timer = null
    }, pasteBurstWindowMs())
  }

  function resetPasteBurst() {
    const state = pasteRef.current
    if (state.timer) clearTimeout(state.timer)
    state.bracketed = false
    state.bracketedBuffer = ''
    state.burstActive = false
    state.consecutivePlain = 0
    state.lastChunkAt = 0
    state.lastChunkLength = 0
    state.timer = null
  }

  function handleBracketedPasteInput(raw: string): boolean {
    const state = pasteRef.current
    const start = findPasteMarker(raw, '200')
    const end = findPasteMarker(raw, '201')

    if (!state.bracketed && start >= 0) {
      const markerLength = pasteMarkerLength(raw, start, '200')
      const payloadStart = start + markerLength
      const endAfterStart = findPasteMarker(raw, '201', payloadStart)
      if (endAfterStart >= 0) {
        const endLength = pasteMarkerLength(raw, endAfterStart, '201')
        insertText(raw.slice(payloadStart, endAfterStart) + raw.slice(endAfterStart + endLength))
        resetPasteBurst()
      } else {
        state.bracketed = true
        state.bracketedBuffer = raw.slice(payloadStart)
      }
      return true
    }

    if (!state.bracketed) return false
    if (end >= 0) {
      const endLength = pasteMarkerLength(raw, end, '201')
      state.bracketedBuffer += raw.slice(0, end)
      state.bracketedBuffer += raw.slice(end + endLength)
      insertText(state.bracketedBuffer)
      resetPasteBurst()
    } else {
      state.bracketedBuffer += raw
    }
    return true
  }

  function moveVertical(direction: -1 | 1) {
    const current = valueRef.current
    const at = clampCursor(current, cursorRef.current)
    const lineStart = current.lastIndexOf('\n', Math.max(0, at - 1)) + 1
    const column = at - lineStart
    const lineEnd = current.indexOf('\n', at)
    const currentEnd = lineEnd < 0 ? current.length : lineEnd
    const targetStart = direction < 0
      ? current.lastIndexOf('\n', Math.max(0, lineStart - 2)) + 1
      : (currentEnd < current.length ? currentEnd + 1 : current.length)
    if (direction < 0 && lineStart === 0) return
    if (direction > 0 && currentEnd === current.length) return
    const targetEndRel = current.indexOf('\n', targetStart)
    const targetEnd = targetEndRel < 0 ? current.length : targetEndRel
    edit(current, targetStart + Math.min(column, targetEnd - targetStart))
  }

  function moveCursor(next: number) {
    cursorRef.current = next
    setCursor(next)
  }

  useEffect(() => {
    if (!stdout.isTTY) return
    // Match Codex/crossterm: request explicit paste events so embedded Enters
    // stay inside the textarea. The burst detector below remains the fallback
    // for terminals and remote chains that ignore bracketed-paste mode.
    stdout.write('\x1b[?2004h')
    return () => { stdout.write('\x1b[?2004l') }
  }, [stdout])

  useEffect(() => () => resetPasteBurst(), [])

  useInput((input, key) => {
    const now = Date.now()
    const escape = isEscapeKeypress(input, key)
    if (typing && escape) { void onStop(); return }

    if (pasteRef.current.bracketed && key.return) {
      pasteRef.current.bracketedBuffer += '\n'
      return
    }

    // Ink 5 incorrectly marks a plain carriage-return as Shift because "\r" is
    // unchanged by toUpperCase(). Detect enhanced-keyboard Shift+Enter from its
    // raw sequence instead of trusting key.shift on an ordinary Enter event.
    if (isEnhancedNewlineInput(input)) { insertText('\n'); return }

    // Terminals that support bracketed paste wrap the payload in ESC[200~ / ESC[201~.
    // Ink's parser strips a leading ESC, so accept both the raw and stripped marker forms.
    if (handleBracketedPasteInput(input)) return

    const current = valueRef.current
    const at = clampCursor(current, cursorRef.current)

    // A few terminals (notably ConPTY and some SSH/tmux combinations) do not expose
    // bracketed paste. They deliver a paste as fast text chunks separated by Enter events.
    // Track that short burst so those Enters become newlines instead of submitting each line.
    if (!key.return && input && !key.ctrl && !key.meta && /[\r\n]/.test(input)) {
      insertText(input)
      pasteRef.current.burstActive = false
      pasteRef.current.lastChunkAt = now
      pasteRef.current.lastChunkLength = 0
      return
    }

    if (popupOpen) {
      if (key.upArrow) { setPopupIdx(i => (i <= 0 ? filtered.length - 1 : i - 1)); return }
      if (key.downArrow) { setPopupIdx(i => (i + 1) % filtered.length); return }
      if (key.return || key.tab) {
        const pick = filtered[popupIdx >= 0 ? popupIdx : 0]
        if (pick) { edit(`${pick.cmd} `, pick.cmd.length + 1); setPopupDismissed(true); return }
      }
      if (escape) { setPopupDismissed(true); return }
    }

    if (key.return) {
      const state = pasteRef.current
      const inPasteBurst = state.burstActive || (
        state.lastChunkLength > 1 && now - state.lastChunkAt <= pasteBurstWindowMs()
      )
      if (inPasteBurst && !key.ctrl && !key.meta) {
        insertText('\n')
        state.burstActive = true
        state.lastChunkAt = now
        state.lastChunkLength = 0
        schedulePasteBurstReset()
        return
      }
      const submitted = valueRef.current
      if (submitted.trim()) {
        historyRef.current.push(submitted)
        onSubmit(submitted)
        edit('', 0)
        setHistIdx(null)
      }
      return
    }
    if (key.ctrl && input === 'c') { typing ? void onStop() : onQuit(); return }
    // Ink reports the terminal Backspace key (\x7f) as `key.delete`; handle both
    // as a backward delete so Backspace works at the end of the input.
    if (key.backspace || key.delete || (key.ctrl && (input === 'h' || input === 'w'))) {
      if (at > 0) {
        if (key.ctrl && input === 'w') {
          const before = current.slice(0, at)
          const match = before.match(/\S+\s*$/)
          const cut = match ? match[0].length : 0
          edit(current.slice(0, at - cut) + current.slice(at), at - cut)
        } else {
          const previous = previousCursorBoundary(current, at)
          edit(current.slice(0, previous) + current.slice(at), previous)
        }
      }
      return
    }
    if (key.leftArrow) { moveCursor(previousCursorBoundary(current, at)); return }
    if (key.rightArrow) { moveCursor(nextCursorBoundary(current, at)); return }

    const onFirstLine = current.slice(0, at).indexOf('\n') === -1
    if (key.upArrow && onFirstLine) {
      const history = historyRef.current
      if (history.length) {
        const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1)
        setHistIdx(next)
        edit(history[next], history[next].length)
      }
      return
    }
    if (key.upArrow) { moveVertical(-1); return }
    if (key.downArrow && histIdx !== null) {
      const history = historyRef.current
      const next = histIdx + 1
      if (next >= history.length) { setHistIdx(null); edit('', 0) }
      else { setHistIdx(next); edit(history[next], history[next].length) }
      return
    }
    if (key.downArrow) { moveVertical(1); return }
    if (key.ctrl && input === 'a') { moveCursor(0); return }
    if (key.ctrl && input === 'e') { moveCursor(current.length); return }
    if (key.ctrl && input === 'u') { edit('', 0); return }
    if (key.ctrl && input === 'k') { edit(current.slice(0, at), at); return }
    if (key.ctrl && input === 'j') { insertText('\n'); return }
    if (key.ctrl || key.meta || escape || !input) return

    const chunkAt = pasteRef.current
    const continuesBurst = chunkAt.lastChunkAt > 0 && now - chunkAt.lastChunkAt <= pasteBurstWindowMs()
    chunkAt.consecutivePlain = continuesBurst ? chunkAt.consecutivePlain + 1 : 1
    if (input.length > 1 || chunkAt.consecutivePlain >= 3) {
      chunkAt.burstActive = true
      schedulePasteBurstReset()
    }
    insertText(input)
    chunkAt.lastChunkAt = now
    chunkAt.lastChunkLength = input.length
  })

  const composerWidth = Math.max(12, (stdout.columns ?? 80) - 9)
  const wrapped = wrapComposerLines(value, composerWidth)
  const visualCursor = findComposerCursorLine(wrapped, clampCursor(value, cursor))
  const maxRows = Math.max(3, Math.min(10, Math.floor((stdout.rows ?? 24) * 0.42)))
  const firstVisible = Math.max(0, Math.min(visualCursor - maxRows + 1, visualCursor))
  const visible = wrapped.slice(firstVisible, firstVisible + maxRows)
  const renderedRows = 4 + visible.length + (popupOpen ? filtered.length + 1 : 0)

  useEffect(() => {
    onHeightChange?.(renderedRows)
  }, [onHeightChange, renderedRows])

  return (
    <Box flexDirection="column" marginTop={1}>
      {popupOpen ? (
        <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
          {filtered.map((command, index) => (
            <Text
              key={command.cmd}
              backgroundColor={index === popupIdx ? 'white' : undefined}
              color={index === popupIdx ? 'black' : undefined}
            >
              {index === popupIdx ? '› ' : '  '}{command.cmd.padEnd(10)}<Text dimColor> {command.desc}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={typing ? 'yellow' : 'gray'}
        borderDimColor={!typing}
        paddingX={1}
      >
        <Box flexDirection="column" height={Math.min(maxRows, wrapped.length)} overflow="hidden">
          {visible.map((line, index) => {
            const realIndex = firstVisible + index
            const isCursorLine = realIndex === visualCursor
            const c = isCursorLine ? clampCursor(value, cursor) - line.start : -1
            const before = isCursorLine ? line.text.slice(0, Math.max(0, c)) : line.text
            const atCursor = isCursorLine ? line.text.slice(Math.max(0, c), Math.max(0, c) + 1) : ''
            const after = isCursorLine ? line.text.slice(Math.max(0, c) + 1) : ''
            return (
              <Text key={`${line.start}-${realIndex}`}>
                {index === 0 ? <Text bold>{firstVisible > 0 ? '… ' : '› '}</Text> : <Text>{'  '}</Text>}
                {isCursorLine
                  ? <>{before}<Text backgroundColor="white" color="black">{atCursor || ' '}</Text>{after}</>
                  : line.text}
                {value === '' && index === 0 ? <Text dimColor> 输入问题或 / 命令</Text> : null}
              </Text>
            )
          })}
        </Box>
        <Box justifyContent="space-between">
          <Text dimColor>{(stdout.columns ?? 80) >= 58 ? 'Enter 发送 · Shift+Enter / Ctrl+J 换行' : 'Enter 发送 · Ctrl+J 换行'}</Text>
          <Text dimColor>{wrapped.length > maxRows ? `${visualCursor + 1}/${wrapped.length} 行` : `${wrapped.length} 行`}</Text>
        </Box>
      </Box>
    </Box>
  )
}

interface ComposerPasteState {
  bracketed: boolean
  bracketedBuffer: string
  burstActive: boolean
  consecutivePlain: number
  lastChunkAt: number
  lastChunkLength: number
  timer: ReturnType<typeof setTimeout> | null
}

function pasteBurstWindowMs(): number {
  return process.platform === 'win32' ? 60 : 20
}

function normalizeComposerPaste(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function isEnhancedNewlineInput(input: string): boolean {
  return /^\[(?:13|27);2(?:u|~)$/.test(input) || input === '\x1b\r'
}

function findPasteMarker(input: string, code: '200' | '201', from = 0): number {
  const raw = `\x1b[${code}~`
  const stripped = `[${code}~`
  const rawAt = input.indexOf(raw, from)
  const strippedAt = input.indexOf(stripped, from)
  if (rawAt < 0) return strippedAt
  if (strippedAt < 0) return rawAt
  return Math.min(rawAt, strippedAt)
}

function pasteMarkerLength(input: string, at: number, code: '200' | '201'): number {
  return input.startsWith(`\x1b[${code}~`, at) ? 6 : 5
}

function clampCursor(text: string, cursor: number): number {
  let at = Math.max(0, Math.min(text.length, cursor))
  while (at > 0 && at < text.length && /[\uDC00-\uDFFF]/.test(text[at])) at--
  return at
}

function previousCursorBoundary(text: string, cursor: number): number {
  const at = clampCursor(text, cursor)
  if (at <= 0) return 0
  const code = text.charCodeAt(at - 1)
  return at - (code >= 0xDC00 && code <= 0xDFFF ? 2 : 1)
}

function nextCursorBoundary(text: string, cursor: number): number {
  const at = clampCursor(text, cursor)
  if (at >= text.length) return text.length
  const code = text.charCodeAt(at)
  return at + (code >= 0xD800 && code <= 0xDBFF ? 2 : 1)
}

interface ComposerLine { text: string; start: number; end: number }

function wrapComposerLines(text: string, width: number): ComposerLine[] {
  if (!text) return [{ text: '', start: 0, end: 0 }]
  const result: ComposerLine[] = []
  let lineStart = 0
  let lineText = ''
  let lineWidth = 0
  for (let i = 0; i < text.length;) {
    const ch = text[i]
    if (ch === '\n') {
      result.push({ text: lineText, start: lineStart, end: i })
      lineText = ''
      lineWidth = 0
      lineStart = i + 1
      i++
      continue
    }
    const next = nextCursorBoundary(text, i)
    const piece = text.slice(i, next)
    const pieceWidth = Math.max(1, displayWidth(piece))
    if (lineText && lineWidth + pieceWidth > width) {
      result.push({ text: lineText, start: lineStart, end: i })
      lineText = ''
      lineWidth = 0
      lineStart = i
    }
    lineText += piece
    lineWidth += pieceWidth
    i = next
  }
  result.push({ text: lineText, start: lineStart, end: text.length })
  return result
}

function findComposerCursorLine(lines: ComposerLine[], cursor: number): number {
  const at = Math.max(0, cursor)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (at < line.end || (at === line.end && (i === lines.length - 1 || lines[i + 1].start > at))) return i
  }
  return Math.max(0, lines.length - 1)
}

function StatusArea({ ready, sessionId, columns, webUrl, aimuxStatus, modelDisplay }: {
  ready: ReadyState
  sessionId: string | null
  columns: number
  webUrl: string
  aimuxStatus?: AimuxStatus
  modelDisplay: string
}) {
  const model = modelDisplay
  const language = ready.prefs.language === 'en' ? 'English' : '中文'
  const cwd = compactPath(process.cwd())
  const leftRaw = columns >= 100
    ? `${model} · ${language} · ${cwd}`
    : `${model} · ${ready.project.name}`
  const rightRaw = columns >= 72
    ? `${ready.project.name} › ${ready.issue.title}${sessionId ? ` · ${sessionId.slice(0, 8)}` : ''}`
    : ''
  const left = truncateDisplay(leftRaw, rightRaw ? Math.floor(columns * 0.45) : columns - 2)
  const right = rightRaw ? truncateDisplay(rightRaw, columns - left.length - 5) : ''
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text dimColor>{left}</Text>
        {right ? <Text dimColor>{right}</Text> : null}
      </Box>
      {/* Merged connectivity row: AIMUX status sits left, the clickable web URL
          sits right and truncates to the remaining width (its OSC 8 link target
          stays full so it stays clickable). This collapses the former separate
          "web · url" and AIMUX rows into one, dropping the status area from
          three rows to two. */}
      <ConnectivityRow aimuxStatus={aimuxStatus} webUrl={webUrl} columns={columns} />
    </Box>
  )
}

// AIMUX status (left) ⟷ clickable web URL (right) on a single row.
function ConnectivityRow({ aimuxStatus, webUrl, columns }: { aimuxStatus?: AimuxStatus; webUrl: string; columns: number }) {
  const aimuxText = aimuxStatus ? aimuxStatusText(aimuxStatus, true) : ''
  // icon (1) + leading space (1) + status text width
  const aimuxWidth = aimuxText ? 2 + displayWidth(aimuxText) : 0
  // No AIMUX status → web URL keeps the whole row (unchanged from before).
  // Otherwise leave room for the AIMUX block + 'web · ' prefix + a safety gap
  // (the gap also absorbs ambiguous-width chars like box-drawing in the detail).
  const urlBudget = aimuxWidth
    ? Math.max(8, columns - 2 - aimuxWidth - WEB_PREFIX.length - 6)
    : undefined
  const web = (
    <Text>
      <Text dimColor>{WEB_PREFIX}</Text>
      <Text color="cyan" underline>{clickableUrl(webUrl, urlBudget)}</Text>
    </Text>
  )
  if (!aimuxStatus) return <Box>{web}</Box>
  return (
    <Box justifyContent="space-between">
      <AimuxStatusLine status={aimuxStatus} compact />
      {web}
    </Box>
  )
}

const WEB_PREFIX = 'web · '

function compactPath(path: string): string {
  const home = process.env.HOME
  if (!home) return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}

function truncateDisplay(value: string, maxLength: number): string {
  const limit = Math.max(1, Math.floor(maxLength))
  if (value.length <= limit) return value
  return limit <= 1 ? '…' : `${value.slice(0, limit - 1)}…`
}

function buildWebUrl(server: string, webUserId: string, ready: ReadyState, sessionId: string | null): string {
  const root = server.replace(/\/+$/, '')
  const user = webUserId || ready.project.created_by || ready.issue.created_by || 'current'
  const base = `${root}/u/${encodeURIComponent(user)}/p/${encodeURIComponent(ready.project.id)}/i/${encodeURIComponent(ready.issue.id)}`
  return sessionId ? `${base}?session=${encodeURIComponent(sessionId)}` : base
}

/** OSC 8 hyperlinks remain readable as plain URLs in terminals without support.
 *  When maxLen is given, only the *visible* text is truncated (the OSC 8 link
 *  target keeps the full URL, so it stays clickable on narrow terminals). */
function clickableUrl(url: string, maxLen?: number): string {
  const display = maxLen != null ? truncateDisplay(url, maxLen) : url
  if (process.env.MOBIUS_TUI_DISABLE_LINKS === '1') return display
  return `\u001B]8;;${url}\u0007${display}\u001B]8;;\u0007`
}

// Visible-column width (CJK / emoji / fullwidth count as 2; combining marks as
// 0), used to size the AIMUX status block so the web URL truncates to exactly
// the remaining width without overflowing the row.
function displayWidth(str: string): number {
  let w = 0
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x0300 && code <= 0x036F) continue // combining diacriticals: 0 cols
    w += isWideCodepoint(code) ? 2 : 1
  }
  return w
}

function isWideCodepoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115F) || // Hangul Jamo
    (code >= 0x2E80 && code <= 0x303E) || // CJK radicals / punctuation
    (code >= 0x3041 && code <= 0x33FF) || // Hiragana / Katakana / CJK compat
    (code >= 0x3400 && code <= 0x4DBF) || // CJK Unified Extension A
    (code >= 0x4E00 && code <= 0x9FFF) || // CJK Unified Ideographs (心跳正常 …)
    (code >= 0xA000 && code <= 0xA4CF) || // Yi
    (code >= 0xAC00 && code <= 0xD7A3) || // Hangul syllables
    (code >= 0xF900 && code <= 0xFAFF) || // CJK compatibility ideographs
    (code >= 0xFE30 && code <= 0xFE4F) || // CJK compatibility forms
    (code >= 0xFF00 && code <= 0xFF60) || // Fullwidth ASCII
    (code >= 0xFFE0 && code <= 0xFFE6) || // Fullwidth signs
    (code >= 0x1F300 && code <= 0x1FAFF)  // Emoji / symbols
  )
}

function wrappedRows(text: string, width: number): number {
  const safeWidth = Math.max(1, width)
  return text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(displayWidth(line) / safeWidth)), 0)
}

function entryRows(entry: AnyEntry, columns: number): number {
  const width = Math.max(8, columns - 4)
  return Math.max(1, viewsForEntry(entry).reduce((sum, view) => {
    switch (view.kind) {
      case 'skip': return sum
      case 'user': return sum + 1 + wrappedRows(view.text, width - 2)
      case 'assistant': {
        const rows = renderMarkdownLines(view.text).reduce((total, line) => {
          return total + (line.code ? 1 : wrappedRows(line.text || ' ', width - 2))
        }, 0)
        return sum + 1 + rows
      }
      case 'tool_call': return sum + 2 + (view.result ? 1 : 0)
      case 'tool_result': return sum + headTailLines(view.text, width - 4, 5).length
      case 'code_edit':
        return sum + 2 + wrappedRows(view.filePath || '(未指定文件)', width - 4)
          + wrappedRows(view.oldString, width - 4) + wrappedRows(view.newString, width - 4)
      case 'write_file':
        return sum + 2 + wrappedRows(view.filePath || '(未指定文件)', width - 4)
          + wrappedRows(view.content, width - 4)
      case 'reasoning': return sum + 1 + clampLines(view.text, width - 4, 2).length
      case 'system': return sum + 1
      case 'error': return sum + 1 + wrappedRows(view.text, width - 2)
      default: return sum
    }
  }, 0))
}

function fitTranscript(entries: AnyEntry[], rowBudget: number, columns: number, scrollBack = 0): {
  entries: AnyEntry[]
  hiddenOlder: number
  hiddenRecent: number
  startIndex: number
} {
  const tail = Math.max(0, entries.length - scrollBack)
  const available = tail === 0 ? [] : entries.slice(0, tail)
  let rows = 0
  let first = available.length
  for (let index = available.length - 1; index >= 0; index--) {
    const nextRows = entryRows(available[index], columns)
    if (first < available.length && rows + nextRows > rowBudget) break
    rows += nextRows
    first = index
  }
  return {
    entries: available.slice(first),
    hiddenOlder: first,
    hiddenRecent: entries.length - tail,
    startIndex: first,
  }
}
