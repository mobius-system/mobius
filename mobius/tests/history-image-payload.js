const assert = require('assert')
const { historyEntryImageAt, projectHistoryEntryImages } = require('../backend/services/history-image-payload')

const base64 = Buffer.from('image payload').toString('base64')
const entry = {
  type: 'user',
  uuid: 'image-entry-test',
  message: {
    content: [{
      type: 'tool_result',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }],
    }],
  },
  toolUseResult: { file: { base64 } },
}

const projected = projectHistoryEntryImages('image-session-test', entry)
const projectedSource = projected.message.content[0].content[0].source
assert.strictEqual(projectedSource.type, 'url')
assert.match(projectedSource.url, /^\/access_base64_image\?/)
assert.strictEqual(projected.toolUseResult.file.base64, '[base64 omitted]')
assert.strictEqual(JSON.stringify(projected).includes(base64), false)
assert.deepStrictEqual(historyEntryImageAt(entry, 0), { mime: 'image/png', base64 })

const envelopeEntry = {
  uuid: 'envelope-entry',
  message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: JSON.stringify({ image_url: `data:image/png;base64,${base64}` }) }] }] },
}
const projectedEnvelope = projectHistoryEntryImages('image-session-test', envelopeEntry)
assert.match(projectedEnvelope.message.content[0].content[0].text, /\/access_base64_image\?/)
assert.strictEqual(projectedEnvelope.message.content[0].content[0].text.includes(base64), false)

const projectedWrappedEnvelope = projectHistoryEntryImages('image-session-test', {
  uuid: 'wrapped-envelope-entry',
  message: { content: `Image: data:image/png;base64,${base64}` },
})
assert.match(projectedWrappedEnvelope.message.content, /\/access_base64_image\?/)
assert.strictEqual(projectedWrappedEnvelope.message.content.includes(base64), false)

const unusedOnly = projectHistoryEntryImages('image-session-test', { toolUseResult: { file: { base64 } } })
assert.strictEqual(unusedOnly.toolUseResult.file.base64, '[base64 omitted]')

const truncatedEntry = {
  payload: { output: [{ type: 'input_text', text: JSON.stringify({ detail: 'high', image_url: `data:image/png;base64,${base64}…1499722 chars truncated…${base64}` }) }] },
}
const truncatedProjection = projectHistoryEntryImages('image-session-test', truncatedEntry, 'truncated')
assert.deepStrictEqual(JSON.parse(truncatedProjection.payload.output[0].text), { detail: 'high', image_url: '[base64 omitted]' })
assert.strictEqual(JSON.stringify(truncatedProjection).includes(base64), false)
assert.strictEqual(historyEntryImageAt(truncatedEntry, 0), null)
assert.strictEqual(projectHistoryEntryImages('image-session-test', truncatedProjection, 'truncated'), truncatedProjection)

const uuidFallback = projectHistoryEntryImages('image-session-test', {
  message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] },
}, 'sha1:stored-row')
assert.match(uuidFallback.message.content[0].source.url, /entry_uuid=sha1%3Astored-row/)

console.log('✅ history-image-payload: all assertions passed')
