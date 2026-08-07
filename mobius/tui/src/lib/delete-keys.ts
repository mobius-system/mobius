/**
 * Delete / Backspace key handling.
 *
 * Ink's parse-keypress collapses the terminal Backspace key (0x7f) and the
 * forward Delete key (ESC[3~) into one `key.delete` keypress with an empty
 * `input` (its own source TODO admits the collision), so a useInput handler
 * alone cannot tell them apart. The raw stdin chunk still can, so the input
 * components subscribe to Ink's internal event emitter — the same channel
 * `useMouseEvents` uses — and own the physical delete keys there, keeping only
 * the unambiguous logical bindings (Ctrl+W / Ctrl+H / Ctrl+D) in useInput.
 */

import { useEffect, useRef } from 'react'
import { useStdin } from 'ink'

export type DeleteIntent = 'backward' | 'forward' | 'backward-word' | 'forward-word'

// Raw sequences Ink receives for physical delete keys, longest first so a
// longer match wins over its prefix. 0x7f is what virtually every terminal's
// Backspace key emits; the ESC-prefixed forms are the standard CSI sequences.
const DELETE_SEQUENCES: ReadonlyArray<readonly [string, DeleteIntent]> = [
  ['\x1b[3;3~', 'forward-word'],   // Alt+Delete (xterm-family CSI modifier 3 = Alt)
  ['\x1b[3;5~', 'backward-word'],  // Ctrl+Backspace on Windows Terminal/ConPTY; Ctrl+Delete on xterm
  ['\x1b\x7f', 'backward-word'],   // Alt+Backspace (ESC + DEL)
  ['\x1b\x08', 'backward-word'],   // Alt+Backspace (ESC + legacy 0x08)
  ['\x1b[3~', 'forward'],          // Delete key
  ['\x7f', 'backward'],            // Backspace key
  ['\x08', 'backward'],            // Backspace key (legacy encoding)
]

/** Map the leading bytes of `raw` to a delete intent, or null when not a delete key. */
export function classifyDeleteSequence(raw: string): { intent: DeleteIntent; length: number } | null {
  for (const [seq, intent] of DELETE_SEQUENCES) {
    if (raw.startsWith(seq)) return { intent, length: seq.length }
  }
  return null
}

// ─── Surrogate-aware cursor helpers (also used by the composer) ─────────────

export function clampCursor(text: string, cursor: number): number {
  let at = Math.max(0, Math.min(text.length, cursor))
  while (at > 0 && at < text.length && /[\uDC00-\uDFFF]/.test(text[at])) at--
  return at
}

export function previousCursorBoundary(text: string, cursor: number): number {
  const at = clampCursor(text, cursor)
  if (at <= 0) return 0
  const code = text.charCodeAt(at - 1)
  return at - (code >= 0xDC00 && code <= 0xDFFF ? 2 : 1)
}

export function nextCursorBoundary(text: string, cursor: number): number {
  const at = clampCursor(text, cursor)
  if (at >= text.length) return text.length
  const code = text.charCodeAt(at)
  return at + (code >= 0xD800 && code <= 0xDBFF ? 2 : 1)
}

/** Backward-word boundary: skip trailing whitespace, then the word before it. */
function backwardWordBoundary(text: string, at: number): number {
  let i = at
  while (i > 0 && /\s/.test(text[i - 1])) i--
  while (i > 0 && !/\s/.test(text[i - 1])) i--
  return i
}

/** Forward-word boundary: skip leading whitespace, then the word after it. */
function forwardWordBoundary(text: string, at: number): number {
  let i = at
  while (i < text.length && /\s/.test(text[i])) i++
  while (i < text.length && !/\s/.test(text[i])) i++
  return i
}

/** Apply a delete intent to `text` at `cursor`, returning the new text/cursor. */
export function applyDeleteIntent(
  text: string,
  cursor: number,
  intent: DeleteIntent,
): { text: string; cursor: number } {
  const at = clampCursor(text, cursor)
  switch (intent) {
    case 'backward': {
      if (at <= 0) return { text, cursor: at }
      const prev = previousCursorBoundary(text, at)
      return { text: text.slice(0, prev) + text.slice(at), cursor: prev }
    }
    case 'forward': {
      if (at >= text.length) return { text, cursor: at }
      const next = nextCursorBoundary(text, at)
      return { text: text.slice(0, at) + text.slice(next), cursor: at }
    }
    case 'backward-word': {
      const start = backwardWordBoundary(text, at)
      if (start === at) return { text, cursor: at }
      return { text: text.slice(0, start) + text.slice(at), cursor: start }
    }
    case 'forward-word': {
      const end = forwardWordBoundary(text, at)
      if (end === at) return { text, cursor: at }
      return { text: text.slice(0, at) + text.slice(end), cursor: at }
    }
  }
}

/**
 * Owns the physical Backspace/Delete keys for one input component. Because Ink
 * reports the Backspace key (0x7f) and the Delete key (ESC[3~) as the same
 * `key.delete`, a useInput handler must not treat a plain `key.delete` as a
 * backward delete — this hook resolves the intent from the raw stdin bytes and
 * calls `onDelete` instead.
 *
 * `enabled` mirrors the field's focus: when false the hook stays silent so
 * Backspace/Del pass through to other handlers (e.g. a parent list that uses
 * Backspace to go back).
 */
export function useDeleteKeyCapture(
  enabled: boolean,
  onDelete: (intent: DeleteIntent) => void,
): void {
  const { internal_eventEmitter } = useStdin()
  const enabledRef = useRef(enabled)
  const onDeleteRef = useRef(onDelete)
  enabledRef.current = enabled
  onDeleteRef.current = onDelete

  useEffect(() => {
    if (!internal_eventEmitter) return
    let buf = ''
    const handler = (chunk: unknown) => {
      buf += String(chunk)
      const m = classifyDeleteSequence(buf)
      if (m) {
        buf = buf.slice(m.length)
        if (enabledRef.current) onDeleteRef.current(m.intent)
      }
      // Keep buf only when it is a strict prefix of a delete sequence (a CSI
      // sequence split across reads, e.g. ESC then [3~), so a delete key still
      // matches on the next chunk while ordinary text / paste content is
      // released instead of accumulating ahead of the next keypress.
      let keep = ''
      for (const [seq] of DELETE_SEQUENCES) {
        if (seq.startsWith(buf)) { keep = buf; break }
      }
      buf = keep
    }
    internal_eventEmitter.on('input', handler)
    return () => { internal_eventEmitter.off('input', handler) }
  }, [internal_eventEmitter])
}
