const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveCodeServerWorkspace,
  validateCodeServerPayload,
} = require('../backend/services/code-server-workspace');

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

  // /tmp 全放行: 即使完全不在 bind_path / 工作区内, /tmp 及其子目录的目录和文件都允许打开
  const tmpDir = fs.mkdtempSync('/tmp/cs-allow-');
  const tmpFile = path.join(tmpDir, 'note.md');
  fs.writeFileSync(tmpFile, 'x');
  try {
    assert.strictEqual(resolveCodeServerWorkspace(project, tmpDir).workspacePath, tmpDir);
    assert.strictEqual(resolveCodeServerWorkspace(project, '/tmp').workspacePath, '/tmp');
    assert.strictEqual(
      validateCodeServerPayload(project, payloadFor(tmpFile), bindPath).ok,
      true,
    );
    // 不存在的 /tmp 文件也放行 (放行只看路径, 不校验存在性)
    assert.strictEqual(
      validateCodeServerPayload(project, payloadFor('/tmp/nonexistent-anywhere-123.md'), bindPath).ok,
      true,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('code-server workspace tests passed');
} finally {
  fs.rmSync(scratchBase, { recursive: true, force: true });
}
