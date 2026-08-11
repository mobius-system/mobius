/** Raw terminal cursor-key capture for keys Ink does not expose in `Key`. */

import { useEffect, useRef } from 'react'
import { useStdin } from 'ink'

export type CursorIntent = 'home' | 'end' | 'backward-word' | 'forward-word'

// Home/End vary by terminal/application mode. Ctrl+Left/Right are the xterm
// CSI modifier-5 forms; the shorter 5D/5C forms are emitted by some tmux and
// ConPTY bridges. Longest sequences come first so prefixes cannot win early.
const CURSOR_SEQUENCES: ReadonlyArray<readonly [string, CursorIntent]> = [
  ['\x1b[1;5D', 'backward-word'],
  ['\x1b[1;5C', 'forward-word'],
  ['\x1b[5D', 'backward-word'],
  ['\x1b[5C', 'forward-word'],
  ['\x1b[1~', 'home'],
  ['\x1b[7~', 'home'],
  ['\x1b[4~', 'end'],
  ['\x1b[8~', 'end'],
  ['\x1b[H', 'home'],
  ['\x1b[F', 'end'],
  ['\x1bOH', 'home'],
  ['\x1bOF', 'end'],
]

export function classifyCursorSequence(raw: string): { intent: CursorIntent; length: number } | null {
  for (const [sequence, intent] of CURSOR_SEQUENCES) {
    if (raw.startsWith(sequence)) return { intent, length: sequence.length }
  }
  return null
}

function isCursorPrefix(raw: string): boolean {
  return CURSOR_SEQUENCES.some(([sequence]) => sequence.startsWith(raw))
}

/** Capture physical Home/End and Ctrl+arrow bytes without relying on Ink's lossy key object. */
export function useCursorKeyCapture(
  enabled: boolean,
  onCursor: (intent: CursorIntent) => void,
): void {
  const { internal_eventEmitter } = useStdin()
  const enabledRef = useRef(enabled)
  const onCursorRef = useRef(onCursor)
  enabledRef.current = enabled
  onCursorRef.current = onCursor

  useEffect(() => {
    if (!internal_eventEmitter) return
    let buf = ''
    const handler = (chunk: unknown) => {
      buf += String(chunk)
      while (buf) {
        const match = classifyCursorSequence(buf)
        if (match) {
          buf = buf.slice(match.length)
          if (enabledRef.current) onCursorRef.current(match.intent)
          continue
        }
        if (isCursorPrefix(buf)) break
        // Ordinary text is handled by Ink's useInput; only retain a possible
        // incomplete escape prefix so split terminal sequences still match.
        const nextEsc = buf.indexOf('\x1b', buf.startsWith('\x1b') ? 1 : 0)
        buf = nextEsc >= 0 ? buf.slice(nextEsc) : ''
      }
    }
    internal_eventEmitter.on('input', handler)
    return () => { internal_eventEmitter.off('input', handler) }
  }, [internal_eventEmitter])
}
