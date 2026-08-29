// run: node --require tsx/cjs tests/file-target-candidates.js
const assert = require('node:assert/strict')
const { projectPathCandidates } = require('../frontend/src/native-easy/components/code-artifacts/file-target.ts')

const legacy = projectPathCandidates('/frontend/src/components/conversation-rail.tsx')
assert.deepEqual(legacy, [
  '/frontend/src/components/conversation-rail.tsx',
  '/frontend/src/native-easy/components/conversation-rail.tsx',
])

const current = projectPathCandidates('/frontend/src/native-easy/components/conversation-rail.tsx')
assert.deepEqual(current, [
  '/frontend/src/native-easy/components/conversation-rail.tsx',
  '/frontend/src/components/conversation-rail.tsx',
])

assert.deepEqual(projectPathCandidates('/docs/README.md'), ['/docs/README.md'])
console.log('file target candidate tests passed')
