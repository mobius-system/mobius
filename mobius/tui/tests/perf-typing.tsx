/**
 * Typing-latency benchmark (scratch, not part of the suite).
 *
 * Mounts ChatScreen on a REAL Ink render (custom stdout PassThrough so the
 * terminal isn't hijacked) and measures key→paint latency: from feeding a
 * keystroke into the input stream to the first stdout write that follows.
 *
 * A/B: with MOBIUS_TUI_DISABLE_PAINT_FLUSH=1 the immediate-paint flush hook
 * is disabled and Ink's stock 32ms throttle paces every keystroke paint.
 *
 * Run: npx tsx tests/perf-typing.tsx [history-count] [disable-flush]
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-tui-perf-'))
process.env.MOBIUS_TUI_HOME = TMP_HOME
process.env.MOBIUS_TUI_DISABLE_AIMUX = '1'

import React from 'react'
import { render } from 'ink'
import { ChatScreen } from '../src/components/Chat.js'
import { MobiusClient } from '../src/api.js'
import type { ReadyState } from '../src/components/PrepScreen.js'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const RS: any = (globalThis as any).ReadableStream
const enc = new TextEncoder()

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function longEntry(i: number) {
  const body = Array.from({ length: 8 }, (_, p) =>
    `第 ${i} 段第 ${p} 句：这是一段比较长的助手回答，用来模拟真实会话里的 markdown 文本与代码块。`).join('\n\n')
  return { type: 'assistant', uuid: `a-${i}`, message: { role: 'assistant', content: [{ type: 'text', text: body }] } }
}

async function bench(label: string, entryCount: number) {
  const client = new MobiusClient('http://mock.local', 'tok')
  const ready: ReadyState = {
    project: { id: 'p1', name: 'p' },
    issue: { id: 'i1', project_id: 'p1', title: 't' },
    prefs: { model: 'm', language: 'zh', excluded_skill_ids: [], excluded_memory_ids: [] },
  }
  const history = Array.from({ length: entryCount }, (_, i) => longEntry(i))
  let historySent = false
  ;(globalThis as any).fetch = ((url: any) => {
    const u = String(url)
    if (u.includes('/events')) {
      return new Response(new RS({
        start(c: any) {
          c.enqueue(enc.encode('event: subscribed\ndata: {"event":"subscribed"}\n\n'))
          if (!historySent) {
            historySent = true
            c.enqueue(enc.encode(`event: jsonl_history\ndata: ${JSON.stringify({ event: 'jsonl_history', entries: history })}\n\n`))
          }
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (u.endsWith('/api/sessions/s1/status')) return json({ session_id: 's1', alive: true, working: false })
    if (u.endsWith('/messages')) return json({ ok: true, session_id: 's1', turn_number: 1 })
    return json({ error: 'no' }, 404)
  }) as any

  // Custom stdin/stdout PassThroughs; the instances WeakMap is keyed by THIS
  // stdout, which is exactly what paint-flush looks up via useStdin().
  const fakeStdin = new PassThrough() as any
  // Ink enables raw mode only when stdin.isTTY; claim TTY with no-op raw-mode
  // (+ref/unref, which raw-mode enablement calls) so useInput subscribes and
  // keystrokes reach the Composer.
  fakeStdin.isTTY = true
  fakeStdin.setRawMode = () => {}
  fakeStdin.ref = () => {}
  fakeStdin.unref = () => {}
  const fakeStdout = new PassThrough() as any
  fakeStdout.columns = 100
  fakeStdout.rows = 30
  fakeStdout.isTTY = false
  let keyAt = 0
  let paints: number[] = []
  const realWrite = fakeStdout.write.bind(fakeStdout)
  fakeStdout.write = (...args: any[]) => {
    if (keyAt) paints.push(performance.now() - keyAt)
    return realWrite(...(args as [any, any?, (() => void)?]))
  }
  // Drain the output so the PassThrough never fills.
  fakeStdout.on('data', () => {})

  const instance = render(
    React.createElement(ChatScreen, {
      client, ready, webUserId: 'u', resumeSessionId: 's1',
      onClear: () => {}, onResume: () => {}, onQuit: () => {}, onLogout: () => {},
      onReconfigure: () => {}, onConfigCancel: () => {},
    }),
    { stdin: fakeStdin, stdout: fakeStdout, patchConsole: false },
  )
  await delay(500) // SSE connect + history replay

  const lat: number[] = []
  for (let i = 0; i < 12; i++) {
    paints = []
    keyAt = performance.now()
    fakeStdin.write('字')
    await delay(80)
    keyAt = 0
    lat.push(paints.length ? Math.min(...paints) : 999)
  }
  lat.sort((a, b) => a - b)
  instance.unmount()
  const median = lat[Math.floor(lat.length / 2)]
  const p90 = lat[Math.floor(lat.length * 0.9)]
  console.log(`${label} (${entryCount} 条历史): key→paint 中位 ${median.toFixed(1)}ms · p90 ${p90.toFixed(1)}ms · 样本 ${lat.map(t => t.toFixed(0)).join(',')}`)
}

async function main() {
  const count = Number(process.argv[2] ?? 300) || 300
  const disableFlush = process.argv[3] === 'noflush'
  process.env.MOBIUS_TUI_DISABLE_PAINT_FLUSH = disableFlush ? '1' : ''
  await bench(disableFlush ? '基线(无 flush)' : 'flush 生效 ', count)
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
}
main().catch(e => { console.error(e); process.exit(2) })
