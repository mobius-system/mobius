/**
 * Typing-latency optimizations against Ink 5.2's fixed render pipeline.
 *
 * Profiling a keystroke loop (node --cpu-prof) showed ~40% of typing time
 * inside Ink's per-paint `Output.get()`:
 *   stringWidth 13.5% + styledCharsFromTokens 12.4% + Output.get 6.4%
 *   + styledCharsToString 5.5% + diffAnsiCodes 3.4%
 *
 * Every paint rebuilds the whole frame: for each write-op line it applies
 * style transformers, tokenizes the ANSI-styled text into styled chars and
 * re-measures widths, then walks the full cell matrix back to a string.
 * While typing, 19 of 22 line strings are byte-identical across paints (only
 * the composer row changes), yet all are re-tokenized every time — that
 * repetition is the lag users feel.
 *
 * Two runtime patches below. Both verify Ink internals first and silently
 * no-op on mismatch (or when MOBIUS_TUI_DISABLE_PAINT_FLUSH=1):
 *
 * 1. usePaintFlushOnInput — Ink hardcodes `throttle(onRender, 32ms)`. React
 *    commits a key in <1ms; the paint can then wait out the throttle window.
 *    On each editing key we call the throttle's `flush()` right after the
 *    commit lands, so the frame paints in the same event-loop turn.
 *
 * 2. installStyledLineCache — replaces `Output.prototype.get` with a faithful
 *    reimplementation whose only difference is memoizing
 *    `styledCharsFromTokens(tokenize(line))` by the post-transform line
 *    string (the exact input tokenize receives, so cached results are
 *    byte-identical). Unchanged lines skip the tokenize+measure hot path,
 *    which is where the profiled ~40% lives.
 */

import { useEffect } from 'react'
import { useStdin, useStdout } from 'ink'

// ── 1. flush the render throttle right after each editing key ────────────────

type Flushable = { flush?: () => void }

/** Text-editing inputs that should paint immediately (typed text, Enter, backspace). */
function isEditingInput(input: string): boolean {
  if (!input) return false
  if (input === '\r' || input === '\n') return true
  if (input === '\x7f' || input === '\x08') return true
  // Anything without an ESC lead is typed text (or a paste chunk). Sequences
  // (arrows, mouse, bracketed paste) start with ESC and keep normal pacing.
  return !input.startsWith('\x1b')
}

export function usePaintFlushOnInput(): void {
  const { internal_eventEmitter } = useStdin()
  const { stdout } = useStdout()

  useEffect(() => {
    if (process.env.MOBIUS_TUI_DISABLE_PAINT_FLUSH === '1') return
    if (!internal_eventEmitter) return
    installStyledLineCache()
    const handler = (chunk: unknown) => {
      if (!isEditingInput(String(chunk))) return
      // React schedules the commit for this key on a setImmediate (scheduler's
      // Immediate priority). Flushing on a microtask would paint the STALE
      // frame before that commit lands. Schedule the flush for after the
      // commit: another setImmediate queued from here runs after the one
      // React already queued (FIFO within the same iteration).
      setImmediate(() => {
        try { getThrottledRender(stdout)?.flush?.() } catch { /* best-effort */ }
      })
    }
    internal_eventEmitter.on('input', handler)
    return () => { internal_eventEmitter.off('input', handler) }
  }, [internal_eventEmitter, stdout])
}

// ── Ink internals access ─────────────────────────────────────────────────────
// Ink's exports map blocks subpath imports ('ink/build/instances.js' →
// ERR_PACKAGE_PATH_NOT_EXPORTED), but `import.meta.resolve('ink')` yields the
// package entry file URL and the internal modules live next to it in the same
// build directory. Resolving relative to the entry keeps this working in any
// install layout (local node_modules, global npm prefix).

function inkModuleUrl(name: string): string {
  return new URL(name, new URL('.', (import.meta as any).resolve('ink') as string)).href
}

let cachedInstances: WeakMap<object, any> | null | undefined

function getThrottledRender(stdout: object): Flushable | null {
  if (cachedInstances === undefined) {
    cachedInstances = null
    void import(inkModuleUrl("instances.js"))
      .then(mod => { cachedInstances = mod.default })
      .catch(() => { /* keep null */ })
  }
  try {
    return cachedInstances?.get(stdout)?.rootNode?.onRender ?? null
  } catch {
    return null
  }
}

// ── 2. memoize styled-line tokenization across paints ────────────────────────

let cacheInstalled = false

