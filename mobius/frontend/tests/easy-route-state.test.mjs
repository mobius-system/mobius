/**
 * 极简路由状态与 Research 接管 — 验证 (Phase 0)。
 *
 * 覆盖:
 *   1. buildEasyModeTargetUrl 的 section/project/session/research/agent 参数序列化
 *   2. buildEasyModeUrlFromContext: research 会话 → research 区带 agent; issue 会话 → projects 区带 session
 *   3. parseEasyModeRouteState 往返 (URL → 状态 → URL)
 *   4. layoutModeTargetPath 对 Research 路径的识别 (从 App.tsx 提取的正则直接测试)
 *
 * 运行: npx tsx frontend/tests/easy-route-state.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildEasyModeTargetUrl, buildEasyModeUrlFromContext, parseEasyModeRouteState } from '../src/services/easy-route-state'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 1. 参数序列化 ──
assert.equal(
  buildEasyModeTargetUrl({ user: 'admin', section: 'projects' }),
  '/u/admin/easy_mode',
  '缺省 section=projects 时省略 section 参数',
)
assert.equal(
  buildEasyModeTargetUrl({ user: 'admin', section: 'research', researchId: 'r1', agentId: 's1', projectId: 'p1' }),
  '/u/admin/easy_mode?section=research&project=p1&research=r1&agent=s1',
  'research 区带全量参数',
)
assert.equal(
  buildEasyModeTargetUrl({ user: 'admin', projectId: 'p1', sessionId: 's1' }),
  '/u/admin/easy_mode?project=p1&session=s1',
  'projects 区带 project+session',
)
console.log('1. URL 序列化: passed')

// ── 2. 上下文推导 ──
assert.equal(
  buildEasyModeUrlFromContext({ user: 'admin', projectId: 'p1', sessionId: 's1', scopeType: 'research', researchId: 'r1' }),
  '/u/admin/easy_mode?section=research&project=p1&research=r1&agent=s1',
  'research 会话 → research 区带 agent',
)
assert.equal(
  buildEasyModeUrlFromContext({ user: 'admin', projectId: 'p1', sessionId: 's1', scopeType: 'issue' }),
  '/u/admin/easy_mode?project=p1&session=s1',
  'issue 会话 → projects 区',
)
assert.equal(
  buildEasyModeUrlFromContext({ user: 'admin' }),
  '/u/admin/easy_mode',
  '无上下文 → 极简主页',
)
console.log('2. 上下文推导: passed')

// ── 3. 往返 ──
{
  const url = buildEasyModeTargetUrl({ user: 'admin', section: 'research', researchId: 'r1', agentId: 's1', projectId: 'p1' })
  const state = parseEasyModeRouteState(new URLSearchParams(url.split('?')[1]))
  assert.equal(state.section, 'research')
  assert.equal(state.projectId, 'p1')
  assert.equal(state.researchId, 'r1')
  assert.equal(state.agentId, 's1')
  const state2 = parseEasyModeRouteState(new URLSearchParams(''))
  assert.equal(state2.section, 'projects', '空查询回落 projects')
}
console.log('3. 往返解析: passed')

// ── 4. layoutModeTargetPath 正则验证 (从 App.tsx 源码提取正则直接测试) ──
{
  const appSource = readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8')
  const m = appSource.match(/const researchPage = pathname\.match\((.+)\/\)/)
  assert.ok(m, 'App.tsx 必须包含 Research 路由接管正则 (layoutModeTargetPath)')
  const pattern = m[1].slice(1, -1) // 去掉两侧斜线
  const researchRegex = new RegExp(pattern)
  assert.ok(researchRegex.test('/u/admin/p/p1/r/r1'), '识别标准 Research 路径')
  assert.ok(researchRegex.test('/u/admin/p/p1/r/r1/'), '识别带尾斜杠的 Research 路径')
  const captured = '/u/admin/p/p1/r/r1'.match(new RegExp(pattern))
  assert.equal(captured[1], 'admin', 'user 捕获组')
  assert.equal(captured[2], 'p1', 'project 捕获组')
  assert.equal(captured[3], 'r1', 'research 捕获组')
  assert.ok(!researchRegex.test('/u/admin/p/p1'), '项目页不被误判')
  assert.ok(!researchRegex.test('/u/admin/easy_mode'), 'easy_mode 自身不被误判')
}
console.log('4. Research 路由接管正则: passed')

console.log('easy route state tests passed')
