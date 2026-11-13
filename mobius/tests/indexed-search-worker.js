const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { cpuRestMs } = require('../backend/services/search/cpu-budget')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indexed-search-worker-'))
process.env.DB_PATH = path.join(root, 'business.db')
process.env.MOBIUS_DATA_PATH = root
process.env.MOBIUS_AGENT_HISTORY_STORE_PATH = path.join(root, 'history.db')
const history = require('../backend/services/mobius-agent-history')
const service = require('../backend/services/search/service')

async function main() {
  assert.strictEqual(cpuRestMs(35, 10, 1), 97)
  assert.strictEqual(cpuRestMs(35, 200, 1), 0)
  assert.strictEqual(cpuRestMs(100, 100, 56), 0)
  assert.strictEqual(cpuRestMs(35, 10, 0.5), 203)
  const testStarted = performance.now()
  const testCpu = process.cpuUsage()
  while (performance.now() - testStarted < 5000) {
    const started = performance.now()
    const initialCpu = process.cpuUsage()
    while (performance.now() - started < 10) Math.sqrt(performance.now())
    const used = process.cpuUsage(initialCpu)
    await new Promise(resolve => setTimeout(resolve, cpuRestMs((used.user + used.system) / 1000, performance.now() - started, 1)))
  }
  const used = process.cpuUsage(testCpu)
  const cpuPercent = (used.user + used.system) / ((performance.now() - testStarted) * 10)
  assert.ok(cpuPercent <= 35, `CPU limiter used ${cpuPercent.toFixed(1)}% of one core`)
  console.log(`cooperative CPU budget: ${cpuPercent.toFixed(1)}% of one core`)
  const source = path.join(root, 'source.jsonl')
  fs.writeFileSync(source, JSON.stringify({ uuid: 'native', type: 'assistant', timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: '中文连接失败，需要修复数据库' } }) + '\n')
  history.syncSession('inside', source)
  service.refreshSearchSources([{ sessionId: 'inside', path: source, backend: 'tmux-codex' }])
  const request = { query: '连接 修复', sessionIds: ['inside'], limit: 10, maxFragments: 3 }
  let result
  for (let attempt = 0; attempt < 1200; attempt++) {
    result = await service.searchHistory(request, new AbortController().signal)
    if (result.hits.length) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.strictEqual(result.hits[0].fragments[0].uuid, 'native')
  fs.appendFileSync(source, JSON.stringify({ uuid: 'append', type: 'assistant', timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: '新增内容实时搜索' } }) + '\n')
  for (let attempt = 0; attempt < 1200; attempt++) {
    result = await service.searchHistory({ ...request, query: '新增 内容' }, new AbortController().signal)
    if (result.hits.length) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.strictEqual(result.hits[0].fragments[0].uuid, 'append')
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(service.searchHistory(request, cancelled.signal), /取消/)
  const outside = await service.searchHistory({ ...request, sessionIds: ['outside'] }, new AbortController().signal)
  assert.deepStrictEqual(outside.hits, [])
  assert.strictEqual(outside.unavailable_sessions, 1)
  const backlog = path.join(root, 'backlog.jsonl')
  fs.writeFileSync(backlog, Array.from({ length: 2000 }, (_, index) => JSON.stringify({
    uuid: `backlog-${index}`, type: 'assistant', message: { role: 'assistant', content: '后台搜索索引并发写入回归测试 '.repeat(50) }
  })).join('\n') + '\n')
  history.syncSession('backlog', backlog)
  service.refreshSearchSources([{ sessionId: 'inside', path: source, backend: 'tmux-codex' },
    { sessionId: 'backlog', path: backlog, backend: 'tmux-codex' }])
  await new Promise(resolve => setTimeout(resolve, 200))
  let maximumWriteMs = 0
  for (let index = 0; index < 40; index++) {
    const started = performance.now()
    assert.strictEqual(history.writeMobiusCoreEntry({ sessionId: 'chat-priority', content: `并发用户提问 ${index}` }), true)
    maximumWriteMs = Math.max(maximumWriteMs, performance.now() - started)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(maximumWriteMs < 1000, `chat writes must not stall behind indexing: ${maximumWriteMs}ms`)
  assert.strictEqual(history.getPendingOpeners('chat-priority').length, 39)
  const Database = require('better-sqlite3')
  const verification = new Database(path.join(root, 'history.db'))
  verification.pragma('busy_timeout=3000')
  const beforeLock = verification.prepare('SELECT last_rowid FROM history_search_state').get().last_rowid
  verification.exec('BEGIN IMMEDIATE')
  await new Promise(resolve => setTimeout(resolve, 500))
  verification.exec('COMMIT')
  await new Promise(resolve => setTimeout(resolve, 1500))
  const afterLock = verification.prepare('SELECT last_rowid FROM history_search_state').get().last_rowid
  assert.ok(afterLock > beforeLock, 'indexing must resume after yielding to a foreground write lock')
  verification.close()
  console.log(`chat writes during indexing: 40/40 saved, max ${maximumWriteMs.toFixed(1)}ms`)
  console.log('indexed-search-worker: ok')
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  service.stopSearchWorkers()
  setTimeout(() => fs.rmSync(root, { recursive: true, force: true }), 500)
})
