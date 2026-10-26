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

const foldResult = await build({
  entryPoints: [path.resolve(__dirname, '../src/components/viewer/fold-rules.ts')],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const foldDataUrl = 'data:text/javascript;base64,' + Buffer.from(foldResult.outputFiles[0].text).toString('base64')
const foldRules = await import(foldDataUrl)

const extractResult = await build({
  entryPoints: [path.resolve(__dirname, '../src/components/viewer/entry-extract.ts')],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const extractDataUrl = 'data:text/javascript;base64,' + Buffer.from(extractResult.outputFiles[0].text).toString('base64')
const entryExtract = await import(extractDataUrl)

const classifyResult = await build({
  entryPoints: [path.resolve(__dirname, '../src/components/viewer/entry-classify.ts')],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const classifyDataUrl = 'data:text/javascript;base64,' + Buffer.from(classifyResult.outputFiles[0].text).toString('base64')
const entryClassify = await import(classifyDataUrl)

const summaryResult = await build({
  entryPoints: [path.resolve(__dirname, '../src/components/viewer/header-summary.ts')],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const summaryDataUrl = 'data:text/javascript;base64,' + Buffer.from(summaryResult.outputFiles[0].text).toString('base64')
const headerSummary = await import(summaryDataUrl)

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
const codexSummaryReasoning = {
  type: 'response_item',
  id: 'codex-summary',
  payload: {
    type: 'reasoning',
    summary: [
      { type: 'summary_text', text: '**Defining validation sample counts**' },
      { type: 'summary_text', text: '**我正将单例标签帧锁定在训练集**' },
    ],
    encrypted_content: 'encrypted-codex-summary',
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

assert.equal(
  entryExtract.reasoningText(codexSummaryReasoning.payload),
  '**Defining validation sample counts**\n**我正将单例标签帧锁定在训练集**',
)
assert.equal(entryClassify.isUnreadableEncryptedReasoningEntry(codexSummaryReasoning), false)
assert.match(headerSummary.buildHeaderSummary(codexSummaryReasoning).full, /我正将单例标签帧锁定在训练集/)
assert.equal(entryExtract.reasoningText({ ...codexSummaryReasoning.payload, content: [] }), entryExtract.reasoningText(codexSummaryReasoning.payload))
assert.equal(entryExtract.reasoningText({ ...codexSummaryReasoning.payload, content: '  ' }), entryExtract.reasoningText(codexSummaryReasoning.payload))
assert.equal(entryExtract.reasoningText({ ...codexSummaryReasoning.payload, content: [{ text: '完整思考正文' }] }), '完整思考正文')
assert.equal(entryExtract.reasoningText({ summary: [null, {}, { text: '  ' }] }), '')
assert.deepEqual(
  visibilityRules.hideRepeatedEncryptedReasoning([
    item(encryptedReasoning('before-codex-summary'), 30),
    item(codexSummaryReasoning, 31),
    item(encryptedReasoning('after-codex-summary'), 32),
  ]).map((entry) => entry.lineNo),
  [30, 31, 32],
)

const collapsed = foldRules.computeCollapsedByForgottenFlag([
  item(answer('before-fold'), 20),
  item(encryptedReasoning('fold-me'), 21),
  item(readableEncryptedReasoning, 22),
  item(codexSummaryReasoning, 23),
])
assert.deepEqual([...collapsed], [21])
console.log('visibility-rules: consecutive encrypted reasoning keeps only the last card')
