// 账号名录接口的角色分档策略:
//   管理员  → 关键字包含匹配 (空关键字给首屏候选), 结果含系统角色
//   普通用户 → 只允许"完整账号 id / 完整昵称"的精确解析, 不含系统角色, 空查询无结果
// 这是"普通用户不得获取系统用户清单"这条要求的落点 (services/user-directory.ts).
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-user-directory-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace')

const { db } = require('../db')
const { searchDirectory, resolveDirectoryIds } = require('../backend/services/user-directory')

function cleanup() {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)

function pass(label) { console.log(`PASS ${label}`) }
function ids(rows) { return rows.map((r) => r.id).sort() }

const admin = { id: 'admin', role: 'admin' }
const plain = { id: 'leilei', role: 'user' }

db.prepare(`INSERT INTO users (id, display_name, password_hash, role, work_dir) VALUES (?, ?, 'h', ?, ?)`)
  .run('admin', '管理员', 'admin', path.join(tempRoot, 'ws', 'admin'))
db.prepare(`INSERT INTO users (id, display_name, password_hash, role, work_dir) VALUES (?, ?, 'h', ?, ?)`)
  .run('leilei', '雷蕾', 'user', path.join(tempRoot, 'ws', 'leilei'))
db.prepare(`INSERT INTO users (id, display_name, password_hash, role, work_dir) VALUES (?, ?, 'h', ?, ?)`)
  .run('wangshijie', '王诗杰', 'user', path.join(tempRoot, 'ws', 'wangshijie'))
db.prepare(`INSERT INTO users (id, display_name, password_hash, role, work_dir, deleted_at) VALUES (?, ?, 'h', ?, ?, ?)`)
  .run('gone', '已删除的人', 'user', path.join(tempRoot, 'ws', 'gone'), '2026-01-01T00:00:00.000Z')

// ---- 管理员: 包含匹配 + 空查询首屏 + 带角色 ----
assert.deepStrictEqual(ids(searchDirectory(admin, 'shi')), ['wangshijie'], '管理员按 id 片段命中')
pass('管理员按 id 片段命中')
assert.deepStrictEqual(ids(searchDirectory(admin, '诗杰')), ['wangshijie'], '管理员按昵称片段命中')
pass('管理员按昵称片段命中')
const adminFirst = searchDirectory(admin, '')
assert.strictEqual(adminFirst.length, 3, '管理员空查询返回在职账号 (不含已删除)')
assert.ok(adminFirst.every((r) => typeof r.role === 'string'), '管理员结果含系统角色')
pass('管理员空查询返回首屏候选且含角色')

// ---- 普通用户: 只有精确解析 ----
assert.deepStrictEqual(searchDirectory(plain, 'shi'), [], '普通用户片段搜索无结果')
pass('普通用户片段搜索无结果')
assert.deepStrictEqual(searchDirectory(plain, ''), [], '普通用户空查询不返回任何账号')
pass('普通用户空查询不返回账号')
assert.deepStrictEqual(ids(searchDirectory(plain, 'wangshijie')), ['wangshijie'], '普通用户完整 id 命中')
pass('普通用户完整 id 命中')
assert.deepStrictEqual(ids(searchDirectory(plain, 'WangShiJie')), ['wangshijie'], '普通用户完整 id 大小写不敏感')
pass('普通用户完整 id 大小写不敏感')
assert.deepStrictEqual(ids(searchDirectory(plain, '王诗杰')), ['wangshijie'], '普通用户完整昵称命中')
pass('普通用户完整昵称命中')
assert.ok(searchDirectory(plain, 'wangshijie').every((r) => r.role === undefined), '普通用户结果不含系统角色')
pass('普通用户结果不含系统角色')
assert.deepStrictEqual(searchDirectory(plain, 'gone'), [], '普通用户查不到已删除账号')
pass('普通用户查不到已删除账号')

// ---- 批量按 id 解析 (下拉框 chip 渲染) ----
assert.deepStrictEqual(ids(resolveDirectoryIds(plain, ['leilei', 'wangshijie'])), ['leilei', 'wangshijie'], '普通用户可解析自己点名的 id')
pass('普通用户可解析自己点名的 id')
assert.ok(resolveDirectoryIds(plain, ['leilei']).every((r) => r.role === undefined), '普通用户按 id 解析不含系统角色')
pass('普通用户按 id 解析不含系统角色')
assert.ok(resolveDirectoryIds(admin, ['admin'])[0].role === 'admin', '管理员按 id 解析含系统角色')
pass('管理员按 id 解析含系统角色')
assert.deepStrictEqual(resolveDirectoryIds(plain, ['leilei', 'nobody']), [expectLeilei()], '不存在的 id 自动跳过')
pass('不存在的 id 自动跳过')
assert.deepStrictEqual(resolveDirectoryIds(plain, []), [], '空 id 列表返回空')
pass('空 id 列表返回空')

function expectLeilei() {
  return { id: 'leilei', display_name: '雷蕾' }
}

console.log('user directory policy tests passed')
