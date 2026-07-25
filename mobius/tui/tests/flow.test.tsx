/**
 * Flow test — drive the WHOLE App as a user would, end to end, through the real
 * Ink screens (login → prep wizard → chat → /clear → /resume), against a mocked
 * backend. Captures rendered frames at each milestone as evidence.
 *
 * Run:  npm run test:flow
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-tui-flow-'))
process.env.MOBIUS_TUI_HOME = TMP_HOME

import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../src/App.js'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const RS: any = (globalThis as any).ReadableStream
const enc = new TextEncoder()
let sseController: any = null
function emit(ev: string, data: Record<string, unknown>) {
  sseController?.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify({ event: ev, ...data })}\n\n`))
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const snapshots: { step: string; frame: string }[] = []
function snap(step: string, frame: string) { snapshots.push({ step, frame: frame.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '') }) }

let pass = 0, fail = 0
function ok(c: boolean, m: string) { c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.error(`  ✗ ${m}`)) }

// ── mocked backend (precise URL matchers — substring overlaps broke an earlier draft) ─
const PID = 'proj-1', IID = 'issue-1', SID = 'sess-1'
function mockFetch(url: string, init?: RequestInit): Response {
  // SSE
  if (url.includes('/events')) {
    return new Response(new RS({ start(c: any) { sseController = c; c.enqueue(enc.encode('event: subscribed\ndata: {"event":"subscribed"}\n\n')) } }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  const method = init?.method ?? 'GET'
  // auth
  if (url.endsWith('/api/auth/config')) return json({ password_required: false })
  if (url.endsWith('/api/auth/me')) return json({ id: 'fuqingxu', display_name: '付清旭', role: 'admin', work_dir: '/tmp' })
  if (url.endsWith('/api/auth/login')) return json({ token: 'mock-jwt-token', user: { id: 'fuqingxu', display_name: '付清旭', role: 'admin' } })
  // sessions (must be checked before issues/projects — the session URL contains /issues too)
  if (url.includes('/sessions') && url.includes('/issues') && method === 'POST') return json({ session_id: SID })         // create session
  if (url.includes('/sessions') && url.includes('/issues') && method === 'GET') {                                            // list sessions (resume)
    return json([{ session_id: SID, name: '历史会话一', last_active: new Date(Date.now() - 3600_000).toISOString(), message_count: 5, model: 'codex', issue_title: '命令行任务' }])
  }
  if (url.endsWith('/messages') && method === 'POST') {
    setTimeout(() => {
      emit('typing', { active: true })
      emit('jsonl_entry', { session_id: SID, entry: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已收到，这是来自 TUI 的回复。' }] } } })
      emit('typing', { active: false })
    }, 200)
    return json({ ok: true, session_id: SID, turn_number: 1 })
  }
  // issues
  if (url.includes('/api/projects/') && url.includes('/issues') && method === 'POST') return json({ id: IID, project_id: PID, title: '命令行任务' })  // create issue
  if (url.includes('/api/projects/') && url.includes('/issues') && method === 'GET') return json([{ id: IID, project_id: PID, title: '命令行任务' }]) // list issues
  // projects
  if (url.includes('/api/projects') && method === 'GET') return json([{ id: PID, name: '已有项目甲' }])   // list projects
  if (url.endsWith('/api/projects') && method === 'POST') return json({ id: PID, name: '测试项目PTY' })   // create project (exact)
  // preference lookups
  if (url.includes('/sessions/model-options')) return json([{ key: 'codex', label: 'GPT-5.5', title: 'GPT-5.5', sub: 'Codex', backend: 'tmux-codex' }])
  if (url.includes('/sessions/default-model')) return json({ model: 'codex' })
  if (url.includes('/skills')) return json([])
  if (url.includes('/memories')) return json([])
  return json({ error: `unmocked ${method} ${url}` }, 404)
}

async function waitFor(lastFrame: () => string | undefined, needle: string, timeoutMs = 4000) {
  for (let i = 0; i < timeoutMs / 50; i++) {
    if ((lastFrame() ?? '').includes(needle)) return true
    await delay(50)
  }
  return false
}

async function main() {
  // Pre-seed login so App auto-logs in (login form itself is covered in ui.test).
  fs.writeFileSync(path.join(TMP_HOME, 'login.json'), JSON.stringify({
    server: 'http://mock.local', username: 'fuqingxu', token: 'mock-jwt-token',
    user: { id: 'fuqingxu', display_name: '付清旭', role: 'admin' },
  }))
  const realFetch = globalThis.fetch
  globalThis.fetch = ((u: any, init?: any) => mockFetch(String(u), init)) as unknown as typeof fetch
  process.env.MOBIUS_TUI_DEBUG = '1'

  console.log('\n[FLOW] full App drive (mocked backend)\n')
  const { stdin, lastFrame, unmount } = render(React.createElement(App))

  try {
    // ── prep: project picker (auto-logged in) ────────────────────────────────
    ok(await waitFor(lastFrame, '选择当前路径的绑定项目'), 'booted into project picker')
    // pick "➕ 创建新项目" (active index 0) → name wizard
    stdin.write('\r'); await delay(120)
    ok(await waitFor(lastFrame, '项目名称'), 'project create wizard opened')
    stdin.write('测试项目PTY'); await delay(120)
    stdin.write('\r'); await delay(120)                              // → desc field
    stdin.write('\r'); await delay(300)                             // submit desc (empty)
    snap('1-prep-project-created', lastFrame() ?? '')

    // ── prep: issue picker (no issues → create) ──────────────────────────────
    ok(await waitFor(lastFrame, '创建新任务'), 'issue picker shown')
    stdin.write('\r'); await delay(120)                             // → create-name
    ok(await waitFor(lastFrame, '第 1 步'), 'issue name wizard opened')
    stdin.write('命令行任务'); await delay(120)
    stdin.write('\r'); await delay(120)                             // → worktree step
    ok(await waitFor(lastFrame, '第 2 步'), 'issue worktree wizard opened')
    stdin.write('\r'); await delay(300)                             // 否 (no worktree)

    // ── prep: preferences ────────────────────────────────────────────────────
    ok(await waitFor(lastFrame, '选择模型'), 'model picker shown')
    stdin.write('\r'); await delay(250)                             // pick codex
    ok(await waitFor(lastFrame, '选择回复语言'), 'language picker shown')
    stdin.write('\r'); await delay(400)                             // zh; skills+memories empty → auto-skip

    // ── chat ─────────────────────────────────────────────────────────────────
    ok(await waitFor(lastFrame, '输入问题'), 'entered chat (preferences complete)')
    snap('2-chat-ready', lastFrame() ?? '')

    // send a message — expect streamed assistant reply
    stdin.write('你好，请回复一句话'); await delay(120)
    stdin.write('\r')
    ok(await waitFor(lastFrame, '已收到', 6000), 'assistant reply streamed into transcript')
    await delay(300)
    snap('3-chat-after-reply', lastFrame() ?? '')

    // ── /clear ───────────────────────────────────────────────────────────────
    stdin.write('/clear'); await delay(120)
    stdin.write('\r')
    ok(await waitFor(lastFrame, '输入问题'), '/clear reset to a fresh chat')
    snap('4-after-clear', lastFrame() ?? '')

    // ── /resume ──────────────────────────────────────────────────────────────
    // /resume — wait for the post-/clear remount to settle, then type slowly.
    await delay(500)
    stdin.write('/resume'); await delay(300)
    stdin.write('\r')
    await delay(500)
    snap('4b-resume-picker', lastFrame() ?? '')
    ok(await waitFor(lastFrame, '恢复历史会话'), '/resume picker opened')
    ok((lastFrame() ?? '').includes('历史会话一'), 'resume list shows the past session')
    stdin.write('\r'); await delay(500)                             // pick session → reconnect SSE
    ok(await waitFor(lastFrame, '输入问题'), 'resumed into chat')
    snap('5-after-resume', lastFrame() ?? '')
  } finally {
    unmount()
    globalThis.fetch = realFetch
  }

  console.log('\n──────── captured frames ────────')
  for (const s of snapshots) {
    console.log(`\n── ${s.step} ──`)
    console.log(s.frame.replace(/\n{3,}/g, '\n\n').trim())
  }

  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
  console.log(`\n==== FLOW RESULT: ${pass} passed, ${fail} failed ====\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(2) })