export function installStyledLineCache(): void {
  if (cacheInstalled || process.env.MOBIUS_TUI_DISABLE_PAINT_FLUSH === '1') return
  cacheInstalled = true
  void (async () => {
    try {
      const [outputMod, at, widestLineMod, stringWidthMod, sliceAnsiMod]: any[] = await Promise.all([
        import(inkModuleUrl("output.js")),
        import('@alcalzone/ansi-tokenize'),
        import('widest-line'),
        import('string-width'),
        import('slice-ansi'),
      ])
      const OutputClass = outputMod.default
      const proto = OutputClass?.prototype
      if (!proto || typeof proto.get !== 'function' || typeof proto.write !== 'function') return
      if (typeof at.styledCharsFromTokens !== 'function' || typeof at.tokenize !== 'function') return
      const widestLine = widestLineMod.default
      const stringWidth = stringWidthMod.default
      const sliceAnsi = sliceAnsiMod.default

      // Fragile-internals guard: confirm the op shape this Ink version writes.
      const probe = new OutputClass({ width: 4, height: 2 })
      probe.write(0, 0, 'ab', { transformers: [] })
      const op = probe.operations?.[0]
      if (!op || op.type !== 'write' || typeof op.text !== 'string' || !Array.isArray(op.transformers)) return

      const cache = new Map<string, any[]>()
      const styledCharsOf = (line: string): any[] => {
        const hit = cache.get(line)
        if (hit) return hit
        const chars = at.styledCharsFromTokens(at.tokenize(line)) as any[]
        if (cache.size >= 4096) cache.clear() // bound memory; rebuilt lazily
        cache.set(line, chars)
        return chars
      }

      const origGet = proto.get
      proto.get = function (this: any) {
        // Faithful reimplementation of Ink 5.2.0 Output.get with one change:
        // the tokenize+styledCharsFromTokens result is memoized by the
        // post-transform line string. Everything else mirrors upstream.
        const output = []
        for (let y = 0; y < this.height; y++) {
          const row = []
          for (let x = 0; x < this.width; x++) {
            row.push({ type: 'char', value: ' ', fullWidth: false, styles: [] })
          }
          output.push(row)
        }
        const clips: any[] = []
        for (const operation of this.operations) {
          if (operation.type === 'clip') clips.push(operation.clip)
          if (operation.type === 'unclip') clips.pop()
          if (operation.type !== 'write') continue
          const { text, transformers } = operation
          let { x, y } = operation
          let lines = text.split('\n')
          const clip = clips.at(-1)
          if (clip) {
            const clipHorizontally = typeof clip?.x1 === 'number' && typeof clip?.x2 === 'number'
            const clipVertically = typeof clip?.y1 === 'number' && typeof clip?.y2 === 'number'
            if (clipHorizontally) {
              const width = widestLine(text)
              if (x + width < clip.x1 || x > clip.x2) continue
            }
            if (clipVertically) {
              const height = lines.length
              if (y + height < clip.y1 || y > clip.y2) continue
            }
            if (clipHorizontally) {
              lines = lines.map((line: string) => {
                const from = x < clip.x1 ? clip.x1 - x : 0
                const width = stringWidth(line)
                const to = x + width > clip.x2 ? clip.x2 - x : width
                return sliceAnsi(line, from, to)
              })
              if (x < clip.x1) x = clip.x1
            }
            if (clipVertically) {
              const from = y < clip.y1 ? clip.y1 - y : 0
              const height = lines.length
              const to = y + height > clip.y2 ? clip.y2 - y : height
              lines = lines.slice(from, to)
              if (y < clip.y1) y = clip.y1
            }
          }
          let offsetY = 0
          for (const [index, line0] of lines.entries()) {
            const currentLine = output[y + offsetY]
            if (!currentLine) continue
            let line = line0
            for (const transformer of transformers) line = transformer(line, index)
            const characters = styledCharsOf(line)
            let offsetX = x
            for (const character of characters) {
              currentLine[offsetX] = character
              const isWideCharacter = character.fullWidth || character.value.length > 1
              if (isWideCharacter) {
                currentLine[offsetX + 1] = {
                  type: 'char', value: '', fullWidth: false, styles: character.styles,
                }
              }
              offsetX += isWideCharacter ? 2 : 1
            }
            offsetY++
          }
        }
        const generatedOutput = output
          .map(line => {
            const lineWithoutEmptyItems = line.filter((item: unknown) => item !== undefined)
            return at.styledCharsToString(lineWithoutEmptyItems).trimEnd()
          })
          .join('\n')
        return { output: generatedOutput, height: output.length }
      }
      // Keep a handle for tests/debugging; origGet unused beyond the guard.
      void origGet
    } catch { /* keep stock behavior */ }
  })()
}
