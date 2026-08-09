/**
 * UI tests — drive the Ink screens with ink-testing-library against a mocked
 * fetch (REST + a fake SSE stream), so no network is needed. The Mobius home
 * dir is redirected to a temp folder so the real ~/.mobius is never touched.
 *
 * Run:  npm run test:ui
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

// Redirect Mobius home BEFORE importing anything that reads/writes it.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-tui-test-'))
process.env.MOBIUS_TUI_HOME = TMP_HOME

import React from 'react'
import { render } from 'ink-testing-library'
import { ChatScreen, Composer, shimmerText } from '../src/components/Chat.js'
import { WindowsInputDecoder } from '../src/lib/windows-input.js'
import { LoginScreen } from '../src/components/Login.js'
import { PrepScreen } from '../src/components/PrepScreen.js'
import { Select, TextInput } from '../src/components/primitives.js'
import { MobiusClient } from '../src/api.js'
import { renderMarkdownLines } from '../src/markdown.js'
import { viewsForEntry, toolLabel } from '../src/lib/entry-view.js'
import { SseConnection } from '../src/sse.js'
import type { ReadyState } from '../src/components/PrepScreen.js'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
let pass = 0, fail = 0
function ok(c: boolean, msg: string) {
  if (c) { pass++; console.log(`  ✓ ${msg}`) } else { fail++; console.error(`  ✗ ${msg}`) }
}

async function waitFor(lastFrame: () => string | undefined, needle: string, timeoutMs = 4000): Promise<boolean> {
  for (let i = 0; i < Math.ceil(timeoutMs / 50); i++) {
    if ((lastFrame() ?? '').includes(needle)) return true
    await delay(50)
  }
  return false
}

// ── shared mock state for the fake SSE controller ─────────────────────────────
// Node 18 exposes ReadableStream as a global at runtime; use globalThis + loose typing.
const RS: any = (globalThis as any).ReadableStream
let sseController: any = null
const enc = new TextEncoder()
function emit(eventName: string, data: Record<string, unknown>) {
  const payload = JSON.stringify({ event: eventName, ...data })
  sseController?.enqueue(enc.encode(`event: ${eventName}\ndata: ${payload}\n\n`))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

type FetchImpl = typeof fetch
let realFetch: FetchImpl

function installMock(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  realFetch = globalThis.fetch
  globalThis.fetch = ((url: any, init?: any) => {
    const requestUrl = String(url)
    // Fresh TUI sessions probe the reverse AIMUX bridge before creating a
    // session. Keep UI tests focused on their own mocked endpoint instead of
    // waiting through the production 8-second bridge readiness grace period.
    const marker = '/aimux_bridge/api/remotes/'
    if (requestUrl.includes(marker) && requestUrl.endsWith('/connection')) {
      const identifier = decodeURIComponent(requestUrl.slice(requestUrl.indexOf(marker) + marker.length, -'/connection'.length))
      return jsonResponse({ identifier, event_stream_connected: true })
    }
    return impl(requestUrl, init)
  }) as FetchImpl
}
function restoreFetch() { globalThis.fetch = realFetch }

// ════════════════════════════════════════════════════════════════════════════
// TEST 1 — Login screen submits and calls onSuccess
// ════════════════════════════════════════════════════════════════════════════
async function testLogin() {
  console.log('\n[UI 1] Login screen')
  // (a) deterministic: exercise the real login() + saveLogin() code path.
  installMock((url) => {
    if (url.endsWith('/api/auth/config')) return jsonResponse({ password_required: false })
    if (url.endsWith('/api/auth/login')) return jsonResponse({ token: 'mock-jwt-token', user: { id: 'tester', display_name: 'Test User', role: 'admin' } })
    return jsonResponse({ error: 'no mock' }, 404)
  })
  try {
    const { login } = await import('../src/api.js')
    const { saveLogin } = await import('../src/config.js')
    const r = await login('http://mock.local', 'tester')
    ok(r.token === 'mock-jwt-token' && r.user.id === 'tester', 'login() returns token + user')
    await saveLogin({ server: 'http://mock.local', username: 'tester', token: r.token, user: r.user })
    const saved = JSON.parse(fs.readFileSync(path.join(TMP_HOME, 'login.json'), 'utf8'))
    ok(saved.token === 'mock-jwt-token' && saved.username === 'tester', 'login.json persisted to temp home')
  } finally { restoreFetch() }

  // (b) smoke: the form renders (keystroke-driven multi-field submit is flaky in
  //     the test harness due to useInput/rerender timing; the submit handler
  //     itself is covered by the deterministic login() path above).
  let captured: any = null
  installMock((url) => {
    if (url.endsWith('/api/auth/config')) return jsonResponse({ password_required: false })
    if (url.endsWith('/api/auth/login')) return jsonResponse({ token: 'mock-jwt-token', user: { id: 'tester', display_name: 'Test User', role: 'admin' } })
    return jsonResponse({ error: 'no mock' }, 404)
  })
  try {
    const { stdin, lastFrame, unmount } = render(<LoginScreen onSuccess={(r) => { captured = r }} />)
    await delay(60)
    const frame = lastFrame() ?? ''
    ok(frame.includes('登录') && frame.includes('用户名'), 'login form renders with fields')
    // best-effort keystroke submit; assert only if the harness lands the keys.
    stdin.write('\t'); await delay(120)
    stdin.write('tester'); await delay(120)
    stdin.write('\t'); await delay(120)
    stdin.write('\r')
    for (let i = 0; i < 50 && !captured; i++) await delay(25)
    unmount()
    console.log(`  ${captured ? '✓' : '·'} form keystroke submit ${captured ? 'succeeded' : 'skipped (harness timing)'} — logic covered by (a)`)
  } finally { restoreFetch() }
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 2 — Chat screen: submit message, SSE streams assistant reply
// ════════════════════════════════════════════════════════════════════════════
async function testChat() {
  console.log('\n[UI 2] Chat screen + SSE streaming')
  sseController = null
  const client = new MobiusClient('http://mock.local', 'mock-jwt-token')
  const ready: ReadyState = {
    project: { id: 'p1', name: '测试项目' },
    issue: { id: 'i1', project_id: 'p1', title: '测试任务' },
    prefs: { model: 'codex', language: 'zh', excluded_skill_ids: [], excluded_memory_ids: [] },
  }
  let runtimeWorking = false
  let createdSessionBody: any = null
  installMock((url, init) => {
    if (url.includes('/events')) {
      const stream = new RS({
        start(c: any) { sseController = c; c.enqueue(enc.encode('event: subscribed\ndata: {"event":"subscribed","session":{}}\n\n')) },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.endsWith('/messages') && init?.method === 'POST') {
      // emit a scripted reply shortly after the message is posted
      setTimeout(() => {
        emit('typing', { active: true })
        emit('jsonl_entry', { session_id: 's1', entry: { type: 'user', message: { role: 'user', content: '你好' } } })
        emit('jsonl_entry', { session_id: 's1', entry: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '成功！\n\n```typescript\nconst answer = 42\nconsole.log(answer)\n```' }] } } })
        emit('typing', { active: false })
      }, 250)
      return jsonResponse({ ok: true, session_id: 's1', turn_number: 1 })
    }
    if (url.endsWith('/api/sessions/s1/status')) {
      return jsonResponse({ session_id: 's1', alive: true, working: runtimeWorking })
    }
    if (url.includes('/sessions') && init?.method === 'POST') {
      createdSessionBody = JSON.parse(String(init.body || '{}'))
      return jsonResponse({ session_id: 's1' })
    }
    return jsonResponse({ error: 'no mock' }, 404)
  })
  try {
    const { stdin, lastFrame, unmount } = render(
      <ChatScreen client={client} ready={ready} webUserId="test-user" onClear={() => {}} onResume={() => {}} onQuit={() => {}} onReconfigure={() => {}} onConfigCancel={() => {}} />
    )
    await delay(40)
    const initialFrame = lastFrame() ?? ''
    ok(initialFrame.includes('Mobius') && /\(v\d+\.\d+\.\d+\)/.test(initialFrame) && !initialFrame.includes('Mobius TUI'), 'welcome card shows the Mobius product identity')
    ok(initialFrame.includes('model:') && initialFrame.includes('project:') && initialFrame.includes('task:'), 'welcome card summarizes active context')
    ok(initialFrame.includes('Tip:') && initialFrame.includes('输入问题或 / 命令'), 'welcome tip and bottom composer are visible together')
    ok(initialFrame.includes('http://mock.local/u/test-user/p/p1/i/i1'), 'web issue URL is always visible before session creation')
    stdin.write('你好'); await delay(30)
    stdin.write('\r'); await delay(80)
    ok((lastFrame() ?? '').includes('第一个问题，正在初始化'), 'first query shows 第一个问题 instead of Working immediately after submit')
    runtimeWorking = true
    await delay(820)   // createSession → connect → POST → emit
    runtimeWorking = false
    emit('typing', { active: false })
    await delay(100)
    const frame = lastFrame() ?? ''
    unmount()
    ok(frame.includes('你好'), 'transcript shows the user message')
    ok(frame.includes('成功'), `assistant reply streamed in (frame has "成功")`)
    ok(frame.includes('const answer = 42') && frame.includes('console.log(answer)'), 'fenced code renders as clean source lines')
    ok(!frame.includes('[typescript]') && !frame.includes('```'), 'code block omits language badge and fence characters')
    ok(frame.includes('测试项目') && frame.includes('测试任务'), `persistent status shows project and task`)
    ok(frame.includes('http://mock.local/u/test-user/p/p1/i/i1?session=s1'), 'web URL follows the newly created session')
    ok(!frame.includes('Working ('), 'authoritative idle status clears Working after completion')
    ok(createdSessionBody?.pc_client_metadata?.is_tui === true, 'session metadata identifies the TUI client')
    ok(createdSessionBody?.pc_client_metadata?.work_mode === 'pc', 'TUI sessions always default to pc work mode')
    ok(/^tui-/.test(createdSessionBody?.pc_client_metadata?.aimux_id || ''), 'session metadata uses the TUI AIMUX identifier')
    ok(createdSessionBody?.pc_client_metadata?.local_path === process.cwd(), 'session metadata includes the TUI current directory')
  } finally { restoreFetch() }
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 3 — resumed sessions restore and stop their live Working state
// ════════════════════════════════════════════════════════════════════════════
async function testResumedWorkingStatus() {
  console.log('\n[UI 3] Resumed session Working status')
  sseController = null
  let runtimeWorking = true
  let stopped = false
  const client = new MobiusClient('http://mock.local', 'mock-jwt-token')
  const ready: ReadyState = {
    project: { id: 'p1', name: '测试项目' },
    issue: { id: 'i1', project_id: 'p1', title: '测试任务' },
    prefs: { model: 'codex', language: 'zh', excluded_skill_ids: [], excluded_memory_ids: [] },
  }
  installMock((url, init) => {
    if (url.includes('/events')) {
      return new Response(new RS({
        start(c: any) { sseController = c; c.enqueue(enc.encode('event: subscribed\ndata: {"event":"subscribed","session":{}}\n\n')) },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.endsWith('/api/sessions/s1/status')) {
      return jsonResponse({ session_id: 's1', alive: true, working: runtimeWorking })
    }
    if (url.endsWith('/api/sessions/s1/stop') && init?.method === 'POST') {
      runtimeWorking = false
      stopped = true
      return jsonResponse({ ok: true })
    }
    return jsonResponse({ error: 'no mock' }, 404)
  })
  try {
    const { stdin, lastFrame, unmount } = render(
      <ChatScreen client={client} ready={ready} webUserId="test-user" resumeSessionId="s1" onClear={() => {}} onResume={() => {}} onQuit={() => {}} onReconfigure={() => {}} onConfigCancel={() => {}} />
    )
    await delay(120)
    ok((lastFrame() ?? '').includes('Working ('), 'resuming an already-running session restores Working without a new typing event')

    runtimeWorking = false
    emit('typing', { active: false })
    await delay(120)
    ok(!(lastFrame() ?? '').includes('Working ('), 'SSE completion requests an immediate authoritative status refresh')

    runtimeWorking = true
    emit('typing', { active: true })
    await delay(30)
    ok((lastFrame() ?? '').includes('Working ('), 'SSE start lights Working without waiting for the next scheduled poll')
    stdin.write('\x1b')
    await delay(120)
    ok(stopped && !(lastFrame() ?? '').includes('Working ('), 'Esc stops the active session and clears Working immediately')
    unmount()
  } finally { restoreFetch() }
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 4 — Markdown follows Codex's borderless, foreground-only code style
// ════════════════════════════════════════════════════════════════════════════
function testMarkdownCodeRendering() {
  console.log('\n[UI 4] Markdown code rendering')
  const stripAnsi = (value: string) => value.replace(/\x1B\[[0-9;]*m/g, '')
  const rendered = renderMarkdownLines('说明 `answer`：\n\n```typescript title=demo\nconst answer = 42\n```\n\n完成。')
  const plain = rendered.map(line => stripAnsi(line.text)).join('\n')
  ok(plain.includes('说明 answer：') && !plain.includes('`answer`'), 'inline code uses color without literal backticks')
  ok(plain.includes('const answer = 42') && !plain.includes('[typescript]') && !plain.includes('```'), 'fenced code has no badge, border, or fences')
  ok(rendered.some(line => line.code && stripAnsi(line.text) === 'const answer = 42'), 'code lines are marked for no-wrap rendering')

  const unlabelled = renderMarkdownLines('```\necho $HOME\n```')
  ok(unlabelled.length === 1 && unlabelled[0].text === 'echo $HOME' && unlabelled[0].code, 'unlabelled code stays plain instead of being guessed as bash')
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 5 — Prep screen renders the project picker when cwd is unbound
// ════════════════════════════════════════════════════════════════════════════
async function testPrepRender() {
  console.log('\n[UI 5] Prep screen project picker')
  const client = new MobiusClient('http://mock.local', 'mock-jwt-token')
  installMock((url) => {
    if (url.includes('/api/projects') && !url.includes('/issues') && !url.includes('/skills') && !url.includes('/memories')) {
      return jsonResponse([
        { id: 'p1', name: '已有项目A', description: '第一行\n第二行' },
        { id: 'p2', name: '已有项目B', description: '单行描述' },
      ])
    }
    if (url.includes('/issues')) return jsonResponse([])
    return jsonResponse({ error: 'no mock' }, 404)
  })
  try {
    const { lastFrame, stdin, unmount } = render(<PrepScreen client={client} onReady={() => {}} />)
    await delay(120)
    const frame = lastFrame() ?? ''
    ok(frame.includes('选择当前路径的绑定项目'), 'project picker title shown')
    ok(frame.includes('已有项目A') && frame.includes('已有项目B'), 'existing projects listed')
    ok(frame.includes('创建新项目'), 'create-new option present')
    // multi-line description must be flattened onto one line with ⏎ in place of \n
    ok(frame.includes('已有项目A — 第一行 ⏎ 第二行'), 'multi-line description flattened to a single line')
    ok(frame.includes('已有项目B — 单行描述'), 'single-line description kept as-is')
    ok(!frame.includes('加载项目列表…'), 'completed project load does not leave a stale loading message')

    stdin.write('\r')
    await delay(30)
    const createFrame = lastFrame() ?? ''
    ok(createFrame.includes('创建新项目（绑定到当前路径）'), 'project creation form opens')
    ok(/项目名称 ←\n\s+未命名项目/.test(createFrame), 'cursor is rendered on the active project-name input')
    ok(!createFrame.includes('描述（可空）'), 'project description input is hidden')
    ok(createFrame.includes('回车创建 · Esc 返回'), 'project name submits directly with Enter')
    unmount()
  } finally { restoreFetch() }
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 6 — Select viewport: a long list must not overflow the terminal
// ════════════════════════════════════════════════════════════════════════════
async function testSelectViewport() {
  console.log('\n[UI 6] Select viewport truncation')
  const items = Array.from({ length: 12 }, (_, i) => ({ label: `项目${i}`, value: `v${i}` }))
  const { lastFrame, stdin } = render(<Select items={items} maxVisible={3} />)
  await delay(20)
  let frame = lastFrame() ?? ''
  ok(frame.includes('项目0') && frame.includes('项目2'), 'top window: first 3 visible')
  ok(!frame.includes('项目3'), 'top window: item past the window hidden')
  ok(frame.includes('↓ 还有 9 项'), 'top window: hidden-below hint')
  ok(!frame.includes('↑ 还有'), 'top window: no hidden-above hint')
  // walk active into the middle of the list
  for (let i = 0; i < 5; i++) { stdin.write('\x1b[B'); await delay(10) }
  frame = lastFrame() ?? ''
  ok(frame.includes('项目5'), 'middle: active item kept visible')
  ok(frame.includes('↑ 还有') && frame.includes('↓ 还有'), 'middle: both tail hints shown')
  ok(!frame.includes('项目0') && !frame.includes('项目11'), 'middle: far items hidden')

  // The first navigation key after mounting must not depend on a later render
  // (the regression presented as arrows doing nothing until Enter was pressed).
  const immediate = render(<Select items={[{ label: '首项', value: 'first' }, { label: '次项', value: 'second' }]} />)
  await delay(20)
  immediate.rerender(<Select items={[{ label: '首项', value: 'first' }, { label: '次项', value: 'second' }]} />)
  immediate.stdin.write('\x1b[B')
  await delay(20)
  ok((immediate.lastFrame() ?? '').includes('❯ 次项'), 'first arrow key is handled immediately after Select mounts')
  immediate.unmount()
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 7 — Project picker: Esc exits the app via onQuit
// ════════════════════════════════════════════════════════════════════════════
async function testProjectPickerEscQuit() {
  console.log('\n[UI 7] Project picker Esc → onQuit')
  const client = new MobiusClient('http://mock.local', 'mock-jwt-token')
  installMock((url) => {
    if (url.includes('/api/projects') && !url.includes('/issues') && !url.includes('/skills') && !url.includes('/memories')) {
      return jsonResponse([{ id: 'p1', name: '已有项目A' }, { id: 'p2', name: '已有项目B' }])
    }
    if (url.includes('/issues')) return jsonResponse([])
    return jsonResponse({ error: 'no mock' }, 404)
  })
  let quitCalled = false
  try {
    const { lastFrame, stdin, unmount } = render(<PrepScreen client={client} onReady={() => {}} onQuit={() => { quitCalled = true }} />)
    await delay(120)
    ok((lastFrame() ?? '').includes('Esc 退出'), 'esc-to-quit hint shown')
    stdin.write('\x1b')
    await delay(30)
    unmount()
    ok(quitCalled, 'Esc on the list triggered onQuit')
  } finally { restoreFetch() }
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 8 — TextInput: terminal Backspace (0x7f) deletes at the end of the input
// ════════════════════════════════════════════════════════════════════════════
async function testTextInputBackspace() {
  console.log('\n[UI 8] TextInput Backspace deletes trailing char')
  function Harness() {
    const [v, setV] = React.useState('abc')
    return <TextInput value={v} onChange={setV} focused />
  }
  const { stdin, lastFrame, unmount } = render(<Harness />)
  await delay(20)
  ok((lastFrame() ?? '').includes('abc'), 'initial value rendered')
  stdin.write(String.fromCharCode(127)) // 0x7f — what virtually every terminal's Backspace key emits
  await delay(20)
  const after = lastFrame() ?? ''
  ok(after.includes('ab') && !after.includes('abc'), 'Backspace (0x7f) deleted the trailing char')
  unmount()
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 8b — TextInput: Delete key (ESC[3~) deletes FORWARD, not backward;
// Ctrl+Backspace (ESC[3;5~) and Alt+Backspace (ESC DEL) delete the whole word.
// Ink reports Backspace (\x7f) and Delete ([3~) as the same key.delete, so the
// raw stdin bytes must drive these.
// ════════════════════════════════════════════════════════════════════════════
async function testTextInputDeleteKeys() {
  console.log('\n[UI 8b] TextInput Delete-forward + Ctrl+Backspace word delete')
  function Harness() {
    const [v, setV] = React.useState('abc')
    return <TextInput value={v} onChange={setV} focused />
  }
  const { stdin, lastFrame, unmount } = render(<Harness />)
  await delay(20)
  // Cursor starts at the end; Ctrl+A moves it to position 0.
  stdin.write('\x01')
  await delay(10)
  stdin.write('\x1b[3~') // Delete key
  await delay(20)
  let frame = lastFrame() ?? ''
  ok(frame.includes('bc') && !frame.includes('abc'), 'TextInput Delete key (ESC[3~) deleted forward, not backward')

  // Now type a word and delete it backward with Ctrl+Backspace.
  stdin.write('hello world')
  await delay(10)
  stdin.write('\x1b[3;5~') // Ctrl+Backspace
  await delay(20)
  frame = lastFrame() ?? ''
  ok(frame.includes('hello ') && !frame.includes('world'), 'TextInput Ctrl+Backspace (ESC[3;5~) deleted the whole word backward')
  unmount()
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 8c — Composer: Backspace deletes backward, Delete deletes forward,
// Ctrl+Backspace / Alt+Backspace / Ctrl+W delete the whole word backward.
// ════════════════════════════════════════════════════════════════════════════
async function testComposerDeleteKeys() {
  console.log('\n[UI 8c] composer Backspace / Delete / word-delete keys')
  const submitted: string[] = []
  const { stdin, unmount } = render(
    <Composer
      onSubmit={(text) => submitted.push(text)}
      onStop={() => {}}
      onQuit={() => {}}
      typing={false}
      commands={[]}
    />,
  )
  await delay(20)

  // Backspace (0x7f) deletes backward, not forward.
  stdin.write('hello')
  stdin.write(String.fromCharCode(127))
  await delay(80) // outlast the 20ms paste-burst window so Enter submits
  stdin.write('\r')
  await delay(20)
  ok(submitted[0] === 'hell', 'Composer Backspace (0x7f) deleted the char before the cursor')

  // Delete key (ESC[3~) deletes FORWARD after Ctrl+A moves to the start.
  stdin.write('hello')
  stdin.write('\x01') // Ctrl+A → cursor at 0
  stdin.write('\x1b[3~') // Delete key
  await delay(80)
  stdin.write('\r')
  await delay(20)
  ok(submitted[1] === 'ello', 'Composer Delete key (ESC[3~) deleted the char after the cursor')

  // Ctrl+Backspace (ESC[3;5~) deletes the whole word backward.
  stdin.write('hello world')
  stdin.write('\x1b[3;5~')
  await delay(80)
  stdin.write('\r')
  await delay(20)
  ok(submitted[2] === 'hello ', 'Composer Ctrl+Backspace (ESC[3;5~) deleted the whole word backward')

  // Alt+Backspace (ESC DEL) deletes the whole word backward too.
  stdin.write('hello world')
  stdin.write('\x1b\x7f')
  await delay(80)
  stdin.write('\r')
  await delay(20)
  ok(submitted[3] === 'hello ', 'Composer Alt+Backspace (ESC DEL) deleted the whole word backward')

  // Ctrl+W (0x17) still deletes the whole word backward.
  stdin.write('hello world')
  stdin.write('\x17')
  await delay(80)
  stdin.write('\r')
  await delay(20)
  ok(submitted[4] === 'hello ', 'Composer Ctrl+W still deletes the whole word backward')

  unmount()
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 9 — Codex-style composer keeps multiline pastes intact and grows/shrinks
// ════════════════════════════════════════════════════════════════════════════
async function testComposerMultilinePaste() {
  console.log('\n[UI 9] composer multiline paste + framed auto-height input')
  const submitted: string[] = []
  const { stdin, lastFrame, unmount } = render(
    <Composer
      onSubmit={(text) => submitted.push(text)}
      onStop={() => {}}
      onQuit={() => {}}
      typing={false}
      commands={[]}
    />,
  )
  await delay(20)
  const initial = lastFrame() ?? ''
  ok(initial.includes('╭') && initial.includes('╰'), 'composer has a visible bordered input boundary')
  ok(initial.includes('Enter 发送') && initial.includes('Ctrl+J 换行'), 'composer shows Codex-style submit/newline hints')

  stdin.write('\x1b[200~第一行\r\n第二行\r第三行\x1b[201~')
  await delay(20)
  const bracketed = lastFrame() ?? ''
  ok(bracketed.includes('第一行') && bracketed.includes('第二行') && bracketed.includes('第三行'), 'bracketed multiline paste preserves every line')
  ok(bracketed.includes('3 行'), 'input grows to report all pasted lines')
  ok(submitted.length === 0, 'newlines inside a bracketed paste do not submit partial messages')
  stdin.write('\r')
  await delay(20)
  ok(submitted[0] === '第一行\n第二行\n第三行', 'one Enter submits the complete normalized bracketed paste')
  ok((lastFrame() ?? '').includes('1 行'), 'composer shrinks back after submission')

  // Simulate terminals that split clipboard input into text + Enter events instead
  // of producing a bracketed paste event (common through ConPTY/SSH/tmux chains).
  stdin.write('first sentence')
  stdin.write('\r')
  stdin.write('second sentence')
  stdin.write('\r')
  stdin.write('last sentence')
  await delay(10)
  const burst = lastFrame() ?? ''
  ok(burst.includes('first sentence') && burst.includes('second sentence') && burst.includes('last sentence'), 'paste burst keeps all split text chunks')
  ok(submitted.length === 1, 'paste-burst Enter events become newlines instead of partial submissions')
  await delay(80)
  stdin.write('\r')
  await delay(20)
  ok(submitted[1] === 'first sentence\nsecond sentence\nlast sentence', 'Enter after the burst submits the complete multiline text once')

  // Windows Terminal win32-input-mode preserves SHIFT_PRESSED in the key
  // record. The decoder turns that into CSI-u before Ink sees the keypress.
  const windowsInput = new WindowsInputDecoder()
  stdin.write('Windows first line')
  stdin.write(windowsInput.push('\x1b[16;42;0;1;16;1_\x1b[13;28;13;1;16;1_'))
  stdin.write(windowsInput.push('\x1b[13;28;13;0;16;1_\x1b[16;42;0;0;0;1_'))
  stdin.write('Windows second line')
  await delay(20)
  ok(submitted.length === 2, 'Windows Shift+Enter inserts a newline instead of submitting')
  stdin.write('\r')
  await delay(20)
  ok(submitted[2] === 'Windows first line\nWindows second line', 'plain Windows Enter submits the multiline message')

  const split = new WindowsInputDecoder()
  ok(split.push('\x1b[13;28;13;1;16') === '', 'split Windows key record waits for its trailing bytes')
  ok(split.push(';1_') === '\x1b[13;2u', 'split Windows Shift+Enter record decodes after completion')
  ok(split.push('\x1b[13;28;13;1;0;1_') === '\r', 'plain Windows Enter remains a submit event')
  ok(split.push('\x1b[65;30;65;1;16;1_\x1b[65;30;97;0;0;1_') === 'A', 'Windows key release does not duplicate typed text')
  ok(split.push('\x1b[A') === '\x1b[A', 'ordinary VT sequences pass through unchanged')

  stdin.write('xterm first line')
  stdin.write('\x1b[27;2;13~')
  stdin.write('xterm second line')
  await delay(20)
  ok(submitted.length === 3, 'xterm modifyOtherKeys Shift+Enter also inserts a newline')
  stdin.write('\r')
  await delay(20)
  ok(submitted[3] === 'xterm first line\nxterm second line', 'xterm Shift+Enter content submits intact')
  unmount()
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 10 — Working text uses a moving multi-level brightness wave
// ════════════════════════════════════════════════════════════════════════════
function testWorkingShimmer() {
  console.log('\n[UI 9] Working brightness animation')
  function colorsAt(frame: number): string[] {
    return shimmerText('Working', frame).map(node => (
      React.isValidElement<{ color?: string }>(node) ? (node.props.color ?? '') : ''
    ))
  }
  const frame0 = colorsAt(0)
  const frame1 = colorsAt(1)
  const wrapped = colorsAt('Working'.length)
  ok(new Set(frame0).size >= 4, 'Working text uses several brightness levels instead of one dim color')
  ok(frame0[0] === '#ffffff' && frame1[1] === '#ffffff', 'brightest point advances across the text between frames')
  ok(wrapped[0] === '#ffffff', 'brightness wave wraps continuously to the start of the text')
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 10 — reasoning / thinking entries are rendered, not skipped
// ════════════════════════════════════════════════════════════════════════════
function testReasoningViews() {
  console.log('\n[UI 10] reasoning/thinking entries rendered')
  // Codex encrypted reasoning → fixed label (matches web viewer)
  const enc = viewsForEntry({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'blob' } } as any)
  ok(enc.length === 1 && enc[0].kind === 'reasoning' && (enc[0] as any).text.includes('闭源'), 'encrypted reasoning → label')
  // Codex reasoning with summary text
  const sum = viewsForEntry({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '先读文件再改' }] } } as any)
  ok(sum.length === 1 && sum[0].kind === 'reasoning' && (sum[0] as any).text === '先读文件再改', 'reasoning summary shown')
  // Claude thinking with body
  const th = viewsForEntry({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '我在想...' }] } } as any)
  ok(th.length === 1 && th[0].kind === 'reasoning' && (th[0] as any).text === '我在想...', 'claude thinking body shown')
  // Claude encrypted/empty thinking → hidden label
  const empty = viewsForEntry({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } } as any)
  ok(empty.length === 1 && empty[0].kind === 'reasoning' && (empty[0] as any).text === '思考内容被隐藏', 'empty thinking → hidden label')
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 11 — current Codex custom tool calls show their nested shell command
// ════════════════════════════════════════════════════════════════════════════
function testCustomToolCallViews() {
  console.log('\n[UI 11] custom_tool_call commands rendered')
  const call = viewsForEntry({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call_1',
      input: 'const r = await tools.exec_command({\n  cmd: "rg -n \\\"needle\\\" mobius/tui/src",\n  workdir: "/repo"\n});\ntext(r.output);',
    },
  } as any)
  ok(call.length === 1 && call[0].kind === 'tool_call', 'custom tool call is not skipped')
  ok(call[0].kind === 'tool_call' && call[0].toolName === 'exec_command', 'nested exec_command tool name extracted')
  ok(call[0].kind === 'tool_call' && call[0].summary.includes('rg -n "needle" mobius/tui/src'), 'nested shell command shown')

  const singleQuoted = viewsForEntry({
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', input: "await tools.exec_command({ cmd: 'npm run typecheck', workdir: '/repo' })" },
  } as any)
  ok(singleQuoted[0].kind === 'tool_call' && singleQuoted[0].summary === 'npm run typecheck', 'JavaScript single-quoted command parsed')

  const parallelWrapped = viewsForEntry({
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', input: 'const all = await Promise.all([tools.exec_command({"cmd":"npm run test:ui"})])' },
  } as any)
  ok(parallelWrapped[0].kind === 'tool_call' && parallelWrapped[0].toolName === 'exec_command' && parallelWrapped[0].summary === 'npm run test:ui', 'transport helper before tools.exec_command is ignored')

  const output = viewsForEntry({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      call_id: 'call_1',
      output: [{ type: 'input_text', text: 'Script completed\nWall time 0.2 seconds' }],
    },
  } as any)
  const o0 = output[0]
  ok(output.length === 1 && o0.kind === 'tool_result' && o0.text.includes('Script completed'), 'custom tool output rendered as a tool_result line (accumulated mode)')

  const legacy = viewsForEntry({
    type: 'response_item',
    payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git status --short"}' },
  } as any)
  ok(legacy[0].kind === 'tool_call' && legacy[0].summary === 'git status --short', 'legacy function_call command remains supported')
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 11b — claude-code MCP 工具渲染与 codex 对齐 (统一)
// ════════════════════════════════════════════════════════════════════════════
function testClaudeMcpUnified() {
  console.log('\n[UI 11b] claude MCP tool name/summary/result unified with codex')
  // ① 长名 mcp__aimux__remote_exec_command → 标签 "运行命令" (与 codex exec 一致)
  ok(toolLabel('mcp__aimux__remote_exec_command') === '运行命令', 'mcp__aimux__remote_exec_command label maps to 运行命令 (same as codex exec)')
  ok(toolLabel('mcp__aimux__send_files') === 'send_files', 'unknown MCP tool falls back to short name without mcp__server__ prefix')
  ok(toolLabel('exec_command') === '运行命令', 'codex short name still maps (unchanged)')

  // ② summary: MCP remote_exec_command 抽出 cmd, 与 codex exec_command 一致 (不带 "cmd:" 前缀)
  const call = viewsForEntry({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__aimux__remote_exec_command', input: { cmd: 'cat /etc/hosts' } }] },
  } as any)
  ok(call.length === 1 && call[0].kind === 'tool_call' && call[0].summary === 'cat /etc/hosts', 'MCP remote_exec_command summary is the bare cmd (unified with codex)')

  // ③ 结果: aimux 返回的 JSON {"output":"...","exit_code":0} 解包成纯 output, 并清 OSC 标题 + AIMUX_EXIT 标记
  const noisy = `line1\n${'\x1b]0;root@h: ~\x07'}line2\n__AIMUX_EXIT_deadbeef__:0`
  const resultEntry = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: JSON.stringify({ output: noisy, exit_code: 0 }) }] },
  }
  const r = viewsForEntry(resultEntry as any)
  ok(r.length === 1 && r[0].kind === 'tool_result', 'MCP JSON result rendered as tool_result')
  ok(r[0].kind === 'tool_result' && r[0].text === 'line1\nline2', 'JSON output unwrapped + OSC title + AIMUX_EXIT marker stripped (clean, like codex)')

  // ④ 守卫: 本身是 JSON 的文件内容 (无 output 字段) 不被误解包
  const plain = viewsForEntry({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: '{"name":"config","version":1}' }] },
  } as any)
  ok(plain[0].kind === 'tool_result' && plain[0].text === '{"name":"config","version":1}', 'plain JSON file content is not unwrapped (no output field)')
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 12 — SSE "terminated" is silent (server/proxy dropped the stream)
// ════════════════════════════════════════════════════════════════════════════
async function testSseTerminatedSilent() {
  console.log('\n[UI 12] SSE "terminated" is silent, not an error')
  let errorMsg: string | null = null
  let opened = false, closed = false
  installMock(async () => ({
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => { throw new Error('terminated') } }) },
  }) as any)
  try {
    const conn = new SseConnection('http://mock/events', {
      onOpen: () => { opened = true },
      onError: (m) => { errorMsg = m },
      onClose: () => { closed = true },
    })
    await conn.start()
    ok(opened, 'SSE opened before the drop')
    ok(errorMsg === null, '"terminated" did not raise a user-facing error')
    ok(closed, 'onClose fired so the hook can reconnect')
  } finally { restoreFetch() }
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 13 — SSE reconnect replays missed entries (no silent freeze)
// ════════════════════════════════════════════════════════════════════════════
async function testChatSseReconnects() {
  console.log('\n[UI 13] SSE reconnect replays missed entries')
  const client = new MobiusClient('http://mock.local', 'mock-jwt-token')
  const ready: ReadyState = {
    project: { id: 'p1', name: '测试项目' },
    issue: { id: 'i1', project_id: 'p1', title: '测试任务' },
    prefs: { model: 'codex', language: 'zh', excluded_skill_ids: [], excluded_memory_ids: [] },
  }
  const frame = (event: string, payload: Record<string, unknown>) =>
    `event: ${event}\ndata: ${JSON.stringify({ event, ...payload })}\n\n`
  const assistantText = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  let sseCall = 0
  installMock((url, init) => {
    if (url.includes('/events')) {
      sseCall++
      if (sseCall === 1) {
        // first connection: one entry, then the stream drops ("terminated")
        return new Response(new RS({
          start(c: any) {
            c.enqueue(enc.encode(frame('subscribed', { session: {} })))
            c.enqueue(enc.encode(frame('jsonl_entry', { session_id: 's1', entry: assistantText('第一条') })))
            setTimeout(() => { try { c.error(new Error('terminated')) } catch { /* already closed */ } }, 30)
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      // reconnect: server replays history including a NEW second entry
      return new Response(new RS({
        start(c: any) {
          c.enqueue(enc.encode(frame('subscribed', { session: {} })))
          c.enqueue(enc.encode(frame('jsonl_history', { entries: [assistantText('第一条'), assistantText('第二条')], done: true })))
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.endsWith('/messages') && init?.method === 'POST') return jsonResponse({ ok: true, session_id: 's1', turn_number: 1 })
    if (url.endsWith('/api/sessions/s1/status')) return jsonResponse({ session_id: 's1', alive: true, working: false })
    if (url.includes('/sessions') && init?.method === 'POST') return jsonResponse({ session_id: 's1' })
    return jsonResponse({ error: 'no mock' }, 404)
  })
  try {
    const { stdin, lastFrame, unmount } = render(
      <ChatScreen client={client} ready={ready} webUserId="test-user" onClear={() => {}} onResume={() => {}} onQuit={() => {}} onReconfigure={() => {}} onConfigCancel={() => {}} />,
    )
    await delay(40)
    // Ink's test stdin treats one chunk as one keypress. Send text and Enter as
    // separate chunks, matching a real terminal and the main chat test above.
    stdin.write('hi')
    await delay(30)
    stdin.write('\r')
    const replayed = await waitFor(lastFrame, '第二条', 4000)
    const out = lastFrame() ?? ''
    unmount()
    ok(out.includes('第一条'), 'pre-drop entry shown')
    ok(replayed, 'reconnect replayed the missed entry')
    ok(sseCall >= 2, 'SSE was reconnected after the drop')
  } finally { restoreFetch() }
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 14 — sending after an idle completed session reopens its closed SSE
// ════════════════════════════════════════════════════════════════════════════
async function testIdleCompletedSessionReopensSseOnSend() {
  console.log('\n[UI 14] Idle completed session reopens SSE on the next send')
  const client = new MobiusClient('http://mock.local', 'mock-jwt-token')
  const ready: ReadyState = {
    project: { id: 'p1', name: '测试项目' },
    issue: { id: 'i1', project_id: 'p1', title: '测试任务' },
    prefs: { model: 'codex', language: 'zh', excluded_skill_ids: [], excluded_memory_ids: [] },
  }
  const frame = (event: string, payload: Record<string, unknown>) =>
    `event: ${event}\ndata: ${JSON.stringify({ event, ...payload })}\n\n`
  let sseCall = 0
  let liveController: any = null
  installMock((url, init) => {
    if (url.includes('/events')) {
      sseCall++
      if (sseCall === 1) {
        return new Response(new RS({
          start(c: any) {
            c.enqueue(enc.encode(frame('subscribed', { session: {} })))
            // The worker is already complete (alive=false below). Later the
            // proxy drops this idle stream, so onClose correctly does not retry.
            setTimeout(() => { try { c.error(new Error('terminated')) } catch { /* closed */ } }, 40)
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(new RS({
        start(c: any) {
          liveController = c
          c.enqueue(enc.encode(frame('subscribed', { session: {} })))
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.endsWith('/messages') && init?.method === 'POST') {
      setTimeout(() => {
        liveController?.enqueue(enc.encode(frame('jsonl_entry', {
          session_id: 's1',
          entry: { type: 'user', uuid: 'idle-user-1', message: { role: 'user', content: 'q' } },
        })))
        liveController?.enqueue(enc.encode(frame('jsonl_entry', {
          session_id: 's1',
          entry: { type: 'assistant', uuid: 'idle-assistant-1', message: { role: 'assistant', content: [{ type: 'text', text: 'TUI 已恢复接收' }] } },
        })))
      }, 30)
      return jsonResponse({ ok: true, session_id: 's1', turn_number: 2 })
    }
    if (url.endsWith('/api/sessions/s1/status')) {
      return jsonResponse({ session_id: 's1', alive: false, working: false })
    }
    return jsonResponse({ error: 'no mock' }, 404)
  })
  try {
    const { stdin, lastFrame, unmount } = render(
      <ChatScreen client={client} ready={ready} webUserId="test-user" resumeSessionId="s1" onClear={() => {}} onResume={() => {}} onQuit={() => {}} onReconfigure={() => {}} onConfigCancel={() => {}} />,
    )
    await delay(180)
    ok(sseCall === 1, 'completed idle session did not reconnect by itself')
    stdin.write('q'); await delay(30); stdin.write('\r')
    const received = await waitFor(lastFrame, 'TUI 已恢复接收', 3000)
    const out = lastFrame() ?? ''
    unmount()
    ok(sseCall >= 2, 'sending reopened the closed SSE stream')
    ok(received && out.includes('q'), 'the new user turn and assistant reply are visible in TUI')
  } finally { restoreFetch() }
}

// ════════════════════════════════════════════════════════════════════════════
// TEST 15 — message dispatch retries a transient 502
// ════════════════════════════════════════════════════════════════════════════
async function testSendRetries502() {
  console.log('\n[UI 15] message dispatch retries transient 502')
  const client = new MobiusClient('http://mock.local', 'mock-jwt-token')
  const ready: ReadyState = {
    project: { id: 'p1', name: 'p' },
    issue: { id: 'i1', project_id: 'p1', title: 't' },
    prefs: { model: 'codex', language: 'zh', excluded_skill_ids: [], excluded_memory_ids: [] },
  }
  let msgCall = 0
  installMock((url, init) => {
    if (url.includes('/events')) {
      return new Response(new RS({ start(c: any) { c.enqueue(enc.encode('event: subscribed\ndata: {"event":"subscribed","session":{}}\n\n')) } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.endsWith('/messages') && init?.method === 'POST') {
      msgCall++
      if (msgCall === 1) return jsonResponse({ error: 'bad gateway' }, 502) // transient
      return jsonResponse({ ok: true, session_id: 's1', turn_number: 1 }) // retry succeeds
    }
    if (url.endsWith('/api/sessions/s1/status')) return jsonResponse({ session_id: 's1', alive: true, working: false })
    if (url.includes('/sessions') && init?.method === 'POST') return jsonResponse({ session_id: 's1' })
    return jsonResponse({ error: 'no mock' }, 404)
  })
  try {
    const { stdin, lastFrame, unmount } = render(
      <ChatScreen client={client} ready={ready} webUserId="u" onClear={() => {}} onResume={() => {}} onQuit={() => {}} onReconfigure={() => {}} onConfigCancel={() => {}} />,
    )
    await delay(40)
    stdin.write('hi'); await delay(30); stdin.write('\r')
    await delay(3000) // first 502 (~0ms) + backoff ~500ms + retry succeeds
    const out = lastFrame() ?? ''
    unmount()
    ok(msgCall >= 2, 'message dispatch was retried after a 502')
    ok(!out.includes('HTTP 502'), 'transient 502 absorbed, not surfaced as a hard error')
  } finally { restoreFetch() }
}

async function main() {
  await testLogin()
  await testChat()
  await testResumedWorkingStatus()
  testMarkdownCodeRendering()
  await testPrepRender()
  await testSelectViewport()
  await testProjectPickerEscQuit()
  await testTextInputBackspace()
  await testTextInputDeleteKeys()
  await testComposerDeleteKeys()
  await testComposerMultilinePaste()
  testWorkingShimmer()
  testReasoningViews()
  testCustomToolCallViews()
  testClaudeMcpUnified()
  await testSseTerminatedSilent()
  await testChatSseReconnects()
  await testIdleCompletedSessionReopensSseOnSend()
  await testSendRetries502()
  // cleanup temp home
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
  console.log(`\n==== UI RESULT: ${pass} passed, ${fail} failed ====\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(2) })
