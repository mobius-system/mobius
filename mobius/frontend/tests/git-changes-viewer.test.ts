import assert from 'node:assert/strict'
import { parseUnifiedDiff, splitUnifiedDiffFiles } from '../src/components/code-git/DiffRows.tsx'
import { buildUnifiedDiffRows } from '../src/components/viewer/CodeDiff.tsx'

const patch = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,3 +20,3 @@ function demo() {',
  ' same',
  '-old',
  '+new',
  ' tail',
  '',
].join('\n')

const model = parseUnifiedDiff(patch, 'src/app.ts')
assert.equal(model.hasHunks, true)
assert.equal(model.displayPath, 'src/app.ts')

const sourceRows = model.rows.filter(row => ['context', 'removed', 'added'].includes(row.kind))
assert.deepEqual(
  sourceRows.map(row => [row.kind, row.oldLine, row.newLine, row.text]),
  [
    ['context', 10, 20, 'same'],
    ['removed', 11, null, 'old'],
    ['added', null, 21, 'new'],
    ['context', 12, 22, 'tail'],
  ],
)
assert(model.rows.filter(row => row.kind === 'meta').every(row => row.oldLine === null && row.newLine === null))

const jsonlRows = buildUnifiedDiffRows({
  kind: 'unified',
  filePath: 'src/app.ts',
  unifiedDiff: patch,
  oldLineCount: 3,
  newLineCount: 3,
  addedLineCount: 1,
  removedLineCount: 1,
})
assert.deepEqual(
  jsonlRows.filter(row => ['context', 'removed', 'added'].includes(row.kind)).map(row => [row.kind, row.oldLine, row.newLine, row.text]),
  sourceRows.map(row => [row.kind, row.oldLine, row.newLine, row.text]),
  'JSONL CodeDiff and GitChangesViewer must share old/new line semantics',
)

const rename = parseUnifiedDiff([
  'diff --git a/old.ts b/new.ts',
  'similarity index 100%',
  'rename from old.ts',
  'rename to new.ts',
].join('\n'))
assert.equal(rename.renamed, true)
assert.equal(rename.hasHunks, false)
assert.equal(rename.oldPath, 'old.ts')
assert.equal(rename.newPath, 'new.ts')

const added = parseUnifiedDiff('diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n')
assert.equal(added.added, true)
assert.equal(added.oldPath, null)

const deleted = parseUnifiedDiff('diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n')
assert.equal(deleted.deleted, true)
assert.equal(deleted.newPath, null)

const binary = parseUnifiedDiff('diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n')
assert.equal(binary.binary, true)
assert.equal(binary.hasHunks, false)

const multiFile = splitUnifiedDiffFiles([
  patch.trimEnd(),
  'diff --git a/src/old-name.ts b/src/new-name.ts',
  'similarity index 100%',
  'rename from src/old-name.ts',
  'rename to src/new-name.ts',
  '',
].join('\n'))
assert.equal(multiFile.length, 2)
assert.equal(multiFile[0].path, 'src/app.ts')
assert.equal(multiFile[0].model.hasHunks, true)
assert.equal(multiFile[1].path, 'src/new-name.ts')
assert.equal(multiFile[1].model.renamed, true)
assert(!multiFile[0].diff.includes('src/new-name.ts'), 'commit 文件列表必须把每个 diff section 隔离')
assert.deepEqual(splitUnifiedDiffFiles(''), [])

console.log('git changes viewer tests passed')
