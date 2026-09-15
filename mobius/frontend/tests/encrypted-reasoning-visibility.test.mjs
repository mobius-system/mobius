/** Consecutive unreadable encrypted reasoning cards keep only the last card. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const result = await build({
  entryPoints: [path.resolve(__dirname, '../src/components/viewer/visibility-rules.ts')],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
const visibilityRules = await import(dataUrl)

const encryptedReasoning = (id) => ({
  type: 'response_item',
  id,
  payload: {
    type: 'reasoning',
    encrypted_content: `encrypted-${id}`,
  },
})
const readableEncryptedReasoning = {
  type: 'response_item',
  id: 'readable',
  payload: {
    type: 'reasoning',
    encrypted_content: 'encrypted-readable',
    content: [{ type: 'reasoning_text', text: '可读思考' }],
  },
}
const answer = (id) => ({
  type: 'response_item',
  id,
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: id }] },
})
const item = (entry, lineNo) => ({ entry, lineNo })

const filtered = visibilityRules.hideRepeatedEncryptedReasoning([
  item(answer('before'), 10),
  item(encryptedReasoning('a'), 11),
  item(encryptedReasoning('b'), 12),
  item(encryptedReasoning('c'), 13),
  item(answer('separator'), 14),
  item(encryptedReasoning('single'), 15),
  item(readableEncryptedReasoning, 16),
  item(encryptedReasoning('after-readable-a'), 17),
  item(encryptedReasoning('after-readable-b'), 18),
])

assert.deepEqual(filtered.map((entry) => entry.lineNo), [10, 13, 14, 15, 16, 18])
console.log('visibility-rules: consecutive encrypted reasoning keeps only the last card')
