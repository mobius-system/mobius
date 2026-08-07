const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-memory-copy-scope-'))
process.env.CORE_DATA_PATH = tempRoot

const memoriesFs = require('../backend/services/memories-fs')

function cleanup() {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

const sourceDir = path.join(memoriesFs.ROOT, 'user=owner', 'project=source-project')
const sourceFile = path.join(sourceDir, 'mem-copy-fixture.md')
const sourceBody = '---\nname: copy fixture\ndescription: source memory\n---\n\nKeep this source.'
fs.mkdirSync(sourceDir, { recursive: true })
fs.writeFileSync(sourceFile, sourceBody)

const projectResult = memoriesFs.moveMemory({
  id: 'project:owner:source-project:mem-copy-fixture',
  requesterUserId: 'owner',
  isAdmin: false,
  targetScope: 'project',
  targetProjectId: 'target-project',
})
assert.strictEqual(projectResult.ok, true)

const targetFile = path.join(memoriesFs.ROOT, 'user=owner', 'project=target-project', 'mem-copy-fixture.md')
assert.strictEqual(fs.existsSync(sourceFile), true, 'source project memory remains after copy')
assert.strictEqual(fs.existsSync(targetFile), true, 'target project memory is created')
assert.strictEqual(fs.readFileSync(targetFile, 'utf8'), sourceBody)

fs.writeFileSync(targetFile, `${sourceBody}\nTarget-only edit.`)
assert.strictEqual(fs.readFileSync(sourceFile, 'utf8'), sourceBody, 'memory copies are independent')

const userResult = memoriesFs.moveMemory({
  id: 'project:owner:target-project:mem-copy-fixture',
  requesterUserId: 'owner',
  isAdmin: false,
  targetScope: 'user',
})
assert.strictEqual(userResult.ok, true)
const userFile = path.join(memoriesFs.ROOT, 'user=owner', 'default_project', 'mem-copy-fixture.md')
assert.strictEqual(fs.existsSync(targetFile), true, 'project source remains after user-level copy')
assert.strictEqual(fs.existsSync(userFile), true, 'user-level target memory is created')

console.log('memory-copy-scope: ok')
