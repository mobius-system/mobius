/**
 * agent-history-store-lock.js — 并发写回归: 另一个连接持有写锁时, 用户消息卡必须等待后落库.
 *
 * 背景 (2026-11-13): 多 worker 共用 agent-history-store.db. 写事务若用默认的 BEGIN (deferred),
 * 事务内先读后写会撞上 SQLITE_BUSY_SNAPSHOT ("database is locked") — busy_timeout 对它无效,
 * 于是 writeMobiusCoreEntry 失败, 用户提问卡没写进库, 对话菜单里就少了这条提问.
 * 修法: 所有写事务改 BEGIN IMMEDIATE. 本测试用一个子进程占住写锁, 复现那次竞争.
 *
 * Regression for the concurrent-write path: while another connection holds the write lock, a
 * user message card must wait and then land. A deferred read-then-write transaction would raise
 * SQLITE_BUSY_SNAPSHOT immediately instead (busy_timeout does not cover it), which silently
 * dropped the card and made the question vanish from the chat.
 *
 * B 段另测: 持锁超过 busy_timeout 时首次写入失败, 后台重试必须在锁释放后补上这张卡 (幂等, 不重复).
 * Part B: when the lock outlives busy_timeout the first write fails and the background retry
 * must still land the card after the lock is released — exactly once.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const DB_PATH = path.join(os.tmpdir(), `agent-history-store-lock-test-${process.pid}.db`)
process.env.MOBIUS_AGENT_HISTORY_STORE_PATH = DB_PATH

const store = require('../backend/services/mobius-agent-history')

const HOLD_MS = 600

// 子进程: 先占住写锁, 通知父进程, 再保持 HOLD_MS 后提交退出.
// Child: grab the write lock, tell the parent, hold it for HOLD_MS, commit and exit.
const CHILD = `
const Database = require(process.argv[1])
const db = new Database(process.argv[2])
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 3000')
db.exec('BEGIN IMMEDIATE')
db.prepare("INSERT OR REPLACE INTO ingest_state (session_id, primary_path) VALUES ('lock-holder', '/tmp/holder.jsonl')").run()
process.stdout.write('locked\\n')
setTimeout(() => { db.exec('COMMIT'); process.exit(0) }, Number(process.argv[3]))
`

function childLocksDb(holdMs = HOLD_MS) {
  const child = spawn(process.execPath, ['-e', CHILD, require.resolve('better-sqlite3'), DB_PATH, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk.toString()
      if (out.includes('locked')) resolve(child)
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (!out.includes('locked')) reject(new Error(`child exited before locking (code ${code})`))
    })
  })
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahs-lock-'))
  const jsonl = path.join(dir, 'sess-lock.jsonl')
  const sid = `test-ahs-lock-${process.pid}`

  // 第一条: 新会话直接开第 1 轮, 让库里已存在 ingest_state 行 (并发写的真实前提).
  // First prompt opens round 1 directly, so the ingest_state row exists (the real precondition).
  assert.strictEqual(store.writeMobiusCoreEntry({ sessionId: sid, content: '第一问', primaryPath: jsonl }), true)

  const child = await childLocksDb()
  const startedAt = Date.now()
  let ok = false
  let error = null
  try {
    ok = store.writeMobiusCoreEntry({ sessionId: sid, content: '并发第二问', primaryPath: jsonl })
  } catch (e) {
    error = e
  }
  const waitedMs = Date.now() - startedAt
  await new Promise((resolve) => child.on('exit', resolve))

  assert.ifError(error)
  assert.strictEqual(ok, true, '锁释放后用户消息卡应写入成功')
  assert.ok(waitedMs >= HOLD_MS / 2, `应当等待持锁方释放后再写 (实际只等了 ${waitedMs}ms)`)

  const pending = store.getPendingOpeners(sid)
  assert.strictEqual(pending.length, 1, '并发写入的提问应挂起为待开轮卡')
  assert.strictEqual(pending[0].user_summary, '并发第二问')

  // ── B. 持锁超过 busy_timeout: 首次失败后由后台重试补写 (不丢卡) ──────────────
  // B. Hold past busy_timeout: the first attempt fails, the background retry still lands the card
  const childLong = await childLocksDb(4000)
  const t0 = Date.now()
  let firstError = null
  try {
    store.writeMobiusCoreEntry({ sessionId: sid, content: '超时后重试的第三问', primaryPath: jsonl })
  } catch (e) {
    firstError = e
  }
  const firstWaited = Date.now() - t0
  assert.ok(firstError, '持锁超过 busy_timeout 时首次写入应失败')
  assert.ok(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT'].includes(firstError.code), `应为忙等超时, 实际 ${firstError.code}`)
  assert.ok(firstWaited >= 2500, `首次应耗满 busy_timeout 而不是立刻失败 (实际 ${firstWaited}ms)`)

  await new Promise((resolve) => childLong.on('exit', resolve))
  // 给后台重试留出窗口 (退避 200/800/2000ms)
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const pendingAfterRetry = store.getPendingOpeners(sid)
  assert.strictEqual(pendingAfterRetry.length, 2, '重试应在锁释放后补上提问卡, 且不重复')
  assert.ok(pendingAfterRetry.some((p) => p.user_summary === '超时后重试的第三问'), '重试补上的卡片内容正确')

  fs.rmSync(dir, { recursive: true, force: true })
  console.log('agent-history-store-lock: ok')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
