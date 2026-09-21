/**
 * display-dedup-priority.test.mjs — 展示层去重的「开轮卡优先」规则单元测试.
 *
 * 直接 import src/components/viewer/display-dedup.ts 的真实实现 (经 esbuild 实时转译),
 * 不重新实现一份, 避免 "测试一份, 渲染另一份" 的脱节.
 *
 * 运行: node frontend/tests/display-dedup-priority.test.mjs
 *
 * 不引入新依赖: esbuild 是 vite 的 transitive dep, 已存在 node_modules/.bin/esbuild.
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const bundled = await build({
  entryPoints: [path.resolve(__dirname, '../src/components/viewer/display-dedup.ts')],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const code = bundled.outputFiles[0].text
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const { filterDisplayDuplicates } = await import(dataUrl)

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
    if (process.env.VERBOSE) console.error(err.stack)
  }
}

// ── 构造器: 贴近真实 jsonl 形态 ────────────────────────────────────────────

/*
 * Builds the card the Mobius send path writes. An opener carries an opening kind (user /
 * user-sp-command / mobius-xiaomo); a non-opener carries one of the notice kinds.
 */
function mobiusCard(uuid, text, opener = true) {
  return {
    type: 'user',
    entrypoint: 'mobius',
    uuid,
    timestamp: '2026-09-21T03:00:00.000Z',
    message: { role: 'user', content: text },
    mobius: { schema_version: 1, kind: opener ? 'user' : 'mobius-monitor', source: 'session.send' },
  }
}
/*
 * Builds the plain user card the agent CLI writes for the same input (no mobius block).
 */
function nativeCard(uuid, text) {
  return {
    type: 'user',
    entrypoint: 'cli',
    uuid,
    timestamp: '2026-09-21T03:00:00.500Z',
    message: { role: 'user', content: text },
  }
}
/*
 * Builds the codex mirror of a user input (event_msg.user_message), a third copy of the text.
 */
function codexMirror(uuid, text) {
  return { type: 'event_msg', uuid, payload: { type: 'user_message', message: text } }
}
function assistantCard(uuid, text) {
  return { type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } }
}
const uuids = (list) => list.map((e) => e.uuid)

// ── 开轮卡优先: 双轨冲突 ───────────────────────────────────────────────────
test('开轮卡优先: 同文的原生卡让位, 留下开轮卡 (开轮卡在前)', () => {
  const out = filterDisplayDuplicates([mobiusCard('opener', '问题A'), nativeCard('native', '问题A')])
  assert.deepEqual(uuids(out), ['opener'])
})

test('开轮卡优先: 到达顺序颠倒时同样留开轮卡', () => {
  const out = filterDisplayDuplicates([nativeCard('native', '问题A'), mobiusCard('opener', '问题A')])
  assert.deepEqual(uuids(out), ['opener'])
})

test('开轮卡优先: 文本不同不误伤, 两张都留', () => {
  const out = filterDisplayDuplicates([mobiusCard('opener', '问题A'), nativeCard('native', '问题B')])
  assert.deepEqual(uuids(out), ['opener', 'native'])
})

test('开轮卡优先: 只吃掉同文的那张, 同组其它原生卡不受影响', () => {
  const out = filterDisplayDuplicates([
    mobiusCard('opener', '问题A'),
    nativeCard('nativeA', '问题A'),
    assistantCard('a1', '回答'),
    nativeCard('nativeB', '问题B'),
  ])
  assert.deepEqual(uuids(out), ['opener', 'a1', 'nativeB'])
})

// ── 开轮卡优先: codex 镜像 ─────────────────────────────────────────────────
test('开轮卡优先: 镜像先到也不重复显示 (旧行为会同时渲染镜像与开轮卡)', () => {
  const out = filterDisplayDuplicates([codexMirror('mirror', '问题A'), mobiusCard('opener', '问题A')])
  assert.deepEqual(uuids(out), ['opener'])
})

test('开轮卡优先: 镜像后到同样藏掉', () => {
  const out = filterDisplayDuplicates([mobiusCard('opener', '问题A'), codexMirror('mirror', '问题A')])
  assert.deepEqual(uuids(out), ['opener'])
})

// ── 连续重复 (同一行被逐字节重写两遍) ──────────────────────────────────────
test('连续重复: 逐字节相同的两行折叠成一条', () => {
  const out = filterDisplayDuplicates([nativeCard('same', '问题A'), nativeCard('same', '问题A')])
  assert.deepEqual(uuids(out), ['same'])
})

test('连续重复: 开轮卡被逐字节重写同样只剩一条', () => {
  const out = filterDisplayDuplicates([mobiusCard('same', '问题A'), mobiusCard('same', '问题A')])
  assert.deepEqual(uuids(out), ['same'])
})

