import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '../src/components/workspace/code-conversation-pane.tsx'), 'utf8')

assert.match(source, /setResolvedRemoteRoot\(typeof data\?\.absolute_root_path === 'string'/,
  'remote root listings must retain the backend-resolved absolute root')
assert.match(source, /const effectiveRemoteRoot = resolvedRemoteRoot \|\| remoteRoot/,
  'later remote operations must reuse the resolved absolute root')
assert.match(source, /copyTextToClipboard\(target\.entry\.abs_path\)/,
  'copy absolute path must use the absolute entry value')
assert.match(source, /function MiddleEllipsisPath/,
  'the path row must use a dedicated middle-truncation renderer')
assert.match(source, /<MiddleEllipsisPath value=\{activeRootPath\} \/>/,
  'the active root path must keep its beginning and ending visible')
assert.match(source, /title=\{activeRootPath \|\| undefined\}/,
  'the untruncated full root path must remain available as a tooltip')

console.log('PASS remote bridge roots are absolute, reused by file operations, and middle-truncated only for display')
