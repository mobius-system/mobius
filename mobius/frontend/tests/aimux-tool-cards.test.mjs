import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

async function loadModule(relativePath) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(relativePath, import.meta.url))],
    bundle: true, format: 'esm', target: 'node18', write: false, logLevel: 'silent',
  })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
}

const extract = await loadModule('../src/components/viewer/entry-extract.ts')
const { buildHeaderSummary } = await loadModule('../src/components/viewer/header-summary.ts')

function entries(name, input) {
  return [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: `mcp__aimux__${name}`, id: 'call-1', input }] } },
    { type: 'response_item', payload: { type: 'function_call', namespace: 'mcp__aimux', name, call_id: 'call-1', arguments: JSON.stringify(input) } },
    { type: 'response_item', payload: { type: 'function_call', name: `mcp__aimux__${name}`, call_id: 'call-1', arguments: JSON.stringify(input) } },
  ]
}

for (const entry of entries('remote_exec_python_script', { python_script_content: 'print("hello")\nprint(2)', workdir: '/remote' })) {
  const calls = extract.extractBashCalls(entry)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'print("hello")\nprint(2)')
  assert.equal(calls[0].cwd, '/remote')
  assert.equal(calls[0].commandSource, 'script')
  assert.equal(extract.isAimuxCommandToolUse(entry), true)
  const output = entry.type === 'assistant'
    ? { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'hello\n2' }] } }
    : { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'hello\n2' } }
  const merged = extract.mergeBashToolResultItems([entry, output], 0)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].bashResults[0].content, 'hello\n2')
}

for (const [name, input, expectedOld, expectedNew] of [
  ['remote_edit', { file_path: '/remote/app.py', old_string: 'before', new_string: 'after', replace_all: true }, 'before', 'after'],
  ['remote_write', { file_path: '/remote/app.py', content: 'print(1)\n' }, '', 'print(1)\n'],
  ['remote_write', { file_path: '/remote/app.py', content: '' }, '', ''],
]) {
  for (const entry of entries(name, input)) {
    assert.equal(extract.isAimuxRemoteApplyPatchToolUse(entry), true)
    const edit = extract.extractCodeEdit(entry)
    assert.equal(edit.files.length, 1)
    assert.equal(edit.files[0].filePath, '/remote/app.py')
    assert.equal(edit.files[0].oldString, expectedOld)
    assert.equal(edit.files[0].newString, expectedNew)
    assert.match(buildHeaderSummary(entry).short, /协作编辑.*app.py/)
    assert.equal(extract.extractBashCalls(entry).length, 0)
  }
}

for (const entry of entries('remote_apply_patch', { input: '*** Begin Patch\n*** Update File: app.py\n@@\n-before\n+after\n*** End Patch' })) {
  assert.equal(extract.extractCodeEdit(entry).files[0].kind, 'unified')
}
for (const entry of entries('remote_exec_command', { cmd: 'echo hello' })) {
  assert.equal(extract.extractBashCalls(entry)[0].command, 'echo hello')
}
for (const name of ['remote_edit', 'remote_write']) {
  for (const entry of entries(name, { file_path: '/remote/app.py' })) {
    assert.equal(extract.extractCodeEdit(entry), null)
  }
}
const remotePath = 'C:\\Users\\fuqingxu-hub\\Desktop\\jev\\decision_runner.py'
for (const entry of entries('remote_read', { file_path: remotePath, offset: 41 })) {
  assert.equal(extract.extractReadCalls(entry)[0].filePath, remotePath)
  assert.match(buildHeaderSummary(entry).short, /Read.*decision_runner.py/)
  for (const wrapped of [false, true]) {
    const body = JSON.stringify({ path: remotePath, total_lines: 180, returned_lines: 2, offset: 41, truncated: true, content: '    41\tdef decide():\n    42\t    return 1' })
    const content = wrapped ? [{ type: 'text', text: body }] : body
    const output = entry.type === 'assistant'
      ? { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content }] } }
      : { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: content } }
    const merged = extract.mergeBashToolResultItems([entry, output], 0)
    assert.equal(merged.length, 1)
    assert.equal(merged[0].readResults.length, 1)
    assert.deepEqual(merged[0].readResults[0].readFile, {
      filePath: remotePath, content: 'def decide():\n    return 1', numLines: 2, startLine: 41, totalLines: 180,
    })
    assert.equal(merged[0].bashResults, undefined)
  }
}
for (const entry of entries('remote_read', { file_path: '/remote/image.png' })) {
  assert.deepEqual(extract.entryReadImagePaths(entry), [])
}
const localImageRead = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/local/image.png' } }] } }
assert.deepEqual(extract.entryReadImagePaths(localImageRead), ['/local/image.png'])
console.log('aimux-tool-cards: execution, edits and read-result merging pass across Claude and Codex')
