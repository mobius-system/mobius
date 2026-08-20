/**
 * AIMUX remote_apply_patch JSONL card regression tests.
 * Bundles the production extractors so this checks the same parsing path the UI uses.
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

const extractors = await bundle('entry-extract.ts')
const summaries = await bundle('header-summary.ts')

const patch = [
  '*** Begin Patch',
  '*** Update File: /mnt/data/project/cross/e2b_backend.py',
  '@@',
  '-SLIME_ROOT = os.environ.get("SLIME_ROOT", "/root/slime")',
  '+SLIME_ROOT = _required_env("SLIME_ROOT")',
  '*** End Patch',
].join('\n')

const entry = {
  type: 'assistant',
  message: {
    content: [{
      type: 'tool_use',
      id: 'call_patch',
      name: 'mcp__aimux__remote_apply_patch',
      input: { input: patch },
    }],
  },
}

const edit = extractors.extractCodeEdit(entry)
assert.ok(edit, 'remote_apply_patch must produce a code edit')
assert.equal(edit.files.length, 1)
assert.equal(edit.files[0].kind, 'unified')
assert.equal(edit.files[0].filePath, '/mnt/data/project/cross/e2b_backend.py')
assert.equal(edit.files[0].addedLineCount, 1)
assert.equal(edit.files[0].removedLineCount, 1)
assert.equal(extractors.isAimuxRemoteApplyPatchToolUse(entry), true)
assert.equal(summaries.buildHeaderSummary(entry).full, '协作编辑 · e2b_backend.py')

const malformed = {
  ...entry,
  message: { content: [{ ...entry.message.content[0], input: { input: 'not a patch' } }] },
}
assert.equal(extractors.extractCodeEdit(malformed), null)
assert.equal(extractors.isAimuxRemoteApplyPatchToolUse(malformed), false)

console.log('aimux patch card tests passed')
