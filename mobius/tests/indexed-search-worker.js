const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { fork } = require('child_process')
const { limitIndexerCpu } = require('../backend/services/search/cpu-budget')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'indexed-search-worker-'))
process.env.DB_PATH = path.join(root, 'business.db')
process.env.MOBIUS_DATA_PATH = root
process.env.MOBIUS_AGENT_HISTORY_STORE_PATH = path.join(root, 'history.db')
const history = require('../backend/services/mobius-agent-history')
const service = require('../backend/services/search/service')

async function main() {
  const burnerPath = path.join(root, 'cpu-burner.js')
  fs.writeFileSync(burnerPath, 'setInterval(() => { const until = Date.now() + 2000; while (Date.now() < until) {} }, 0)')
  const burner = fork(burnerPath, [], { execArgv: [], stdio: 'ignore' })
  limitIndexerCpu(burner)
  try {
    const readTicks = () => {
      const stat = fs.readFileSync(`/proc/${burner.pid}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return Number(fields[11]) + Number(fields[12])
    }
    const started = performance.now()
    const initialTicks = readTicks()
    await new Promise(resolve => setTimeout(resolve, 8000))
    const cpuPercent = (readTicks() - initialTicks) * 1000 / (performance.now() - started)
    assert.ok(cpuPercent <= 10, `CPU limiter used ${cpuPercent.toFixed(1)}% of one core`)
    assert.ok(cpuPercent > 1, 'CPU limiter must allow forward progress')
    console.log(`indexer CPU cap: ${cpuPercent.toFixed(1)}% of one core`)
  } finally {
    burner.kill('SIGCONT')
    burner.kill()
  }
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
  console.log('indexed-search-worker: ok')
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  service.stopSearchWorkers()
  setTimeout(() => fs.rmSync(root, { recursive: true, force: true }), 500)
})
