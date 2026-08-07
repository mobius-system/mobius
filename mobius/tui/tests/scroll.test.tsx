/**
 * Chat viewport regression: history paging and live terminal resizing.
 *
 * The chat caps the transcript to the terminal height and (because Ink redraws
 * only the live frame) the terminal's own scrollback holds no past turns, so
 * older messages used to be unreachable. The fix is an in-app pager: PageUp
 * scrolls back through history, PageDown forward, with a "stick to latest"
 * rule so the conversation auto-follows again once you page back to the bottom.
 *
 * It also emits real stdout resize events after a long transcript is present.
 * The dynamic tree must refit the visible records without duplicating or
 * corrupting the fixed header, composer, and status rows.
 *
 * Run:  npm run test:scroll
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-tui-scroll-'))
process.env.MOBIUS_TUI_HOME = TMP_HOME

import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../src/App.js'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const RS: any = (globalThis as any).ReadableStream
const enc = new TextEncoder()
let sseController: any = null

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function emitEntry(n: number) {
  // distinct uuid per entry so useChat's de-dup keeps every one
  const payload = { event: 'jsonl_entry', session_id: SID, entry: { type: 'assistant', uuid: `a-${n}`, message: { role: 'assistant', content: [{ type: 'text', text: `回答 ${n}` }] } } }
  sseController?.enqueue(enc.encode(`event: jsonl_entry\ndata: ${JSON.stringify(payload)}\n\n`))
}

let pass = 0, fail = 0
function ok(c: boolean, m: string) { c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.error(`  ✗ ${m}`)) }
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
const answerCount = (s: string) => (strip(s).match(/回答 \d+/g) ?? []).length

function resize(stdout: NodeJS.WriteStream, columns: number, rows: number) {
  Object.defineProperty(stdout, 'columns', { configurable: true, value: columns })
  Object.defineProperty(stdout, 'rows', { configurable: true, value: rows })
  Object.defineProperty(stdout, 'isTTY', { configurable: true, value: true })
  stdout.emit('resize')
}

const PID = 'proj-1', IID = 'issue-1', SID = 'sess-1'

function mockFetch(url: string, init?: RequestInit): Response {
  if (url.includes('/events')) {
    return new Response(new RS({
      start(c: any) {
        sseController = c
        c.enqueue(enc.encode('event: subscribed\ndata: {"event":"subscribed"}\n\n'))
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const method = init?.method ?? 'GET'
  if (url.endsWith('/api/auth/config')) return json({ password_required: false })
  if (url.endsWith('/api/auth/me')) return json({ id: 'tester', display_name: 'Test User', role: 'admin', work_dir: '/tmp' })
  if (url.endsWith('/api/auth/login')) return json({ token: 'mock-jwt-token', user: { id: 'tester', display_name: 'Test User', role: 'admin' } })
  if (url.includes('/aimux_bridge/api/remotes/') && url.includes('/connection')) {
    const m = url.match(/remotes\/([^/]+)\/connection/)
    return json({ identifier: m ? decodeURIComponent(m[1]) : 'x', event_stream_connected: true })
  }
  if (url.includes('/sessions') && url.includes('/issues') && method === 'POST') return json({ session_id: SID })
  if (url.includes('/sessions') && url.includes('/issues') && method === 'GET') return json([])
  if (url.endsWith('/messages') && method === 'POST') return json({ ok: true, session_id: SID, turn_number: 1 }) // keep SSE alive
  if (url.endsWith(`/api/sessions/${SID}/status`)) return json({ session_id: SID, alive: true, working: false })
  if (url.includes('/api/projects/') && url.includes('/issues') && method === 'POST') return json({ id: IID, project_id: PID, title: '命令行任务' })
  if (url.includes('/api/projects/') && url.includes('/issues') && method === 'GET') return json([])
  if (url.includes('/api/projects') && method === 'GET') return json([{ id: PID, name: '已有项目甲' }])
  if (url.endsWith('/api/projects') && method === 'POST') return json({ id: PID, name: '测试项目PTY' })
  if (url.includes('/sessions/model-options')) return json([{ key: 'codex', label: 'GPT-5.5', title: 'GPT-5.5', sub: 'Codex', backend: 'tmux-codex' }])
  if (url.includes('/sessions/default-model')) return json({ model: 'codex' })
  if (url.includes('/skills')) return json([])
  if (url.includes('/memories')) return json([])
  return json({ error: `unmocked ${method} ${url}` }, 404)
}

async function waitFor(lastFrame: () => string | undefined, needle: string, timeoutMs = 6000) {
  for (let i = 0; i < timeoutMs / 50; i++) {
    if ((strip(lastFrame() ?? '')).includes(needle)) return true
    await delay(50)
  }
  return false
}

// Walk the prep wizard (project → issue → model → language) into the chat.
async function bootToChat(stdin: any, lastFrame: () => string | undefined) {
  ok(await waitFor(lastFrame, '选择当前路径的绑定项目'), 'booted into project picker')
  stdin.write('\r'); await delay(120)
  ok(await waitFor(lastFrame, '项目名称'), 'project create wizard opened')
  stdin.write('测试项目PTY'); await delay(120)
  stdin.write('\r'); await delay(300)
  ok(await waitFor(lastFrame, '创建新任务'), 'issue picker shown')
  stdin.write('\r'); await delay(120)
  ok(await waitFor(lastFrame, '输入任务名称'), 'issue name wizard opened')
  stdin.write('命令行任务'); await delay(120)
  stdin.write('\r'); await delay(300)
  ok(await waitFor(lastFrame, '选择模型'), 'model picker shown')
  stdin.write('\r'); await delay(250)
  ok(await waitFor(lastFrame, '选择回复语言'), 'language picker shown')
  stdin.write('\r'); await delay(400)
  ok(await waitFor(lastFrame, '输入问题'), 'entered chat')
}

async function populateTranscript(stdin: any, emit: (n: number) => void, count = 25) {
  stdin.write('hi'); await delay(120)
  stdin.write('\r'); await delay(400)                     // creates session → SSE connects
  for (let i = 0; i < count; i++) { emit(i); await delay(15) }
  await delay(500)
}

async function main() {
  fs.writeFileSync(path.join(TMP_HOME, 'login.json'), JSON.stringify({
    server: 'http://mock.local', username: 'tester', token: 'mock-jwt-token',
    user: { id: 'tester', display_name: 'Test User', role: 'admin' },
  }))
  const realFetch = globalThis.fetch
  globalThis.fetch = ((u: any, init?: any) => mockFetch(String(u), init)) as unknown as typeof fetch

  console.log('\n[SCROLL] in-app history pager (mocked backend)\n')
  const { stdin, stdout, lastFrame, unmount } = render(React.createElement(App))

  try {
    // ── boot through the prep wizard into chat ────────────────────────────────
    await bootToChat(stdin, lastFrame)

    // ── populate a long transcript ────────────────────────────────────────────
    await populateTranscript(stdin, emitEntry)
    const tailFrame = strip(lastFrame() ?? '')

    ok(tailFrame.includes('回答 24'), 'latest entry visible at tail (not hidden)')
    ok(tailFrame.includes('PageUp'), 'older-records hint offers PageUp (nothing is silently lost)')

    // ── live resize: refit one dynamic frame, never retain old-width output ──
    resize(stdout as unknown as NodeJS.WriteStream, 52, 18)
    await delay(300)
    const narrowFrame = strip(lastFrame() ?? '')
    const narrowAnswers = answerCount(narrowFrame)
    ok(narrowFrame.includes('回答 24'), 'narrow resize keeps the latest reply visible')
    ok(narrowFrame.includes('Mobius') && narrowFrame.includes('输入问题或 / 命令') && narrowFrame.includes('web ·'), 'narrow resize preserves header, composer, and status')
    ok((narrowFrame.match(/>_ Mobius/g) ?? []).length === 1, 'narrow resize leaves exactly one dynamic header')

    resize(stdout as unknown as NodeJS.WriteStream, 100, 36)
    await delay(300)
    const tallFrame = strip(lastFrame() ?? '')
    const tallAnswers = answerCount(tallFrame)
    ok(tallFrame.includes('回答 24'), 'larger resize keeps the latest reply visible')
    ok(tallAnswers > narrowAnswers, 'larger resize reveals more history in the same viewport')
    ok((tallFrame.match(/>_ Mobius/g) ?? []).length === 1, 'larger resize still has one dynamic header')

    // The "↑ 还有 N 条较早记录" hint must be pinned to the FIRST line below the
    // header and span the full width — it must not float mid-transcript when the
    // viewport has spare rows (regression for real terminals, which bound the
    // transcript box height via stdout.isTTY).
    const tallLines = tallFrame.split('\n')
    const hintIdx = tallLines.findIndex(l => l.includes('较早记录'))
    ok(hintIdx === 1, `older-records hint is the first line under the header (line ${hintIdx}, expected 1)`)
    const messageRows = tallLines.slice(hintIdx + 1).filter(line => line.trim())
    ok(messageRows.length > 0 && messageRows[0].includes('⋯'), 'older message tail is visible immediately after the history hint')

    // ── PageUp: viewport scrolls back over history ────────────────────────────
    stdin.write('\x1b[5~')                                   // PageUp
    await delay(300)
    const upFrame = strip(lastFrame() ?? '')
    ok(upFrame.includes('PageDown'), 'after PageUp: a PageDown hint appears (scrolled up)')
    ok(!upFrame.includes('回答 24'), 'after PageUp: latest entry paged out of view')
    ok(/回答 \d+/.test(upFrame), 'after PageUp: an older entry is visible')

    // ── PageDown: snaps back to the latest ────────────────────────────────────
    stdin.write('\x1b[6~')                                   // PageDown
    await delay(300)
    const downFrame = strip(lastFrame() ?? '')
    ok(downFrame.includes('回答 24'), 'after PageDown: latest entry back in view')

    // ── Mouse wheel: SGR wheel events drive the same pager ────────────────────
    stdin.write('\x1b[<64;5;5M')                             // wheel up = scroll back
    await delay(300)
    const wheelUp = strip(lastFrame() ?? '')
    ok(wheelUp.includes('PageDown'), 'wheel up: a PageDown hint appears (scrolled back)')
    ok(!wheelUp.includes('回答 24'), 'wheel up: latest entry paged out of view')
    ok(/回答 \d+/.test(wheelUp), 'wheel up: an older entry is visible')

    stdin.write('\x1b[<65;5;5M')                             // wheel down = scroll forward
    await delay(300)
    const wheelDown = strip(lastFrame() ?? '')
    ok(wheelDown.includes('回答 24'), 'wheel down: latest entry back in view')

    // ── Mouse wheel (legacy X10 encoding, terminals without SGR 1006) ────────
    // wheel up: ESC [ M Cb Cx Cy, Cb = button + 32 → 0x60 (96); coords at 18,18
    stdin.write('\x1b[M' + String.fromCharCode(96, 50, 50))
    await delay(300)
    const legacyUp = strip(lastFrame() ?? '')
    ok(legacyUp.includes('PageDown'), 'legacy wheel up: a PageDown hint appears (scrolled back)')
    ok(!legacyUp.includes('回答 24'), 'legacy wheel up: latest entry paged out of view')

    stdin.write('\x1b[M' + String.fromCharCode(97, 50, 50))  // wheel down Cb = 0x61
    await delay(300)
    const legacyDown = strip(lastFrame() ?? '')
    ok(legacyDown.includes('回答 24'), 'legacy wheel down: latest entry back in view')
  } finally {
    unmount()
    globalThis.fetch = realFetch
  }

  // ── Phase 2: MOBIUS_TUI_DISABLE_MOUSE=1 opts out of wheel mode ─────────────
  // Mouse reporting hands the terminal mouse to the app, which disables native
  // drag-select. The env flag is the escape hatch: wheel stops, selection is
  // free again. Here we assert wheel events no longer scroll the pager. A fresh
  // MOBIUS_TUI_HOME is used because phase 1 persisted a dir→project binding.
  const TMP_HOME2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-tui-scroll2-'))
  process.env.MOBIUS_TUI_DISABLE_MOUSE = '1'
  process.env.MOBIUS_TUI_HOME = TMP_HOME2
  fs.writeFileSync(path.join(TMP_HOME2, 'login.json'), JSON.stringify({
    server: 'http://mock.local', username: 'tester', token: 'mock-jwt-token',
    user: { id: 'tester', display_name: 'Test User', role: 'admin' },
  }))
  globalThis.fetch = ((u: any, init?: any) => mockFetch(String(u), init)) as unknown as typeof fetch
  const second = render(React.createElement(App))
  try {
    await bootToChat(second.stdin, second.lastFrame)
    await populateTranscript(second.stdin, emitEntry)
    const before = strip(second.lastFrame() ?? '')
    ok(before.includes('回答 24'), 'disable-mouse: latest entry visible before wheel')

    second.stdin.write('\x1b[<64;5;5M')                    // wheel up — must be ignored
    await delay(300)
    const after = strip(second.lastFrame() ?? '')
    ok(after.includes('回答 24'), 'disable-mouse: wheel up leaves latest entry in view')
    ok(!after.includes('PageDown'), 'disable-mouse: wheel up does NOT scroll (no PageDown hint)')
  } finally {
    second.unmount()
    delete process.env.MOBIUS_TUI_DISABLE_MOUSE
    delete process.env.MOBIUS_TUI_HOME
    globalThis.fetch = realFetch
    try { fs.rmSync(TMP_HOME2, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
  console.log(`\n==== SCROLL RESULT: ${pass} passed, ${fail} failed ====\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(2) })