// ── 非开轮 kind: 只有 user / user-sp-command / mobius-xiaomo 开轮 ──────────
test('监控通知卡不具备开轮卡优先级: 同文时仍旧藏它 (维持旧行为)', () => {
  const out = filterDisplayDuplicates([mobiusCard('notice', '提醒正文', false), nativeCard('native', '提醒正文')])
  assert.deepEqual(uuids(out), ['native'])
})

test('监控通知卡在前、原生卡在后: 原生卡不因它让位', () => {
  const out = filterDisplayDuplicates([nativeCard('native', '提醒正文'), mobiusCard('notice', '提醒正文', false)])
  assert.deepEqual(uuids(out), ['native'])
})

test('同文三者相遇: 通知卡与原生卡都让位给开轮卡', () => {
  const out = filterDisplayDuplicates([
    mobiusCard('reminder', '同一段文本', false),
    nativeCard('native', '同一段文本'),
    mobiusCard('opener', '同一段文本'),
  ])
  assert.deepEqual(uuids(out), ['opener'])
})

test('同文只有通知卡与开轮卡时，通知卡也让位', () => {
  const out = filterDisplayDuplicates([
    mobiusCard('reminder', '同一段文本', false),
    mobiusCard('opener', '同一段文本'),
  ])
  assert.deepEqual(uuids(out), ['opener'])
})

// ── 开轮 kind 的覆盖面 ─────────────────────────────────────────────────────
test('小莫提问 (kind=user, source=assistant.question) 是开轮卡', () => {
  const asked = { ...mobiusCard('xiaomo', '问题A'), mobius: { kind: 'user', source: 'assistant.question' } }
  const out = filterDisplayDuplicates([asked, nativeCard('native', '问题A')])
  assert.deepEqual(uuids(out), ['xiaomo'])
})

test('会话页 slash command (kind=user-sp-command) 是开轮卡', () => {
  const compact = { ...mobiusCard('compact', '/compact'), mobius: { kind: 'user-sp-command' } }
  const out = filterDisplayDuplicates([compact, nativeCard('native', '/compact')])
  assert.deepEqual(uuids(out), ['compact'])
})

test('跨智能体通讯 (kind=mobius-multiagent) 是开轮卡', () => {
  const relay = { ...mobiusCard('relay', '收到跨智能体通讯！'), mobius: { kind: 'mobius-multiagent' } }
  const out = filterDisplayDuplicates([relay, nativeCard('native', '收到跨智能体通讯！')])
  assert.deepEqual(uuids(out), ['relay'])
})

test('黑板提醒 (kind=mobius-blackboard) 不是开轮卡', () => {
  const board = { ...mobiusCard('board', '提醒正文'), mobius: { kind: 'mobius-blackboard' } }
  const out = filterDisplayDuplicates([board, nativeCard('native', '提醒正文')])
  assert.deepEqual(uuids(out), ['native'])
})

test('扩展发起 (kind=mobius-extension) 是开轮卡 (扩展拿它发新会话第一条消息)', () => {
  const ext = { ...mobiusCard('ext', '问题A'), mobius: { kind: 'mobius-extension' } }
  const out = filterDisplayDuplicates([ext, nativeCard('native', '问题A')])
  assert.deepEqual(uuids(out), ['ext'])
})

test('群聊 @agent (kind=mobius-com) 是开轮卡 (它跑在全新分身 session 里)', () => {
  const com = { ...mobiusCard('com', '问题A'), mobius: { kind: 'mobius-com' } }
  const out = filterDisplayDuplicates([com, nativeCard('native', '问题A')])
  assert.deepEqual(uuids(out), ['com'])
})

test('非 user 类型的 mobius 卡 (task_state / error) 不是开轮卡', () => {
  const taskState = { type: 'task_state', uuid: 'ts', message: { content: '问题A' }, mobius: { kind: 'task_state' } }
  const out = filterDisplayDuplicates([taskState, nativeCard('native', '问题A')])
  assert.deepEqual(uuids(out), ['ts', 'native'])
})

// ── 存量数据的旧 kind 兼容 ─────────────────────────────────────────────────
test('来源枚举之前的老卡 (kind=user_input) 仍被认作开轮卡', () => {
  const legacy = { ...mobiusCard('old', '问题A'), mobius: { kind: 'user_input' } }
  const out = filterDisplayDuplicates([legacy, nativeCard('native', '问题A')])
  assert.deepEqual(uuids(out), ['old'])
})

test('旧 kind=compact 同样被认作开轮卡', () => {
  const legacy = { ...mobiusCard('old', '/compact'), mobius: { kind: 'compact' } }
  const out = filterDisplayDuplicates([legacy, nativeCard('native', '/compact')])
  assert.deepEqual(uuids(out), ['old'])
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
