/**
 * Reconnect regression — "TUI 输入经常显示两次" (input often renders twice).
 *
 * Root cause: the optimistic `pendingUser` placeholder is cleared on the live
 * `jsonl_entry` path but NOT when the same message is delivered via a reconnect's
 * `jsonl_history` replay. Behind a reverse proxy (nginx idle timeout) the SSE
 * stream drops mid-turn and auto-reconnects; the reconnect replays the session
 * tail — which now contains the just-sent user message — so it lands in `entries`
 * while `pendingUser` is still set, and the user's input is shown twice. If the
 * whole turn finished while disconnected, no live entry ever arrives to clear the
 * placeholder, so the duplication persists until the next send.
 *
 * This test drops the SSE stream right after the user sends "good" and has the
 * reconnect replay history containing that user entry, then asserts "good" is
 * rendered exactly once. Without the fix it renders twice.
 *
 * Run:  npm run test:reconnect
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-tui-reconnect-'))
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

let pass = 0, fail = 0
function ok(c: boolean, m: string) { c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.error(`  ✗ ${m}`)) }

const PID = 'proj-1', IID = 'issue-1', SID = 'sess-1'
let connectCount = 0
// Entries the next SSE connect should replay as jsonl_history (simulates the
// server's tail snapshot on reconnect containing the just-persisted user turn).
let pendingHistory: any[] = []

function mockFetch(url: string, init?: RequestInit): Response {
  // ── SSE: a fresh stream per connect. Reconnects (connect >= 2) replay history. ─
  if (url.includes('/events')) {
    const n = ++connectCount
    return new Response(new RS({
      start(c: any) {
        sseController = c
        c.enqueue(enc.encode('event: subscribed\ndata: {"event":"subscribed"}\n\n'))
        if (n >= 2 && pendingHistory.length) {
          const payload = JSON.stringify({ event: 'jsonl_history', entries: pendingHistory, done: true })
          c.enqueue(enc.encode(`event: jsonl_history\ndata: ${payload}\n\n`))
        }
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const method = init?.method ?? 'GET'
  if (url.endsWith('/api/auth/config')) return json({ password_required: false })
  if (url.endsWith('/api/auth/me')) return json({ id: 'fuqingxu', display_name: '付清旭', role: 'admin', work_dir: '/tmp' })
  if (url.endsWith('/api/auth/login')) return json({ token: 'mock-jwt-token', user: { id: 'fuqingxu', display_name: '付清旭', role: 'admin' } })
  // aimux bridge probe — satisfy it so ensureSession doesn't loop for 8s.
  if (url.includes('/aimux_bridge/api/remotes/') && url.includes('/connection')) {
    const m = url.match(/remotes\/([^/]+)\/connection/)
    return json({ identifier: m ? decodeURIComponent(m[1]) : 'x', event_stream_connected: true })
  }
  if (url.includes('/sessions') && url.includes('/issues') && method === 'POST') return json({ session_id: SID })
  if (url.includes('/sessions') && url.includes('/issues') && method === 'GET') return json([])
  // Sending a message: persist it, then DROP the live stream so the only delivery
  // path is the reconnect's history replay (the exact scenario that double-rendered).
  if (url.endsWith('/messages') && method === 'POST') {
    pendingHistory = [{ type: 'user', uuid: 'user-good-1', message: { role: 'user', content: 'good' } }]
    setTimeout(() => { try { sseController?.close() } catch { /* ignore */ } }, 150)
    return json({ ok: true, session_id: SID, turn_number: 1 })
  }
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
    if ((lastFrame() ?? '').includes(needle)) return true
    await delay(50)
  }
  return false
}

/** Count non-overlapping occurrences of needle in s (after stripping ANSI codes). */
function countOccur(s: string, needle: string): number {
  const clean = s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  let n = 0, i = 0
  while ((i = clean.indexOf(needle, i)) !== -1) { n++; i += needle.length }
  return n
}

async function main() {
  fs.writeFileSync(path.join(TMP_HOME, 'login.json'), JSON.stringify({
    server: 'http://mock.local', username: 'fuqingxu', token: 'mock-jwt-token',
    user: { id: 'fuqingxu', display_name: '付清旭', role: 'admin' },
  }))
  const realFetch = globalThis.fetch
  globalThis.fetch = ((u: any, init?: any) => mockFetch(String(u), init)) as unknown as typeof fetch

  console.log('\n[RECONNECT] input-not-duplicated regression (mocked backend)\n')
  const { stdin, lastFrame, unmount } = render(React.createElement(App))

  try {
    // ── boot through the prep wizard into chat (same drive as flow.test) ─────────
    ok(await waitFor(lastFrame, '选择当前路径的绑定项目'), 'booted into project picker')
    stdin.write('\r'); await delay(120)
    ok(await waitFor(lastFrame, '项目名称'), 'project create wizard opened')
    stdin.write('测试项目PTY'); await delay(120)
    stdin.write('\r'); await delay(300)
    ok(await waitFor(lastFrame, '创建新任务'), 'issue picker shown')
    stdin.write('\r'); await delay(120)
    ok(await waitFor(lastFrame, '第 1 步'), 'issue name wizard opened')
    stdin.write('命令行任务'); await delay(120)
    stdin.write('\r'); await delay(120)
    ok(await waitFor(lastFrame, '第 2 步'), 'issue worktree wizard opened')
    stdin.write('\r'); await delay(300)
    ok(await waitFor(lastFrame, '选择模型'), 'model picker shown')
    stdin.write('\r'); await delay(250)
    ok(await waitFor(lastFrame, '选择回复语言'), 'language picker shown')
    stdin.write('\r'); await delay(400)
    ok(await waitFor(lastFrame, '输入问题'), 'entered chat')

    // ── the bug: send "good", SSE drops, reconnect replays it via history ───────
    connectCount = 0  // reset so the post-send reconnect is "connect 2"
    stdin.write('good'); await delay(120)
    stdin.write('\r')
    // The user's message shows instantly via the optimistic placeholder, so do NOT
    // gate on "good" appearing — gate on the reconnect actually firing (connect 2),
    // which is what replays history and (without the fix) double-renders the input.
    let reconnected = false
    for (let i = 0; i < 8000 / 50; i++) {
      if (connectCount >= 2) { reconnected = true; break }
      await delay(50)
    }
    ok(reconnected, 'SSE dropped and reconnected after the send')
    await delay(500)  // let the reconnect's history replay render

    const frame = lastFrame() ?? ''
    const occurrences = countOccur(frame, 'good')
    console.log(`  i occurrences of "good" in frame: ${occurrences}`)
    ok(occurrences === 1, `user input rendered exactly once (got ${occurrences}; would be 2 without the fix)`)
    if (occurrences !== 1) {
      console.log('── frame ──\n' + frame.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\n{3,}/g, '\n\n').trim())
    }
  } finally {
    unmount()
    globalThis.fetch = realFetch
  }

  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
  console.log(`\n==== RECONNECT RESULT: ${pass} passed, ${fail} failed ====\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(2) })
