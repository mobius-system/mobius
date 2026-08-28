const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  ProviderCliDetectionService,
  _private,
  toPublicProviderStatus,
} = require('../backend/services/provider-cli-detection.cjs')
const { buildCodexCliExec, buildClaudeCliExec } = require('../backend/agents/provider-cli-command')

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
}

function serviceOptions(root, extra = {}) {
  return {
    home: path.join(root, 'home'),
    cwd: root,
    env: { PATH: '' },
    includeLoginShell: false,
    includeManagerDiscovery: false,
    wellKnownDirs: [],
    timeouts: { version: 5000, auth: 5000 },
    getLaunchReadiness: () => ({ ready: true, reason: null }),
    ...extra,
  }
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-provider-cli-'))
  try {
    // Service PATH wins deterministically and yields parsed version/auth state.
    const pathBin = path.join(root, 'path-bin')
    const codex = path.join(pathBin, 'codex')
    writeExecutable(codex, `
if [ "$1" = "--version" ]; then
  echo "codex-cli 0.142.1"
  exit 0
fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  echo "Logged in using ChatGPT"
  exit 0
fi
exit 2`)
    const pathService = new ProviderCliDetectionService(serviceOptions(root, {
      env: { PATH: pathBin, SHOULD_NEVER_REACH_PROVIDER: 'service-secret' },
    }))
    const pathStatus = await pathService.detectProvider('codex')
    assert.equal(pathStatus.installed, true)
    assert.equal(pathStatus.available, true)
    assert.equal(pathStatus.launchReady, true)
    assert.equal(pathStatus.binaryPath, fs.realpathSync(codex))
    assert.equal(pathStatus.version, '0.142.1')
    assert.equal(pathStatus.authStatus, 'authenticated')
    const pathRuntime = pathService.cachedProviderRuntime('codex')
    assert.equal(pathRuntime.executable, fs.realpathSync(codex))
    assert.equal(pathRuntime.env.HOME, path.join(root, 'home'))
    assert.equal(pathRuntime.env.CODEX_HOME, path.join(root, 'home', '.codex'))
    assert.equal(pathRuntime.env.JWT_SECRET, undefined)
    assert.equal(pathRuntime.env.SHOULD_NEVER_REACH_PROVIDER, undefined)
    let statusRefreshes = 0
    const unsubscribe = pathService.onStatusRefresh((provider) => {
      if (provider === 'codex') statusRefreshes += 1
    })
    await pathService.detectProvider('codex', { force: true })
    unsubscribe()
    assert.equal(statusRefreshes, 1)

    const directoryCandidate = path.join(root, 'directory-candidate')
    const nonExecutableCandidate = path.join(root, 'non-executable-candidate')
    fs.mkdirSync(path.join(directoryCandidate, 'codex'), { recursive: true })
    fs.mkdirSync(nonExecutableCandidate)
    fs.writeFileSync(path.join(nonExecutableCandidate, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o644 })
    const validationService = new ProviderCliDetectionService(serviceOptions(root, {
      env: { PATH: [directoryCandidate, nonExecutableCandidate, pathBin].join(path.delimiter) },
    }))
    assert.deepEqual((await validationService.detectProvider('codex')).candidates, [fs.realpathSync(codex)])

    // A common user-global directory is searched even when service PATH is empty.
    const localBin = path.join(root, 'home', '.local', 'bin')
    const claude = path.join(localBin, 'claude')
    writeExecutable(claude, `
if [ "$1" = "--version" ]; then
  echo "2.1.191 (Claude Code)"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  printf '%s\\n' '{"loggedIn":true}'
  exit 0
fi
exit 2`)
    const commonService = new ProviderCliDetectionService(serviceOptions(root, {
      wellKnownDirs: [localBin],
    }))
    const commonStatus = await commonService.detectProvider('claude')
    assert.equal(commonStatus.binaryPath, fs.realpathSync(claude))
    assert.equal(commonStatus.version, '2.1.191')
    assert.equal(commonStatus.authStatus, 'authenticated')

    const knownDirsService = new ProviderCliDetectionService(serviceOptions(root, {
      wellKnownDirs: undefined,
    }))
    const knownDirs = knownDirsService._wellKnownDirs()
    assert.ok(knownDirs.includes(path.join(root, 'home', '.npm-global', 'bin')))
    assert.ok(knownDirs.includes(path.join(root, 'home', '.local', 'share', 'pnpm')))
    assert.ok(knownDirs.includes(path.join(root, 'home', '.bun', 'bin')))
    assert.ok(knownDirs.includes('/opt/homebrew/bin'))
    assert.ok(knownDirs.includes('/usr/local/bin'))

    // Read-only npm/pnpm/bun/brew queries contribute their global bin dirs in stable order.
    const managerBin = path.join(root, 'managers')
    const managerTargets = {
      npm: path.join(root, 'npm-prefix', 'bin'),
      pnpm: path.join(root, 'pnpm-global'),
      bun: path.join(root, 'bun-global'),
      brew: path.join(root, 'brew-prefix', 'bin'),
    }
    for (const manager of Object.keys(managerTargets)) writeExecutable(path.join(managerBin, manager), 'exit 0')
    for (const target of Object.values(managerTargets)) writeExecutable(path.join(target, 'codex'), 'exit 0')
    const managerService = new ProviderCliDetectionService(serviceOptions(root, {
      env: { PATH: managerBin },
      includeManagerDiscovery: true,
      runCommand: async (binary, args, options) => {
        const name = path.basename(binary)
        if (name === 'npm') {
          assert.ok(options.env.PATH.includes(managerBin))
          return { ok: true, code: 0, timedOut: false, stdout: path.dirname(managerTargets.npm), stderr: '' }
        }
        if (name === 'pnpm') return { ok: true, code: 0, timedOut: false, stdout: managerTargets.pnpm, stderr: '' }
        if (name === 'bun') return { ok: true, code: 0, timedOut: false, stdout: managerTargets.bun, stderr: '' }
        if (name === 'brew') return { ok: true, code: 0, timedOut: false, stdout: path.dirname(managerTargets.brew), stderr: '' }
        if (args[0] === '--version') return { ok: true, code: 0, timedOut: false, stdout: `codex ${path.basename(path.dirname(binary))}.1.0`, stderr: '' }
        return { ok: true, code: 0, timedOut: false, stdout: 'Logged in', stderr: '' }
      },
    }))
    const managerStatus = await managerService.detectProvider('codex')
    assert.deepEqual(managerStatus.candidates, [
      fs.realpathSync(path.join(managerTargets.npm, 'codex')),
      fs.realpathSync(path.join(managerTargets.pnpm, 'codex')),
      fs.realpathSync(path.join(managerTargets.bun, 'codex')),
      fs.realpathSync(path.join(managerTargets.brew, 'codex')),
    ])

    // Login-shell PATH is included, while profile noise before the marker is ignored.
    let shellCalls = 0
    const loginService = new ProviderCliDetectionService(serviceOptions(root, {
      includeLoginShell: true,
      env: { PATH: '', SHELL: '/bin/sh' },
      runCommand: async (binary, args) => {
        if (args[0] === '-l') {
          shellCalls++
          return { ok: true, code: 0, timedOut: false, stdout: `profile noise\n__MOBIUS_LOGIN_PATH__${pathBin}`, stderr: '' }
        }
        if (args[0] === '--version') return { ok: true, code: 0, timedOut: false, stdout: 'codex 1.4.0', stderr: '' }
        return { ok: true, code: 0, timedOut: false, stdout: 'Logged in', stderr: '' }
      },
    }))
    assert.equal((await loginService.detectProvider('codex')).binaryPath, fs.realpathSync(codex))
    assert.equal(shellCalls, 1)

    // Multiple symlink launchers resolving to the same regular executable are de-duplicated.
    const realBin = path.join(root, 'real', 'codex')
    writeExecutable(realBin, 'echo "codex 2.0.0"; exit 0')
    const linkOneDir = path.join(root, 'link-one')
    const linkTwoDir = path.join(root, 'link-two')
    fs.mkdirSync(linkOneDir)
    fs.mkdirSync(linkTwoDir)
    fs.symlinkSync(realBin, path.join(linkOneDir, 'codex'))
    fs.symlinkSync(realBin, path.join(linkTwoDir, 'codex'))
    const linkService = new ProviderCliDetectionService(serviceOptions(root, {
      env: { PATH: [linkOneDir, linkTwoDir].join(path.delimiter) },
    }))
    const linkStatus = await linkService.detectProvider('codex')
    assert.deepEqual(linkStatus.candidates, [fs.realpathSync(realBin)])
    assert.equal(linkStatus.binaryPath, fs.realpathSync(realBin))

    // Version probes have a short hard timeout and a timed-out CLI is not available.
    const slowBin = path.join(root, 'slow', 'codex')
    writeExecutable(slowBin, '/bin/sleep 2')
    const slowService = new ProviderCliDetectionService(serviceOptions(root, {
      env: { PATH: path.dirname(slowBin) },
      timeouts: { version: 30, auth: 30 },
    }))
    const timeoutStarted = Date.now()
    const slowStatus = await slowService.detectProvider('codex')
    assert.equal(slowStatus.installed, true)
    assert.equal(slowStatus.available, false)
    assert.ok(Date.now() - timeoutStarted < 1000, 'version timeout was not enforced')

    // Missing providers and missing Mobius profiles are safe, explicit states.
    const missingService = new ProviderCliDetectionService(serviceOptions(root))
    const missingStatus = await missingService.detectProvider('codex')
    assert.equal(missingStatus.installed, false)
    assert.equal(missingStatus.launchReady, false)
    assert.match(missingStatus.reason, /未安装/)
    await assert.rejects(missingService.resolveExecutable('codex'), /Codex CLI 不可用.*未安装/)
    const noProfileService = new ProviderCliDetectionService(serviceOptions(root, {
      env: { PATH: pathBin },
      getLaunchReadiness: () => ({ ready: false, reason: 'Mobius profile 缺失' }),
    }))
    const noProfile = await noProfileService.detectProvider('codex')
    assert.equal(noProfile.installed, true)
    assert.equal(noProfile.launchReady, false)
    assert.equal(noProfile.reason, 'Mobius profile 缺失')

    // Native readiness requires an explicit official authenticated status; no Mobius
    // profile is needed, while unknown/required auth can never be promoted.
    const nativeService = new ProviderCliDetectionService(serviceOptions(root, {
      env: { PATH: pathBin },
      getLaunchReadiness: () => ({
        ready: true,
        configuredReady: false,
        nativeEnabled: true,
        reason: null,
      }),
    }))
    const nativeStatus = await nativeService.detectProvider('codex')
    assert.equal(nativeStatus.launchReady, true)
    assert.equal(nativeStatus.launchMode, 'native')
    assert.equal(nativeStatus.nativeReady, true)
    assert.equal(await nativeService.resolveNativeExecutable('codex'), fs.realpathSync(codex))

    const unauthenticatedService = new ProviderCliDetectionService(serviceOptions(root, {
      env: { PATH: pathBin },
      getLaunchReadiness: () => ({ configuredReady: false, nativeEnabled: true }),
      runCommand: async (_binary, args) => {
        if (args[0] === '--version') return { ok: true, code: 0, timedOut: false, stdout: 'codex 4.0.0', stderr: '' }
        return { ok: false, code: 1, timedOut: false, stdout: '', stderr: 'Not logged in' }
      },
    }))
    const unauthenticated = await unauthenticatedService.detectProvider('codex')
    assert.equal(unauthenticated.authStatus, 'required')
    assert.equal(unauthenticated.nativeReady, false)
    assert.equal(unauthenticated.launchReady, false)
    await assert.rejects(unauthenticatedService.resolveNativeExecutable('codex'), /native 模式不可用.*尚未认证/)

    const adminDisabledService = new ProviderCliDetectionService(serviceOptions(root, {
      env: { PATH: pathBin },
      getLaunchReadiness: () => ({
        configuredReady: false,
        nativeEnabled: false,
        nativeModelEnabled: true,
        reason: '管理员已禁用本机 Provider 自动导入',
      }),
    }))
    const adminDisabled = await adminDisabledService.detectProvider('codex')
    assert.equal(adminDisabled.authStatus, 'authenticated')
    assert.equal(adminDisabled.nativeReady, false)
    assert.equal(adminDisabled.launchReady, false)
    await assert.rejects(adminDisabledService.resolveNativeExecutable('codex'), /管理员已禁用/)

    // Unsupported/ambiguous auth commands must not be promoted to required/authenticated.
    assert.equal(_private.parseAuthStatus('codex', {
      ok: false, code: 2, timedOut: false, stdout: '', stderr: 'unknown subcommand status',
    }), 'unknown')
    assert.equal(_private.parseAuthStatus('codex', {
      ok: false, code: 2, timedOut: false, stdout: '', stderr: 'network error',
    }), 'unknown')
    assert.equal(_private.parseAuthStatus('codex', {
      ok: false, code: null, timedOut: true, stdout: '', stderr: '',
    }), 'unknown')
    assert.equal(_private.parseAuthStatus('claude', {
      ok: false, code: 1, timedOut: false, stdout: '{"loggedIn":false}', stderr: '',
    }), 'required')
    assert.equal(_private.parseVersion('v1.2.3-beta.1'), '1.2.3-beta.1')
    assert.equal(_private.parseVersion('Claude Code'), null)

    // TTL cache reuses a probe; force refresh bypasses it.
    let version = '3.0.0'
    let versionCalls = 0
    const cacheService = new ProviderCliDetectionService(serviceOptions(root, {
      env: { PATH: pathBin },
      ttlMs: 60_000,
      runCommand: async (_binary, args) => {
        if (args[0] === '--version') {
          versionCalls++
          return { ok: true, code: 0, timedOut: false, stdout: `codex ${version}`, stderr: '' }
        }
        return { ok: true, code: 0, timedOut: false, stdout: 'Logged in', stderr: '' }
      },
    }))
    assert.equal((await cacheService.detectProvider('codex')).version, '3.0.0')
    version = '3.1.0'
    assert.equal((await cacheService.detectProvider('codex')).version, '3.0.0')
    assert.equal(versionCalls, 1)
    assert.equal((await cacheService.detectProvider('codex', { force: true })).version, '3.1.0')
    assert.equal(versionCalls, 2)

    // API serializer is an allowlist: arbitrary command output/secrets never escape.
    const publicStatus = toPublicProviderStatus({
      ...pathStatus,
      token: 'never-return-this-secret',
      apiKey: 'never-return-this-secret',
      stdout: 'never-return-this-secret',
    })
    const serialized = JSON.stringify(publicStatus)
    assert.equal(serialized.includes('never-return-this-secret'), false)
    assert.deepEqual(Object.keys(publicStatus), [
      'provider', 'installed', 'available', 'launchReady', 'launchMode',
      'configuredReady', 'nativeEnabled', 'nativeModelEnabled', 'nativeReady', 'binaryPath', 'version',
      'authStatus', 'reason', 'checkedAt', 'candidates',
    ])

    // Both tmux backends reject relative executables and shell-quote absolute ones.
    const codexCommand = buildCodexCliExec({
      executable: '/opt/My Tools/codex',
      useProxy: false,
      proxyConfig: '/tmp/proxy.conf',
      profileKey: 'mobiusdefault',
      subcommand: '',
      codexArgs: ['-m', 'gpt-test'],
    })
    assert.match(codexCommand, /^exec '\/opt\/My Tools\/codex' /)
    assert.match(codexCommand, /--profile 'mobiusdefault'/)
    assert.equal(/\bexec codex\b/.test(codexCommand), false)
    const nativeCodexCommand = buildCodexCliExec({
      executable: '/opt/codex',
      useProxy: false,
      proxyConfig: '/tmp/proxy.conf',
      profileKey: null,
      subcommand: '',
      codexArgs: ['-m', 'gpt-test', '--dangerously-bypass-approvals-and-sandbox'],
    })
    assert.equal(nativeCodexCommand.includes('--profile'), false)
    assert.match(nativeCodexCommand, /'-m' 'gpt-test'/)
    const claudeCommand = buildClaudeCliExec({
      executable: "/Users/test/O'Brien/claude",
      useProxy: false,
      proxyConfig: '/tmp/proxy.conf',
      settingsArg: "--settings '/tmp/settings.json'",
      claudeArgs: ['--session-id test'],
    })
    assert.match(claudeCommand, /^exec '\/Users\/test\/O'\\''Brien\/claude' /)
    assert.match(claudeCommand, /--settings/)
    assert.equal(/\bexec claude\b/.test(claudeCommand), false)
    const nativeClaudeCommand = buildClaudeCliExec({
      executable: '/opt/claude',
      useProxy: false,
      proxyConfig: '/tmp/proxy.conf',
      settingsArg: '',
      claudeArgs: ['--dangerously-skip-permissions', "--model 'opus-test'"],
    })
    assert.equal(nativeClaudeCommand.includes('--settings'), false)
    assert.match(nativeClaudeCommand, /--dangerously-skip-permissions/)
    assert.match(nativeClaudeCommand, /--model 'opus-test'/)
    assert.throws(() => buildCodexCliExec({ executable: 'codex', useProxy: false, proxyConfig: '', profileKey: 'x', subcommand: '', codexArgs: [] }), /绝对路径/)
    assert.throws(() => buildClaudeCliExec({ executable: 'claude', useProxy: false, proxyConfig: '', settingsArg: '', claudeArgs: [] }), /绝对路径/)

    // The actual backend sources resolve at launch time and pass only the absolute result.
    const codexBackendSource = fs.readFileSync(path.join(__dirname, '../backend/agents/tmux-codex.js'), 'utf8')
    const claudeBackendSource = fs.readFileSync(path.join(__dirname, '../backend/agents/tmux-claude-code.js'), 'utf8')
    assert.match(codexBackendSource, /await resolveProviderExecutable\('codex'\)/)
    assert.match(codexBackendSource, /executable: codexExecutable/)
    assert.match(claudeBackendSource, /await resolveProviderExecutable\('claude'\)/)
    assert.match(claudeBackendSource, /executable: claudeExecutable/)
    assert.match(codexBackendSource, /await resolveNativeProviderExecutable\('codex', \{ force: true \}\)/)
    assert.match(claudeBackendSource, /await resolveNativeProviderExecutable\('claude', \{ force: true \}\)/)
    assert.equal(codexBackendSource.includes('const profileArg = `--profile'), false)
    assert.equal(claudeBackendSource.includes('--settings "$HOME/.claude/mobiusdefault.settings.json"'), false)
    assert.equal(/process\.exit\(/.test(claudeBackendSource), false)
    const adminRouteSource = fs.readFileSync(path.join(__dirname, '../backend/routes/admin.ts'), 'utf8')
    assert.match(adminRouteSource, /router\.get\('\/provider-cli-status', adminAuth,/)

    console.log('provider-cli-detection: ok')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
