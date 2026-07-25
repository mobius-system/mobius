/**
 * Regression test: when ~/.mobius already has a bound project + an issue whose
 * preferences are all configured, the app must boot STRAIGHT into chat (not get
 * stuck on a bare prep header, and not need to re-run the wizard).
 *
 * Run:  npm run test:resume
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-tui-resume-'))
process.env.MOBIUS_TUI_HOME = TMP_HOME

import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../src/App.js'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const CWD = process.cwd()
const PID = 'proj-r', IID = 'issue-r'
let pass = 0, fail = 0
function ok(c: boolean, m: string) { c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.error(`  ✗ ${m}`)) }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function mockFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? 'GET'
  if (url.endsWith('/api/auth/me')) return json({ id: 'fuqingxu', display_name: 'x', role: 'admin' })
  if (url.includes('/api/projects') && method === 'GET' && !url.includes('issues')) return json([{ id: PID, name: '绑定项目' }])
  if (url.includes('/issues') && method === 'GET') return json([{ id: IID, project_id: PID, title: '已配置任务' }])
  if (url.includes('/sessions/model-options')) return json([{ key: 'codex', label: 'GPT', title: 'GPT', sub: '', backend: 'x' }])
  return json({ error: `unmocked ${method} ${url}` }, 404)
}

async function main() {
  // Pre-seed: token + cwd→project binding + issue with all prefs done.
  fs.writeFileSync(path.join(TMP_HOME, 'login.json'), JSON.stringify({
    server: 'http://mock.local', username: 'fuqingxu', token: 'tok', user: { id: 'fuqingxu', display_name: 'x', role: 'admin' },
  }))
  fs.writeFileSync(path.join(TMP_HOME, 'dir2project.json'), JSON.stringify({ [CWD]: PID }))
  fs.writeFileSync(path.join(TMP_HOME, 'dir2project_preference.json'), JSON.stringify({
    [CWD]: { issueId: IID, issueTitle: '已配置任务', prefs: { [IID]: {
      model: 'codex', language: 'zh', excluded_skill_ids: [], excluded_memory_ids: [],
      done: ['model', 'language', 'skills', 'memories'],
    } } },
  }))

  const realFetch = globalThis.fetch
  globalThis.fetch = ((u: any, init?: any) => mockFetch(String(u), init)) as unknown as typeof fetch

  console.log('\n[RESUME] boot with saved prefs → straight to chat\n')
  let reachedChat = false
  const { lastFrame, unmount } = render(React.createElement(App))
  for (let i = 0; i < 80; i++) {        // up to ~4s
    if ((lastFrame() ?? '').includes('输入问题')) { reachedChat = true; break }
    await delay(50)
  }
  const frame = lastFrame() ?? ''
  unmount()
  globalThis.fetch = realFetch

  ok(reachedChat, 'booted straight into chat (skipped wizard)')
  ok(frame.includes('绑定项目') && frame.includes('已配置任务'), 'chat header shows the saved project + issue')
  ok(!frame.includes('选择当前路径的绑定项目') && !frame.includes('选择模型'), 'did NOT show project/model picker')

  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
  console.log(`\n==== RESUME RESULT: ${pass} passed, ${fail} failed ====\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(2) })
