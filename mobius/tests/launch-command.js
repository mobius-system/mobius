/**
 * launch-command.test — the bash -lc chain built for a spawn keeps every
 * fragment the original inline builder produced.
 *
 * The launch assembly moved out of the backend into a helper module; a dropped
 * fragment would not fail any type check and would only show up as a session
 * that starts without its CLI environment or with the wrong proxy tier. These
 * cases pin the fragment set per proxy tier.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-launch-command-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.AIMUX_BIN = '/nonexistent/aimux'
process.on('exit', () => { try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch {} })

const { buildClaudeLaunch } = require('../backend/agents/claude-code-utils/launch-command')

const settingsPath = path.join(tempRoot, 'settings.json')
fs.writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } }))

function base(proxyMode) {
  return {
    sessionId: 'sid-1',
    userId: 'alice',
    cwd: tempRoot,
    flagRoot: tempRoot,
    model: 'claude-sonnet-5-5',
    useProxy: proxyMode !== 'direct',
    proxyMode,
    settingsPath,
    captureStream: false,
    forceNoProxy: false,
  }
}

;(async () => {
  const direct = await buildClaudeLaunch(base('direct'))
  // 会话级 CLI 环境: PATH + 身份 + TMPDIR + eager flush, 每个模式都必须在
  // Per-session CLI env: PATH, identity, TMPDIR and eager flush in every tier
  for (const fragment of [
    'export PATH=',
    'unset VSCODE_IPC_HOOK_CLI',
    'export IS_SANDBOX=1',
    'export MOBIUS_SESSION_ID=',
    'MOBIUS_USER_ID=',
    'export TMPDIR=',
    'export CLAUDE_CODE_EAGER_FLUSH=1',
    '--dangerously-skip-permissions',
    '--disallowedTools AskUserQuestion,ExitPlanMode,EnterPlanMode',
    '--session-id ',
  ]) {
    assert.ok(direct.cmd.includes(fragment), `direct 缺少片段: ${fragment}`)
  }
  assert.ok(!direct.cmd.includes('--mcp-config'), '无远端目标时不应注入 MCP')
  assert.ok(direct.cmd.includes(`--settings '${path.resolve(settingsPath)}'`), 'direct 必须带 --settings')
  assert.ok(/exec claude .*--settings/.test(direct.cmd), 'direct 以 exec claude 收尾')
  assert.ok(!direct.cmd.includes('proxychains'), 'direct 不应套 proxychains')
  assert.ok(!direct.cmd.includes('source "$HOME/proxy_envs'), 'direct 不应加载代理环境变量')

  const envMode = await buildClaudeLaunch(base('env'))
  assert.ok(envMode.cmd.includes('set -a && (source "$HOME/proxy_envs.conf"'), 'env 档必须加载代理环境变量')
  assert.ok(envMode.cmd.includes('exec claude '), 'env 档直接 exec claude')
  assert.ok(!envMode.cmd.includes('exec proxychains'), 'env 档不套 proxychains')

  const chains = await buildClaudeLaunch(base('env_proxychains'))
  assert.ok(chains.cmd.includes('source "$HOME/proxy_envs.conf"'), '双档要加载环境变量')
  assert.ok(chains.cmd.includes('exec proxychains -q -f "$HOME/proxychains_config_for_llm_models.conf" claude'), '双档要套 proxychains')
  assert.ok(chains.cmd.includes(`--settings '${path.resolve(settingsPath)}'`), '代理档同样必须带 --settings (曾经漏传)')

  const pure = await buildClaudeLaunch(base('proxychains'))
  assert.ok(!pure.cmd.includes('source "$HOME/proxy_envs'), '纯 proxychains 档不加载环境变量代理')
  assert.ok(pure.cmd.includes('exec proxychains -q'), '纯 proxychains 档仍要套代理')

  // forceNoProxy 压过档位, 并且不残留代理片段
  // forceNoProxy wins over the tier and leaves no proxy fragment behind
  const forced = await buildClaudeLaunch({ ...base('env_proxychains'), forceNoProxy: true })
  assert.strictEqual(forced.proxyMode, 'direct')
  assert.strictEqual(forced.useProxy, false)
  assert.ok(!forced.cmd.includes('proxychains'), 'forceNoProxy 必须彻底直连')

  // --model 只在调用方指定时出现, 且做 shell 转义
  // --model appears only when pinned, and is shell-quoted
  const noModel = await buildClaudeLaunch({ ...base('direct'), model: null })
  assert.ok(!noModel.cmd.includes('--model'), '未指定模型时不带 --model')

  console.log('launch command: ok')
  process.exit(0)
})().catch((e) => { console.error(e); process.exit(1) })
