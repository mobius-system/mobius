// Docker 隔离: 普通用户的工作目录子树 (work_dir 及其下 .sbx-home / 各项目) 必须在
// code-server 里可打开 —— 容器可写面就是本人 work_dir + 例外项目, bind_path 的
// 直接父目录规则太窄, 会把 work_dir/.sbx-home (容器 HOME) 拒掉.
// Docker isolation: a sandboxed user may open anything under their own work dir.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-cs-docker-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.USER_ISOLATION_METHOD = 'docker'
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

for (const dir of [bindPath, sbxHome, path.join(sbxHome, '.claude'), siblingProject, otherUserWorkDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
insertUser('normal-test', 'user', userWorkDir);
insertUser('test1', 'user', otherUserWorkDir);
insertUser('boss', 'admin', path.join(workRoot, 'boss'));

const project = { bind_path: bindPath };
const payloadFor = (filePath) => JSON.stringify([['openFile', `vscode-remote://localhost${filePath}`]]);

try {
  // 本人 work_dir 子树: 项目根 / work_dir 本身 / .sbx-home 及其子目录 / 兄弟项目 —— 全放行
  for (const dir of [bindPath, userWorkDir, sbxHome, path.join(sbxHome, '.claude'), siblingProject]) {
    assert.strictEqual(
      resolveCodeServerWorkspace(project, dir, 'normal-test').workspacePath,
      dir,
      `${dir} 应可作为 docker 隔离用户的工作区`,
    );
  }

  // work_dir 之外: 父目录 (装着所有账号的目录) / 别人的 work_dir / 无关宿主路径 —— 全拒
  for (const dir of [workRoot, otherUserWorkDir, '/etc']) {
    assert.strictEqual(
      resolveCodeServerWorkspace(project, dir, 'normal-test').code,
      'BIND_PATH_DENIED',
      `${dir} 不应作为 docker 隔离用户的工作区`,
    );
  }

  // 放宽只对隔离中的普通用户生效: admin 拿不到这条规则
  assert.strictEqual(isAllowedWorkspacePath(project, sbxHome, 'boss'), false);

  // 工作区放宽后, payload 里的文件根也随之外移到 .sbx-home
  assert.strictEqual(
    validateCodeServerPayload(project, payloadFor(path.join(sbxHome, '.claude', 'x.json')), sbxHome, 'normal-test').ok,
    true,
  );
  assert.strictEqual(
    validateCodeServerPayload(project, payloadFor(path.join(otherUserWorkDir, 'note.md')), sbxHome, 'normal-test').ok,
    false,
  );

  console.log('code-server docker workspace tests passed');
} finally {
  cleanup();
}
