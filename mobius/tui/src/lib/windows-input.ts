import { Transform } from 'node:stream'

const ENABLE_WIN32_INPUT_MODE = '\x1b[?9001h'
const DISABLE_WIN32_INPUT_MODE = '\x1b[?9001l'

const WIN32_KEY_RECORD_RE = /^\x1b\[(\d*);(\d*);(\d*);(\d*);(\d*);(\d*)_/

/**
 * Decode Windows Terminal's win32-input-mode KEY_EVENT_RECORD sequences back
 * into the VT input Ink expects. This preserves modifiers that legacy ConPTY
 * input loses, most importantly the distinction between Enter and Shift+Enter.
 */
export class WindowsInputDecoder {
  private buffer = ''

  get hasPendingInput(): boolean {
    return this.buffer.length > 0
  }

  push(chunk: string): string {
    this.buffer += chunk
    let output = ''

    while (this.buffer) {
      const start = this.buffer.indexOf('\x1b[')
      if (start < 0) {
        if (this.buffer.endsWith('\x1b')) {
          output += this.buffer.slice(0, -1)
          this.buffer = '\x1b'
        } else {
          output += this.buffer
          this.buffer = ''
        }
        break
      }

      output += this.buffer.slice(0, start)
      this.buffer = this.buffer.slice(start)
      const match = WIN32_KEY_RECORD_RE.exec(this.buffer)
      if (match) {
        this.buffer = this.buffer.slice(match[0].length)
        output += translateWindowsKeyRecord(match.slice(1))
        continue
      }

      if (isPartialWindowsKeyRecord(this.buffer)) break

      // A normal VT sequence (arrows, mouse, paste markers, and so on) is not
      // part of win32-input-mode. Release its ESC byte and scan the remainder.
      output += this.buffer[0]
      this.buffer = this.buffer.slice(1)
    }

    return output
  }

  flush(): string {
    const remainder = this.buffer
    this.buffer = ''
    return remainder
  }
}

function isPartialWindowsKeyRecord(value: string): boolean {
  if (value === '\x1b' || value === '\x1b[') return true
  if (!value.startsWith('\x1b[')) return false
  const body = value.slice(2)
  return /^[\d;]*$/.test(body) && body.split(';').length <= 6
}

function numberParam(value: string | undefined, fallback: number): number {
  return value === undefined || value === '' ? fallback : Number(value)
}

function translateWindowsKeyRecord(params: string[]): string {
  const virtualKey = numberParam(params[0], 0)
  const unicode = numberParam(params[2], 0)
  const keyDown = numberParam(params[3], 1) !== 0
  const controlState = numberParam(params[4], 0)
  const repeat = Math.max(1, Math.min(100, numberParam(params[5], 1)))
  if (!keyDown) return ''

  const shift = (controlState & 0x0010) !== 0
  const leftAlt = (controlState & 0x0002) !== 0
  const rightAlt = (controlState & 0x0001) !== 0
  const leftCtrl = (controlState & 0x0008) !== 0
  const altGr = rightAlt && leftCtrl

  // Modifier-only records carry no text and must not leak into the composer.
  if (unicode === 0 && [0x10, 0x11, 0x12, 0x14, 0x5b, 0x5c].includes(virtualKey)) return ''

  let encoded = ''
  if (virtualKey === 0x0d) {
    encoded = shift ? '\x1b[13;2u' : '\r'
  } else if (virtualKey === 0x08) {
    encoded = '\x7f'
  } else if (virtualKey === 0x09) {
    encoded = shift ? '\x1b[Z' : '\t'
  } else if (virtualKey === 0x1b) {
    encoded = '\x1b'
  } else if (unicode !== 0) {
    encoded = String.fromCharCode(unicode)
    if ((leftAlt || rightAlt) && !altGr) encoded = `\x1b${encoded}`
  } else {
    encoded = virtualKeySequence(virtualKey, controlState)
  }

  return encoded.repeat(repeat)
}

function virtualKeySequence(virtualKey: number, controlState: number): string {
  const shift = (controlState & 0x0010) !== 0
  const alt = (controlState & 0x0003) !== 0
  const ctrl = (controlState & 0x000c) !== 0
  const modifier = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)
  const suffix = modifier === 1 ? '' : `1;${modifier}`
  const csiLetter: Record<number, string> = {
    0x23: 'F', 0x24: 'H', 0x25: 'D', 0x26: 'A',
    0x27: 'C', 0x28: 'B',
  }
  if (csiLetter[virtualKey]) return `\x1b[${suffix}${csiLetter[virtualKey]}`

  const csiTilde: Record<number, number> = {
    0x21: 5, 0x22: 6, 0x2d: 2, 0x2e: 3,
    0x74: 15, 0x75: 17, 0x76: 18, 0x77: 19,
    0x78: 20, 0x79: 21, 0x7a: 23, 0x7b: 24,
  }
  if (csiTilde[virtualKey]) {
    const code = csiTilde[virtualKey]
    return modifier === 1 ? `\x1b[${code}~` : `\x1b[${code};${modifier}~`
  }

  const ss3: Record<number, string> = { 0x70: 'P', 0x71: 'Q', 0x72: 'R', 0x73: 'S' }
  if (ss3[virtualKey]) return modifier === 1 ? `\x1bO${ss3[virtualKey]}` : `\x1b[1;${modifier}${ss3[virtualKey]}`
  return ''
}

/** Use a translating stdin only on a real Windows TTY; other platforms remain untouched. */
export function createInkInputStream(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): NodeJS.ReadStream {
  if (process.platform !== 'win32' || !input.isTTY) return input

  const decoder = new WindowsInputDecoder()
  let modeEnabled = false
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  const translated = new Transform({
    transform(chunk, _encoding, callback) {
      if (pendingTimer) clearTimeout(pendingTimer)
      const decoded = decoder.push(String(chunk))
      if (decoder.hasPendingInput) {
        // An unsupported terminal still sends a legacy standalone Esc. Give a
        // split win32 record one event-loop beat to finish, then release it.
        pendingTimer = setTimeout(() => {
          pendingTimer = null
          translated.push(decoder.flush())
        }, 15)
      }
      callback(null, decoded)
    },
    flush(callback) {
      if (pendingTimer) clearTimeout(pendingTimer)
      callback(null, decoder.flush())
    },
  }) as Transform & Partial<NodeJS.ReadStream>

  Object.defineProperty(translated, 'isTTY', { value: true })
  Object.defineProperty(translated, 'isRaw', { get: () => input.isRaw })
  translated.setRawMode = (enabled: boolean) => {
    input.setRawMode?.(enabled)
    if (enabled !== modeEnabled) {
      output.write(enabled ? ENABLE_WIN32_INPUT_MODE : DISABLE_WIN32_INPUT_MODE)
      modeEnabled = enabled
    }
    return translated as NodeJS.ReadStream
  }
  translated.ref = () => { input.ref(); return translated as NodeJS.ReadStream }
  translated.unref = () => { input.unref(); return translated as NodeJS.ReadStream }

  input.pipe(translated)
  process.once('exit', () => {
    if (modeEnabled) output.write(DISABLE_WIN32_INPUT_MODE)
  })
  return translated as NodeJS.ReadStream
}
