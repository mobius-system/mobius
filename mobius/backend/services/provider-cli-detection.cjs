/**
 * Detect locally installed Codex / Claude Code CLIs without reading credentials.
 *
 * Discovery is deliberately bounded: exact executable names are checked in a
 * deterministic list of PATH and well-known package-manager directories.  No
 * recursive filesystem walk is performed.  Symlinks are resolved before
 * executable validation and de-duplication.
 */
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PROVIDERS = Object.freeze({
  codex: {
    command: 'codex',
    label: 'Codex',
    versionArgs: ['--version'],
    authArgs: ['login', 'status'],
  },
  claude: {
    command: 'claude',
    label: 'Claude Code',
    versionArgs: ['--version'],
    authArgs: ['auth', 'status'],
  },
})

const DEFAULT_TTL_MS = 15 * 1000
const DEFAULT_TIMEOUTS = Object.freeze({
  loginShell: 2000,
  manager: 2000,
  version: 3000,
  auth: 3000,
})
const OUTPUT_LIMIT = 8 * 1024
const MAX_SEARCH_DIRS = 256
const MAX_VERSION_DIRS = 64
const MAX_CANDIDATES = 32
const LOGIN_PATH_MARKER = '__MOBIUS_LOGIN_PATH__'

// Provider 子进程只需要用户目录、可执行文件搜索路径、终端/区域设置、
// 包管理器目录和网络/TLS 设置。不要把 JWT_SECRET、数据库口令等 Mobius
// 服务端秘密随 process.env 交给自动发现的外部 CLI。
const SAFE_ENV_KEYS = new Set([
  'PATH', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'TERM', 'COLORTERM',
  'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'NVM_DIR', 'VOLTA_HOME', 'PNPM_HOME', 'ASDF_DIR', 'ASDF_DATA_DIR',
  'FNM_DIR', 'BUN_INSTALL', 'NPM_CONFIG_PREFIX',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
])

function safeProviderEnvironment(source) {
  const out = {}
  for (const [key, value] of Object.entries(source || {})) {
    if ((SAFE_ENV_KEYS.has(key) || key.startsWith('LC_')) && typeof value === 'string') {
      out[key] = value
    }
  }
  return out
}

function capped(value) {
  return String(value || '').slice(0, OUTPUT_LIMIT)
}

function defaultRunCommand(binary, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    childProcess.execFile(binary, args, {
      encoding: 'utf8',
      env,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: OUTPUT_LIMIT,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const timedOut = !!(error && (error.killed || error.code === 'ETIMEDOUT') && error.signal === 'SIGKILL')
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        ok: !error,
        timedOut,
        stdout: capped(stdout),
        stderr: capped(stderr),
      })
    })
  })
}

function parseVersion(output) {
  const match = String(output || '').match(/(?:^|[^0-9])v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)(?=$|[^0-9A-Za-z.-])/)
  return match ? match[1] : null
}

function combinedOutput(result) {
  return capped(`${result?.stdout || ''}\n${result?.stderr || ''}`).trim()
}

function unsupportedAuthCommand(output) {
  return /(?:unknown|unrecognized|invalid|unsupported)\s+(?:command|subcommand|option)|no such (?:command|subcommand)|usage:/i.test(output)
}

function booleanFromObject(value, keys) {
  if (!value || typeof value !== 'object') return null
  for (const key of keys) {
    if (typeof value[key] === 'boolean') return value[key]
  }
  return null
}

function parseAuthStatus(provider, result) {
  if (!result || result.timedOut) return 'unknown'
  const output = combinedOutput(result)
  if (unsupportedAuthCommand(output)) return 'unknown'

  if (provider === 'claude' && output) {
    try {
      const parsed = JSON.parse(output)
      const loggedIn = booleanFromObject(parsed, ['loggedIn', 'logged_in', 'authenticated'])
      if (loggedIn === true) return 'authenticated'
      if (loggedIn === false) return 'required'
    } catch { /* Older versions may return text; use only explicit markers below. */ }
  }

  if (/\bnot logged in\b|\blogin required\b|\bnot authenticated\b|please (?:run|use).{0,30}\blogin\b|\bno (?:valid )?credentials\b/i.test(output)) {
    return 'required'
  }
  if (result.code === 0) return 'authenticated'
  // Claude documents exit 1 specifically as "not logged in".  Codex only
  // documents exit 0 for present credentials, so ambiguous Codex failures
  // remain unknown unless an explicit marker above was present.
  if (provider === 'claude' && result.code === 1) return 'required'
  return 'unknown'
}

