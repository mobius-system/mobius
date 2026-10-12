const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-user-work-dir-role-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')

const { db } = require('../db')
const {
  Users,
  workDirRoleProblem,
  assertWorkDirAssignable,
  previewDefaultWorkDir,
} = require('../backend/repositories/users')

function cleanup() {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

function expectEqual(label, actual, expected) {
  assert.strictEqual(actual, expected, `${label}: actual=${actual} expected=${expected}`)
  console.log(`PASS ${label}`)
}

function expectOk(label, condition, detail = '') {
  assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`)
  console.log(`PASS ${label}`)
}

const root = path.join(tempRoot, 'workspace')
const outside = path.join(tempRoot, 'outside')

function addUser(id, role, workDir) {
  db.prepare(
    `INSERT INTO users (id, display_name, password_hash, role, work_dir)
     VALUES (?, ?, 'hash', ?, ?)`,
  ).run(id, id, role, workDir)
}

// ---- 规则本体: 普通用户必须在工作区根下, 管理员不受限 ----
expectEqual('普通用户在根下放行', workDirRoleProblem(path.join(root, 'alice'), 'user'), null)
expectOk(
  '普通用户在根外被拒',
  /工作区根/.test(String(workDirRoleProblem(path.join(outside, 'alice'), 'user'))),
  workDirRoleProblem(path.join(outside, 'alice'), 'user'),
)
expectOk('根外被拒详情给出根路径', String(workDirRoleProblem(path.join(outside, 'alice'), 'user')).includes(root))
expectOk(
  '同名前缀目录不算在根下',
  /工作区根/.test(String(workDirRoleProblem(`${root}-other/alice`, 'user'))),
)
expectEqual('根自身不作为工作目录的角色判定', workDirRoleProblem(root, 'user'), null)
expectEqual('管理员可用根外路径', workDirRoleProblem(path.join(outside, 'boss'), 'admin'), null)
expectEqual('缺省角色按普通用户处理', workDirRoleProblem(outside, undefined) !== null, true)

// ---- 分配校验: 建号 / 改号走同一条断言 ----
addUser('worker', 'user', path.join(root, 'worker'))
addUser('boss', 'admin', path.join(outside, 'boss'))
addUser('legacy', 'user', path.join(outside, 'legacy'))

assert.throws(
  () => assertWorkDirAssignable('worker', path.join(outside, 'worker'), 'user'),
  /工作区根/,
  '普通用户改到根外应当抛错',
)
console.log('PASS 普通用户改到根外 throws')
assert.doesNotThrow(() => assertWorkDirAssignable('worker', path.join(root, 'worker2'), 'user'))
console.log('PASS 普通用户改到根下不抛错')
assert.doesNotThrow(() => assertWorkDirAssignable('boss', path.join(outside, 'boss2'), 'admin'))
console.log('PASS 管理员改到根外不抛错')
// 原值回填放行: 记录里既有的根外路径不该因本次校验把用户卡住.
assert.doesNotThrow(() => assertWorkDirAssignable('legacy', path.join(outside, 'legacy'), 'user'))
console.log('PASS 回填原值放行')
assert.throws(
  () => assertWorkDirAssignable('boss', path.join(root, 'worker'), 'admin'),
  /已是其他账号的工作目录/,
  '根下也不能占用别人已用的目录',
)
console.log('PASS 根下占用他人目录 throws')
assert.throws(
  () => assertWorkDirAssignable('boss', root, 'admin'),
  /工作区根目录所在位置/,
  '工作区根自己不能当工作目录',
)
console.log('PASS 工作区根自身 throws')

// ---- 默认工作目录预览: 唯一来源就是工作区根下的 <id> ----
expectEqual('新账号默认目录', previewDefaultWorkDir('fresh').work_dir, path.join(root, 'fresh'))
expectEqual('默认目录来源标记', previewDefaultWorkDir('fresh').source, 'workspace')
fs.mkdirSync(path.join(root, 'existing'), { recursive: true })
expectEqual('已存在的空目录同样可用', previewDefaultWorkDir('existing').work_dir, path.join(root, 'existing'))
// 默认位置已被占用 (目录里有内容) 时不给默认值 —— 预览不能推荐一个建号必报错的路径.
fs.mkdirSync(path.join(root, 'taken', 'inner'), { recursive: true })
expectEqual('默认位置已被占用时不给默认值', previewDefaultWorkDir('taken').source, 'none')
expectEqual('不给默认值时不返回路径', previewDefaultWorkDir('taken').work_dir, '')

// ---- 既有记录: 根内的自动目录会被建/保留, 根外的既成事实不被搬动 ----
fs.rmSync(path.join(root, 'worker'), { recursive: true, force: true })
const repaired = Users.findById('worker')
expectEqual('根内缺失的自动目录会被补建', repaired.work_dir, path.join(root, 'worker'))
expectOk('补建后的目录真实存在', fs.statSync(path.join(root, 'worker')).isDirectory())
expectEqual(
  '根外的既有记录保持不动',
  Users.findById('legacy').work_dir,
  path.join(outside, 'legacy'),
)

console.log('user-work-dir-role: ok')
