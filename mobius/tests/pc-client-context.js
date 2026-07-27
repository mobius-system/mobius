const assert = require('assert');

const {
  parsePcClientMetadata,
  pcClientRequiresAimuxSkill,
  pcTaskModePrompt,
} = require('../backend/services/pc-client-context');

const device = 'tui-workstation';
const localPath = '/workspace/project';

assert.deepStrictEqual(
  parsePcClientMetadata(JSON.stringify({ work_mode: 'dual', aimux_id: device, is_tui: true })),
  { work_mode: 'dual', aimux_id: device, is_tui: true },
  'JSON metadata should retain is_tui',
);

assert.strictEqual(pcClientRequiresAimuxSkill({ work_mode: 'hub', aimux_id: device, is_tui: true }), true,
  'TUI must include mobius-aimux even in hub mode');
assert.strictEqual(pcClientRequiresAimuxSkill({ work_mode: 'hub', aimux_id: device, is_tui: false }), false,
  'Electron hub mode should keep its existing no-skill behavior');
assert.strictEqual(pcClientRequiresAimuxSkill({ work_mode: 'pc', aimux_id: device, is_tui: false }), true,
  'Electron pc mode must include mobius-aimux');

const tuiHubPrompt = pcTaskModePrompt({ work_mode: 'hub', aimux_id: device, is_tui: true }, 'zh');
assert.match(tuiHubPrompt, /You are working at remote machine tui-workstation/,
  'TUI prompt should include the remote-machine orientation');
assert.match(tuiHubPrompt, /不要使用aimux.*在mobius中枢（即本地）工作/,
  'TUI hub prompt should select Mobius Hub work');

const tuiPcPrompt = pcTaskModePrompt({ work_mode: 'pc', aimux_id: device, local_path: localPath, is_tui: true }, 'zh');
assert.match(tuiPcPrompt, /使用aimux连接到以下远程对象执行所有工作/,
  'TUI pc prompt should require remote execution');
assert.match(tuiPcPrompt, /先将项目同步到mobius中枢.*每次修改后都立即同步回到 tui-workstation 指定路径/s,
  'TUI pc prompt should describe hub sync and direct-aimux fallback');

const tuiDualPrompt = pcTaskModePrompt({ work_mode: 'dual', aimux_id: device, local_path: localPath, is_tui: true }, 'zh');
assert.match(tuiDualPrompt, /先修改本地的代码.*同步到tui-workstation上/s,
  'TUI dual prompt should retain the synchronization rule');
assert.strictEqual(
  pcTaskModePrompt({ work_mode: 'pc', aimux_id: device, local_path: localPath, is_tui: false }, 'zh'),
  `使用aimux连接到以下远程对象执行所有工作，尽量不修改本地的代码： ${device}。该远程对象上的工作目录为：\`${localPath}\``,
  'Electron prompt should remain unchanged apart from explicit is_tui metadata',
);
assert.match(
  pcTaskModePrompt({ work_mode: 'pc', aimux_id: device, local_path: localPath, is_tui: true }, 'en'),
  /Mobius Hub.*immediately sync every change back/s,
  'English TUI sessions should receive the equivalent TUI-specific prompt',
);
assert.strictEqual(pcTaskModePrompt({ work_mode: 'invalid', aimux_id: device, is_tui: true }, 'zh'), '',
  'invalid work modes should not produce a prompt');

console.log('pc client context tests passed');