function defaultLaunchReadiness(provider) {
  try {
    // Lazy require avoids coupling executable resolution at module load time to
    // the model registry (and keeps a missing CLI from affecting server boot).
    const imported = require('./model-access')
    const modelAccess = imported?.default || imported
    const isClaude = provider === 'claude'
    const rows = isClaude
      ? modelAccess.listClaudeCodeModels({ enabledOnly: false, includeSettings: false, seedBuiltins: false })
      : modelAccess.listCodexModels({ enabledOnly: false, includeConfig: false, seedBuiltins: false })
    const providerLabel = isClaude ? 'Claude Code' : 'Codex'
    const fileLabel = isClaude ? 'settings' : 'profile/config'
    const existsKey = isClaude ? 'settings_exists' : 'config_exists'
    const enabled = rows.filter((row) => row?.enabled !== false)
    const native = typeof modelAccess.getNativeProvider === 'function'
      ? modelAccess.getNativeProvider(provider)
      : { enabled: true }
    const builtinControl = rows.find((row) => row?.key === 'mobiusdefault') || null
    const nativeModelEnabled = builtinControl?.enabled !== false
    // 只用 existsSync 判断内置文件，不读取其内容。探测路径绝不能触发 model-access
    // 的 seed 逻辑，否则可能把专用 config 中的 api_key 复制进 MODEL_ACCESS_PATH。
    const builtinPath = isClaude
      ? modelAccess.settingsPathForKey('mobiusdefault')
      : modelAccess.codexConfigPathForKey('mobiusdefault')
    const implicitBuiltinReady = builtinControl?.enabled !== false && fs.existsSync(builtinPath)
    const configuredReady = enabled.some((row) => row?.[existsKey] === true) || implicitBuiltinReady
    let reason = null
    if (!configuredReady && native.enabled === false) {
      reason = `管理员已禁用 ${providerLabel} 本机自动导入，且没有已启用的 Mobius ${fileLabel}`
    } else if (!configuredReady && !nativeModelEnabled) {
      reason = `管理员已禁用 ${providerLabel} 内置模型`
    } else if (!configuredReady && rows.length > 0 && enabled.length === 0) {
      reason = `管理员已禁用所有 ${providerLabel} 专用模型`
    }
    return {
      ready: configuredReady || (native.enabled !== false && nativeModelEnabled),
      configuredReady,
      nativeEnabled: native.enabled !== false,
      nativeModelEnabled,
      reason,
    }
  } catch {
    return {
      ready: false,
      configuredReady: false,
      nativeEnabled: false,
      nativeModelEnabled: false,
      reason: 'Mobius 模型配置暂时无法读取',
    }
  }
}

