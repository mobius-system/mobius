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

test('Home composer 接入通用附件选择、paste/drop、缩略图和文件芯片', () => {
  assert.match(homeSource, /className="workbench-composer relative[\s\S]*onPaste=\{handlePaste\}[\s\S]*onDrop=\{handleDrop\}/)
  assert.match(homeSource, /type="file"[\s\S]*multiple[\s\S]*onChange=\{handleFileInputChange\}/)
  assert.doesNotMatch(homeSource, /HOME_COMPOSER_IMAGE_ACCEPT|accept=\{/)
  assert.match(homeSource, /data-home-composer-attachment-button[\s\S]*aria-label="选择附件"[\s\S]*<Paperclip/)
  assert.doesNotMatch(homeSource, /data-home-composer-expand-toggle|ImagePlus/)
  assert.match(homeSource, /<HomeComposerAttachments attachments=\{attachments\}/)
  assert.match(homeSource, /kind: attachment\.kind/)
  assert.match(attachmentSource, /cursor-zoom-in[\s\S]*aria-label=\{`放大图片/)
  assert.match(attachmentSource, /aria-label=\{`文件附件/)
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
