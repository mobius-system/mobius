import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractClipboardFiles,
  extractDroppedFiles,
  isImageFile,
  isImagePath,
} from '../src/services/home-composer-attachments.ts'

test('Home 能区分常用图片与普通文件', () => {
  for (const name of ['a.png', 'b.JPEG', 'c.webp', 'd.gif']) {
    assert.equal(isImagePath(name), true, name)
    assert.equal(isImageFile(new File(['image'], name)), true, name)
  }
  for (const name of ['notes.pdf', 'plain.txt']) {
    assert.equal(isImagePath(name), false, name)
    assert.equal(isImageFile(new File(['text'], name, { type: 'application/octet-stream' })), false, name)
  }
})

test('clipboard item 与 clipboardData.files 都能提取各种文件', () => {
  const itemImage = new File(['clipboard'], 'clipboard-image', { type: 'image/png' })
  const filesImage = new File(['files'], 'edge-files.webp', { type: 'image/webp' })
  const pdf = new File(['pdf'], 'ignored.pdf', { type: 'application/pdf' })
  const extracted = extractClipboardFiles({
    files: [filesImage, pdf],
    items: [
      { type: 'image/png', getAsFile: () => itemImage },
      { type: 'application/pdf', getAsFile: () => pdf },
    ],
  })
  assert.deepEqual(extracted, [filesImage, pdf, itemImage])
})

test('clipboardData.files 与 items 返回同图但时间戳不同时只添加一次', () => {
  const filesImage = new File(['same-image'], 'screenshot.png', {
    type: 'image/png',
    lastModified: 100,
  })
  const itemImage = new File(['same-image'], 'screenshot.png', {
    type: 'image/png',
    lastModified: 200,
  })
  const extracted = extractClipboardFiles({
    files: [filesImage],
    items: [{ type: 'image/png', getAsFile: () => itemImage }],
  })

  assert.deepEqual(extracted, [filesImage])
})

test('drop 接受图片和其他普通文件并去重', () => {
  const pathImage = new File(['image'], 'camera.heic')
  const mimeImage = new File(['image'], 'clipboard', { type: 'image/png' })
  const text = new File(['text'], 'notes.txt', { type: 'text/plain' })
  const extracted = extractDroppedFiles({
    files: [pathImage, text],
    items: [
      { kind: 'file', getAsFile: () => mimeImage },
      { kind: 'file', getAsFile: () => text },
    ],
  })
  assert.deepEqual(extracted, [pathImage, text, mimeImage])
})
