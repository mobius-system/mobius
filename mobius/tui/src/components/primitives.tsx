/**
 * Reusable Ink primitives: TextInput (with inline block cursor + multi-line),
 * Select (single-choice list + multi-choice with checkboxes), and a Spinner.
 */
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'

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
    if (key.return) { props.onSubmit?.(); return }
    if (key.upArrow) { props.onArrowUp?.(); return }
    if (key.downArrow) { props.onArrowDown?.(); return }
    if (key.escape) { props.onEscape?.(); return }
    if (key.tab) { props.onTab?.(); return }
    if (key.backspace || (key.ctrl && input === 'h')) {
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
    if (key.delete) { if (cursor < value.length) edit(value.slice(0, cursor) + value.slice(cursor + 1), cursor); return }
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
  }, { isActive: props.focused !== false })

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
        <Text color="gray">{props.placeholder}</Text>
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
}

export function Select(props: SelectProps) {
  const mode = props.mode ?? 'single'
  const [active, setActive] = useState(0)
  const items = props.items
  const selectedSet = new Set<string>(mode === 'multi' ? (props.selected as string[]) ?? [] : [])

  useEffect(() => { setActive(a => Math.min(a, Math.max(0, items.length - 1))) }, [items.length])

  useInput((input, key) => {
    if (!items.length) return
    if (key.upArrow) { setActive(a => (a - 1 + items.length) % items.length); return }
    if (key.downArrow) { setActive(a => (a + 1) % items.length); return }
    if (mode === 'single') {
      if (key.return) { props.onSelect?.(items[active].value); return }
    } else {
      if (key.return) { props.onConfirm?.(Array.from(selectedSet)); return }
      if (input === ' ') { props.onToggle?.(items[active].value); return }
    }
    if (key.escape) { props.onBack?.(); return }
  }, { isActive: props.focused !== false })

  return (
    <Box flexDirection="column">
      {props.title ? <Text color="cyan" bold>{props.title}</Text> : null}
      {items.length === 0 ? <Text color="gray">（无项目）</Text> : null}
      {items.map((it, i) => {
        const isActive = i === active
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
