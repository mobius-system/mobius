import assert from 'node:assert/strict'
import {
  isUnambiguousFileCandidate,
  parseFileTarget,
} from '../src/components/easy-workbench/code-artifacts/file-target'

const inlineCode = (value: string) => isUnambiguousFileCandidate(value, 'inline-code')

// Git refs and extensionless relative directories are ambiguous. They must
// remain inline code instead of opening a bogus file preview.
assert.equal(inlineCode('origin/main'), false)
assert.equal(inlineCode('github/main'), false)
assert.equal(inlineCode('feature/chat-render'), false)
assert.equal(inlineCode('refs/heads/main'), false)
assert.equal(inlineCode('src/components'), false)
assert.equal(parseFileTarget('origin/main', { context: 'inline-code' }), null)

// Concrete file names and explicitly-shaped paths remain interactive.
assert.equal(inlineCode('src/components/App.tsx'), true)
assert.equal(inlineCode('README.md'), true)
assert.equal(inlineCode('./Dockerfile'), true)
assert.equal(inlineCode('../Makefile'), true)
assert.equal(inlineCode('/home/example/project/LICENSE'), true)
assert.equal(inlineCode('C:\\work\\project\\Dockerfile'), true)
assert.equal(inlineCode('docs/My Guide.md'), true)

// Whole commands must not become file references just because an argument has
// a file extension.
assert.equal(inlineCode('python3 start.py'), false)

console.log('file target tests passed')
