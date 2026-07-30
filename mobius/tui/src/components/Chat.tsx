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
import { viewsForEntry, toolLabel, type EntryView } from '../lib/entry-view.js'
import type { ReadyState } from './PrepScreen.js'
import type { AnyEntry } from '../types.js'
import type { AimuxStatus } from '../aimux.js'
import { AimuxStatusLine } from './AimuxStatus.js'

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

const VERSION = '0.2.4'
const WELCOME_ROWS = 12
const CHROME_ROWS = 11

const SLASH_COMMANDS = [
  { cmd: '/clear', desc: '清空当前对话，开启新会话' },
  { cmd: '/resume', desc: '恢复一个历史会话' },
  { cmd: '/help', desc: '显示帮助' },
  { cmd: '/quit', desc: '退出 TUI' },
]

export function ChatScreen({ client, ready, webUserId, resumeSessionId, onClear, onResume, onQuit, aimuxStatus }: ChatProps) {
  const chat = useChat({ client, ready, resumeSessionId })
  const [showHelp, setShowHelp] = useState(false)
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
    void chat.send(t)
  }, [chat, runSlash])

  const transcriptRows = Math.max(5, terminal.rows - CHROME_ROWS)
  const fitted = useMemo(
    () => fitTranscript(chat.entries, transcriptRows, terminal.columns),
    [chat.entries, transcriptRows, terminal.columns],
  )
  // Welcome card is for fresh / short sessions only. Once the conversation is
  // long enough that fitTranscript hides older entries, switch to the compact
  // header + full transcript — otherwise the 12-row welcome card crowds out the
  // recent messages and the chat area reads as blank after "已隐藏较早的…".
  const showWelcome = fitted.hiddenCount === 0 && fitted.estimatedRows + WELCOME_ROWS <= transcriptRows

  return (
    <Box
      flexDirection="column"
      width={terminal.isTty ? terminal.columns : undefined}
      height={terminal.isTty ? Math.max(16, terminal.rows - 1) : undefined}
      paddingX={1}
      overflowY="hidden"
    >
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {showWelcome
          ? <WelcomeCard ready={ready} columns={terminal.columns} resumed={Boolean(resumeSessionId)} />
          : <CompactHeader ready={ready} sessionId={chat.sessionId} />}

        <Box flexDirection="column" marginTop={showWelcome ? 1 : 0}>
          {fitted.hiddenCount > 0
            ? <Text dimColor>  … 已隐藏较早的 {fitted.hiddenCount} 条记录；使用 /resume 可重新载入会话</Text>
            : null}
          {fitted.entries.map((entry, index) => (
            <EntryBlock key={entry.__id ?? `entry-${index}`} entry={entry} />
          ))}
          {chat.pendingUser !== null ? <UserLine text={chat.pendingUser} /> : null}
        </Box>

        {chat.entries.length === 0 && chat.pendingUser === null && !showHelp
          ? <Box marginTop={1}><Text dimColor>输入问题开始协作，或输入 <Text color="cyan">/</Text> 查看命令。</Text></Box>
          : null}

        {showHelp ? <HelpBlock commands={SLASH_COMMANDS} /> : null}
      </Box>

      {chat.typing ? <WorkingIndicator /> : null}
      {chat.error ? <Text color="red">⚠ {chat.error}</Text> : null}

      <Composer
        onSubmit={onSubmit}
        onStop={chat.stop}
        onQuit={onQuit}
        typing={chat.typing}
        commands={SLASH_COMMANDS}
      />
      <StatusArea
        ready={ready}
        sessionId={chat.sessionId}
        columns={terminal.columns}
        webUrl={buildWebUrl(client.server, webUserId, ready, chat.sessionId)}
        aimuxStatus={aimuxStatus}
      />
    </Box>
  )
}

