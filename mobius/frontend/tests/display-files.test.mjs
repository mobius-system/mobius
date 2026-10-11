import assert from 'node:assert/strict'
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundled = await build({
  entryPoints: [path.resolve(here, '../src/components/viewer/entry-extract.ts')],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
const { entryDisplayFiles } = await import(moduleUrl)

const bashEntry = (command) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] },
})

assert.deepEqual(entryDisplayFiles(bashEntry('display-files /tmp/a.txt /tmp/main.py')), [
  { path: '/tmp/a.txt' },
  { path: '/tmp/main.py' },
])
assert.deepEqual(entryDisplayFiles(bashEntry('display-files --remote dev-1 --root /srv/app "src/a file.py"')), [
  { path: 'src/a file.py', remote: 'dev-1', root: '/srv/app' },
])
assert.deepEqual(entryDisplayFiles(bashEntry("bash -c 'display-files --remote=dev-2 --root=/workspace README.md' && display-files README.md")), [
  { path: 'README.md', remote: 'dev-2', root: '/workspace' },
  { path: 'README.md' },
])
assert.deepEqual(entryDisplayFiles({
  type: 'response_item',
  payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'display-files /work/index.html' }) },
}), [{ path: '/work/index.html' }])
assert.deepEqual(entryDisplayFiles(bashEntry('echo display-files /tmp/ignored.py')), [])
// 只有 toolcall 卡片参与辨识: 普通卡片 (助手正文/用户消息/其它工具) 里出现多少 display-files 都不算
// Only tool-call cards are scanned: plain cards (assistant text / user message / other tools) never count
assert.deepEqual(entryDisplayFiles({
  type: 'assistant',
  message: { content: [{ type: 'text', text: '已改好:\ndisplay-files /tmp/a.ts 🎉' }] },
}), [])
assert.deepEqual(entryDisplayFiles({ type: 'user', message: { content: '帮我看看 display-files /tmp/a.ts' } }), [])
assert.deepEqual(entryDisplayFiles({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Edit', input: { command: 'display-files /tmp/a.ts' } }] },
}), [])
assert.deepEqual(entryDisplayFiles({
  type: 'response_item',
  payload: { type: 'function_call', name: 'some_other_tool', arguments: JSON.stringify({ command: 'display-files /tmp/a.ts' }) },
}), [])
// shell 控制符和重定向结束 argv；带引号或转义的同名字符仍可属于合法文件名
// Shell controls and redirects end argv; quoted or escaped copies remain valid file-name characters
assert.deepEqual(
  entryDisplayFiles(bashEntry('display-files mobius/a.ts mobius/b.js 2>&1 | tail -5')),
  [{ path: 'mobius/a.ts' }, { path: 'mobius/b.js' }],
)
assert.deepEqual(entryDisplayFiles(bashEntry('display-files a.ts 2>&1')), [{ path: 'a.ts' }])
assert.deepEqual(entryDisplayFiles(bashEntry('display-files a.ts 2>/dev/null')), [{ path: 'a.ts' }])
assert.deepEqual(entryDisplayFiles(bashEntry('display-files a.ts > output.log')), [{ path: 'a.ts' }])
assert.deepEqual(entryDisplayFiles(bashEntry('display-files a.ts 2> /tmp/error.log')), [{ path: 'a.ts' }])
assert.deepEqual(entryDisplayFiles(bashEntry('display-files a.ts & echo b.ts')), [{ path: 'a.ts' }])
assert.deepEqual(entryDisplayFiles(bashEntry('display-files "a&b.txt" "report>draft.md"')), [
  { path: 'a&b.txt' },
  { path: 'report>draft.md' },
])
assert.deepEqual(entryDisplayFiles(bashEntry('display-files a\\&b.txt')), [{ path: 'a&b.txt' }])
// 文件名里恰好带数字时不受影响
// A file name that merely ends in a digit stays intact
assert.deepEqual(entryDisplayFiles(bashEntry('display-files v2.ts')), [{ path: 'v2.ts' }])
console.log('display-files parser tests passed')
