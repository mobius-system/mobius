/**
 * extension-entry.test.mjs — 拓展应用入口 URL 纯逻辑单元测试.
 *
 * 运行: node --test tests/extension-entry.test.mjs
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const helpersPath = path.resolve(__dirname, '../src/services/extension-entry.ts')

const bundled = await build({
  entryPoints: [helpersPath],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const code = bundled.outputFiles[0].text
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const { extensionAppUrlForProject } = await import(dataUrl)

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

test('extensionAppUrlForProject: 有效拓展项目返回 /extension/<name>/', () => {
  assert.equal(
    extensionAppUrlForProject({ kind: 'extension', extension_name: 'promo-video-studio', disabled: false }),
    '/extension/promo-video-studio/',
  )
})

test('extensionAppUrlForProject: 普通项目不返回入口', () => {
  assert.equal(extensionAppUrlForProject({ kind: 'normal', extension_name: 'promo-video-studio' }), '')
})

test('extensionAppUrlForProject: 已失效拓展不返回入口', () => {
  assert.equal(extensionAppUrlForProject({ kind: 'extension', extension_name: 'promo-video-studio', disabled: true }), '')
})

test('extensionAppUrlForProject: 非法标识不返回入口', () => {
  assert.equal(extensionAppUrlForProject({ kind: 'extension', extension_name: '../bad' }), '')
  assert.equal(extensionAppUrlForProject({ kind: 'extension', extension_name: 'BadName' }), '')
})

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\n${passed} passed`)
