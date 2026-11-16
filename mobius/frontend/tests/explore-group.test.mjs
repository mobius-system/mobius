import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const result = await build({
  entryPoints: [fileURLToPath(new URL('../src/components/viewer/explore-group.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
const { isExploreToolUse, groupExploreItems } = await import(dataUrl)

function claudeTool(name, id = 'claude-read') {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input: { path: '/remote/file.ts' } }] } }
}

function codexTool(name, namespace) {
  return { type: 'response_item', payload: { type: 'function_call', name, namespace, call_id: 'codex-read', arguments: '{}' } }
}

const remoteReads = [
  claudeTool('mcp__aimux__remote_read'),
  codexTool('mcp__aimux__remote_read'),
  codexTool('remote_read', 'mcp__aimux'),
]
for (const entry of remoteReads) {
  assert.equal(isExploreToolUse(entry), true)
  const items = [entry, claudeTool('Read', 'local-read')].map((item, index) => ({ entry: item, lineNo: index + 1 }))
  const grouped = groupExploreItems(items, null)
  assert.equal(grouped.length, 1)
  assert.equal(grouped[0].kind, 'explore')
  assert.deepEqual(grouped[0].items, items)
  assert.equal(grouped[0].hasError, false)
  assert.equal(groupExploreItems(items.slice(0, 1), null)[0].kind, 'single')
  const callId = entry.payload?.call_id || entry.message.content[0].id
  const statuses = new Map([[callId, { isError: true, interrupted: false }]])
  assert.equal(groupExploreItems(items, statuses)[0].hasError, true)
}

for (const name of ['Read', 'Grep', 'Glob', 'WebFetch', 'web_search', 'LS']) {
  assert.equal(isExploreToolUse(claudeTool(name)), true)
  assert.equal(isExploreToolUse(codexTool(name)), true)
}

for (const entry of [
  claudeTool('mcp__aimux__remote_exec_command'),
  claudeTool('mcp__aimux__remote_apply_patch'),
  claudeTool('mcp__other__remote_read'),
  codexTool('remote_read', 'mcp__other'),
  codexTool('remote_read'),
  claudeTool('Write'),
  { type: 'assistant', message: { content: [{ type: 'text', text: '继续探索' }] } },
]) {
  assert.equal(isExploreToolUse(entry), false)
  const items = [remoteReads[0], entry, remoteReads[1]].map((item, index) => ({ entry: item, lineNo: index + 1 }))
  assert.deepEqual(groupExploreItems(items, null).map(item => item.kind), ['single', 'single', 'single'])
}

console.log('explore-group: remote reads reuse exploration groups across Claude and Codex')
