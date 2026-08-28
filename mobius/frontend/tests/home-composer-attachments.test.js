import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HOME_COMPOSER_IMAGE_ACCEPT,
  extractClipboardImageFiles,
  extractDroppedImageFiles,
  isImageFile,
  isImagePath,
} from '../src/services/home-composer-attachments.ts'

test('Home 图片白名单接受常用图片并拒绝非图片扩展名', () => {
  for (const name of ['a.png', 'b.JPEG', 'c.webp', 'd.gif']) {
    assert.equal(isImagePath(name), true, name)
    assert.equal(isImageFile(new File(['image'], name)), true, name)
  }
  for (const name of ['notes.pdf', 'plain.txt']) {
    assert.equal(isImagePath(name), false, name)
    assert.equal(isImageFile(new File(['text'], name, { type: 'application/octet-stream' })), false, name)
  }
  assert.match(HOME_COMPOSER_IMAGE_ACCEPT, /\.png,[\s\S]*\.heif/)
})

test('clipboard image item 与 clipboardData.files 都能提取图片', () => {
  const itemImage = new File(['clipboard'], 'clipboard-image', { type: 'image/png' })
  const filesImage = new File(['files'], 'edge-files.webp', { type: 'image/webp' })
  const pdf = new File(['pdf'], 'ignored.pdf', { type: 'application/pdf' })
  const extracted = extractClipboardImageFiles({
    files: [filesImage, pdf],
    items: [
      { type: 'image/png', getAsFile: () => itemImage },
      { type: 'application/pdf', getAsFile: () => pdf },
    ],
  })
  assert.deepEqual(extracted, [filesImage, itemImage])
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
  const extracted = extractClipboardImageFiles({
    files: [filesImage],
    items: [{ type: 'image/png', getAsFile: () => itemImage }],
  })

  assert.deepEqual(extracted, [filesImage])
})

test('drop 只保留扩展名或 MIME 表明为图片的文件', () => {
  const pathImage = new File(['image'], 'camera.heic')
  const mimeImage = new File(['image'], 'clipboard', { type: 'image/png' })
  const text = new File(['text'], 'notes.txt', { type: 'text/plain' })
  const extracted = extractDroppedImageFiles({
    files: [pathImage, text],
    items: [
      { kind: 'file', getAsFile: () => mimeImage },
      { kind: 'file', getAsFile: () => text },
    ],
  })
  assert.deepEqual(extracted, [pathImage, mimeImage])
})
