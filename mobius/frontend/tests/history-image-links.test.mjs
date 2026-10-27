import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const extractPath = path.resolve(here, '../src/components/viewer/entry-extract.ts')
const imageUrlPath = path.resolve(here, '../src/components/viewer/image-url.ts')

const [extractorBundle, imageUrlBundle] = await Promise.all([
  build({ entryPoints: [extractPath], bundle: true, format: 'esm', platform: 'node', write: false }),
  build({ entryPoints: [imageUrlPath], bundle: true, format: 'esm', platform: 'node', write: false }),
])
const extractors = await import(`data:text/javascript;base64,${Buffer.from(extractorBundle.outputFiles[0].text).toString('base64')}`)
const imageUrlHelpers = await import(`data:text/javascript;base64,${Buffer.from(imageUrlBundle.outputFiles[0].text).toString('base64')}`)

const imageUrl = '/access_base64_image?session_id=session&entry_uuid=entry&image_index=0'
const entry = {
  type: 'user',
  uuid: 'entry',
  message: {
    content: [{
      type: 'tool_result',
      content: [{ type: 'image', source: { type: 'url', media_type: 'image/png', url: imageUrl } }],
    }],
  },
}
assert.deepEqual(extractors.claudeToolResultImageOutput(entry)?.imageUrls, [imageUrl])

globalThis.window = { location: { origin: 'https://mobius.test' }, localStorage: { getItem: () => 'jwt-token' } }
assert.equal(imageUrlHelpers.authenticatedImageUrl(imageUrl), `${imageUrl}&token=jwt-token`)
assert.equal(imageUrlHelpers.authenticatedImageUrl('/access_base64_image?token=old'), '/access_base64_image?token=jwt-token')
assert.equal(imageUrlHelpers.authenticatedImageUrl('/access_base64_image-not-an-endpoint'), '/access_base64_image-not-an-endpoint')
assert.equal(imageUrlHelpers.authenticatedImageUrl('https://example.test/image.png'), 'https://example.test/image.png')
console.log('✅ history image links: all assertions passed')
