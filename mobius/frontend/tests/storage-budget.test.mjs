/**
 * localStorage 预算与淘汰策略 — 验证同源 code-server 的配额余量.
 *
 * 覆盖:
 *   1. pruneStorageForQuota 按 ts 从旧到新淘汰, 缓存总预算 ≤ 1.5M 字符
 *   2. 非缓存 key (令牌/主题/草稿) 永不删除
 *   3. safeSetCacheItem 在配额满时先清缓存再重试, 最终写入成功
 *   4. prepareStorageForCodeServer 额外预留 2.5M 给 code-server
 *
 * 运行: npx tsx frontend/tests/storage-budget.test.mjs
 */
import assert from 'node:assert/strict'

class FakeStorage {
  constructor(limit) {
    this.map = new Map()
    this.limit = limit
  }
  get length() { return this.map.size }
  key(i) { return Array.from(this.map.keys())[i] ?? null }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null }
  setItem(k, v) {
    const next = new Map(this.map)
    next.set(k, String(v))
    let total = 0
    for (const [kk, vv] of next) total += kk.length + vv.length
    if (total > this.limit) {
      const err = new Error(`Setting the value of '${k}' exceeded the quota.`)
      err.name = 'QuotaExceededError'
      throw err
    }
    this.map = next
  }
  removeItem(k) { this.map.delete(k) }
  clear() { this.map.clear() }
  totalChars() {
    let total = 0
    for (const [k, v] of this.map) total += k.length + v.length
    return total
  }
}

// 模块读取全局 localStorage / window; 每个场景前重建假存储.
const ORIGIN_LIMIT = 5_242_880
globalThis.window = {}
globalThis.localStorage = new FakeStorage(ORIGIN_LIMIT)

const {
  pruneStorageForQuota,
  safeSetCacheItem,
  prepareStorageForCodeServer,
  ORIGIN_STORAGE_LIMIT_CHARS,
} = await import('../src/services/storage-budget.ts')

const now = Date.now()
const chunk = 'x'.repeat(20000)

// ── 1. 按 ts 淘汰, 预算内 ──
try {
  for (let i = 0; i < 300; i++) {
    localStorage.setItem(`mobius:list-cache:issues:p${i}:u1`, JSON.stringify({ ts: now - i * 60000, list: [chunk] }))
  }
} catch { /* 真实浏览器同样会在写满时抛错 */ }
localStorage.setItem('cc-token', 'jwt-keep')
localStorage.setItem('mobius:ui:draft:test', 'draft-keep')
const result = pruneStorageForQuota()
assert.ok(result.removed > 0, '超预算时必须触发淘汰')
let cacheChars = 0
let cacheKeys = 0
for (const k of localStorage.map.keys()) {
  const size = k.length + localStorage.getItem(k).length
  if (/^mobius:(list-cache|recent-sessions|session-input-history):/.test(k)) { cacheChars += size; cacheKeys++ }
}
assert.ok(cacheChars <= 1_500_000, `缓存应压到 1.5M 以内, 实际 ${cacheChars}`)
assert.ok(localStorage.totalChars() <= ORIGIN_STORAGE_LIMIT_CHARS - 2_000_000, '必须给 code-server 留 2M 余量')
assert.equal(localStorage.getItem('cc-token'), 'jwt-keep', '令牌不能被淘汰')
assert.equal(localStorage.getItem('mobius:ui:draft:test'), 'draft-keep', '用户草稿不能被淘汰')
// 最新 ts 的缓存应保留下来
assert.ok(localStorage.getItem('mobius:list-cache:issues:p0:u1'), '最新缓存应保留')
assert.equal(localStorage.getItem('mobius:list-cache:issues:p299:u1'), null, '最旧缓存应被删除')
console.log(`1. 预算淘汰: removed=${result.removed} cacheChars=${cacheChars} cacheKeys=${cacheKeys}`)

// ── 2. 配额满时 safeSetCacheItem 自愈 ──
localStorage.clear()
const big = 'y'.repeat(1000)
for (let i = 0; ; i++) {
  try { localStorage.setItem(`mobius:list-cache:fill${i}:u1`, big) } catch { break }
}
const ok = safeSetCacheItem('mobius:list-cache:fresh:u1', JSON.stringify({ ts: Date.now(), list: ['z'.repeat(400000)] }))
assert.equal(ok, true, '配额满时也应通过清理后写入成功')
assert.ok(localStorage.getItem('mobius:list-cache:fresh:u1'), '新缓存应写入')
console.log('2. 配额满自愈: passed')

// ── 3. 打开 code-server 前额外预留 ──
localStorage.clear()
for (let i = 0; i < 80; i++) {
  localStorage.setItem(`mobius:list-cache:issue${i}:u1`, JSON.stringify({ ts: now + i, list: [chunk] }))
}
localStorage.setItem('code-server-workspace-state', 'c'.repeat(1300000))
prepareStorageForCodeServer()
assert.ok(
  localStorage.totalChars() <= ORIGIN_STORAGE_LIMIT_CHARS - 2_500_000,
  `打开 code-server 前必须留 2.5M 余量, 实际剩余 ${ORIGIN_STORAGE_LIMIT_CHARS - localStorage.totalChars()}`,
)
console.log('3. code-server 预留: passed')

console.log('storage-budget: all passed')
