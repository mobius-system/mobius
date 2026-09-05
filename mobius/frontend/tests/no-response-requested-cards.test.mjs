/**
 * "No response requested." synthetic placeholder card hiding regression tests.
 * Bundles the production classify predicates so this checks the same parsing
 * path the UI uses (isHiddenJsonlNoiseEntry drives all three views:
 * JsonlView / EasyJsonlView / agent-conversation-overlays).
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(__dirname, '../src/components/viewer')

async function bundle(moduleName) {
  const result = await build({
    entryPoints: [path.join(sourceRoot, moduleName)],
    bundle: true,
    format: 'esm',
    target: 'node18',
    write: false,
    logLevel: 'silent',
  })
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
  return import(dataUrl)
}

const classify = await bundle('entry-classify.ts')

function syntheticAssistant(text) {
  return {
    type: 'assistant',
    uuid: 'synthetic-1',
    timestamp: '2026-09-05T16:04:39.487Z',
    isApiErrorMessage: false,
    message: {
      id: 'msg_1',
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }
}

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// 1) 占位卡本体: 精确 "No response requested." 文本 + <synthetic> model → 命中隐藏谓词
check('exact placeholder text is hidden', () => {
  assert.equal(classify.isNoResponseRequestedEntry(syntheticAssistant('No response requested.')), true)
  assert.equal(classify.isHiddenJsonlNoiseEntry(syntheticAssistant('No response requested.')), true)
})

// 2) 同为 <synthetic> 的 API Error 卡有诊断价值 → 不隐藏
check('synthetic API error card is kept', () => {
  assert.equal(classify.isNoResponseRequestedEntry(syntheticAssistant('API Error: The operation timed out.')), false)
  assert.equal(classify.isHiddenJsonlNoiseEntry(syntheticAssistant('API Error: The operation timed out.')), false)
})

// 3) 真实模型发出同样文案 (理论场景) → 不隐藏, 只针对 <synthetic>
check('same text from a real model is kept', () => {
  const e = syntheticAssistant('No response requested.')
  e.message.model = 'glm-5.3'
  assert.equal(classify.isNoResponseRequestedEntry(e), false)
})

// 4) 占位文案作为前缀/后缀拼在其它内容里 → 不隐藏 (只匹配全文)
check('placeholder as substring prefix is kept', () => {
  assert.equal(classify.isNoResponseRequestedEntry(syntheticAssistant('No response requested. Anyway, here is the answer.')), false)
})

// 5) 空白容差: 尾随换行/空格仍视为占位卡
check('trailing whitespace still matches', () => {
  assert.equal(classify.isNoResponseRequestedEntry(syntheticAssistant('No response requested.\n')), true)
})

// 6) 中断时落盘的半截真实回复 (同为 <synthetic>) → 不隐藏
check('interrupted partial real reply is kept', () => {
  assert.equal(classify.isNoResponseRequestedEntry(syntheticAssistant('我先')), false)
})

// 7) 非 assistant 类型 / 缺 model / 非 content 数组 → 安全返回 false
check('malformed entries are safe', () => {
  assert.equal(classify.isNoResponseRequestedEntry({ type: 'user' }), false)
  assert.equal(classify.isNoResponseRequestedEntry({ type: 'assistant' }), false)
  assert.equal(classify.isNoResponseRequestedEntry({ type: 'assistant', message: { model: '<synthetic>' } }), false)
  assert.equal(classify.isNoResponseRequestedEntry(null), false)
})

console.log(`no-response-requested-cards: ${passed} tests passed`)
