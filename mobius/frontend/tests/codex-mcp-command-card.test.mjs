/**
 * codex-mcp-command-card.test.mjs — codex 的 aimux MCP 命令调用要合成一张"协作执行"卡片.
 *
 * 线上现象 (codex 后端): 同一次远程命令在会话里渲染成两张"应答"字段卡 —
 *   1) response_item.function_call        namespace=mcp__aimux, name=remote_exec_command
 *   2) response_item.function_call_output call_id 与上者相同, output 里垫着 "Wall time: … / Output:"
 * 期望: 像 Claude 的 mcp__aimux__remote_exec_command 那样, 合并成一张命令 + 返回的卡片.
 *
 * 直接 import src/components/viewer/entry-extract.ts 的真实实现 (esbuild 实时转译).
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const srcPath = path.resolve(__dirname, '../src/components/viewer/entry-extract.ts')

const bundled = await build({
  entryPoints: [srcPath],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const mod = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))

const {
  extractBashCalls,
  isAimuxCommandToolUse,
  extractBashToolResultRecords,
  mergeBashToolResultItems,
  functionOutputBody,
} = mod

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`    ${error.message}`)
  }
}

const CALL_ID = 'call_TeIfpxkn5ZK0lEt3irb3o5YJ'
const COMMAND = 'python3 -u /tmp/diagnose.py poll | tail -n 30'

// 与线上 rollout 同构: codex 把 MCP 服务名放在 namespace 上, 工具名只有 remote_exec_command.
const functionCall = {
  type: 'response_item',
  timestamp: '2026-10-27T08:16:33.839Z',
  payload: {
    type: 'function_call',
    id: 'fc_0198306a17f702ce',
    name: 'remote_exec_command',
    namespace: 'mcp__aimux',
    arguments: JSON.stringify({ cmd: COMMAND, yield_time_ms: 1000, max_output_tokens: 2800 }),
    call_id: CALL_ID,
  },
}

// 真正的输出被包在 aimux exec 信封里, 前面还垫了两个 "Wall time / Output:" 文本块.
const envelope = JSON.stringify({
  output: 'codex (qwen3.8-max) on adhoc\n┃ Metric ┃ Value ┃',
  original_token_count: 882,
  wall_time_seconds: 2.369,
})
const functionCallOutput = {
  type: 'response_item',
  timestamp: '2026-10-27T08:16:37.166Z',
  payload: {
    type: 'function_call_output',
    id: 'fco_01a17c6e',
    call_id: CALL_ID,
    output: [
      { type: 'input_text', text: 'Wall time: 3.3141 seconds\nOutput:' },
      { type: 'input_text', text: envelope },
    ],
  },
}

// 同轮里的一条普通文本条目, 用来确认合并不会误吞别的卡.
const assistantMessage = {
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '接下来继续排查' }] },
}

console.log('\ncodex MCP 命令卡片')

test('function_call 被识别为一条命令调用 (call_id 即配对键)', () => {
  const calls = extractBashCalls(functionCall)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, CALL_ID)
  assert.equal(calls[0].command, COMMAND)
})

test('归属"协作执行"主题 (与 Claude 的 mcp__aimux__remote_exec_command 同款)', () => {
  assert.equal(isAimuxCommandToolUse(functionCall), true)
})

test('非 aimux 命名空间的 exec_command 不被当成命令卡', () => {
  const other = { ...functionCall, payload: { ...functionCall.payload, namespace: 'mcp__other' } }
  assert.deepEqual(extractBashCalls(other), [])
  assert.equal(isAimuxCommandToolUse(other), false)
})

test('无命名空间的 codex 内置 exec_command 行为不变', () => {
  const builtin = { ...functionCall, payload: { ...functionCall.payload, name: 'exec_command', namespace: undefined } }
  assert.equal(extractBashCalls(builtin).length, 1)
  assert.equal(isAimuxCommandToolUse(builtin), false)
})

test('function_call_output 的 "Wall time" 前缀被剥掉, 信封正文保留真实换行', () => {
  const [record] = extractBashToolResultRecords(functionCallOutput, 1)
  assert.equal(record.toolUseId, CALL_ID)
  assert.ok(!record.stdout.includes('Wall time'), `stdout 仍带前缀: ${record.stdout.slice(0, 80)}`)
  assert.ok(record.stdout.startsWith('codex (qwen3.8-max) on adhoc'))
  assert.ok(record.stdout.includes('\n┃ Metric ┃ Value ┃'))
})

test('output 数组里出现 "Output:" 但首块不是 Wall time 头时不做截断', () => {
  const body = functionOutputBody([
    { type: 'input_text', text: 'raw log line' },
    { type: 'input_text', text: 'Output: not a header' },
  ])
  assert.equal(body, 'raw log line\nOutput: not a header')
})

test('合并后只剩一张卡: 命令调用挂上返回结果, 输出条目不再单独出现', () => {
  const items = mergeBashToolResultItems([functionCall, functionCallOutput, assistantMessage], 0)
  assert.equal(items.length, 2)
  assert.equal(items[0].entry, functionCall)
  assert.equal(items[1].entry, assistantMessage)
  assert.equal(items[0].bashResults.length, 1)
  const result = items[0].bashResults[0]
  assert.ok(result.stdout.startsWith('codex (qwen3.8-max) on adhoc'))
  assert.deepEqual(
    result.meta.map((m) => `${m.label}=${m.value}`),
    ['耗时=2.369s', 'tokens=882'],
  )
  assert.equal(result.isError, false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
