const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-skill-copy-scope-'))
process.env.CORE_DATA_PATH = tempRoot

const skillsFs = require('../backend/services/skills-fs')

function cleanup() {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

const sourceDir = path.join(
  skillsFs.ROOT,
  'user=owner',
  'project=source-project',
  '.claude',
  'skills',
  'shared-skill',
)
const sourceBody = '---\nname: shared-skill\ndescription: shared fixture\n---\n\nKeep both copies.'
fs.mkdirSync(sourceDir, { recursive: true })
fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), sourceBody)
fs.writeFileSync(path.join(sourceDir, 'notes.txt'), 'resource file')

const projectResult = skillsFs.moveSkill({
  id: 'project:owner:source-project:shared-skill',
  requesterUserId: 'owner',
  isAdmin: false,
  targetScope: 'project',
  targetProjectId: 'target-project',
})
assert.strictEqual(projectResult.ok, true)

const targetDir = path.join(
  skillsFs.ROOT,
  'user=owner',
  'project=target-project',
  '.claude',
  'skills',
  'shared-skill',
)
assert.strictEqual(fs.existsSync(sourceDir), true, 'source project skill remains after copy')
assert.strictEqual(fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8'), sourceBody)
assert.strictEqual(fs.existsSync(targetDir), true, 'target project skill is created')
assert.strictEqual(fs.readFileSync(path.join(targetDir, 'notes.txt'), 'utf8'), 'resource file')

fs.writeFileSync(path.join(targetDir, 'SKILL.md'), `${sourceBody}\nTarget-only edit.`)
assert.strictEqual(fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8'), sourceBody, 'copies are independent')

const userResult = skillsFs.moveSkill({
  id: 'project:owner:target-project:shared-skill',
  requesterUserId: 'owner',
  isAdmin: false,
  targetScope: 'user',
})
assert.strictEqual(userResult.ok, true)
const userDir = path.join(skillsFs.ROOT, 'user=owner', 'default_project', '.claude', 'skills', 'shared-skill')
assert.strictEqual(fs.existsSync(targetDir), true, 'project source remains after user-level copy')
assert.strictEqual(fs.existsSync(userDir), true, 'user-level target skill is created')

console.log('skill-copy-scope: ok')
