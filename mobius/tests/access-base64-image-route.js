const assert = require('assert')
const Module = require('module')
const { projectHistoryEntryImages, historyEntryImageAt } = require('../backend/services/history-image-payload')

const sessionId = 'history-image-route-session'
const entryUuid = 'history-image-route-entry'
const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Q6sAAAAASUVORK5CYII='
const entry = {
  uuid: entryUuid,
  message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }] },
}
const projected = projectHistoryEntryImages(sessionId, entry)
const resourceUrl = projected.message.content[0].source.url
const originalLoad = Module._load
let canRead = true
let auditedAction = ''

Module._load = function (request, parent, isMain) {
  if (parent?.filename?.endsWith('/backend/routes/access-base64-image.ts')) {
    if (request === '../middleware/auth') {
      return {
        downloadAuth(req, res, next) {
          if (req.query.token !== 'valid-token') return res.status(401).json({ error: 'Unauthorized' })
          req.user = { id: 'test-reader' }
          next()
        },
      }
    }
    if (request === '../repositories/sessions') {
      return { Sessions: { findById: (id) => id === sessionId ? { session_id: id, user_id: 'test-owner' } : null } }
    }
    if (request === '../services/access-control') {
      return { canReadSession: () => canRead }
    }
    if (request === '../services/admin-audit') {
      return { recordAdminAuditIfCrossUser: (_user, action) => { auditedAction = action } }
    }
    if (request === '../services/mobius-agent-history') {
      return {
        getEntryImage: (sid, uuid, index) => sid === sessionId && uuid === entryUuid
          ? historyEntryImageAt(entry, index)
          : null,
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}

async function main() {
  const express = require('express')
  const { router } = require('../backend/routes/access-base64-image')
  const app = express()
  app.use('/access_base64_image', router)
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const baseUrl = `http://127.0.0.1:${server.address().port}${resourceUrl}`

  try {
    const ok = await fetch(`${baseUrl}&token=valid-token`)
    assert.strictEqual(ok.status, 200)
    assert.strictEqual(ok.headers.get('content-type'), 'image/png')
    assert.deepStrictEqual(Buffer.from(await ok.arrayBuffer()), Buffer.from(base64, 'base64'))
    assert.strictEqual(auditedAction, 'read_session_history_image')

    const noToken = await fetch(baseUrl)
    assert.strictEqual(noToken.status, 401)

    canRead = false
    const forbidden = await fetch(`${baseUrl}&token=valid-token`)
    assert.strictEqual(forbidden.status, 404)
    canRead = true

    const missingImage = await fetch(`${baseUrl.replace('image_index=0', 'image_index=1')}&token=valid-token`)
    assert.strictEqual(missingImage.status, 404)
    console.log('✅ access-base64-image route: projection, auth, access, and bytes passed')
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
