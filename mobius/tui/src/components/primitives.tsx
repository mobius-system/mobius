/**
 * Reusable Ink primitives: TextInput (with inline block cursor + multi-line),
 * Select (single-choice list + multi-choice with checkboxes), and a Spinner.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout, useStdin, type Key } from 'ink'
import { useDeleteKeyCapture, applyDeleteIntent } from '../lib/delete-keys.js'

/** Return false when a mounted listener deliberately did not consume the input. */
type InputHandler = (input: string, key: Key) => void | false

type StableInputOptions = {
  isActive?: boolean
  /** Passive listeners (App raw-mode keepalive, Chat paging) must not claim or receive replayed input. */
  interactive?: boolean
}

type ReplayInput = { input: string; key: Key; signature: string; claimed: boolean }

const pendingRootInputs: ReplayInput[] = []
const replayQueue: ReplayInput[] = []
const interactiveHandlers = new Set<InputHandler>()
const earlyClaimCredits = new Map<string, number>()
let earlyClaimCleanupScheduled = false
let replayingInput = false

function inputSignature(input: string, key: Key): string {
  const flags = Object.keys(key)
    .filter(name => Boolean((key as unknown as Record<string, unknown>)[name]))
    .sort()
    .join(',')
  return `${input}\u0000${flags}`
}

function markRootInputClaimed(input: string, key: Key): void {
  const signature = inputSignature(input, key)
  const pending = pendingRootInputs.find(event => !event.claimed && event.signature === signature)
  if (pending) {
    pending.claimed = true
    return
  }

  // React/Ink may register a child's listener before the App listener. Keep a
  // one-microtask credit so the root callback later in the same emitter pass
  // recognizes that this exact input was already handled.
  earlyClaimCredits.set(signature, (earlyClaimCredits.get(signature) ?? 0) + 1)
  if (!earlyClaimCleanupScheduled) {
    earlyClaimCleanupScheduled = true
    queueMicrotask(() => {
      earlyClaimCredits.clear()
      earlyClaimCleanupScheduled = false
    })
  }
}

function deliverOrQueue(event: ReplayInput): void {
  for (const handler of Array.from(interactiveHandlers).reverse()) {
    replayingInput = true
    try {
      if (handler(event.input, event.key) !== false) return
    } finally {
      replayingInput = false
    }
  }
  replayQueue.push(event)
  if (replayQueue.length > 8) replayQueue.shift()
}

/**
 * App-level input safety net. It stays mounted across async route changes and
 * only buffers a key when no interactive Ink listener claimed that emitter
 * pass. The next Select/TextInput/Composer receives the key after it mounts.
 */
export function bufferUnclaimedInput(input: string, key: Key): void {
  if (isMouseInput(input)) return
  const signature = inputSignature(input, key)
  const credits = earlyClaimCredits.get(signature) ?? 0
  if (credits > 0) {
    if (credits === 1) earlyClaimCredits.delete(signature)
    else earlyClaimCredits.set(signature, credits - 1)
    return
  }

  const event: ReplayInput = { input, key: { ...key }, signature, claimed: false }
  pendingRootInputs.push(event)
  setTimeout(() => {
    const index = pendingRootInputs.indexOf(event)
    if (index >= 0) pendingRootInputs.splice(index, 1)
    if (!event.claimed) deliverOrQueue(event)
  }, 0)
}

/** Keep one Ink listener while a component rerenders; read the latest handler through a ref. */
export function useStableInput(handler: InputHandler, options?: StableInputOptions): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const stableRef = useRef<InputHandler | null>(null)
  const interactive = options?.interactive !== false
  if (!stableRef.current) {
    stableRef.current = (input, key) => {
      const handled = handlerRef.current(input, key)
      if (interactive && !replayingInput && handled !== false) markRootInputClaimed(input, key)
      return handled
    }
  }
  useInput(stableRef.current, { isActive: options?.isActive })

  useEffect(() => {
    if (!interactive || options?.isActive === false || !stableRef.current) return
    const stable = stableRef.current
    interactiveHandlers.add(stable)
    const queued = replayQueue.splice(0)
    replayingInput = true
    try {
      for (const event of queued) stable(event.input, event.key)
    } finally {
      replayingInput = false
    }
    return () => { interactiveHandlers.delete(stable) }
  }, [interactive, options?.isActive])
}

