// 原生文件编辑器右键菜单: 前端纯逻辑测试 (无 DOM/React)。
// 覆盖: 目录名计算、粘贴目标目录、跨项目/跨数据源/只读/复制到自身禁用、
//       重命名选区、目录重命名后 expanded 迁移、错误码文案、名称预校验。
// run: node --require tsx/cjs tests/file-tree-menu-logic.js
const assert = require('assert');
const {
  dirnameRel, joinRel, targetDirForPaste, canPaste,
  selectRenameRange, migrateExpandedPaths, errorCodeToMessage, isNameValidClient,
} = require('../frontend/src/components/workspace/file-tree-ops');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); pass++; console.log('  ok -', name); }
function eq(name, a, b) { assert.deepStrictEqual(a, b, `${name}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); pass++; console.log('  ok -', name); }

// Entry / target 构造助手
function file(name, abs) { return { name, type: 'file', size: 1, modified: '', abs_path: abs || '/r/' + name }; }
function dir(name, abs) { return { name, type: 'dir', size: null, modified: '', abs_path: abs || '/r/' + name }; }
function tgt(entry, relPath, parentRelPath) { return { entry, relPath, parentRelPath }; }

console.log('[dirnameRel]');
eq('根', dirnameRel('/'), '/');
eq('一级', dirnameRel('/a'), '/');
eq('多级', dirnameRel('/a/b/c.txt'), '/a/b');
eq('尾斜杠', dirnameRel('/a/b/'), '/a');

console.log('\n[joinRel]');
eq('根+名', joinRel('/', 'x'), '/x');
eq('目录+名', joinRel('/a', 'x'), '/a/x');

console.log('\n[targetDirForPaste]');
eq('null(根空白) -> 根', targetDirForPaste(null), '/');
eq('目录目标 -> 自身', targetDirForPaste(tgt(dir('d'), '/a/d', '/a')), '/a/d');
eq('文件目标 -> 父目录', targetDirForPaste(tgt(file('f.txt'), '/a/f.txt', '/a')), '/a');

console.log('\n[canPaste]');
const clip = { projectId: 'p1', source: 'hub', relPath: '/src/a.txt', type: 'file', name: 'a.txt' };
ok('剪贴板空 -> 禁用', canPaste(null, tgt(file('x'), '/x', '/'), 'p1', 'hub', true).ok === false);
ok('跨项目 -> 禁用', canPaste({ ...clip, projectId: 'p2' }, tgt(dir('d'), '/d', '/'), 'p1', 'hub', true).ok === false);
ok('跨数据源 -> 禁用', canPaste({ ...clip, source: 'local' }, tgt(dir('d'), '/d', '/'), 'p1', 'hub', true).ok === false);
ok('只读 -> 禁用', canPaste(clip, tgt(dir('d'), '/d', '/'), 'p1', 'hub', false).ok === false);
ok('合法文件粘贴 -> 允许', canPaste(clip, tgt(dir('d'), '/d', '/'), 'p1', 'hub', true).ok === true);
// 目录复制到自身/子目录
const dirClip = { projectId: 'p1', source: 'hub', relPath: '/a', type: 'dir', name: 'a' };
ok('目录复制到自身 -> 禁用', canPaste(dirClip, tgt(dir('a'), '/a', '/'), 'p1', 'hub', true).ok === false);
ok('目录复制到子目录 -> 禁用', canPaste(dirClip, tgt(dir('b'), '/a/b', '/a'), 'p1', 'hub', true).ok === false);
ok('目录复制到根 -> 允许', canPaste(dirClip, tgt(dir('c'), '/c', '/'), 'p1', 'hub', true).ok === true);
ok('跨项目粘贴有原因', !!canPaste({ ...clip, projectId: 'p2' }, tgt(dir('d'), '/d', '/'), 'p1', 'hub', true).reason);

console.log('\n[selectRenameRange]');
eq('文件名主体 (到首个点)', selectRenameRange('report.pdf'), { start: 0, end: 6 });
eq('双扩展取主体', selectRenameRange('archive.tar.gz'), { start: 0, end: 7 });
eq('隐藏文件全选', selectRenameRange('.gitignore'), { start: 0, end: 10 });
eq('无扩展全选', selectRenameRange('Makefile'), { start: 0, end: 8 });

console.log('\n[migrateExpandedPaths]');
const exp = new Set(['/', '/a', '/a/c', '/x']);
const next = migrateExpandedPaths(exp, '/a', '/b');
ok('旧路径迁移', next.has('/b'));
ok('子路径迁移', next.has('/b/c'));
ok('无关路径保留', next.has('/x') && next.has('/'));
ok('旧路径已移除', !next.has('/a') && !next.has('/a/c'));

console.log('\n[isNameValidClient]');
ok('合法名', isNameValidClient('ok.txt'));
ok('合法中文名', isNameValidClient('报告.pdf'));
ok('空非法', !isNameValidClient(''));
ok('斜杠非法', !isNameValidClient('a/b'));
ok('点非法', !isNameValidClient('.'));
ok('双点非法', !isNameValidClient('..'));
ok('保留名非法', !isNameValidClient('CON'));

console.log('\n[errorCodeToMessage]');
ok('NOT_FOUND 有文案', !!errorCodeToMessage('NOT_FOUND'));
ok('CONFLICT 有文案', !!errorCodeToMessage('CONFLICT'));
ok('未知码回退 UNKNOWN 文案', errorCodeToMessage('XXX') === errorCodeToMessage('UNKNOWN'));

console.log(`\n全部通过: ${pass} 项`);
