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

function childLocksDb() {
  const child = spawn(process.execPath, ['-e', CHILD, require.resolve('better-sqlite3'), DB_PATH, String(HOLD_MS)], {
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

  fs.rmSync(dir, { recursive: true, force: true })
  console.log('agent-history-store-lock: ok')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
