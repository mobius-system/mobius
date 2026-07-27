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

assert.strictEqual(
  pcTaskModePrompt({ work_mode: 'hub', aimux_id: device, is_tui: true }, 'zh'),
  `【不要使用aimux连接到以下远程对象： ${device}，在mobius中枢（即本地）工作】`,
  'TUI hub prompt should select Mobius Hub work',
);
assert.strictEqual(
  pcTaskModePrompt({ work_mode: 'pc', aimux_id: device, local_path: localPath, is_tui: true }, 'zh'),
  `【使用aimux连接到以下远程对象执行所有工作：${device}。该远程对象上的工作目录为：\`${localPath}\`。当你需要修改文档时，先将项目同步到mobius中枢（即本地），每次修改后都立即同步回到 ${device} 指定路径，除非用户反对你这样做。如果用户反对，直接通过aimux命令读取或修改文件】`,
  'TUI pc prompt should describe hub sync and direct-aimux fallback',
);
assert.strictEqual(
  pcTaskModePrompt({ work_mode: 'dual', aimux_id: device, local_path: localPath, is_tui: true }, 'zh'),
  `【你现在被授权使用aimux连接到以下远程对象： ${device}，当你需要修改代码时，先修改本地的代码，然后把代码都要同步到${device}上，除非用户反对你这样做。当用户需要你运行代码时，遵循一样的规则，可操作远程路径。该远程对象上的工作目录为：\`${localPath}\`。】`,
  'TUI dual prompt should retain the requested synchronization rule',
);
assert.strictEqual(
  pcTaskModePrompt({ work_mode: 'pc', aimux_id: device, local_path: localPath, is_tui: false }, 'zh'),
  `【使用aimux连接到以下远程对象执行所有工作，尽量不修改本地的代码： ${device}。该远程对象上的工作目录为：\`${localPath}\`】`,
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