/** Windows Terminal/ConPTY may expose Esc as a named key, a raw byte, or Ctrl+[. */
export function isEscapeKeypress(input: string, key: { escape?: boolean; ctrl?: boolean }): boolean {
  return key.escape === true || input === '\x1b' || (key.ctrl === true && input === '[')
}

// ─── Mouse events ────────────────────────────────────────────────────────────
// Terminals report mouse events only after DECSET 1000 (button-event) + 1002
// (cell motion while a button is held) + 1006 (SGR coordinates) are enabled.
// An event arrives as a sequence:
//   press   → ESC [ < b ; x ; y M     b = 0/1/2 (left/middle/right)
//   release → ESC [ < b ; x ; y m     b = 0/1/2
//   motion  → ESC [ < b ; x ; y M     b = 32/33/34 (drag with button 0/1/2)
//   wheel   → ESC [ < 64 ; x ; y M    (up) / < 65 (down), no release event
// Legacy X10 (no SGR support) reports ESC [ M Cb Cx Cy with Cb = button + 32
// (0x20 left, 0x23 release, 0x40 left-drag, 0x60 wheel-up, 0x61 wheel-down).
// Coordinates are 1-based in SGR and offset by 32 in X10; both are normalized
// to 0-based row/col here.
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
const LEGACY_MOUSE_RE = /\x1b\[M([\s\S]{3})/g

export type MouseEventInfo =
  | { kind: 'wheel'; delta: number }
  | { kind: 'press' | 'release' | 'motion'; button: number; row: number; col: number }

/**
 * True when `input` (a chunk Ink forwarded to useInput handlers) begins with a
 * mouse event. Ink strips a leading ESC before passing `input`, so both the raw
 * and stripped forms are accepted. Guards must be added to any handler that
 * would otherwise treat a mouse event as typed text.
 */
export function isMouseInput(input: string): boolean {
  return /^\x1b?\[<\d+;\d+;\d+[Mm]/.test(input) || /^\x1b?\[M/.test(input)
}

/** Extract the wheel delta from a chunk: +1 wheel-up, -1 wheel-down, else 0. */
export function mouseWheelDelta(input: string): number {
  let delta = 0
  for (const e of parseMouseEvents(input)) if (e.kind === 'wheel') delta += e.delta
  return delta
}

/** Parse every mouse event in a chunk (may contain several; fast scroll batches). */
export function parseMouseEvents(input: string): MouseEventInfo[] {
  const out: MouseEventInfo[] = []
  SGR_MOUSE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SGR_MOUSE_RE.exec(input)) !== null) {
    const btn = Number(m[1])
    const row = Number(m[3]) - 1
    const col = Number(m[2]) - 1
    const down = m[4] === 'M'
    if (btn === 64) out.push({ kind: 'wheel', delta: 1 })
    else if (btn === 65) out.push({ kind: 'wheel', delta: -1 })
    else if (btn >= 32 && btn <= 34) out.push({ kind: 'motion', button: btn - 32, row, col })
    else if (btn <= 2) out.push({ kind: down ? 'press' : 'release', button: btn, row, col })
  }
  LEGACY_MOUSE_RE.lastIndex = 0
  let lm: RegExpExecArray | null
  while ((lm = LEGACY_MOUSE_RE.exec(input)) !== null) {
    const bytes = lm[1]
    const btn = bytes.charCodeAt(0) - 32
    const row = bytes.charCodeAt(2) - 32 - 1
    const col = bytes.charCodeAt(1) - 32 - 1
    if (btn === 64) out.push({ kind: 'wheel', delta: 1 })
    else if (btn === 65) out.push({ kind: 'wheel', delta: -1 })
    else if (btn >= 32 && btn <= 34) out.push({ kind: 'motion', button: btn - 32, row, col })
    else if (btn === 3) out.push({ kind: 'release', button: 0, row, col })
    else if (btn <= 2) out.push({ kind: 'press', button: btn, row, col })
  }
  return out
}

/**
 * Enables terminal mouse tracking for the lifetime of the calling component and
 * forwards mouse events (wheel + left-button press/motion/release) to the given
 * handlers. Mouse events reach the rest of Ink as raw input chunks, so any
 * text-inserting useInput handler must guard with `isMouseInput(input)`.
 *
 * The DECSET enable/disable sequences are only written when stdout is a TTY
 * (writing them into a pipe would litter the output). The emitter listener is
 * attached unconditionally so the harness can simulate mouse events.
 *
 * Trade-off: terminal mouse reporting (DECSET 1000) hands the mouse to the app,
 * so native drag-to-select is disabled while it is on. The app therefore draws
 * its own selection (tmux-style) and copies via OSC 52. Users who prefer native
 * selection can opt out with `MOBIUS_TUI_DISABLE_MOUSE=1`.
 */
export function useMouseEvents(handlers: {
  onWheel?: (delta: number) => void
  onPress?: (row: number, col: number) => void
  onMotion?: (row: number, col: number) => void
  onRelease?: (row: number, col: number) => void
}): void {
  const { internal_eventEmitter } = useStdin()
  const { stdout } = useStdout()
  const refs = useRef(handlers)
  refs.current = handlers

  useEffect(() => {
    if (!internal_eventEmitter) return
    if (process.env.MOBIUS_TUI_DISABLE_MOUSE === '1') return
    const isTTY = Boolean(stdout.isTTY)
    if (isTTY) stdout.write('\x1b[?1000h\x1b[?1002h\x1b[?1006h')
    let buf = ''
    const handler = (chunk: unknown) => {
      // A single read() chunk may carry several events and a sequence may be
      // split across chunks, so accumulate and re-scan.
      buf += String(chunk)
      for (const e of parseMouseEvents(buf)) {
        if (e.kind === 'wheel') refs.current.onWheel?.(e.delta)
        else if (e.kind === 'press') refs.current.onPress?.(e.row, e.col)
        else if (e.kind === 'motion') refs.current.onMotion?.(e.row, e.col)
        else refs.current.onRelease?.(e.row, e.col)
      }
      // Drop the fully-matched sequences, keeping any trailing partial escape
      // prefix so a split sequence still matches on the next chunk.
      buf = buf.replace(SGR_MOUSE_RE, '').replace(LEGACY_MOUSE_RE, '')
      const esc = buf.lastIndexOf('\x1b')
      buf = esc >= 0 ? buf.slice(esc) : ''
    }
    internal_eventEmitter.on('input', handler)
    return () => {
      internal_eventEmitter.off('input', handler)
      if (isTTY) stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1006l')
    }
  }, [internal_eventEmitter, stdout])
}

// ─── TextInput ───────────────────────────────────────────────────────────────
export interface TextInputProps {
  value: string
  onChange: (v: string) => void
  onSubmit?: () => void
  onArrowUp?: () => void
  onArrowDown?: () => void
  onEscape?: () => void
  onTab?: () => void
  placeholder?: string
  focused?: boolean
  mask?: boolean
  prompt?: string
}

export function TextInput(props: TextInputProps) {
  const { value, onChange } = props
  const focused = props.focused !== false
  const [cursor, setCursor] = useState(value.length)
  const lastValueRef = useRef(value)

  // When the value is changed externally (e.g. history navigation), park the
  // cursor at the end. Edits performed below keep lastValueRef in sync so this
  // effect only fires on true external changes.
  useEffect(() => {
    if (value !== lastValueRef.current) {
      lastValueRef.current = value
      setCursor(value.length)
    }
  }, [value])

  function edit(next: string, nextCursor: number) {
    lastValueRef.current = next
    onChange(next)
    setCursor(nextCursor)
  }

  // Physical Backspace/Delete keys are owned by useDeleteKeyCapture from the
  // raw stdin bytes — Ink reports the Backspace key (\x7f) and the Delete key
  // (ESC[3~) both as `key.delete`, so handling `key.delete` in useInput would
  // delete in the wrong direction. Refs keep the hook's callback on the latest
  // value/cursor without re-subscribing.
  const valueRef = useRef(value)
  const cursorRef = useRef(cursor)
  valueRef.current = value
  cursorRef.current = cursor
  useDeleteKeyCapture(focused, (intent) => {
    const { text, cursor: nextCursor } = applyDeleteIntent(valueRef.current, cursorRef.current, intent)
    edit(text, nextCursor)
  })

  useStableInput((input, key) => {
    if (isMouseInput(input)) return
    if (key.return) { props.onSubmit?.(); return }
    if (key.upArrow) { props.onArrowUp?.(); return }
    if (key.downArrow) { props.onArrowDown?.(); return }
    if (isEscapeKeypress(input, key)) { props.onEscape?.(); return }
    if (key.tab) { props.onTab?.(); return }
    // Only the unambiguous logical editing bindings stay here; the physical
    // delete keys are handled above via useDeleteKeyCapture.
    if (key.ctrl && input === 'w') {
      const { text, cursor: nextCursor } = applyDeleteIntent(value, cursor, 'backward-word')
      edit(text, nextCursor)
      return
    }
    if (key.ctrl && input === 'h') {
      const { text, cursor: nextCursor } = applyDeleteIntent(value, cursor, 'backward')
      edit(text, nextCursor)
      return
    }
    if (key.ctrl && input === 'd') {
      const { text, cursor: nextCursor } = applyDeleteIntent(value, cursor, 'forward')
      edit(text, nextCursor)
      return
    }
    if (key.leftArrow) { setCursor(c => Math.max(0, c - 1)); return }
    if (key.rightArrow) { setCursor(c => Math.min(value.length, c + 1)); return }
    if (key.ctrl && input === 'a') { setCursor(0); return }
    if (key.ctrl && input === 'e') { setCursor(value.length); return }
    if (key.ctrl && input === 'u') { edit('', 0); return }
    if (key.ctrl && input === 'k') { edit(value.slice(0, cursor), cursor); return }
    if (key.ctrl && input === 'j') { edit(value.slice(0, cursor) + '\n' + value.slice(cursor), cursor + 1); return } // newline
    if (key.ctrl || key.meta) return
    if (!input) return
    edit(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length)
  }, { isActive: focused })

  const c = Math.min(cursor, value.length)
  const display = props.mask ? '•'.repeat(value.length) : value
  const dc = props.mask ? c : c
  const lineStart = display.slice(0, dc).lastIndexOf('\n') + 1
  const lineIdx = (display.slice(0, dc).match(/\n/g) ?? []).length
  const lines = display.split('\n')
  const curLine = lines[lineIdx] ?? ''
  const col = dc - lineStart
  const beforeCol = curLine.slice(0, col)
  const atCol = curLine.slice(col, col + 1)
  const afterCol = curLine.slice(col + 1)

  if (!display && props.placeholder) {
    return (
      <Box>
        {props.prompt ? <Text color="cyan">{props.prompt} </Text> : null}
        {focused ? <Text backgroundColor="white" color="black"> </Text> : null}
        <Text color="gray">{props.placeholder}</Text>
      </Box>
    )
  }

  // Keep inactive inputs visible without drawing a fake cursor. Previously
  // every TextInput painted a white block even when its useInput hook was
  // inactive, so multi-field forms appeared focused in two places at once.
  if (!focused) {
    return (
      <Box>
        {props.prompt ? <Text color="cyan">{props.prompt} </Text> : null}
        <Text>{display || ' '}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box>
        {props.prompt ? <Text color="cyan">{props.prompt} </Text> : null}
        <Text>
          {lines.map((ln, i) => {
            if (i < lineIdx) return <Text key={i}>{ln || ' '}{'\n'}</Text>
            if (i === lineIdx) {
              return (
                <Text key={i}>
                  {beforeCol}
                  <Text backgroundColor="white" color="black">{atCol || ' '}</Text>
                  {afterCol}
                  {i < lines.length - 1 ? '\n' : ''}
                </Text>
              )
            }
            return <Text key={i}>{'\n'}{ln || ' '}</Text>
          })}
        </Text>
      </Box>
    </Box>
  )
}

// ─── Select ──────────────────────────────────────────────────────────────────
export interface SelectItem {
  label: string
  value: string
  desc?: string
}

export interface SelectProps {
  items: SelectItem[]
  mode?: 'single' | 'multi'
  selected?: string | string[] // single value (single-mode) or selected values (multi)
  onSelect?: (value: string) => void // single-mode
  onToggle?: (value: string) => void // multi-mode: space toggles
  onConfirm?: (selected: string[]) => void // multi-mode: Enter confirms
  onBack?: () => void
  focused?: boolean
  title?: string
  maxVisible?: number // cap rendered rows so long lists never overflow the terminal
  initialActive?: number // initial keyboard focus; useful when a create action occupies row 0
}

export function Select(props: SelectProps) {
  const mode = props.mode ?? 'single'
  const [active, setActive] = useState(() => Math.max(0, props.initialActive ?? 0))
  const items = props.items
  const selectedSet = new Set<string>(mode === 'multi' ? (props.selected as string[]) ?? [] : [])
  const { stdout } = useStdout()

  useEffect(() => { setActive(a => Math.min(a, Math.max(0, items.length - 1))) }, [items.length])

  useStableInput((input, key) => {
    if (!items.length) return
    if (isMouseInput(input)) return
    if (key.upArrow) { setActive(a => (a - 1 + items.length) % items.length); return }
    if (key.downArrow) { setActive(a => (a + 1) % items.length); return }
    if (mode === 'single') {
      if (key.return) {
        props.onSelect?.(items[active].value)
        return
      }
    } else {
      if (key.return) { props.onConfirm?.(Array.from(selectedSet)); return }
      if (input === ' ') { props.onToggle?.(items[active].value); return }
    }
    if (isEscapeKeypress(input, key)) { props.onBack?.(); return }
  }, { isActive: props.focused !== false })

  // viewport: keep the active item on screen. Without this a long list renders
  // every row and pushes the lower items (and the rest of the UI) past the
  // terminal bottom, which scrolls Ink's frame and leaves on-screen residue.
  // We render a sliding window around `active` plus a "↑/↓ 还有 N 项" hint for
  // the hidden tails. Reserve generously (13): the window items plus the two
  // scroll hints, the active item's desc line, the AIMUX status line, and the
  // picker's own header/footer/padding must all fit within `rows`.
  const total = items.length
  const rows = stdout?.rows ?? 24
  const maxVisible = props.maxVisible ?? Math.max(3, rows - 13)
  let start = 0
  if (total > maxVisible) {
    const half = Math.floor(maxVisible / 2)
    start = Math.max(0, active - half)
    start = Math.min(start, total - maxVisible)
  }
  const end = Math.min(total, start + maxVisible)
  const hiddenAbove = start
  const hiddenBelow = total - end

  return (
    <Box flexDirection="column">
      {props.title ? <Text color="cyan" bold>{props.title}</Text> : null}
      {items.length === 0 ? <Text color="gray">（无项目）</Text> : null}
      {hiddenAbove > 0 ? <Text color="gray">  ↑ 还有 {hiddenAbove} 项</Text> : null}
      {items.slice(start, end).map((it, i) => {
        const realIdx = start + i
        const isActive = realIdx === active
        const checked = mode === 'multi' ? selectedSet.has(it.value) : false
        const marker = mode === 'multi' ? (checked ? '☑' : '☐') : isActive ? '❯' : ' '
        return (
          <Box key={it.value} flexDirection="column">
            <Text
              color={isActive ? 'black' : undefined}
              backgroundColor={isActive ? 'cyan' : undefined}
              bold={isActive}
              wrap="truncate-end"
            >
              {marker} {it.label}
            </Text>
            {isActive && it.desc ? <Text color="gray" wrap="truncate-end">    {it.desc}</Text> : null}
          </Box>
        )
      })}
      {hiddenBelow > 0 ? <Text color="gray">  ↓ 还有 {hiddenBelow} 项</Text> : null}
    </Box>
  )
}

// ─── Spinner ─────────────────────────────────────────────────────────────────
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export function Spinner({ label }: { label?: string }) {
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setI(x => (x + 1) % FRAMES.length), 80)
    return () => clearInterval(id)
  }, [])
  return (
    <Text>
      <Text color="cyan">{FRAMES[i]}</Text>
      {label ? ` ${label}` : ''}
    </Text>
  )
}
