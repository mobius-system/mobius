'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-admin-assistant-callbacks-'))
process.env.MOBIUS_DATA_PATH = tempDataPath

const adminSettings = require('../backend/services/admin-settings.ts').default

try {
  assert.deepStrictEqual(
    adminSettings.getAdminAssistantCallbackForUser('admin'),
    { enabled: false },
    'Session 状态上报应默认关闭',
  )
  assert.deepStrictEqual(adminSettings.listAdminAssistantCallbackUserIds(), [])

  assert.deepStrictEqual(
    adminSettings.setAdminAssistantCallbackForUser('admin', true),
    { enabled: true },
    '管理中心应能显式开启状态上报',
  )
  assert.deepStrictEqual(adminSettings.listAdminAssistantCallbackUserIds(), ['admin'])

  assert.deepStrictEqual(
    adminSettings.setAdminAssistantCallbackForUser('admin', false),
    { enabled: false },
    '管理中心应能再次关闭状态上报',
  )
  assert.deepStrictEqual(adminSettings.listAdminAssistantCallbackUserIds(), [])

  console.log('admin assistant callback settings tests passed')
} finally {
  fs.rmSync(tempDataPath, { recursive: true, force: true })
}
