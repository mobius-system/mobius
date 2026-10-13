// code-server 工作区放行的两条边界 (2026-10-13 用户要求):
//   1. docker 隔离中的普通用户: 本人工作目录整棵子树放行 (work_dir / .sbx-home /
//      兄弟项目). bind_path 的"直接父目录"规则太窄, 会把容器 HOME (.sbx-home) 拒掉.
//   2. 容器外的管理员: 无论 landlock 还是 docker 模式, VSCode 打开路径不受任何限制.
// 本文件跑两遍: 默认 docker 相位, 再以 MOBIUS_CS_LANDLOCK_PHASE=1 自派生一个 landlock 相位.
// Two rules: a sandboxed user may open anything under their own work dir; an admin
// (outside any container) may open anything at all, in either isolation mode.
const fs = require('fs');
const os = require('os');
const path = require('path');

const LANDLOCK_PHASE = process.env.MOBIUS_CS_LANDLOCK_PHASE === '1';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-cs-docker-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.USER_ISOLATION_METHOD = LANDLOCK_PHASE ? 'landlock' : 'docker'
process.env.USER_ISOLATION_DOCKER_IMAGE = 'mobius-system-sbx:test'

const assert = require('assert');
const { db } = require('../db');
const {
  resolveCodeServerWorkspace,
  validateCodeServerPayload,
  isAllowedWorkspacePath,
} = require('../backend/services/code-server-workspace');

function cleanup() {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup);

function insertUser(id, role, workDir) {
  db.prepare(
    `INSERT INTO users (id, display_name, password_hash, role, work_dir, group_id)
     VALUES (?, ?, 'hash', ?, ?, 'g1')`,
  ).run(id, id, role, workDir);
}

const workRoot = path.join(tempRoot, 'workspace');
const userWorkDir = path.join(workRoot, 'normal-test');
const bindPath = path.join(userWorkDir, 'let-us-chat');
const sbxHome = path.join(userWorkDir, '.sbx-home');
const siblingProject = path.join(userWorkDir, 'another-project');
const otherUserWorkDir = path.join(workRoot, 'test1');

db.prepare("INSERT OR IGNORE INTO user_groups (id, name) VALUES ('g1', 'Group 1')").run();

for (const dir of [bindPath, sbxHome, path.join(sbxHome, '.claude'), siblingProject, otherUserWorkDir, workRoot]) {
  fs.mkdirSync(dir, { recursive: true });
}
insertUser('normal-test', 'user', userWorkDir);
insertUser('test1', 'user', otherUserWorkDir);
insertUser('boss', 'admin', path.join(workRoot, 'boss'));

const project = { bind_path: bindPath };
const payloadFor = (filePath) => JSON.stringify([['openFile', `vscode-remote://localhost${filePath}`]]);

function expectWorkspace(dir, userId, isAdmin) {
  assert.strictEqual(
    resolveCodeServerWorkspace(project, dir, userId, isAdmin).workspacePath,
    dir,
    `${dir} 应可作为工作区 (user=${userId} admin=${!!isAdmin} phase=${LANDLOCK_PHASE ? 'landlock' : 'docker'})`,
  );
}

function expectDenied(dir, userId, isAdmin) {
  assert.strictEqual(
    resolveCodeServerWorkspace(project, dir, userId, isAdmin).code,
    'BIND_PATH_DENIED',
    `${dir} 不应作为工作区 (user=${userId} admin=${!!isAdmin} phase=${LANDLOCK_PHASE ? 'landlock' : 'docker'})`,
  );
}

try {
  // ── 管理员: 两种模式, 任何真实路径都放行 (容器外跑, 不受沙箱边界约束) ──
  for (const dir of ['/etc', '/var/log', workRoot, otherUserWorkDir, userWorkDir, sbxHome]) {
    expectWorkspace(dir, 'boss', true);
  }
  // 管理员打开的文件同样不设限
  assert.strictEqual(
    validateCodeServerPayload(project, payloadFor('/etc/hosts'), '/etc', 'boss', true).ok,
    true,
    '管理员 payload 打开文件不应受工作区约束',
  );
  assert.strictEqual(
    isAllowedWorkspacePath(project, '/etc', 'boss', true),
    true,
    '管理员 isAllowedWorkspacePath 恒真',
  );

  // ── 隔离中的普通用户 (仅 docker): 本人 work_dir 整棵子树放行 ──
  expectWorkspace(bindPath, 'normal-test'); // 项目绑定根两种模式都放行
  expectWorkspace(userWorkDir, 'normal-test'); // 绑定根的上一级目录, 基础规则本来也放行
  for (const dir of [sbxHome, path.join(sbxHome, '.claude'), siblingProject]) {
    if (LANDLOCK_PHASE) expectDenied(dir, 'normal-test'); // landlock 无这条放宽 (且 code-server 整体禁用)
    else expectWorkspace(dir, 'normal-test');
  }
  // work_dir 之外: 父目录 (装着所有账号的目录) / 别人的 work_dir / 无关宿主路径 —— 全拒
  for (const dir of [workRoot, otherUserWorkDir, '/etc']) {
    expectDenied(dir, 'normal-test');
  }
  // 放宽只认"本人" work_dir: 换个普通用户看同一路径仍是拒绝
  expectDenied(sbxHome, 'test1');

  if (!LANDLOCK_PHASE) {
    // 工作区放宽后, payload 里的文件根也随之外移到 .sbx-home
    assert.strictEqual(
      validateCodeServerPayload(project, payloadFor(path.join(sbxHome, '.claude', 'x.json')), sbxHome, 'normal-test').ok,
      true,
      'docker 隔离用户可打开本人 work_dir 子树内的文件',
    );
    assert.strictEqual(
      validateCodeServerPayload(project, payloadFor(path.join(otherUserWorkDir, 'note.md')), sbxHome, 'normal-test').ok,
      false,
      'docker 隔离用户不可打开他人 work_dir 内的文件',
    );
  } else {
    // landlock 相位: 普通用户 payload 照旧受工作区约束
    assert.strictEqual(
      validateCodeServerPayload(project, payloadFor('/etc/hosts'), '/etc', 'normal-test').ok,
      false,
      'landlock 相位普通用户 payload 仍受约束',
    );
  }

  if (!LANDLOCK_PHASE) {
    // 派生 landlock 相位 (env 必须在 require 之前设好, 只能换个进程)
    const { execFileSync } = require('child_process');
    execFileSync(process.execPath, ['--require', 'tsx/cjs', __filename], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, MOBIUS_CS_LANDLOCK_PHASE: '1' },
      stdio: 'inherit',
    });
  }

  console.log(`code-server workspace tests passed (${LANDLOCK_PHASE ? 'landlock' : 'docker'} phase)`);
} finally {
  cleanup();
}
