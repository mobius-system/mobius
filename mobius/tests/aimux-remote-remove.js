const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// removeRemote 直接改 ~/.ssh/config, 所以测试必须把 HOME 换到临时目录,
// 绝不能碰真实的 ssh 配置.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-aimux-remove-'));
const sshDir = path.join(tempHome, '.ssh');
fs.mkdirSync(sshDir, { recursive: true });
const configPath = path.join(sshDir, 'config');

const AIMUX_MARK = '# Added by aimux at 2026-10-27T00:00:00Z';

function writeConfig(text) {
  fs.writeFileSync(configPath, text, { mode: 0o600 });
}

writeConfig([
  'Host hand-written-gateway',
  '    HostName gw.example.com',
  '    User ops',
  '',
  AIMUX_MARK,
  'Host mobius-added',
  '    HostName 10.0.0.9',
  '    Port 2222',
  '    User root',
  '',
  'Host other-host',
  '    HostName 10.0.0.10',
  '    User root',
  '',
].join('\n'));

process.env.HOME = tempHome;
const aimuxRemote = require('../backend/services/aimux-remote');

// 1. 手写的主机不归莫比乌斯管 —— 必须拒绝, 且不能动文件.
assert.throws(
  () => aimuxRemote.removeRemote('hand-written-gateway'),
  /不是通过莫比乌斯添加/,
  '手写进 ~/.ssh/config 的主机必须拒绝移除',
);
assert.ok(
  fs.readFileSync(configPath, 'utf8').includes('Host hand-written-gateway'),
  '拒绝之后配置必须原样保留',
);

// 2. 莫比乌斯添加的主机可以移除, 且只移除它自己那一个块.
const removed = aimuxRemote.removeRemote('mobius-added');
assert.strictEqual(removed.ok, true);
assert.strictEqual(removed.name, 'mobius-added');
const after = fs.readFileSync(configPath, 'utf8');
assert.ok(!after.includes('Host mobius-added'), '被移除的主机不应再出现');
assert.ok(!after.includes('10.0.0.9'), '被移除主机的选项行也不应残留');
assert.ok(after.includes('Host hand-written-gateway'), '其它主机必须保留');
assert.ok(after.includes('Host other-host'), '其它主机必须保留');

// 3. 备份文件存在 (改配置前先备份, 与 aimux remote add 的做法一致).
assert.ok(fs.existsSync(removed.backup), '移除前必须留备份');
assert.ok(
  fs.readFileSync(removed.backup, 'utf8').includes('Host mobius-added'),
  '备份里必须含被移除的主机',
);

// 4. 不存在的主机报错, 不静默成功.
assert.throws(() => aimuxRemote.removeRemote('never-existed'), /没有主机/);

// 5. 名字里的路径穿越字符必须被挡掉 (cleanRemoteName 只放行字母数字与 . _ @ : -).
assert.throws(() => aimuxRemote.removeRemote('../evil'), /只能包含/);

fs.rmSync(tempHome, { recursive: true, force: true });
console.log('ok - removeRemote 只删莫比乌斯自己添加的 Host 块, 其余配置原样保留');