function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout()
  const read = useCallback((): TerminalSize => ({
    columns: Math.max(40, stdout.columns ?? 80),
    rows: Math.max(16, stdout.rows ?? 24),
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

function WelcomeCard({ ready, columns, resumed }: { ready: ReadyState; columns: number; resumed: boolean }) {
  const cwd = compactPath(process.cwd())
  const width = Math.max(38, Math.min(68, columns - 4))
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
        <MetaRow label="model:" value={ready.prefs.model ?? 'default'} hint="/help 查看命令" labelWidth={labelWidth} />
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

function CompactHeader({ ready, sessionId }: { ready: ReadyState; sessionId: string | null }) {
  return (
    <Box justifyContent="space-between">
      <Text bold><Text dimColor>{'>_ '}</Text>Mobius</Text>
      <Text dimColor>{ready.project.name} › {ready.issue.title}{sessionId ? ` · ${sessionId.slice(0, 8)}` : ''}</Text>
    </Box>
  )
}

function EntryBlock({ entry }: { entry: AnyEntry }) {
  const views = viewsForEntry(entry)
  return (
    <Box flexDirection="column">
      {views.map((view, index) => <ViewLine key={index} view={view} />)}
    </Box>
  )
}

function ViewLine({ view }: { view: EntryView }) {
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
    case 'tool_call':
      return (
        <Text>
          <Text color="cyan">• {toolLabel(view.toolName)}</Text>
          {view.summary ? <Text dimColor>  {view.summary}</Text> : null}
        </Text>
      )
    case 'tool_result':
      return (
        <Text dimColor color={view.isError ? 'red' : undefined}>
          {'  └ '}{view.summary || '(无输出)'}
        </Text>
      )
    case 'reasoning':
      return <Text dimColor color="magenta">  ◇ {view.text}</Text>
    case 'system':
      return <Text dimColor color="yellow">  {view.text}</Text>
    case 'error':
      return <Text color="red">⚠ {view.text}</Text>
    default:
      return null
  }
}

function UserLine({ text }: { text: string }) {
  const lines = text.split('\n')
  if (lines[0] !== undefined) lines[0] = `› ${lines[0]}`
  for (let i = 1; i < lines.length; i++) lines[i] = `  ${lines[i]}`
  return <Box marginTop={1}><Text bold>{lines.join('\n')}</Text></Box>
}

function WorkingIndicator() {
  const startedAt = useRef(Date.now())
  const [animationFrame, setAnimationFrame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setAnimationFrame(frame => frame + 1), 80)
    return () => clearInterval(id)
  }, [])
  const secs = Math.floor((Date.now() - startedAt.current) / 1000)
  const elapsed = secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s` : `${secs}s`
  const label = `• Working (${elapsed} · esc to interrupt)`
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
}

function Composer({ onSubmit, onStop, onQuit, typing, commands }: ComposerProps) {
  const [value, setValue] = useState('')
  const [cursor, setCursor] = useState(0)
  const [popupIdx, setPopupIdx] = useState(0)
  const [popupDismissed, setPopupDismissed] = useState(false)
  const historyRef = useRef<string[]>([])
  const [histIdx, setHistIdx] = useState<number | null>(null)

  const filtered = useMemo(() => {
    const match = /^(\w*)$/.exec(value.slice(1))
    if (!value.startsWith('/') || match === null) return []
    const prefix = value.slice(1)
    return commands.filter(command => command.cmd.slice(1).startsWith(prefix))
  }, [value, commands])

  useEffect(() => { setPopupIdx(0); setPopupDismissed(false) }, [value])
  const popupOpen = !popupDismissed && value.startsWith('/') && filtered.length > 0 && value.trim() !== filtered[popupIdx]?.cmd

  function edit(next: string, nextCursor: number) {
    setValue(next)
    setCursor(nextCursor)
  }

  useInput((input, key) => {
    if (typing && key.escape) { void onStop(); return }

    if (popupOpen) {
      if (key.upArrow) { setPopupIdx(i => (i <= 0 ? filtered.length - 1 : i - 1)); return }
      if (key.downArrow) { setPopupIdx(i => (i + 1) % filtered.length); return }
      if (key.return || key.tab) {
        const pick = filtered[popupIdx >= 0 ? popupIdx : 0]
        if (pick) { edit(`${pick.cmd} `, pick.cmd.length + 1); setPopupDismissed(true); return }
      }
      if (key.escape) { setPopupDismissed(true); return }
    }

    if (key.return) {
      if (value.trim()) {
        historyRef.current.push(value)
        onSubmit(value)
        edit('', 0)
        setHistIdx(null)
      }
      return
    }
    if (key.ctrl && input === 'c') { typing ? void onStop() : onQuit(); return }
    // Ink reports the terminal Backspace key (\x7f) as `key.delete`; handle both
    // as a backward delete so Backspace works at the end of the input.
    if (key.backspace || key.delete) {
      if (cursor > 0) edit(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1)
      return
    }
    if (key.leftArrow) { setCursor(current => Math.max(0, current - 1)); return }
    if (key.rightArrow) { setCursor(current => Math.min(value.length, current + 1)); return }

    const onFirstLine = value.slice(0, cursor).indexOf('\n') === -1
    if (key.upArrow && onFirstLine) {
      const history = historyRef.current
      if (history.length) {
        const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1)
        setHistIdx(next)
        edit(history[next], history[next].length)
      }
      return
    }
    if (key.downArrow && histIdx !== null) {
      const history = historyRef.current
      const next = histIdx + 1
      if (next >= history.length) { setHistIdx(null); edit('', 0) }
      else { setHistIdx(next); edit(history[next], history[next].length) }
      return
    }
    if (key.ctrl && input === 'a') { setCursor(0); return }
    if (key.ctrl && input === 'e') { setCursor(value.length); return }
    if (key.ctrl && input === 'u') { edit('', 0); return }
    if (key.ctrl && input === 'k') { edit(value.slice(0, cursor), cursor); return }
    if (key.ctrl && input === 'j') { edit(value.slice(0, cursor) + '\n' + value.slice(cursor), cursor + 1); return }
    if (key.ctrl || key.meta || key.escape || !input) return
    edit(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length)
  })

  const lines = value.split('\n')
  const lineIdx = value.slice(0, cursor).match(/\n/g)?.length ?? 0
  const col = cursor - (value.slice(0, cursor).lastIndexOf('\n') + 1)
  const currentLine = lines[lineIdx] ?? ''
  const beforeCursor = currentLine.slice(0, col)
  const atCursor = currentLine.slice(col, col + 1)
  const afterCursor = currentLine.slice(col + 1)

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
      <Box>
        <Text bold>{'› '}</Text>
        <Text>
          {lines.map((line, index) => {
            if (index < lineIdx) return <Text key={index}>{line}{'\n'}</Text>
            if (index === lineIdx) {
              return (
                <Text key={index}>
                  {beforeCursor}<Text backgroundColor="white" color="black">{atCursor || ' '}</Text>{afterCursor}
                  {index < lines.length - 1 ? '\n' : ''}
                </Text>
              )
            }
            return <Text key={index}>{'\n'}{line}</Text>
          })}
          {value === '' ? <Text dimColor> 输入问题或 / 命令</Text> : null}
        </Text>
      </Box>
    </Box>
  )
}

function StatusArea({ ready, sessionId, columns, webUrl, aimuxStatus }: {
  ready: ReadyState
  sessionId: string | null
  columns: number
  webUrl: string
  aimuxStatus?: AimuxStatus
}) {
  const model = ready.prefs.model ?? 'default'
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
      <Text>
        <Text dimColor>web · </Text>
        <Text color="cyan" underline>{clickableUrl(webUrl)}</Text>
      </Text>
      {aimuxStatus ? <AimuxStatusLine status={aimuxStatus} compact /> : null}
    </Box>
  )
}

function compactPath(path: string): string {
  const home = process.env.HOME
  if (!home) return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}

function truncateDisplay(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return maxLength <= 1 ? '…' : `${value.slice(0, maxLength - 1)}…`
}

function buildWebUrl(server: string, webUserId: string, ready: ReadyState, sessionId: string | null): string {
  const root = server.replace(/\/+$/, '')
  const user = webUserId || ready.project.created_by || ready.issue.created_by || 'current'
  const base = `${root}/u/${encodeURIComponent(user)}/p/${encodeURIComponent(ready.project.id)}/i/${encodeURIComponent(ready.issue.id)}`
  return sessionId ? `${base}?session=${encodeURIComponent(sessionId)}` : base
}

/** OSC 8 hyperlinks remain readable as plain URLs in terminals without support. */
function clickableUrl(url: string): string {
  if (process.env.MOBIUS_TUI_DISABLE_LINKS === '1') return url
  return `\u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`
}

function wrappedRows(text: string, columns: number): number {
  const width = Math.max(20, columns - 6)
  return text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0)
}

function entryRows(entry: AnyEntry, columns: number): number {
  return viewsForEntry(entry).reduce((sum, view) => {
    if (view.kind === 'skip') return sum
    if (view.kind === 'tool_call') return sum + wrappedRows(`${toolLabel(view.toolName)} ${view.summary}`, columns)
    if (view.kind === 'tool_result') return sum + wrappedRows(view.summary, columns)
    return sum + wrappedRows(view.text, columns) + (view.kind === 'user' || view.kind === 'assistant' ? 1 : 0)
  }, 0)
}

function fitTranscript(entries: AnyEntry[], rowBudget: number, columns: number): {
  entries: AnyEntry[]
  hiddenCount: number
  estimatedRows: number
} {
  let rows = 0
  let first = entries.length
  for (let index = entries.length - 1; index >= 0; index--) {
    const nextRows = entryRows(entries[index], columns)
    if (first < entries.length && rows + nextRows > rowBudget) break
    rows += nextRows
    first = index
  }
  return { entries: entries.slice(first), hiddenCount: first, estimatedRows: rows }
}
