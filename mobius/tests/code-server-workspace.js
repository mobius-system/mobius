const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveCodeServerWorkspace,
  validateCodeServerPayload,
} = require('../backend/services/code-server-workspace');
const { tempRootFor } = require('../backend/services/file-access');

function payloadFor(filePath) {
  return JSON.stringify([['openFile', `vscode-remote://localhost${filePath}`]]);
}

// 注意: scratch 根必须不在 /tmp, 否则 "工作区外拒绝" 用例会被 /tmp 全放行规则
// 覆盖而失去意义. 放到 home 下的隐藏目录, finally 里整体清掉.
const scratchBase = path.join(os.homedir(), '.cs-workspace-test-scratch');
fs.mkdirSync(scratchBase, { recursive: true });
const wsRoot = fs.mkdtempSync(path.join(scratchBase, 'ws-'));

try {
  const bindPath = path.join(wsRoot, 'project');
  const childPath = path.join(bindPath, 'src');
  const siblingPath = path.join(wsRoot, 'sibling');
  const outsidePath = path.join(path.dirname(wsRoot), `outside-${path.basename(wsRoot)}`, 'note.md');
  const project = { bind_path: bindPath };

  fs.mkdirSync(childPath, { recursive: true });
  fs.mkdirSync(siblingPath, { recursive: true });

  assert.strictEqual(resolveCodeServerWorkspace(project, bindPath).workspacePath, bindPath);
  assert.strictEqual(resolveCodeServerWorkspace(project, childPath).workspacePath, childPath);
  assert.strictEqual(resolveCodeServerWorkspace(project, wsRoot).workspacePath, wsRoot);
  assert.strictEqual(resolveCodeServerWorkspace(project, siblingPath).code, 'BIND_PATH_DENIED');

  assert.strictEqual(
    validateCodeServerPayload(project, payloadFor(path.join(bindPath, 'README.md')), bindPath).ok,
    true,
  );
  assert.strictEqual(
    validateCodeServerPayload(project, payloadFor(path.join(siblingPath, 'note.md')), bindPath).ok,
    false,
  );
  assert.strictEqual(
    validateCodeServerPayload(project, payloadFor(path.join(siblingPath, 'note.md')), wsRoot).ok,
    true,
  );
  assert.strictEqual(
    validateCodeServerPayload(project, payloadFor(outsidePath), wsRoot).ok,
    false,
  );
  assert.strictEqual(
    validateCodeServerPayload(project, payloadFor(path.join(siblingPath, 'note.md')), siblingPath).ok,
    false,
  );

  // temp 根收紧为本人 per-user 目录 (/tmp/mobius/mobius-<uid>/, 见 file-access.tempRootFor).
  // 即使完全不在 bind_path 内, 本人 temp 下的目录与文件都允许打开; 裸 /tmp 与别人的
  // temp 一律拒绝.
  const myTemp = tempRootFor('u1');
  const otherTemp = tempRootFor('u2');
  fs.mkdirSync(myTemp, { recursive: true });
  const tmpFile = path.join(myTemp, 'note.md');
  fs.writeFileSync(tmpFile, 'x');
  try {
    assert.strictEqual(resolveCodeServerWorkspace(project, myTemp, 'u1').workspacePath, myTemp);
    assert.strictEqual(
      validateCodeServerPayload(project, payloadFor(tmpFile), bindPath, 'u1').ok,
      true,
    );
    // 不存在的 temp 文件也放行 (放行只看路径, 不校验存在性)
    assert.strictEqual(
      validateCodeServerPayload(project, payloadFor(path.join(myTemp, 'nope.md')), bindPath, 'u1').ok,
      true,
    );
    // 裸 /tmp: 不再是合法工作区, 其下的文件也不再放行
    assert.strictEqual(resolveCodeServerWorkspace(project, '/tmp', 'u1').code, 'BIND_PATH_DENIED');
    assert.strictEqual(
      validateCodeServerPayload(project, payloadFor('/tmp/loose.md'), bindPath, 'u1').ok,
      false,
    );
    // 别人的 temp: 目录与文件都拒绝
    assert.strictEqual(resolveCodeServerWorkspace(project, otherTemp, 'u1').code, 'BIND_PATH_DENIED');
    assert.strictEqual(
      validateCodeServerPayload(project, payloadFor(path.join(otherTemp, 'note.md')), bindPath, 'u1').ok,
      false,
    );
  } finally {
    fs.rmSync(myTemp, { recursive: true, force: true });
  }

  console.log('code-server workspace tests passed');
} finally {
  fs.rmSync(scratchBase, { recursive: true, force: true });
}
