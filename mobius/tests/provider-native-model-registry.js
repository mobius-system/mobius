const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-provider-native-registry-'))
const home = path.join(root, 'home')
const codexHome = path.join(root, 'custom-codex-home')

process.env.HOME = home
process.env.CODEX_HOME = codexHome
process.env.MOBIUS_DATA_PATH = path.join(root, 'data')
process.env.CORE_DATA_PATH = path.join(root, 'protected')
process.env.MODEL_ACCESS_PATH = path.join(root, 'data', 'model-access.json')
process.env.JWT_SECRET = 'provider-native-model-registry-test-secret'

function providerStatus(provider, authenticated = true) {
  return {
    installed: true,
    available: true,
    launchReady: authenticated,
    launchMode: authenticated ? 'native' : null,
    configuredReady: false,
    nativeEnabled: true,
    nativeReady: authenticated,
    binaryPath: path.join(root, 'bin', provider === 'codex' ? 'codex' : 'claude'),
    version: '1.0.0',
    authStatus: authenticated ? 'authenticated' : 'required',
    reason: authenticated ? '可启动（复用本机官方登录态）' : '本机 CLI 报告尚未认证',
    checkedAt: new Date().toISOString(),
    candidates: [],
  }
}

async function main() {
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })

  const detection = require('../backend/services/provider-cli-detection.cjs')
  const catalog = require('../backend/services/codex-model-catalog.cjs')
  const modelAccess = require('../backend/services/model-access')
  const registry = require('../backend/services/model-registry')
  const { buildCodexCliExec, buildClaudeCliExec } = require('../backend/agents/provider-cli-command')

  // Read-only provider detection must not seed/copy a dedicated config (including api_key)
  // into MODEL_ACCESS_PATH.
  const probeBin = path.join(root, 'probe-bin')
  const probeCodex = path.join(probeBin, 'codex')
  fs.mkdirSync(probeBin, { recursive: true })
  fs.writeFileSync(probeCodex, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const dedicatedConfig = path.join(codexHome, 'mobiusdefault.config.toml')
  fs.writeFileSync(dedicatedConfig, 'model = "configured"\napi_key = "must-not-be-copied"\n')
  const readOnlyProbe = new detection.ProviderCliDetectionService({
    home,
    cwd: root,
    env: { PATH: probeBin },
    includeLoginShell: false,
    includeManagerDiscovery: false,
    wellKnownDirs: [],
    runCommand: async (_binary, args) => ({
      ok: true,
      code: 0,
      timedOut: false,
      stdout: args[0] === '--version' ? 'codex 1.0.0' : 'Logged in using ChatGPT',
      stderr: '',
    }),
  })
  const configuredStatus = await readOnlyProbe.detectProvider('codex')
  assert.equal(configuredStatus.configuredReady, true)
  assert.equal(fs.existsSync(process.env.MODEL_ACCESS_PATH), false)
  fs.rmSync(dedicatedConfig)

  detection._private.setProviderStatusForTests('codex', providerStatus('codex', true))
  detection._private.setProviderStatusForTests('claude', providerStatus('claude', true))

  // No Mobius profile/settings: authenticated native built-ins are immediately visible
  // from the precomputed status snapshot, and launch options contain no synthetic files.
  let options = registry.listSessionModelOptions()
  const nativeCodexOption = options.find((row) => row.key === 'codex')
  const nativeClaudeOption = options.find((row) => row.key === 'opus')
  assert.equal(nativeCodexOption.native, true)
  assert.equal(nativeCodexOption.codex_config_path, null)
  assert.equal(nativeCodexOption.codex_channel, null)
  assert.equal(nativeClaudeOption.native, true)
  assert.equal(nativeClaudeOption.settings_path, null)

  let launch = registry.launchOptionsForSession({ model: 'codex' })
  assert.equal(launch.native, true)
  assert.equal(launch.model, 'gpt-5.5')
  assert.equal(launch.codexProfileKey, undefined)
  assert.equal(launch.codexSecretEnvKey, undefined)
  const nativeCodexCommand = buildCodexCliExec({
    executable: '/usr/local/bin/codex',
    useProxy: false,
    proxyConfig: '/tmp/proxy.conf',
    profileKey: launch.codexProfileKey,
    subcommand: '',
    codexArgs: ['-m', launch.model, '--dangerously-bypass-approvals-and-sandbox'],
  })
  assert.equal(nativeCodexCommand.includes('--profile'), false)

  // The native Codex catalog replaces the compatibility item without changing
  // the stable default key. Every other CLI model gets a collision-free key.
  catalog._private.setSnapshotForTests({
    models: [
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'Frontier', isDefault: true },
      { id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', isDefault: false },
      { id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: false },
    ],
  })
  options = registry.listSessionModelOptions()
  assert.deepEqual(
    options.filter((row) => row.native && row.backend === 'tmux-codex').map((row) => row.key),
    ['codex', 'codex-native:gpt-5.6-terra', 'codex-native:gpt-5.5'],
  )
  assert.equal(options.find((row) => row.key === 'codex').title, 'GPT-5.6-Sol')
  assert.equal(options.find((row) => row.key === 'codex').model, 'gpt-5.6-sol')
  assert.equal(options.find((row) => row.key === 'codex').is_default, true)
  assert.equal(registry.resolveSessionModelForCreate('codex').sessionModelValue, 'codex')
  assert.equal(registry.backendNameForSessionModel('codex-native:gpt-5.6-terra'), 'tmux-codex')

  launch = registry.launchOptionsForSession({ model: 'codex' })
  assert.equal(launch.native, true)
  assert.equal(launch.model, 'gpt-5.6-sol')
  launch = registry.launchOptionsForSession({ model: 'codex-native:gpt-5.6-terra' })
  assert.equal(launch.model, 'gpt-5.6-terra')
  assert.equal(launch.codexProfileKey, undefined)
  // Concrete ids stored by old sessions remain concrete when still advertised.
  assert.equal(registry.launchOptionsForSession({ model: 'gpt-5.5' }).model, 'gpt-5.5')
  const terraCommand = buildCodexCliExec({
    executable: '/usr/local/bin/codex',
    useProxy: false,
    proxyConfig: '/tmp/proxy.conf',
    profileKey: launch.codexProfileKey,
    subcommand: '',
    codexArgs: ['-m', launch.model],
  })
  assert.match(terraCommand, /'-m' 'gpt-5\.6-terra'/)

  launch = registry.launchOptionsForSession({ model: 'opus' })
  assert.equal(launch.native, true)
  assert.equal(launch.model, 'opus-4.8')
  assert.equal(launch.settingsPath, undefined)
  const nativeClaudeCommand = buildClaudeCliExec({
    executable: '/usr/local/bin/claude',
    useProxy: false,
    proxyConfig: '/tmp/proxy.conf',
    settingsArg: launch.settingsPath ? `--settings '${launch.settingsPath}'` : '',
    claudeArgs: ['--dangerously-skip-permissions', `--model '${launch.model}'`],
  })
  assert.equal(nativeClaudeCommand.includes('--settings'), false)

  // Administrator switch is enforced by backend resolution, not merely by the picker.
  modelAccess.setNativeProviderEnabled('codex', false)
  options = registry.listSessionModelOptions()
  assert.equal(options.some((row) => row.key === 'codex'), false)
  assert.equal(options.some((row) => row.key.startsWith('codex-native:')), false)
  assert.equal(registry.resolveSessionModel('codex'), null)
  assert.equal(registry.resolveSessionModel('codex-native:gpt-5.6-terra'), null)
  assert.equal(registry.resolveSessionModelForCreate('codex'), null)
  assert.throws(() => registry.launchOptionsForSession({ model: 'codex' }), /模型未配置/)
  modelAccess.setNativeProviderEnabled('codex', true)

  // An installed but unauthenticated CLI is not a native model and cannot reach launch.
  detection._private.setProviderStatusForTests('codex', providerStatus('codex', false))
  assert.equal(registry.resolveSessionModel('codex'), null)
  assert.throws(() => registry.launchOptionsForSession({ model: 'codex' }), /模型未配置/)

  // Dedicated profile/settings retain priority even when official native auth is absent.
  fs.writeFileSync(path.join(codexHome, 'mobiusdefault.config.toml'), [
    'model = "custom-codex-model"',
    'model_reasoning_effort = "xhigh"',
    '',
  ].join('\n'))
  const claudeDir = path.join(home, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(path.join(claudeDir, 'mobiusdefault.settings.json'), JSON.stringify({ model: 'custom-claude-model' }))
  detection._private.setProviderStatusForTests('codex', providerStatus('codex', true))
  detection._private.setProviderStatusForTests('claude', providerStatus('claude', false))

  const configuredCodex = registry.resolveSessionModel('codex')
  assert.equal(configuredCodex.native, false)
  assert.equal(configuredCodex.codexConfigPath, path.join(codexHome, 'mobiusdefault.config.toml'))
  launch = registry.launchOptionsForSession({ model: 'codex' })
  assert.equal(launch.native, false)
  assert.equal(launch.codexProfileKey, 'mobiusdefault')
  assert.equal(launch.codexConfigPath, path.join(codexHome, 'mobiusdefault.config.toml'))
  // The explicit native key remains available, while bare `codex` continues
  // to resolve to the administrator's dedicated profile.
  const configuredOptions = registry.listSessionModelOptions()
  assert.ok(configuredOptions.some((row) => row.key === 'codex-native:gpt-5.6-sol'))
  const explicitNative = registry.launchOptionsForSession({ model: 'codex-native:gpt-5.6-sol' })
  assert.equal(explicitNative.native, true)
  assert.equal(explicitNative.model, 'gpt-5.6-sol')
  assert.equal(explicitNative.codexProfileKey, undefined)

  const configuredClaude = registry.resolveSessionModel('opus')
  assert.equal(configuredClaude.native, false)
  assert.equal(configuredClaude.settingsPath, path.join(claudeDir, 'mobiusdefault.settings.json'))
  launch = registry.launchOptionsForSession({ model: 'opus' })
  assert.equal(launch.native, false)
  assert.equal(launch.settingsPath, path.join(claudeDir, 'mobiusdefault.settings.json'))

  // Seeded dedicated enabled=false also blocks direct backend resolution/creation.
  modelAccess.upsertCodexModel({
    key: 'mobiusdefault',
    label: 'disabled configured Codex',
    codex_model: 'custom-codex-model',
    enabled: false,
  }, { existingKey: 'mobiusdefault' })
  assert.equal(registry.resolveSessionModel('codex'), null)
  assert.equal(registry.listSessionModelOptions().some((row) => row.key === 'codex'), false)
  assert.equal(registry.listSessionModelOptions().some((row) => row.key.startsWith('codex-native:')), false)

  assert.equal(modelAccess.codexConfigPathForKey('mobiusdefault'), path.join(codexHome, 'mobiusdefault.config.toml'))
  const tmuxCodexSource = fs.readFileSync(path.join(__dirname, '../backend/agents/tmux-codex.js'), 'utf8')
  assert.match(tmuxCodexSource, /const explicitNativeMode = !!model/)
  assert.match(tmuxCodexSource, /explicitNativeMode \? null : \(codexChannel \|\| codexProfileKey \|\| persisted\?\.codexProfileKey\)/)
  console.log('provider-native-model-registry: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true })
})
