/**
 * Reusable Ink primitives: TextInput (with inline block cursor + multi-line),
 * Select (single-choice list + multi-choice with checkboxes), and a Spinner.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout, useStdin } from 'ink'

/** Windows Terminal/ConPTY may expose Esc as a named key, a raw byte, or Ctrl+[. */
export function isEscapeKeypress(input: string, key: { escape?: boolean; ctrl?: boolean }): boolean {
  return key.escape === true || input === '\x1b' || (key.ctrl === true && input === '[')
}

// ─── Mouse wheel ─────────────────────────────────────────────────────────────
// Terminals report wheel events only after DECSET 1000 (button-event) + 1006
// (SGR coordinates) are enabled. A wheel tick arrives as a mouse sequence:
//   wheel up   → ESC [ < 64 ; x ; y M   (SGR, the modern encoding)
//   wheel down → ESC [ < 65 ; x ; y M
// Legacy X10 (no SGR support) reports ESC [ M Cb Cx Cy with Cb = button + 32,
// so wheel up is 0x60 (`) and wheel down is 0x61 (a). There is no release event
// for the wheel in either form. Button 64/65 map to a delta of +1/-1 so the
// transcript pager can scroll back/forward by a fixed step.
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
const LEGACY_MOUSE_RE = /\x1b\[M([\s\S]{3})/g

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
  SGR_MOUSE_RE.lastIndex = 0
  let delta = 0
  let m: RegExpExecArray | null
  while ((m = SGR_MOUSE_RE.exec(input)) !== null) {
    const btn = Number(m[1])
    if (btn === 64) delta++
    else if (btn === 65) delta--
  }
  LEGACY_MOUSE_RE.lastIndex = 0
  let lm: RegExpExecArray | null
  while ((lm = LEGACY_MOUSE_RE.exec(input)) !== null) {
    const btn = lm[1].charCodeAt(0) - 32 // X10 adds a 32 offset to the button
    if (btn === 64) delta++
    else if (btn === 65) delta--
  }
  return delta
}

/**
 * Enables terminal mouse tracking for the lifetime of the calling component and
 * forwards wheel deltas to `onWheel`. Mouse events reach the rest of Ink as raw
 * input chunks, so any text-inserting useInput handler must guard with
 * `isMouseInput(input)`.
 *
 * The DECSET enable/disable sequences are only written when stdout is a TTY
 * (writing them into a pipe would litter the output). The emitter listener is
 * attached unconditionally so the harness can simulate wheel events.
 *
 * Trade-off: terminal mouse reporting (DECSET 1000) hands the mouse to the app,
 * so native drag-to-select is disabled while it is on. The universal escape is
 * Shift+drag (the terminal selects and does not forward the event). Users who
 * prefer native selection at all times can opt out with
 * `MOBIUS_TUI_DISABLE_MOUSE=1` (wheel then stops working).
 */
export function useMouseWheel(onWheel: (delta: number) => void): void {
  const { internal_eventEmitter } = useStdin()
  const { stdout } = useStdout()
  const cbRef = useRef(onWheel)
  cbRef.current = onWheel

  useEffect(() => {
    if (!internal_eventEmitter) return
    if (process.env.MOBIUS_TUI_DISABLE_MOUSE === '1') return
    const isTTY = Boolean(stdout.isTTY)
    if (isTTY) stdout.write('\x1b[?1000h\x1b[?1006h')
    let buf = ''
    const handler = (chunk: unknown) => {
      // A single read() chunk may carry several wheel ticks (fast scrolling) and
      // an SGR sequence may be split across chunks, so accumulate and re-scan.
      buf += String(chunk)
      const delta = mouseWheelDelta(buf)
      // Drop the fully-matched sequences, keeping any trailing partial escape
      // prefix so a split sequence still matches on the next chunk.
      buf = buf.replace(SGR_MOUSE_RE, '').replace(LEGACY_MOUSE_RE, '')
      const esc = buf.lastIndexOf('\x1b')
      buf = esc >= 0 ? buf.slice(esc) : ''
      if (delta !== 0) cbRef.current(delta)
    }
    internal_eventEmitter.on('input', handler)
    return () => {
      internal_eventEmitter.off('input', handler)
      if (isTTY) stdout.write('\x1b[?1000l\x1b[?1006l')
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

  useInput((input, key) => {
    if (isMouseInput(input)) return
    if (key.return) { props.onSubmit?.(); return }
    if (key.upArrow) { props.onArrowUp?.(); return }
    if (key.downArrow) { props.onArrowDown?.(); return }
    if (isEscapeKeypress(input, key)) { props.onEscape?.(); return }
    if (key.tab) { props.onTab?.(); return }
    // Ink labels the \x7f that virtually every terminal's Backspace key emits
    // as `key.delete` (see its parse-keypress.js TODO). Treat either signal as
    // a backward delete — otherwise Backspace at the end of the input is a no-op.
    if (key.backspace || key.delete || (key.ctrl && input === 'h')) {
      if (cursor > 0) {
        // delete word on Ctrl+W
        if (key.ctrl && input === 'w') {
          const before = value.slice(0, cursor)
          const m = before.match(/\S+\s*$/)
          const cut = m ? m[0].length : 0
          edit(value.slice(0, cursor - cut) + value.slice(cursor), cursor - cut)
        } else {
          edit(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1)
        }
      }
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
}

export function Select(props: SelectProps) {
  const mode = props.mode ?? 'single'
  const [active, setActive] = useState(0)
  const items = props.items
  const selectedSet = new Set<string>(mode === 'multi' ? (props.selected as string[]) ?? [] : [])
  const { stdout } = useStdout()

  useEffect(() => { setActive(a => Math.min(a, Math.max(0, items.length - 1))) }, [items.length])

  useInput((input, key) => {
    if (!items.length) return
    if (isMouseInput(input)) return
    if (key.upArrow) { setActive(a => (a - 1 + items.length) % items.length); return }
    if (key.downArrow) { setActive(a => (a + 1) % items.length); return }
    if (mode === 'single') {
      if (key.return) { props.onSelect?.(items[active].value); return }
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
