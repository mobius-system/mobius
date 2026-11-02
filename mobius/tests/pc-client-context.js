const assert = require('assert');

const {
  parsePcClientMetadata,
  pcClientRequiresAimuxSkill,
  pcTaskModePrompt,
  aimuxRemoteNameFromMeta,
  pcClientMetadataForContinuation,
} = require('../backend/services/pc-client-context');

const device = 'tui-workstation';
const localPath = '/workspace/project';

assert.deepStrictEqual(
  parsePcClientMetadata(JSON.stringify({ work_mode: 'dual', aimux_id: device, is_tui: true })),
  { work_mode: 'dual', aimux_id: device, is_tui: true },
  'JSON metadata should retain is_tui',
);

const continuedMetadata = pcClientMetadataForContinuation({
  work_mode: 'pc',
  aimux_id: 'currently-selected-device',
  initial_aimux_id: 'previously-selected-device',
  local_path: localPath,
  is_tui: true,
  add_remote_aimux_mcp: true,
});
assert.deepStrictEqual(continuedMetadata, {
  work_mode: 'pc',
  aimux_id: 'currently-selected-device',
  local_path: localPath,
  is_tui: true,
  add_remote_aimux_mcp: true,
}, 'continued sessions should inherit the current binding without the source switch-history anchor');
assert.strictEqual(pcClientMetadataForContinuation(null), null,
  'continued web sessions should remain without PC metadata');

assert.strictEqual(pcClientRequiresAimuxSkill({ work_mode: 'hub', aimux_id: device, is_tui: true }), true,
  'TUI must include mobius-aimux even in hub mode');
assert.strictEqual(pcClientRequiresAimuxSkill({ work_mode: 'hub', aimux_id: device, is_tui: false }), false,
  'Electron hub mode should keep its existing no-skill behavior');
assert.strictEqual(pcClientRequiresAimuxSkill({ work_mode: 'pc', aimux_id: device, is_tui: false }), true,
  'Electron pc mode must include mobius-aimux');

const tuiHubPrompt = pcTaskModePrompt({ work_mode: 'hub', aimux_id: device, is_tui: true }, 'zh');
assert.match(tuiHubPrompt, /你在远程机器 tui-workstation/,
  'TUI prompt should include the remote-machine orientation (localized to zh)');
assert.doesNotMatch(tuiHubPrompt, /You are working at remote machine/,
  'zh sessions should not receive the English orientation text');
assert.match(tuiHubPrompt, /不要使用aimux连接到以下远程机器.*tui-workstation/,
  'TUI hub prompt should select Mobius Hub work');

const tuiPcPrompt = pcTaskModePrompt({ work_mode: 'pc', aimux_id: device, local_path: localPath, is_tui: true }, 'zh');
assert.match(tuiPcPrompt, /使用已注册的 remote_\* MCP 工具.*执行所有工作/,
  'TUI pc prompt should require remote execution via remote_* tools');
assert.match(tuiPcPrompt, /尽量不修改Mobius中枢的代码/,
  'TUI PC mode prefers direct remote execution');

const tuiDualPrompt = pcTaskModePrompt({ work_mode: 'dual', aimux_id: device, local_path: localPath, is_tui: true }, 'zh');
assert.doesNotMatch(tuiDualPrompt, /先修改本地的代码.*同步到tui-workstation上/s,
  'TUI dual omits the desktop-only sync tail (77b0e765)');
assert.match(
  pcTaskModePrompt({ work_mode: 'pc', aimux_id: device, local_path: localPath, is_tui: false }, 'zh'),
  /使用已注册的 remote_\* MCP 工具.*尽量不修改Mobius中枢的代码/s,
  'Electron prompt should explain the shared remote MCP toolset',
);
assert.match(
  pcTaskModePrompt({ work_mode: 'pc', aimux_id: device, local_path: localPath, is_tui: true }, 'en'),
  /remote_\* MCP tools.*carry out all work.*avoid modifying the Mobius hub code/s,
  'English TUI sessions should receive the equivalent TUI-specific prompt',
);
assert.strictEqual(pcTaskModePrompt({ work_mode: 'invalid', aimux_id: device, is_tui: true }, 'zh'), '',
  'invalid work modes should not produce a prompt');

// aimuxRemoteNameFromMeta gate: requires explicit opt-in and aimux_id for both
// TUI and Electron desktop clients.
assert.strictEqual(
  aimuxRemoteNameFromMeta({ work_mode: 'pc', aimux_id: device, is_tui: true, add_remote_aimux_mcp: true }),
  device,
  'TUI session opted into add_remote_aimux_mcp should resolve the remote name',
);
assert.strictEqual(
  aimuxRemoteNameFromMeta({ work_mode: 'pc', aimux_id: device, is_tui: true }),
  undefined,
  'TUI session WITHOUT add_remote_aimux_mcp must NOT get MCP injected (opt-in gate)',
);
assert.strictEqual(
  aimuxRemoteNameFromMeta({ work_mode: 'pc', aimux_id: device, is_tui: false, add_remote_aimux_mcp: true }),
  device,
  'Electron sessions opt into the same MCP protocol with the flag',
);
assert.strictEqual(
  aimuxRemoteNameFromMeta({ work_mode: 'pc', is_tui: true, add_remote_aimux_mcp: true }),
  undefined,
  'missing aimux_id must not resolve a remote name',
);

console.log('pc client context tests passed');