class ProviderCliDetectionService {
  constructor(options = {}) {
    this.home = path.resolve(options.home || os.homedir())
    this.env = {
      ...safeProviderEnvironment(process.env),
      ...safeProviderEnvironment(options.env || {}),
      HOME: this.home,
    }
    this.cwd = path.resolve(options.cwd || process.cwd())
    this.now = options.now || (() => Date.now())
    this.ttlMs = Number.isFinite(options.ttlMs) ? Math.max(0, options.ttlMs) : DEFAULT_TTL_MS
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts || {}) }
    this.runCommand = options.runCommand || defaultRunCommand
    this.getLaunchReadiness = options.getLaunchReadiness || defaultLaunchReadiness
    this.includeLoginShell = options.includeLoginShell !== false
    this.includeManagerDiscovery = options.includeManagerDiscovery !== false
    this.wellKnownDirs = Array.isArray(options.wellKnownDirs) ? options.wellKnownDirs.slice() : null
    this.cache = new Map()
    this.statusByProvider = new Map()
    this.runtimeEnvByProvider = new Map()
    this.statusListeners = new Set()
  }

  _provider(provider) {
    const spec = PROVIDERS[provider]
    if (!spec) throw new Error(`Unsupported CLI provider: ${provider}`)
    return spec
  }

  _addDir(out, seen, value) {
    if (!value || out.length >= MAX_SEARCH_DIRS) return
    const raw = String(value).trim()
    if (!raw) return
    const absolute = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(this.cwd, raw)
    if (seen.has(absolute)) return
    seen.add(absolute)
    out.push(absolute)
  }

  _addPathValue(out, seen, value) {
    for (const entry of String(value || '').split(path.delimiter)) this._addDir(out, seen, entry)
  }

  _boundedChildren(root, suffixParts) {
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'en'))
      .slice(0, MAX_VERSION_DIRS)
      .map((name) => path.join(root, name, ...suffixParts))
  }

  _wellKnownDirs() {
    if (this.wellKnownDirs) return this.wellKnownDirs.slice()
    const dirs = [
      path.join(this.home, '.local', 'bin'),
      path.join(this.home, '.npm-global', 'bin'),
      path.join(this.home, '.npm', 'bin'),
      path.join(this.home, '.local', 'share', 'pnpm'),
      path.join(this.home, 'Library', 'pnpm'),
      path.join(this.home, '.pnpm-global', 'bin'),
      path.join(this.home, '.bun', 'bin'),
      path.join(this.home, '.volta', 'bin'),
      path.join(this.home, '.asdf', 'shims'),
      path.join(this.home, '.local', 'share', 'mise', 'shims'),
      path.join(this.home, '.nodebrew', 'current', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]
    if (this.env.NPM_CONFIG_PREFIX) dirs.push(path.join(this.env.NPM_CONFIG_PREFIX, 'bin'))
    if (this.env.PNPM_HOME) dirs.push(this.env.PNPM_HOME)
    if (this.env.BUN_INSTALL) dirs.push(path.join(this.env.BUN_INSTALL, 'bin'))
    dirs.push(...this._boundedChildren(path.join(this.home, '.nvm', 'versions', 'node'), ['bin']))
    dirs.push(...this._boundedChildren(path.join(this.home, '.fnm', 'node-versions'), ['installation', 'bin']))
    dirs.push(...this._boundedChildren(path.join(this.home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin']))
    return dirs
  }

  _validatedExecutable(candidate) {
    if (!candidate) return null
    const launcher = path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(this.cwd, candidate)
    let realPath
    let stat
    try {
      realPath = fs.realpathSync(launcher)
      stat = fs.statSync(realPath)
      if (!stat.isFile()) return null
      fs.accessSync(realPath, fs.constants.X_OK)
    } catch {
      return null
    }
    return {
      path: path.normalize(realPath),
      identity: `${stat.dev}:${stat.ino}:${path.normalize(realPath)}`,
    }
  }

  _findManager(command, dirs) {
    for (const dir of dirs) {
      const found = this._validatedExecutable(path.join(dir, command))
      if (found) return found.path
    }
    return null
  }

  async _loginShellPath() {
    if (!this.includeLoginShell) return ''
    const configured = String(this.env.SHELL || '').trim()
    const shellCandidates = [configured, '/bin/zsh', '/bin/bash']
    const seen = new Set()
    for (const candidate of shellCandidates) {
      const executable = this._validatedExecutable(candidate)
      if (!executable || seen.has(executable.path)) continue
      seen.add(executable.path)
      const result = await this.runCommand(executable.path, [
        '-l',
        '-c',
        `printf '\\n${LOGIN_PATH_MARKER}%s' "$PATH"`,
      ], { env: this.env, timeoutMs: this.timeouts.loginShell })
      if (!result?.ok || result.timedOut) continue
      const output = capped(result.stdout)
      const markerAt = output.lastIndexOf(LOGIN_PATH_MARKER)
      if (markerAt >= 0) return output.slice(markerAt + LOGIN_PATH_MARKER.length).trim()
    }
    return ''
  }

  async _managerDirs(baseDirs) {
    if (!this.includeManagerDiscovery) return []
    const queries = [
      { command: 'npm', args: ['prefix', '-g'], map: (value) => path.join(value, 'bin') },
      { command: 'pnpm', args: ['bin', '-g'], map: (value) => value },
      { command: 'bun', args: ['pm', 'bin', '-g'], map: (value) => value },
      { command: 'brew', args: ['--prefix'], map: (value) => path.join(value, 'bin') },
    ]
    const values = await Promise.all(queries.map(async (query) => {
      const executable = this._findManager(query.command, baseDirs)
      if (!executable) return ''
      const result = await this.runCommand(executable, query.args, {
        env: { ...this.env, PATH: baseDirs.join(path.delimiter) },
        timeoutMs: this.timeouts.manager,
      })
      if (!result?.ok || result.timedOut) return ''
      const value = capped(result.stdout).trim().split(/\r?\n/).pop()?.trim() || ''
      if (!path.isAbsolute(value)) return ''
      return query.map(path.normalize(value))
    }))
    return values.filter(Boolean)
  }

  async _searchDirs() {
    const out = []
    const seen = new Set()
    this._addPathValue(out, seen, this.env.PATH)
    this._addPathValue(out, seen, await this._loginShellPath())
    for (const dir of this._wellKnownDirs()) this._addDir(out, seen, dir)
    for (const dir of await this._managerDirs(out)) this._addDir(out, seen, dir)
    return out
  }

  async _candidates(provider) {
    const spec = this._provider(provider)
    const candidates = []
    const identities = new Set()
    const searchDirs = await this._searchDirs()
    for (const dir of searchDirs) {
      if (candidates.length >= MAX_CANDIDATES) break
      const executable = this._validatedExecutable(path.join(dir, spec.command))
      if (!executable || identities.has(executable.identity)) continue
      identities.add(executable.identity)
      candidates.push(executable.path)
    }
    return {
      candidates,
      commandEnv: { ...this.env, PATH: searchDirs.join(path.delimiter) },
    }
  }

  _withReadiness(base, readiness) {
    let launchReady = false
    let reason
    let launchMode = null
    const structuredReadiness = readiness && (
      Object.prototype.hasOwnProperty.call(readiness, 'configuredReady')
      || Object.prototype.hasOwnProperty.call(readiness, 'nativeEnabled')
      || Object.prototype.hasOwnProperty.call(readiness, 'nativeModelEnabled')
    )
    // 兼容单元测试/外部注入的旧 { ready, reason } 契约：ready 只表示专用配置，
    // 不应凭空开启 native。生产 defaultLaunchReadiness 始终返回结构化字段。
    const configuredReady = structuredReadiness
      ? readiness?.configuredReady === true
      : readiness?.ready === true
    const nativeEnabled = structuredReadiness ? readiness?.nativeEnabled !== false : false
    const nativeModelEnabled = structuredReadiness ? readiness?.nativeModelEnabled !== false : true
    const nativeReady = nativeEnabled && nativeModelEnabled && base.authStatus === 'authenticated'
    if (!base.installed) {
      reason = `${base.provider === 'codex' ? 'Codex' : 'Claude Code'} CLI 未安装或未在已知目录中找到`
    } else if (!base.available) {
      reason = 'CLI 已找到，但 --version 执行失败或超时'
    } else if (configuredReady) {
      launchReady = true
      launchMode = 'configured'
      reason = nativeReady ? '可启动（Mobius 专用配置优先；本机官方登录态也可用）' : '可启动（Mobius 专用配置）'
    } else if (nativeReady) {
      launchReady = true
      launchMode = 'native'
      reason = '可启动（复用本机官方登录态）'
    } else if (!nativeEnabled) {
      reason = readiness?.reason || '管理员已禁用本机 Provider 自动导入'
    } else if (!nativeModelEnabled) {
      reason = readiness?.reason || '管理员已禁用对应内置模型'
    } else if (base.authStatus === 'required') {
      reason = '本机 CLI 报告尚未认证，请先在同一用户 HOME 下登录'
    } else if (base.authStatus === 'unknown') {
      reason = '本机 CLI 认证状态无法确认；native 模式要求官方 status 明确为已认证'
    } else if (!readiness?.ready) {
      reason = readiness?.reason || 'Mobius 模型配置缺失或未启用'
    } else {
      reason = readiness?.reason || 'Provider 暂不可启动'
    }
    return {
      ...base,
      launchReady,
      launchMode,
      configuredReady,
      nativeEnabled,
      nativeModelEnabled,
      nativeReady: base.available && nativeReady,
      reason,
    }
  }

  async _detectUncached(provider) {
    const spec = this._provider(provider)
    const discovery = await this._candidates(provider)
    const { candidates, commandEnv } = discovery
    this.runtimeEnvByProvider.set(provider, {
      ...commandEnv,
      HOME: this.home,
      CODEX_HOME: commandEnv.CODEX_HOME || path.join(this.home, '.codex'),
    })
    const versionResults = await Promise.all(candidates.map(async (binaryPath) => {
      const result = await this.runCommand(binaryPath, spec.versionArgs, {
        env: commandEnv,
        timeoutMs: this.timeouts.version,
      })
      return { binaryPath, result, version: parseVersion(combinedOutput(result)) }
    }))
    const selected = versionResults.find((entry) => entry.result?.ok && !entry.result.timedOut) || null
    const binaryPath = selected?.binaryPath || candidates[0] || null
    let authStatus = 'unknown'
    if (selected) {
      const authResult = await this.runCommand(selected.binaryPath, spec.authArgs, {
        env: commandEnv,
        timeoutMs: this.timeouts.auth,
      })
      authStatus = parseAuthStatus(provider, authResult)
    }
    const readiness = await Promise.resolve(this.getLaunchReadiness(provider))
    return this._withReadiness({
      provider,
      installed: candidates.length > 0,
      available: !!selected,
      launchReady: false,
      binaryPath,
      version: selected?.version || null,
      authStatus,
      reason: null,
      checkedAt: new Date(this.now()).toISOString(),
      candidates,
    }, readiness)
  }

  async detectProvider(provider, { force = false } = {}) {
    this._provider(provider)
    const current = this.cache.get(provider)
    const now = this.now()
    if (!force && current && current.expiresAt > now) return current.promise
    const promise = this._detectUncached(provider).catch(() => ({
      provider,
      installed: false,
      available: false,
      launchReady: false,
      launchMode: null,
      configuredReady: false,
      nativeEnabled: false,
      nativeModelEnabled: false,
      nativeReady: false,
      binaryPath: null,
      version: null,
      authStatus: 'unknown',
      reason: 'CLI 检测失败',
      checkedAt: new Date(this.now()).toISOString(),
      candidates: [],
    }))
    this.cache.set(provider, { expiresAt: now + this.ttlMs, promise })
    promise.then((status) => {
      this.statusByProvider.set(provider, status)
      for (const listener of this.statusListeners) {
        try { listener(provider, status) } catch { /* observers must not break detection */ }
      }
    })
    return promise
  }

  detectAll({ force = false } = {}) {
    return Promise.all(Object.keys(PROVIDERS).map((provider) => this.detectProvider(provider, { force })))
  }

  async resolveExecutable(provider, { force = false } = {}) {
    const status = await this.detectProvider(provider, { force })
    if (!status.available || !status.binaryPath || !path.isAbsolute(status.binaryPath)) {
      const label = PROVIDERS[provider]?.label || provider
      throw new Error(`${label} CLI 不可用: ${status.reason}`)
    }
    return status.binaryPath
  }

  async resolveNativeExecutable(provider, { force = false } = {}) {
    const status = await this.detectProvider(provider, { force })
    if (!status.nativeReady || !status.binaryPath || !path.isAbsolute(status.binaryPath)) {
      const label = PROVIDERS[provider]?.label || provider
      throw new Error(`${label} native 模式不可用: ${status.reason}`)
    }
    return status.binaryPath
  }

  peekProviderStatus(provider) {
    this._provider(provider)
    return this.statusByProvider.get(provider) || null
  }

  cachedProviderRuntime(provider, { nativeOnly = false } = {}) {
    this._provider(provider)
    const status = this.statusByProvider.get(provider)
    const ready = nativeOnly
      ? status?.nativeReady === true && status?.authStatus === 'authenticated'
      : status?.available === true
    if (!ready || !status?.binaryPath || !path.isAbsolute(status.binaryPath)) {
      throw new Error(`${PROVIDERS[provider].label} CLI runtime 不可用`)
    }
    const runtimeEnv = this.runtimeEnvByProvider.get(provider) || {
      ...this.env,
      HOME: this.home,
      CODEX_HOME: this.env.CODEX_HOME || path.join(this.home, '.codex'),
    }
    return {
      executable: status.binaryPath,
      env: { ...runtimeEnv },
    }
  }

  onStatusRefresh(listener) {
    if (typeof listener !== 'function') throw new Error('provider status listener 必须是函数')
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  setProviderStatusForTests(provider, status) {
    this._provider(provider)
    if (status == null) this.statusByProvider.delete(provider)
    else this.statusByProvider.set(provider, { provider, ...status })
  }

  clearCache(provider) {
    if (provider) this.cache.delete(provider)
    else this.cache.clear()
  }
}

function toPublicProviderStatus(status) {
  return {
    provider: status?.provider === 'claude' ? 'claude' : 'codex',
    installed: status?.installed === true,
    available: status?.available === true,
    launchReady: status?.launchReady === true,
    launchMode: ['configured', 'native'].includes(status?.launchMode) ? status.launchMode : null,
    configuredReady: status?.configuredReady === true,
    nativeEnabled: status?.nativeEnabled === true,
    nativeModelEnabled: status?.nativeModelEnabled === true,
    nativeReady: status?.nativeReady === true,
    binaryPath: typeof status?.binaryPath === 'string' ? status.binaryPath : null,
    version: typeof status?.version === 'string' ? status.version : null,
    authStatus: ['authenticated', 'required', 'unknown'].includes(status?.authStatus) ? status.authStatus : 'unknown',
    reason: typeof status?.reason === 'string' ? status.reason : null,
    checkedAt: typeof status?.checkedAt === 'string' ? status.checkedAt : null,
    candidates: Array.isArray(status?.candidates)
      ? status.candidates.filter((value) => typeof value === 'string').slice(0, MAX_CANDIDATES)
      : [],
  }
}

const providerCliDetection = new ProviderCliDetectionService()

module.exports = {
  PROVIDERS,
  ProviderCliDetectionService,
  detectProvider: (...args) => providerCliDetection.detectProvider(...args),
  detectProviders: (...args) => providerCliDetection.detectAll(...args),
  resolveProviderExecutable: (...args) => providerCliDetection.resolveExecutable(...args),
  resolveNativeProviderExecutable: (...args) => providerCliDetection.resolveNativeExecutable(...args),
  getCachedProviderStatus: (...args) => providerCliDetection.peekProviderStatus(...args),
  getCachedProviderRuntime: (...args) => providerCliDetection.cachedProviderRuntime(...args),
  onProviderStatusRefresh: (...args) => providerCliDetection.onStatusRefresh(...args),
  clearProviderCliDetectionCache: (...args) => providerCliDetection.clearCache(...args),
  toPublicProviderStatus,
  _private: {
    parseAuthStatus,
    parseVersion,
    setProviderStatusForTests: (...args) => providerCliDetection.setProviderStatusForTests(...args),
  },
}
