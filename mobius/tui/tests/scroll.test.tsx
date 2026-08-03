/**
 * Scroll pager regression — "回答问题后把一切都隐藏了，请不要隐藏，支持向上翻页查看".
 *
 * The chat caps the transcript to the terminal height and (because Ink redraws
 * only the live frame) the terminal's own scrollback holds no past turns, so
 * older messages used to be unreachable. The fix is an in-app pager: PageUp
 * scrolls back through history, PageDown forward, with a "stick to latest"
 * rule so the conversation auto-follows again once you page back to the bottom.
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

async function main() {
  fs.writeFileSync(path.join(TMP_HOME, 'login.json'), JSON.stringify({
    server: 'http://mock.local', username: 'tester', token: 'mock-jwt-token',
    user: { id: 'tester', display_name: 'Test User', role: 'admin' },
  }))
  const realFetch = globalThis.fetch
  globalThis.fetch = ((u: any, init?: any) => mockFetch(String(u), init)) as unknown as typeof fetch

  console.log('\n[SCROLL] in-app history pager (mocked backend)\n')
  const { stdin, lastFrame, unmount } = render(React.createElement(App))

  try {
    // ── boot through the prep wizard into chat ────────────────────────────────
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

    // ── populate a long transcript ────────────────────────────────────────────
    stdin.write('hi'); await delay(120)
    stdin.write('\r'); await delay(400)                      // creates session → SSE connects
    for (let i = 0; i < 25; i++) { emitEntry(i); await delay(15) }
    await delay(500)
    const tailFrame = strip(lastFrame() ?? '')

    ok(tailFrame.includes('回答 24'), 'latest entry visible at tail (not hidden)')
    ok(tailFrame.includes('PageUp'), 'older-records hint offers PageUp (nothing is silently lost)')

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
  } finally {
    unmount()
    globalThis.fetch = realFetch
  }

  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
  console.log(`\n==== SCROLL RESULT: ${pass} passed, ${fail} failed ====\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(2) })
