const assert = require('assert')
const Database = require('better-sqlite3')
const { initializeSearchIndex, indexBatch, queryIndex } = require('../backend/services/search/index')
const { parseSearchQuery, extractSearchContent, matchingSnippet, searchWords } = require('../backend/services/search/content')

const db = new Database(':memory:')
db.exec(`CREATE TABLE entries(session_id TEXT,uuid TEXT,seq INTEGER,ts INTEGER,json TEXT);
  CREATE TABLE ingest_state(session_id TEXT PRIMARY KEY,error TEXT);`)
initializeSearchIndex(db)
const allowed = new Set(['inside', 'old-session'])
function add(session, uuid, text) {
  db.prepare('INSERT INTO entries VALUES(?,?,?,?,?)').run(session, uuid, 1, Date.now(),
    JSON.stringify({ type: 'user', message: { role: 'user', content: text } }))
}
function search(query, options = {}) {
  return queryIndex(db, { query, sessionIds: [...allowed], limit: 50, maxFragments: 3, ...options })
}
function drain() { while (indexBatch(db, allowed, 2)) {} }

add('inside', 'both', '数据库连接失败，需要修复。API 调用报错，repair.md 记录解决办法。')
add('inside', 'only-one', '数据库读取成功')
add('outside', 'external', '数据库连接失败，需要修复，API 调用报错。')
add('old-session', 'old', '数据库连接失败，需要修复')
assert.strictEqual(search('数据库 修复').indexing, true)
drain()
assert.strictEqual(search('数据库 修复').hits.length, 2)
assert.deepStrictEqual(search('API 报错').hits[0].fragments.map(item => item.uuid), ['both'])
assert.strictEqual(search('不存在的关键词').hits.length, 0)
assert.strictEqual(search('api 报错', { caseSensitive: true }).hits.length, 0)
assert.strictEqual(search('API 报错', { caseSensitive: true }).hits.length, 1)
assert.strictEqual(search('repair.md').hits.length, 1)
assert.strictEqual(search('API 报错', { sessionIds: ['old-session'] }).hits.length, 0)
assert.strictEqual(search('数据库 修复', { sessionIds: [] }).hits.length, 0)
assert.strictEqual(search('数据库 修复').indexing, false)
assert.throws(() => parseSearchQuery('a'), /2～200/)
assert.throws(() => parseSearchQuery('" *'), /有效/)
assert.ok(parseSearchQuery('API OR repair').match.includes('AND'))
assert.strictEqual(extractSearchContent({ message: { role: 'user', content:
  '以下信息描述了你正在协助的用户\nsecret-injected\n## 用户的问题\n实际问题 API 报错' } }).text.includes('secret-injected'), false)
assert.ok(extractSearchContent({ type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: '中文回答' }] } }).text.includes('中文回答'))
assert.ok(extractSearchContent({ payload: { type: 'function_call_output', output: '工具结果' } }).text.includes('工具结果'))
const longText = '头部关键词' + 'a'.repeat(220000) + ' 尾部关键词'
assert.ok(matchingSnippet(longText, ['头部关键词', '尾部关键词'], {}).includes('尾部关键词'))
const largeText = '数据库修复 API repair.md\n'.repeat(260000) + '最终关键词'
const tokenizationStarted = Date.now()
assert.deepStrictEqual(new Set(searchWords(largeText)), new Set(searchWords('数据库修复 API repair.md\n最终关键词')))
assert.ok(Date.now() - tokenizationStarted < 15000, 'multi-megabyte messages must not stall indexing')
assert.ok(searchWords(' '.repeat(4090) + 'boundarykeyword').includes('boundarykeyword'))
db.prepare('UPDATE entries SET json=? WHERE uuid=?').run(JSON.stringify({ message: { content: '已经恢复正常' } }), 'both')
drain()
assert.strictEqual(search('API 报错').hits.length, 0)
db.prepare('DELETE FROM entries WHERE session_id=?').run('old-session')
assert.strictEqual(search('数据库 修复').hits.length, 0)
add('inside', 'new', '新增中文内容，修复连接问题')
drain()
assert.strictEqual(search('修复 连接').hits[0].fragments[0].uuid, 'new')
const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='history_search_fts'").get().sql
assert.ok(sql.includes("content=''"), 'index must not store another copy of message text')
db.close()
console.log('indexed-search: ok')
