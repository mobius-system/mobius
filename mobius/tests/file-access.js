const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  authorize,
  canAccess,
  grantsFor,
  isWithin,
  joinWithin,
  normalizePath,
  tempRootFor,
  ensureTempRoot,
} = require('../backend/services/file-access');

// scratch 根必须不在 /tmp, 否则 temp 用例与工作区用例互相污染.
const scratchBase = path.join(os.homedir(), '.file-access-test-scratch');
fs.mkdirSync(scratchBase, { recursive: true });
const root = fs.mkdtempSync(path.join(scratchBase, 'case-'));

function mk(...segs) {
  const p = path.join(root, ...segs);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function deny(decision, reason) {
  assert.strictEqual(decision.allowed, false, `期望拒绝, 实际放行: ${JSON.stringify(decision)}`);
  if (reason) assert.strictEqual(decision.reason, reason, `拒绝原因应为 ${reason}, 实际 ${decision.reason}`);
}

try {
  const home = mk('home');
  const project = mk('projects', 'p1');
  const sessionDir = mk('projects', 'p1', '.mobius');
  const outside = mk('outside');
  const extUser = mk('extdata', 'acme', 'users', 'u1');
  const extOther = mk('extdata', 'acme', 'users', 'u2');
  const upload = mk('projects', 'p1', '.mobius', 'upload');
  const builtin = mk('builtin');
  const ctxPersonal = mk('ctx', 'personal');
  const ctxProject = mk('ctx', 'project');
  const ctxBuiltin = mk('ctx', 'builtin');

  const user = { id: 'u1', role: 'user', work_dir: home };
  const admin = { id: 'root', role: 'admin', work_dir: home };
  const otherUserTemp = tempRootFor('u2');
  const myTemp = tempRootFor('u1');

  // ── 纯谓词 ────────────────────────────────────────────────
  assert.strictEqual(isWithin(project, project), true);
  assert.strictEqual(isWithin(project, path.join(project, 'a', 'b')), true);
  assert.strictEqual(isWithin(project, path.join(root, 'outside')), false);
  assert.strictEqual(isWithin(project, project + 'X'), false, '前缀相同但不是子路径必须拒绝');
  assert.strictEqual(joinWithin(project, 'src', '..', '..', 'outside'), null);
  assert.strictEqual(normalizePath('  '), '');
  assert.strictEqual(tempRootFor('u1'), path.join('/tmp', 'mobius', 'mobius-u1'));
  // ensureTempRoot: 与 tempRootFor 同一路径, 并真的建出目录 (agent TMPDIR 就指这里); 幂等
  const created = ensureTempRoot('u1', scratchBase);
  assert.strictEqual(created, tempRootFor('u1', scratchBase));
  assert.strictEqual(fs.statSync(created).isDirectory(), true);
  assert.strictEqual(ensureTempRoot('u1', scratchBase), created);
  // uid 里的路径分隔符等危险字符被替换, 不会逃出 temp 根
  assert.strictEqual(tempRootFor('../../evil'), path.join('/tmp', 'mobius', 'mobius-.._.._evil'));

  // ── admin 全通 ────────────────────────────────────────────
  assert.strictEqual(canAccess(admin, 'read', path.join(outside, 'x.md'), []), true);
  assert.strictEqual(canAccess(admin, 'write', path.join(outside, 'x.md'), []), true);
  assert.strictEqual(canAccess(admin, 'write', path.join(builtin, 'x'), [{ kind: 'builtin_assets', path: builtin }]), true);

  // ── user_home 本人读写 ────────────────────────────────────
  const homeRoots = [{ kind: 'user_home', path: home }];
  assert.strictEqual(canAccess(user, 'write', path.join(home, 'a.txt'), homeRoots), true);
  assert.strictEqual(canAccess(user, 'read', home, homeRoots), true);
  deny(authorize(user, 'read', path.join(outside, 'a.txt'), homeRoots), 'OUTSIDE_ALLOWED_ROOTS');

  // ── project: viewer 读 / developer 写 ─────────────────────
  const viewerRoots = [{ kind: 'project', path: project, role: 'viewer' }];
  assert.strictEqual(canAccess(user, 'read', path.join(project, 'README.md'), viewerRoots), true);
  assert.strictEqual(canAccess(user, 'list', project, viewerRoots), true);
  deny(authorize(user, 'write', path.join(project, 'README.md'), viewerRoots), 'ACTION_DENIED');

  const devRoots = [{ kind: 'project', path: project, role: 'developer' }];
  assert.strictEqual(canAccess(user, 'write', path.join(project, 'README.md'), devRoots), true);
  const ownerRoots = [{ kind: 'project', path: project, role: 'owner' }];
  assert.strictEqual(canAccess(user, 'write', path.join(project, 'x'), ownerRoots), true);

  // 非成员 (role=null) 的 project 根不产生任何 grant
  const nonMemberRoots = [{ kind: 'project', path: project, role: null }];
  assert.strictEqual(grantsFor(user, nonMemberRoots).length, 0);
  deny(authorize(user, 'read', path.join(project, 'README.md'), nonMemberRoots));

  // ── session_dir: 与 project 同口径 ────────────────────────
  assert.strictEqual(canAccess(user, 'write', path.join(sessionDir, 'flags', 'f'), [{ kind: 'session_dir', path: sessionDir, role: 'developer' }]), true);
  deny(authorize(user, 'write', path.join(sessionDir, 'flags', 'f'), [{ kind: 'session_dir', path: sessionDir, role: 'viewer' }]), 'ACTION_DENIED');

  // ── extension_user_data: 本人读写, 而已限定为本人的根 ──────
  assert.strictEqual(canAccess(user, 'write', path.join(extUser, 'x.bin'), [{ kind: 'extension_user_data', path: extUser }]), true);
  const selfExtOnly = [{ kind: 'extension_user_data', path: extUser }];
  deny(authorize(user, 'read', path.join(extOther, 'x.bin'), selfExtOnly));

  // ── 上传产物: 已并入 project / user_home, 不再有"全员可读"的独立上传根 ──
  // 项目内的 .imac/upload 按项目规则 (developer 可读写), 非成员仍看不到
  assert.strictEqual(canAccess(user, 'read', path.join(upload, 'a.pdf'), devRoots), true);
  assert.strictEqual(canAccess(user, 'write', path.join(upload, 'a.pdf'), devRoots), true);
  assert.strictEqual(canAccess(user, 'read', path.join(upload, 'a.pdf'), viewerRoots), true);
  deny(authorize(user, 'write', path.join(upload, 'a.pdf'), viewerRoots), 'ACTION_DENIED');
  deny(authorize(user, 'read', path.join(upload, 'a.pdf'), nonMemberRoots));

  // ── temp: 只放行本人的 /tmp/mobius/mobius-<uid>/ ───────────
  const tempRoots = [{ kind: 'temp', path: myTemp }];
  assert.strictEqual(canAccess(user, 'write', path.join(myTemp, 'shot.png'), tempRoots), true);
  deny(authorize(user, 'read', path.join(otherUserTemp, 'shot.png'), tempRoots));
  deny(authorize(user, 'read', '/tmp/loose-file.txt', tempRoots), 'OUTSIDE_ALLOWED_ROOTS');

  // ── builtin_assets: 所有人读, 仅 admin 写 ─────────────────
  const builtinRoots = [{ kind: 'builtin_assets', path: builtin }];
  assert.strictEqual(canAccess(user, 'read', path.join(builtin, 'SKILL.md'), builtinRoots), true);
  deny(authorize(user, 'write', path.join(builtin, 'SKILL.md'), builtinRoots), 'ACTION_DENIED');

  // ── skill_memory 三档 ─────────────────────────────────────
  assert.strictEqual(canAccess(user, 'write', path.join(ctxPersonal, 'm.md'), [{ kind: 'context_personal', path: ctxPersonal }]), true);
  assert.strictEqual(canAccess(user, 'read', path.join(ctxProject, 'm.md'), [{ kind: 'context_project', path: ctxProject, role: 'viewer' }]), true);
  deny(authorize(user, 'write', path.join(ctxProject, 'm.md'), [{ kind: 'context_project', path: ctxProject, role: 'viewer' }]), 'ACTION_DENIED');
  assert.strictEqual(canAccess(user, 'write', path.join(ctxProject, 'm.md'), [{ kind: 'context_project', path: ctxProject, role: 'developer' }]), true);
  assert.strictEqual(canAccess(user, 'read', path.join(ctxBuiltin, 'm.md'), [{ kind: 'context_builtin', path: ctxBuiltin }]), true);
  deny(authorize(user, 'write', path.join(ctxBuiltin, 'm.md'), [{ kind: 'context_builtin', path: ctxBuiltin }]), 'ACTION_DENIED');

  // ── 符号链接不得越界 ──────────────────────────────────────
  const secret = path.join(outside, 'secret.md');
  fs.writeFileSync(secret, 'top secret');
  const link = path.join(project, 'escape-link');
  try {
    fs.symlinkSync(secret, link);
    // 链接字面上在 project 内, realpath 后落在 outside → 必须拒绝
    deny(authorize(user, 'read', link, devRoots), 'OUTSIDE_ALLOWED_ROOTS');
    // 中间目录是符号链接同样拒绝
    const dirLink = path.join(project, 'escape-dir');
    fs.symlinkSync(outside, dirLink);
    deny(authorize(user, 'read', path.join(dirLink, 'secret.md'), devRoots), 'OUTSIDE_ALLOWED_ROOTS');
  } finally {
    try { fs.unlinkSync(link); } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(project, 'escape-dir')); } catch { /* ignore */ }
  }
  // 关闭 realpath 时退回字面判断 (调用方明确知道目标尚不存在时才可用)
  assert.strictEqual(
    canAccess(user, 'write', path.join(project, 'brand-new.md'), devRoots, { realpath: false }),
    true,
  );

  // ── 回归: 本次线上报错的真实组合 ──────────────────────────
  // 工作区 = 项目 bind_path, 但 payload 要打开的文件在另一个挂载点 /mnt/... → 拒绝
  const bind = '/home/fuqingxu/cc-workspace/kind_star';
  const reported = authorize(
    user,
    'open',
    '/mnt/data_cpfs/xuanfa.jxf/team-harbor-bench/eval_0927v/35b_freechoice_report.md',
    [{ kind: 'project', path: bind, role: 'developer' }],
  );
  deny(reported, 'OUTSIDE_ALLOWED_ROOTS');
  assert.strictEqual(canAccess(user, 'open', path.join(bind, 'src', 'a.ts'), [{ kind: 'project', path: bind, role: 'developer' }]), true);

  // ── 未认证一律拒绝 ────────────────────────────────────────
  deny(authorize(null, 'read', home, homeRoots), 'UNAUTHENTICATED');
  deny(authorize(user, 'read', '', homeRoots), 'EMPTY_PATH');

  console.log('file-access tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(scratchBase, { recursive: true, force: true });
}
