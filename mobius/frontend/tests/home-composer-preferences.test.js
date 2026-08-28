import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HOME_LAST_MODEL_KEY,
  HOME_LAST_PROJECT_ID_KEY,
  readLastHomeModel,
  readLastHomeProjectId,
  rememberLastHomeModel,
  rememberLastHomeProjectId,
} from '../src/services/home-composer-preferences.ts'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  }
}

test('读写 Home 上次项目和模型', () => {
  const storage = memoryStorage()
  rememberLastHomeProjectId('project-1', storage)
  rememberLastHomeModel('gpt-5.6 · codex', storage)
  assert.equal(readLastHomeProjectId(storage), 'project-1')
  assert.equal(readLastHomeModel(storage), 'gpt-5.6 · codex')
  assert.equal(storage.values.get(HOME_LAST_PROJECT_ID_KEY), JSON.stringify('project-1'))
  assert.equal(storage.values.get(HOME_LAST_MODEL_KEY), JSON.stringify('gpt-5.6 · codex'))
})

test('坏 JSON 和不可用 storage 静默回退为空', () => {
  const storage = memoryStorage()
  storage.values.set(HOME_LAST_PROJECT_ID_KEY, '{bad json')
  storage.values.set(HOME_LAST_MODEL_KEY, JSON.stringify({ model: 'wrong-shape' }))
  assert.equal(readLastHomeProjectId(storage), '')
  assert.equal(readLastHomeModel(storage), '')

  const unavailable = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('blocked') },
  }
  assert.equal(readLastHomeProjectId(unavailable), '')
  assert.doesNotThrow(() => rememberLastHomeModel('model', unavailable))
})
