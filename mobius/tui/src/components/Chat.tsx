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
import { Box, Static, Text, useInput, useStdout } from 'ink'
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

const SLASH_COMMANDS = [
  { cmd: '/clear', desc: '清空当前对话，开启新会话' },
  { cmd: '/resume', desc: '恢复一个历史会话' },
  { cmd: '/help', desc: '显示帮助' },
  { cmd: '/quit', desc: '退出 TUI' },
]

export function ChatScreen({ client, ready, webUserId, resumeSessionId, onClear, onResume, onQuit, aimuxStatus }: ChatProps) {
  const chat = useChat({ client, ready, resumeSessionId })
  const [showHelp, setShowHelp] = useState(false)
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
    void chat.send(t)
  }, [chat, runSlash])

  // Welcome card is for a truly fresh session only — once there's any
  // conversation (or an in-flight message) it disappears. The transcript then
  // streams into <Static> below and accumulates into the terminal scrollback
  // (the terminal's own scrollback holds history; no in-app pager needed).
  const showWelcome = chat.entries.length === 0 && chat.pendingUser === null

  // First query of a fresh session triggers the full backend bootstrap (lazy
  // session creation, worker spawn, context load) before any output streams.
  // Label that phase "Initializing for the first query" instead of "Working"
  // so it reads as startup rather than a stuck agent. Once the first assistant
  // output is observed (or the session is a resumed one with prior history),
  // the indicator falls back to the normal Working label for every turn.
  const firstQueryInFlight = !resumeSessionId && !chat.entries.some(isAssistantOutput)

  // 用户输入去重 (对齐 web viewer/rounds.ts buildRounds): codex 同一提问的 3 形态
  // (type:user / response_item.message[user] / event_msg.user_message) 合并成 1 条,
  // 避免在累积视图里把同一条提问显示多次.
  const dedupedEntries = useMemo(() => dedupeUserEntries(chat.entries), [chat.entries])

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

  return (
    <Box flexDirection="column" width={terminal.isTty ? terminal.columns : undefined} paddingX={1}>
      {showWelcome ? (
        <WelcomeCard ready={ready} columns={terminal.columns} resumed={Boolean(resumeSessionId)} modelDisplay={modelDisplay} />
      ) : null}

      {/* <Static> 累积输出: 每个 entry 永久打印进终端 scrollback, 不参与动态重绘.
          新 entry 只追加打印, 历史靠终端自身滚动, 不再需要 in-app 翻页/视窗裁剪. */}
      <Static items={dedupedEntries}>
        {(entry, index) => (
          <EntryAccum key={entry.__id ?? `e${index}`} entry={entry} columns={terminal.columns} />
        )}
      </Static>

      {chat.pendingUser !== null ? <UserLine text={chat.pendingUser} /> : null}
      {chat.typing ? <WorkingIndicator firstQuery={firstQueryInFlight} /> : null}
      {chat.error ? <Text color="red">⚠ {chat.error}</Text> : null}

      {chat.entries.length === 0 && chat.pendingUser === null && !showHelp
        ? <Box marginTop={1}><Text dimColor>输入问题开始协作，或输入 <Text color="cyan">/</Text> 查看命令。</Text></Box>
        : null}

      {showHelp ? <HelpBlock commands={SLASH_COMMANDS} /> : null}

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
        modelDisplay={modelDisplay}
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

function WelcomeCard({ ready, columns, resumed, modelDisplay }: { ready: ReadyState; columns: number; resumed: boolean; modelDisplay: string }) {
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

function EntryAccum({ entry, columns }: { entry: AnyEntry; columns: number }) {
  const views = viewsForEntry(entry)
  return (
    <Box flexDirection="column">
      {views.map((view, index) => <ViewLine key={index} view={view} columns={columns} />)}
    </Box>
  )
}

function ViewLine({ view, columns }: { view: EntryView; columns: number }) {
  const width = Math.max(20, columns - 4)
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
    ? `• Initializing for the first query (${elapsed})`
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
    const escape = isEscapeKeypress(input, key)
    if (typing && escape) { void onStop(); return }

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
    if (key.ctrl || key.meta || escape || !input) return
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
  if (value.length <= maxLength) return value
  return maxLength <= 1 ? '…' : `${value.slice(0, maxLength - 1)}…`
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

// (fitTranscript / blockRows / wrappedRows 视窗裁剪 + in-app 翻页逻辑已移除:
//  transcript 现由 <Static> 累积进终端 scrollback, 历史靠终端自身滚动.)
