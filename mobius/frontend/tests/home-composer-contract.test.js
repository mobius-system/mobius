import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSource = relativePath => fs.readFileSync(path.join(here, '..', relativePath), 'utf8')
const homeSource = readSource('src/pages/UserPage.tsx')
const attachmentSource = readSource('src/components/home-composer-attachments.tsx')
const preferenceSource = readSource('src/services/home-composer-preferences.ts')

test('Home composer 接入 paste/drop、选择器、缩略图和放大入口', () => {
  assert.match(homeSource, /className="workbench-composer relative[\s\S]*onPaste=\{handlePaste\}[\s\S]*onDrop=\{handleDrop\}/)
  assert.match(homeSource, /accept=\{HOME_COMPOSER_IMAGE_ACCEPT\}/)
  assert.match(homeSource, /<HomeComposerAttachments attachments=\{attachments\}/)
  assert.match(attachmentSource, /cursor-zoom-in[\s\S]*aria-label=\{`放大图片/)
  assert.match(attachmentSource, /event\.key === 'Escape'/)
  assert.match(attachmentSource, /workbench-layer-modal[\s\S]*aria-label="关闭图片预览"/)
  assert.match(attachmentSource, /URL\.revokeObjectURL/)
})

test('Home 持久化并按要求恢复上次项目和模型', () => {
  assert.match(preferenceSource, /mobius:ui:home:last-project-id/)
  assert.match(preferenceSource, /mobius:ui:home:last-model/)
  assert.match(homeSource, /requestedProjectId[\s\S]*lastRememberedProjectId[\s\S]*currentProject[\s\S]*usableProjects\[0\]/)
  assert.match(homeSource, /rememberLastHomeProjectId\(nextProjectId\)[\s\S]*setHomeSearch/)
  assert.match(homeSource, /rememberLastHomeModel\(model\)/)
  assert.match(homeSource, /lastRememberedModel=\{lastRememberedModel\}/)
  assert.doesNotMatch(homeSource, /setSelectedModel\(''\)/)
})
