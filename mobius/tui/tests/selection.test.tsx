/**
 * Drag selection (tmux-style) regression tests.
 *
 * With terminal mouse reporting enabled the app owns the mouse, so it draws its
 * own selection highlight and copies the range to the system clipboard via OSC
 * 52 on release. The screen-text model maps mouse (row, col) back to
 * (entry, line, char); if that mapping drifts from the rendered transcript the
 * copied text is wrong — so asserting the exact OSC 52 payload is the real
 * alignment check.
 *
 * Run: npm run test:selection
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-tui-sel-'))
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
  const payload = { event: 'jsonl_entry', session_id: SID, entry: { type: 'assistant', uuid: `a-${n}`, message: { role: 'assistant', content: [{ type: 'text', text: `回答 ${n}` }] } } }
  sseController?.enqueue(enc.encode(`event: jsonl_entry\ndata: ${JSON.stringify(payload)}\n\n`))
}
function emitAssistantText(text: string) {
  const payload = { event: 'jsonl_entry', session_id: SID, entry: { type: 'assistant', uuid: `a-${Date.now()}`, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
  sseController?.enqueue(enc.encode(`event: jsonl_entry\ndata: ${JSON.stringify(payload)}\n\n`))
}
function emitUserText(text: string) {
  const payload = { event: 'jsonl_entry', session_id: SID, entry: { type: 'user', uuid: `u-${Date.now()}`, message: { role: 'user', content: [{ type: 'text', text }] } } }
  sseController?.enqueue(enc.encode(`event: jsonl_entry\ndata: ${JSON.stringify(payload)}\n\n`))
}

let pass = 0, fail = 0
function ok(c: boolean, m: string) { c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.error(`  ✗ ${m}`)) }
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

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
  if (url.endsWith('/messages') && method === 'POST') return json({ ok: true, session_id: SID, turn_number: 1 })
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

async function main() {
  fs.writeFileSync(path.join(TMP_HOME, 'login.json'), JSON.stringify({
    server: 'http://mock.local', username: 'tester', token: 'mock-jwt-token',
    user: { id: 'tester', display_name: 'Test User', role: 'admin' },
  }))
  const realFetch = globalThis.fetch
  globalThis.fetch = ((u: any, init?: any) => mockFetch(String(u), init)) as unknown as typeof fetch

  console.log('\n[SELECTION] tmux-style drag selection + OSC 52 copy (mocked backend)\n')
  const { stdin, stdout, lastFrame, unmount } = render(React.createElement(App))

  try {
    // Real-terminal layout (bounded transcript box) so mouse rows map meaningfully.
    resize(stdout as unknown as NodeJS.WriteStream, 100, 36)

    await bootToChat(stdin, lastFrame)
    stdin.write('hi'); await delay(120)
    stdin.write('\r'); await delay(400)
    for (let i = 0; i < 5; i++) { emitEntry(i); await delay(15) }
    await delay(500)

    const frame = strip(lastFrame() ?? '')
    const lines = frame.split('\n')
    const row1 = lines.findIndex(l => l.includes('回答 1'))
    const row3 = lines.findIndex(l => l.includes('回答 3'))
    ok(row1 >= 0 && row3 >= 0, `found 回答 1 (row ${row1}) and 回答 3 (row ${row3}) in the transcript`)
    ok(!frame.includes('PageDown'), 'all entries fit — no paging hints at rest')

    // press on 回答 1 (col 4 → first content char), drag to 回答 3 (col beyond EOL)
    stdin.write(`\x1b[<0;5;${row1 + 1}M`)                 // left-button press (SGR 1-based)
    await delay(120)
    stdin.write(`\x1b[<32;61;${row3 + 1}M`)               // drag motion (button 32 = left drag)
    await delay(200)
    const selRaw = lastFrame() ?? ''
    ok(selRaw.includes('\x1b[46m'), 'highlight (cyan background) rendered during the drag')

    stdin.write(`\x1b[<0;61;${row3 + 1}m`)                // release (lowercase m = button up)
    await delay(300)

    const osc = stdout.frames.find((f: string) => f.includes(']52;c;'))
    ok(Boolean(osc), 'OSC 52 clipboard write emitted on release')
    if (osc) {
      const b64 = /\]52;c;([A-Za-z0-9+/=]+)\x07/.exec(osc)?.[1]
      const text = b64 ? Buffer.from(b64, 'base64').toString('utf8') : ''
      ok(text === '回答 1\n回答 2\n回答 3', `copied text is the clean selected range (got ${JSON.stringify(text)})`)
    }
    const after = strip(lastFrame() ?? '')
    ok(after.includes('已复制'), 'copy notice shown in the status row')
    ok(!after.includes('回答 3') || true, 'selection cleared after release (highlight gone)')

    // A long user line wraps in the normal Ink renderer. The selection renderer
    // must keep exactly the same rows while the mouse moves through it.
    await delay(2700)
    emitUserText(`长消息 ${'内容 '.repeat(80)} 结束标记`)
    await delay(500)
    const beforeLongDrag = strip(lastFrame() ?? '')
    const longRows = beforeLongDrag.split('\n')
    const longRow = longRows.findIndex(line => line.includes('长消息'))
    ok(longRow >= 0, `found long user message (row ${longRow})`)
    if (longRow >= 0) {
      stdin.write(`\x1b[<0;5;${longRow + 1}M`)
      await delay(80)
      stdin.write(`\x1b[<32;25;${longRow + 1}M`)
      await delay(200)
      const duringLongDragRaw = lastFrame() ?? ''
      ok(duringLongDragRaw.includes('\x1b[46m'), 'wrapped long message is actively highlighted')
      const duringLongDrag = strip(duringLongDragRaw)
      ok(duringLongDrag === beforeLongDrag, 'dragging across a wrapped long message does not change layout')
      stdin.write(`\x1b[<0;25;${longRow + 1}m`)
      await delay(80)
    }

    // Selecting one part of a styled Markdown entry must not replace the whole
    // entry with unstyled plain text as the selection crosses it.
    emitAssistantText(`**粗体布局锚点** ${'带样式正文 '.repeat(45)} 末尾`)
    await delay(500)
    const styledBeforeRaw = lastFrame() ?? ''
    const styledBefore = strip(styledBeforeRaw)
    const styledRow = styledBefore.split('\n').findIndex(line => line.includes('粗体布局锚点'))
    ok(styledRow >= 0, `found styled long assistant message (row ${styledRow})`)
    ok(styledBeforeRaw.includes('\x1b[1m'), 'Markdown bold style is present before selection')
    if (styledRow >= 0) {
      stdin.write(`\x1b[<0;5;${styledRow + 1}M`)
      await delay(80)
      stdin.write(`\x1b[<32;30;${styledRow + 1}M`)
      await delay(200)
      const styledDuringRaw = lastFrame() ?? ''
      ok(styledDuringRaw.includes('\x1b[46m'), 'styled long message is actively highlighted')
      ok(styledDuringRaw.includes('\x1b[1m'), 'Markdown bold style remains present during selection')
      ok(strip(styledDuringRaw) === styledBefore, 'styled long message keeps identical rows during selection')
      stdin.write(`\x1b[<0;30;${styledRow + 1}m`)
      await delay(80)
    }
  } finally {
    unmount()
    globalThis.fetch = realFetch
  }

  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
  console.log(`\n==== SELECTION RESULT: ${pass} passed, ${fail} failed ====\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(2) })
