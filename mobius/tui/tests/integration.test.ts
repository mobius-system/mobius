/**
 * Integration test — exercises the real Mobius backend end-to-end.
 *
 *   login (passwordless) → getMe → listModels → createProject → createIssue →
 *   createSession → sendMessage → open SSE → assert assistant entries stream in.
 *
 * Run:  npm run test:integration
 * Target: a local Mobius backend by default; set MOBIUS_TUI_SERVER /
 * MOBIUS_TUI_USER to point at a specific server.
 */
import { login, getMe, MobiusClient, ApiError } from '../src/api.js'
import { SseConnection } from '../src/sse.js'
import { assistantEntryText, isHiddenNoise } from '../src/lib/entry-view.js'
import type { AnyEntry } from '../src/types.js'

const SERVER = process.env.MOBIUS_TUI_SERVER || 'http://127.0.0.1:45616'
const USERNAME = process.env.MOBIUS_TUI_USER || 'admin'
const WAIT_MS = Number(process.env.MOBIUS_TUI_WAIT_MS || 90000)

let pass = 0, fail = 0
function ok(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; console.error(`  ✗ ${msg}`) }
}

async function main() {
  console.log(`\n[1/7] login → ${SERVER} as ${USERNAME}`)
  const lr = await login(SERVER, USERNAME)
  ok(!!lr.token && lr.token.length > 20, `got token (len ${lr.token.length})`)
  ok(lr.user.id === USERNAME, `user.id = ${lr.user.id} (${lr.user.display_name})`)

  console.log('\n[2/7] getMe validates token')
  const me = await getMe(SERVER, lr.token)
  ok(me.id === USERNAME, `getMe ok, role=${me.role}, work_dir=${me.work_dir}`)

  const client = new MobiusClient(SERVER, lr.token)

  console.log('\n[3/7] model options')
  const models = await client.modelOptions()
  const keys = models.map(m => m.key)
  ok(models.length > 0, `${models.length} models available`)
  ok(keys.includes('codex') || models.some(m => /codex|claude|deepseek/i.test(m.key)),
    `a usable model present (sample: ${keys.slice(0, 5).join(', ')})`)
  const modelKey = keys.includes('codex') ? 'codex' : models[0].key

  console.log('\n[4/7] create test project + issue')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const proj = await client.createProject({ name: `tui-itest-${stamp}`, description: 'TUI integration test (auto)', bindPath: `tui-itest-${stamp}`, defaultUseWorktree: false })
  ok(!!proj.id, `project created: ${proj.name} (${proj.id})`)
  const issue = await client.createIssue(proj.id, { title: 'auto-test', description: 'integration', use_worktree: false })
  ok(!!issue.id, `issue created: ${issue.title} (${issue.id})`)

  console.log('\n[5/7] create session with preferences')
  const session = await client.createSession(issue.id, {
    name: `tui-itest-${stamp}`, model: modelKey, language: 'zh',
    excluded_skill_ids: [], excluded_memory_ids: [],
  })
  ok(!!session.session_id, `session created (${session.session_id})`)

  console.log('\n[6/7] send message + open SSE, wait for assistant reply')
  await client.sendMessage(session.session_id, '请只回复两个字：成功。不要调用任何工具。')

  const entries: AnyEntry[] = []
  let gotAssistant = false
  let firstEntryMs = 0
  const t0 = Date.now()
  await new Promise<void>((resolve) => {
    const url = `${SERVER}/api/sessions/${encodeURIComponent(session.session_id)}/events?token=${encodeURIComponent(lr.token)}`
    const conn = new SseConnection(url, {
      onEntry: (entry) => {
        if (!firstEntryMs) firstEntryMs = Date.now() - t0
        entries.push(entry)
        if (!isHiddenNoise(entry) && assistantEntryText(entry)) gotAssistant = true
        if (gotAssistant) { setTimeout(resolve, 1500) } // grab trailing entries
      },
      onError: (m) => console.error('  (sse error)', m),
    })
    conn.start()
    const deadline = setTimeout(() => { conn.close(); resolve() }, WAIT_MS)
    // also resolve promptly once we clearly have a finalized assistant msg
    const poll = setInterval(() => {
      if (gotAssistant && Date.now() - (entries[entries.length - 1]?.__ts ?? 0) > 3000) {
        // no-op; rely on the 1.5s resolve above
      }
      if (Date.now() - t0 > WAIT_MS) { clearInterval(poll); clearTimeout(deadline) }
    }, 1000)
  })

  ok(entries.length > 0, `received ${entries.length} SSE jsonl_entry events`)
  ok(firstEntryMs > 0, `first entry after ${firstEntryMs}ms`)
  ok(gotAssistant, 'received an assistant text entry')

  // Show a sample of the transcript the TUI would render.
  console.log('\n  —— transcript sample ——')
  for (const e of entries.slice(0, 8)) {
    const t = assistantEntryText(e)
    if (t) console.log('  • ' + t.slice(0, 120).replace(/\n/g, '\n    '))
  }

  console.log('\n[7/7] cleanup')
  try { await client.stopSession(session.session_id) } catch { /* ignore */ }
  for (const p of [`/api/sessions/${session.session_id}`, `/api/issues/${issue.id}`, `/api/projects/${proj.id}`]) {
    try { await fetch(`${SERVER}${p}`, { method: 'DELETE', headers: { Authorization: `Bearer ${lr.token}` } }) } catch { /* ignore */ }
  }
  console.log('  (best-effort cleanup done)')

  console.log(`\n==== RESULT: ${pass} passed, ${fail} failed ====\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nFATAL:', e instanceof ApiError ? `${e.message} (HTTP ${e.status})` : e)
  process.exit(2)
})
