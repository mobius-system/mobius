// 原生文件编辑器右键菜单: 后端安全逻辑测试。
// 覆盖: 路径解析/穿越防护、newName 校验、复制到自身、符号链接(含中间目录)、
//       目录递归复制上限与失败清理。run: node --require tsx/cjs tests/native-file-menu.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveProjectPath } = require('../backend/services/project-path');
const { validateNewName, assertNoSymlink, isDirEqualOrChild, copyEntryRecursive, FileOpError } = require('../backend/services/project-file-ops');

// scratch 根不放在 /tmp (避免被 /tmp 放行规则干扰), 放 home 下隐藏目录, finally 整体清掉。
const scratch = path.join(os.homedir(), '.native-file-menu-test-scratch');
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, 'proj-'));

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); pass++; console.log('  ok -', name); }
function eq(name, actual, expected) { assert.strictEqual(actual, expected, `${name}: expected ${expected}, got ${actual}`); pass++; console.log('  ok -', name); }
function expectCode(name, fn, code) {
  try {
    fn();
    assert.fail(name + ': 应抛错但未抛');
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    eq(name + ' (code)', e && e.code, code);
  }
}
async function expectCodeAsync(name, fn, code) {
  try {
    await fn();
    assert.fail(name + ': 应抛错但未抛');
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    eq(name + ' (code)', e && e.code, code);
  }
}

