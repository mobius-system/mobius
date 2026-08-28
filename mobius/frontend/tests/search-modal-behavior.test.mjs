import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const helperPath = path.resolve(here, '../src/services/search-session-intent.ts')
const searchSource = fs.readFileSync(path.resolve(here, '../src/components/search-modal.tsx'), 'utf8')
const bundled = await build({
  entryPoints: [helperPath],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const dataUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
const {
  resolvedSessionId,
  searchInputIntent,
  sessionLookupErrorMessage,
  SESSION_UNAVAILABLE_MESSAGE,
} = await import(dataUrl)

test('有效 Session ID 走后端精确查询并通过 canonical 导航打开', () => {
  assert.deepEqual(searchInputIntent('  A1b2C3d4  '), {
    kind: 'session',
    query: 'A1b2C3d4',
    sessionId: 'a1b2c3d4',
  })
  assert.deepEqual(searchInputIntent('Session ID: a1b2c3d4'), {
    kind: 'session',
    query: 'Session ID: a1b2c3d4',
    sessionId: 'a1b2c3d4',
  })
  assert.deepEqual(searchInputIntent('session=legacy-session_17'), {
    kind: 'session',
    query: 'session=legacy-session_17',
    sessionId: 'legacy-session_17',
  })
  assert.equal(resolvedSessionId('a1b2c3d4', { session_id: 'a1b2c3d4' }), 'a1b2c3d4')
  assert.match(searchSource, /api\(`\/api\/tasks\/\$\{encodeURIComponent\(sessionId\)\}`/)
  assert.match(searchSource, /sessionNavigation\(user\?\.id \|\| '', verifiedSessionId, \{ match, timestamp \}\)/)
  assert.match(searchSource, /onNavigate\(destination\.path, \{ state: destination\.state \}\)/)
})

test('无效、不可见或不存在的 Session ID 保留查询并提供原地重试', () => {
  assert.equal(resolvedSessionId('a1b2c3d4', { session_id: 'ffffffff' }), null)
  assert.equal(sessionLookupErrorMessage(new Error('未找到')), SESSION_UNAVAILABLE_MESSAGE)
  assert.match(searchSource, /const retry: SearchRetryAction = \{ kind: 'session', query, sessionId, match, timestamp \}/)
  assert.match(searchSource, /setRetryAction\(retry\)[\s\S]*setErr\(sessionLookupErrorMessage\(reason\)\)/)
  assert.match(searchSource, /value=\{q\}/)
})

test('普通关键词继续使用既有 SSE 内容搜索', () => {
  assert.deepEqual(searchInputIntent('部署失败日志'), { kind: 'keyword', query: '部署失败日志' })
  assert.match(searchSource, /new URLSearchParams\(\{ q: t, limit: '50', range: rangeArg, stream: '1' \}\)/)
  assert.match(searchSource, /if \(intent\.kind === 'session'\)[\s\S]*runSearch\(intent\.query\)/)
})

test('关键词空结果可在原 overlay 用原 query 重新搜索', () => {
  assert.match(searchSource, /results\.length === 0[\s\S]*未找到匹配的会话[\s\S]*onClick=\{\(\) => runSearch\(q\)\}[\s\S]*重新搜索/)
  assert.doesNotMatch(searchSource, /results\.length === 0[\s\S]{0,500}setQ\(''\)/)
})

test('关键词和精确查询的 API 失败都记录对应动作且不清空输入', () => {
  assert.equal(sessionLookupErrorMessage(new Error('HTTP 503')), '查询 Session 失败：HTTP 503')
  assert.match(searchSource, /setRetryAction\(\{ kind: 'keyword', query: t, range: rangeArg, caseSensitive: cs, wholeWord: ww \}\)/)
  assert.match(searchSource, /retryAction\?\.kind === 'session' \? '重试打开' : '重试搜索'/)
  assert.match(searchSource, /if \(retryAction\?\.kind === 'session'\)[\s\S]*if \(retryAction\?\.kind === 'keyword'\)/)
})