(async () => {
  // ---------- resolveProjectPath: 路径解析与穿越防护 ----------
  console.log('\n[resolveProjectPath]');
  {
    const r = resolveProjectPath(root, '/a/b.txt');
    ok('合法相对路径无 error', !('error' in r));
    if (!('error' in r)) ok('absPath 落在 root 子树', r.absPath === path.join(root, 'a', 'b.txt'));
  }
  // resolveProjectPath 返回 {error} 而非抛出。
  {
    const r = resolveProjectPath(null, '/a');
    ok('未绑定路径返回 error', 'error' in r && typeof r.error === 'string');
  }
  {
    // ".." 字面被剔除, 剩余按相对 root 解析, 仍落在 root 子树 (无法越界)。
    const r = resolveProjectPath(root, '/../outside');
    ok('".." 被剥离后仍落在 root 内', !('error' in r) && (!('error' in r) && r.absPath.startsWith(root + path.sep)));
  }
  {
    // 绝对外部路径: 前导 / 被剥离后相对 root 解析 -> 被收容在 root 内 (无法越界读取系统文件)。
    const r = resolveProjectPath(root, '/etc/passwd');
    ok('绝对外部路径被收容在 root 内 (不越界)', !('error' in r) && r.absPath.startsWith(root + path.sep));
  }
  {
    // 多重穿越 ../ 仍被收容在 root 内。
    const r = resolveProjectPath(root, '/../../../../etc/passwd');
    ok('多重 ../ 仍被收容在 root 内', !('error' in r) && r.absPath.startsWith(root + path.sep));
  }
  {
    // 前缀相似但非子树 (sibling) 无法触达: ../sibling -> 剥离 .. -> 相对 root 解析, 仍在 root 内。
    const r = resolveProjectPath(root, '../' + path.basename(root) + '-evil/x');
    ok('sibling 前缀路径被收容在 root 内 (无法越界)', !('error' in r) && r.absPath.startsWith(root + path.sep));
  }

  // ---------- validateNewName ----------
  console.log('\n[validateNewName]');
  eq('普通文件名', validateNewName('report.pdf'), 'report.pdf');
  eq('去首尾空白', validateNewName('  name  '), 'name');
  expectCode('空串', () => validateNewName(''), 'INVALID_NAME');
  expectCode('仅空白', () => validateNewName('   '), 'INVALID_NAME');
  expectCode('点', () => validateNewName('.'), 'INVALID_NAME');
  expectCode('双点', () => validateNewName('..'), 'INVALID_NAME');
  expectCode('含正斜杠', () => validateNewName('a/b'), 'INVALID_NAME');
  expectCode('含反斜杠', () => validateNewName('a\\b'), 'INVALID_NAME');
  expectCode('含 NUL', () => validateNewName('a\x00b'), 'INVALID_NAME');
  expectCode('Windows 保留名 CON', () => validateNewName('CON'), 'INVALID_NAME');
  expectCode('Windows 保留名 nul.txt', () => validateNewName('nul.txt'), 'INVALID_NAME');
  expectCode('非字符串', () => validateNewName(123), 'INVALID_NAME');

  // ---------- isDirEqualOrChild (复制到自身/子目录) ----------
  console.log('\n[isDirEqualOrChild]');
  ok('自身', isDirEqualOrChild('/a', '/a'));
  ok('子目录', isDirEqualOrChild('/a', '/a/b'));
  ok('深层子目录', isDirEqualOrChild('/a', '/a/b/c'));
  ok('非子树 sibling /ab', !isDirEqualOrChild('/a', '/ab'));
  ok('非子树 /b', !isDirEqualOrChild('/a', '/b'));
  ok('父目录不算', !isDirEqualOrChild('/a/b', '/a'));

  // ---------- assertNoSymlink (含中间目录符号链接) ----------
  console.log('\n[assertNoSymlink]');
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'b', 'c.txt'), 'hi');
  await assertNoSymlink(root, path.join(root, 'a', 'b', 'c.txt')); // 正常路径不抛
  ok('正常路径通过', true);

  // 目标自身是符号链接 -> 拒绝
  fs.writeFileSync(path.join(root, 'target.txt'), 'x');
  fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, 'link.txt'));
  await expectCodeAsync('目标符号链接被拒', () => assertNoSymlink(root, path.join(root, 'link.txt')), 'SYMLINK_UNSUPPORTED');

  // 中间目录是符号链接 -> 拒绝
  fs.mkdirSync(path.join(root, 'realdir'), { recursive: true });
  fs.symlinkSync(path.join(root, 'realdir'), path.join(root, 'dirlink'));
  fs.writeFileSync(path.join(root, 'dirlink', 'f.txt'), 'x'); // 通过链接写入
  await expectCodeAsync('中间目录符号链接被拒', () => assertNoSymlink(root, path.join(root, 'dirlink', 'f.txt')), 'SYMLINK_UNSUPPORTED');

  // 越出 root -> 拒绝
  await expectCodeAsync('越出 root 被拒', () => assertNoSymlink(root, path.join(root, '..', 'outside')), 'OUTSIDE_ROOT');

  // ---------- copyEntryRecursive: 正常复制 / 上限 / 失败清理 / 符号链接 ----------
  console.log('\n[copyEntryRecursive]');
  // 正常目录树复制
  fs.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'A');
  fs.writeFileSync(path.join(root, 'src', 'sub', 'b.txt'), 'BB');
  await copyEntryRecursive(path.join(root, 'src'), path.join(root, 'dst'));
  ok('复制后目标 a.txt 存在', fs.existsSync(path.join(root, 'dst', 'a.txt')));
  ok('复制后嵌套 b.txt 存在', fs.existsSync(path.join(root, 'dst', 'sub', 'b.txt')));
  ok('复制内容正确', fs.readFileSync(path.join(root, 'dst', 'a.txt'), 'utf8') === 'A');

  // 单文件复制
  await copyEntryRecursive(path.join(root, 'src', 'a.txt'), path.join(root, 'a-copy.txt'));
  ok('单文件复制存在', fs.existsSync(path.join(root, 'a-copy.txt')));

  // 文件数量超限 -> TOO_LARGE 且清理 (不留下半成品 dst2)
  fs.mkdirSync(path.join(root, 'src2'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src2', 'x.txt'), '1');
  fs.writeFileSync(path.join(root, 'src2', 'y.txt'), '2');
  await expectCodeAsync('文件数超限 -> TOO_LARGE', () => copyEntryRecursive(path.join(root, 'src2'), path.join(root, 'dst2'), { maxFiles: 1, maxBytes: 1024 * 1024, maxDepth: 50 }), 'TOO_LARGE');
  ok('超限失败后清理半成品 dst2', !fs.existsSync(path.join(root, 'dst2')));

  // 源含符号链接 -> 拒绝
  fs.mkdirSync(path.join(root, 'src3'), { recursive: true });
  fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, 'src3', 'lnk'));
  await expectCodeAsync('复制源含符号链接 -> SYMLINK_UNSUPPORTED', () => copyEntryRecursive(path.join(root, 'src3'), path.join(root, 'dst3')), 'SYMLINK_UNSUPPORTED');

  console.log(`\n全部通过: ${pass} 项`);
})().catch((e) => {
  console.error('\n测试失败:', e && e.stack ? e.stack : e);
  process.exit(1);
}).finally(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 忽略清理错误 */ }
});
