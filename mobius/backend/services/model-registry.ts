/**
 * model-registry.ts — Session 可选模型统一解析.
 *
 * 内置模型来自 config.js (opus/codex);
 * 管理员导入的 Claude Code 模型来自 model-access.js (settings JSON);
 * 管理员导入的 Codex 模型来自 model-access.js (per-channel TOML, --profile 加载).
 *
 * Mobius 专用配置存在时优先使用；否则，已安装且由官方 status 明确认证的本机
 * Codex / Claude CLI 可作为 native built-in，直接复用同一 HOME 的登录态。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  MODEL_OPTIONS,
  MODELS,
  DEFAULT_MODEL_KEY,
  DEFAULT_AGENT_BACKEND,
  modelKeyFor,
} from '../config'
import adminSettings from './admin-settings'
import * as modelAccess from './model-access'
// @ts-ignore — shared detector is CommonJS so tmux .js backends can reuse it directly.
import providerCliDetection from './provider-cli-detection.cjs'
// @ts-ignore — app-server catalog is shared with CommonJS startup/tests.
import codexModelCatalog from './codex-model-catalog.cjs'

const BUILTIN_ORDER = ['codex', 'opus']
const NATIVE_CODEX_MODEL_PREFIX = 'codex-native:'
// 内置 Claude (Opus) 在 model-access 表里的 seed key (= settings 文件 mobiusdefault.settings.json).
const BUILTIN_CLAUDE_KEY = 'mobiusdefault'

function applyDisplayOrder(options: any[]): any[] {
  const order = adminSettings.getModelDisplayOrder()
  if (!Array.isArray(order) || order.length === 0) return options
  const rank = new Map(order.map((key, index) => [key, index]))
  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => {
      const ar = rank.has(a.option.key) ? rank.get(a.option.key) as number : Number.MAX_SAFE_INTEGER
      const br = rank.has(b.option.key) ? rank.get(b.option.key) as number : Number.MAX_SAFE_INTEGER
      if (ar !== br) return ar - br
      return a.index - b.index
    })
    .map(item => item.option)
}

function defaultUseProxyForBackend(backend: any): boolean {
  return false
}

function modelUseProxy(key: any, fallback: any): any {
  return adminSettings.getModelNetworkProxy(key, fallback)
}

// 黑客帝国数字雨 · 若该模型开启了"捕获实时输出"且 .withproxy.json 已生成 (保存开关时落盘),
// 启动 cc 时改用 withproxy 变体 → 请求经 token-proxy 中转并被抓取流式 token.
// 找不到 withproxy 文件 (例如尚未保存) 就安全回落原 settings, 不阻断启动.
function effectiveClaudeSettingsPath(resolved: any): any {
  const base = resolved?.settingsPath
  if (!base) return base
  if (!adminSettings.getModelCaptureStream(resolved.key)) return base
  const withProxy = modelAccess.withProxyPathFor(base)
  return fileExists(withProxy) ? withProxy : base
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

function builtinCodexConfigPath(profileKey: string): string {
  return path.join(codexHome(), `${profileKey}.config.toml`)
}

function builtinClaudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'mobiusdefault.settings.json')
}

function fileExists(file: any): boolean {
  return !!file && fs.existsSync(file)
}

function builtinProviderForKey(key: string): 'codex' | 'claude' {
  return key === 'codex' ? 'codex' : 'claude'
}

function builtinControlRow(key: string): any {
  if (!modelAccess) return null
  if (key === 'codex' && typeof modelAccess.findCodexModel === 'function') {
    const profileKey = (MODEL_OPTIONS as Record<string, any>).codex?.profileKey
    return profileKey ? modelAccess.findCodexModel(profileKey) : null
  }
  if (key === 'opus' && typeof modelAccess.findClaudeCodeModel === 'function') {
    return modelAccess.findClaudeCodeModel(BUILTIN_CLAUDE_KEY)
  }
  return null
}

function builtinAllowedByAdmin(key: string): boolean {
  return builtinControlRow(key)?.enabled !== false
}

function builtinEntryFor(modelOrKey: any): any {
  const key = modelKeyFor(modelOrKey)
  if (!key) return null
  const opt = (MODEL_OPTIONS as Record<string, any>)[key]
  if (!opt) return null
  if (!builtinAllowedByAdmin(key)) return null
  const settingsPath = opt.backend === 'tmux-claude-code' ? builtinClaudeSettingsPath() : null
  const codexConfigPath = opt.backend === 'tmux-codex' && opt.profileKey ? builtinCodexConfigPath(opt.profileKey) : null
  const configPath = codexConfigPath || settingsPath
  if (!fileExists(configPath)) return null
  const useProxy = modelUseProxy(key, defaultUseProxyForBackend(opt.backend))
  return {
    key,
    value: key,
    sessionModelValue: opt.id,
    model: opt.id,
    label: opt.label,
    title: titleForBuiltin(key, opt),
    sub: subForBuiltin(key),
    backend: opt.backend,
    imported: false,
    native: false,
    useProxy,
    settingsPath,
    // built-in codex 也必须显式指定渠道.
    codexProfileKey: opt.profileKey || null,
    codexChannel: opt.profileKey || null,
    codexConfigPath,
    codexSecretEnvKey: opt.secretEnvKey || null,
    codexSecretValue: null,
    codexModel: null,
    claudeModel: opt.id,
  }
}

// native built-in 是同步、纯状态读取：慢速 CLI/status 探测在服务 listen 前预热，
// 此处只读取已完成的 snapshot，因此 model-options 不会在同步热路径里 spawn CLI。
function nativeBuiltinEntryFor(modelOrKey: any): any {
  const key = modelKeyFor(modelOrKey)
  if (!key) return null
  // Codex native models come from app-server model/list below. Claude keeps
  // the existing single built-in mapping because it has no equivalent catalog.
  if (key === 'codex') return null
  const opt = (MODEL_OPTIONS as Record<string, any>)[key]
  if (!opt || !builtinAllowedByAdmin(key)) return null
  const provider = builtinProviderForKey(key)
  const nativeSetting = typeof modelAccess?.getNativeProvider === 'function'
    ? modelAccess.getNativeProvider(provider)
    : { enabled: false }
  if (nativeSetting.enabled !== true) return null
  const status = providerCliDetection.getCachedProviderStatus(provider)
  if (!status || status.nativeReady !== true || status.authStatus !== 'authenticated') return null
  const useProxy = modelUseProxy(key, defaultUseProxyForBackend(opt.backend))
  return {
    key,
    value: key,
    sessionModelValue: opt.id,
    model: opt.id,
    label: opt.label,
    title: titleForBuiltin(key, opt),
    sub: `${subForBuiltin(key)} · 本机登录`,
    backend: opt.backend,
    imported: false,
    native: true,
    useProxy,
    settingsPath: null,
    codexProfileKey: null,
    codexChannel: null,
    codexConfigPath: null,
    codexSecretEnvKey: null,
    codexSecretValue: null,
    codexModel: key === 'codex' ? opt.id : null,
    claudeModel: key === 'opus' ? opt.id : null,
  }
}

function nativeCodexAvailable(): boolean {
  if (!builtinAllowedByAdmin('codex')) return false
  const nativeSetting = typeof modelAccess?.getNativeProvider === 'function'
    ? modelAccess.getNativeProvider('codex')
    : { enabled: false }
  if (nativeSetting.enabled !== true) return false
  const status = providerCliDetection.getCachedProviderStatus('codex')
  return status?.nativeReady === true && status?.authStatus === 'authenticated'
}

function nativeCodexModelKey(model: any, forceNativeKey = false): string {
  return !forceNativeKey && model?.isDefault === true
    ? 'codex'
    : `${NATIVE_CODEX_MODEL_PREFIX}${model.id}`
}

function nativeCodexEntry(model: any, { forceNativeKey = false }: { forceNativeKey?: boolean } = {}): any {
  if (!model || !nativeCodexAvailable()) return null
  const key = nativeCodexModelKey(model, forceNativeKey)
  const description = String(model.description || '').trim()
  return {
    key,
    value: key,
    // Native sessions persist the stable registry key. In particular the
    // app-server default remains `codex` even when its concrete model id moves.
    sessionModelValue: key,
    model: model.id,
    label: model.label || model.displayName || model.id,
    title: model.displayName || model.label || model.id,
    sub: description || 'Codex · 本机登录',
    description,
    backend: 'tmux-codex',
    imported: false,
    native: true,
    useProxy: modelUseProxy(key, false),
    settingsPath: null,
    codexProfileKey: null,
    codexChannel: null,
    codexConfigPath: null,
    codexSecretEnvKey: null,
    codexSecretValue: null,
    codexModel: model.id,
    claudeModel: null,
    isDefault: model.isDefault === true,
    reasoningEffortsAdvertised: model.reasoningEffortsAdvertised === true,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    speedsAdvertised: model.speedsAdvertised === true,
    supportedSpeeds: model.supportedSpeeds,
    defaultSpeed: model.defaultSpeed,
    supportsImageInput: model.supportsImageInput,
  }
}

function cachedNativeCodexModels(): any[] {
  if (!nativeCodexAvailable()) return []
  const snapshot = codexModelCatalog.getCachedCatalog()
  return Array.isArray(snapshot?.models) ? snapshot.models : []
}

function nativeCodexEntryFor(modelOrKey: any): any {
  if (!nativeCodexAvailable()) return null
  const raw = String(modelOrKey || '').trim()
  const models = cachedNativeCodexModels()
  if (models.length === 0) return null
  let model = null
  let forceNativeKey = false
  if (raw.startsWith(NATIVE_CODEX_MODEL_PREFIX)) {
    const id = raw.slice(NATIVE_CODEX_MODEL_PREFIX.length)
    model = models.find((candidate: any) => candidate.id === id) || null
    forceNativeKey = true
  } else if (raw === 'codex') {
    model = models.find((candidate: any) => candidate.isDefault === true) || models[0]
  } else {
    // Preserve old sessions that stored a concrete id (notably gpt-5.5): if
    // that id is still advertised, launch it rather than silently moving it.
    model = models.find((candidate: any) => candidate.id === raw) || null
    forceNativeKey = model?.isDefault !== true
    if (!model && modelKeyFor(raw) === 'codex') {
      model = models.find((candidate: any) => candidate.isDefault === true) || models[0]
    }
  }
  return nativeCodexEntry(model, { forceNativeKey })
}

function resolvedBuiltinEntryFor(modelOrKey: any): any {
  // 专用 profile/settings 始终优先；不存在时才允许 native fallback。
  return builtinEntryFor(modelOrKey) || nativeCodexEntryFor(modelOrKey) || nativeBuiltinEntryFor(modelOrKey)
}

function titleForBuiltin(key: any, opt: any): string {
  if (key === 'codex') return 'GPT-5.5'
  return opt.label
}

function subForBuiltin(key: any): string {
  if (key === 'codex') return 'Codex · 强力'
  if (key === 'opus') return 'Claude Code · 强力'
  return '内置模型'
}

function dynamicEntryFor(modelOrKey: any): any {
  // modelAccess (import * as 的命名空间) 在 tsx/CJS 下偶发为 undefined (模块解析竞争),
  // 此时直接返回 null, 不要抛 —— 抛出会冒成 unhandledRejection 终止整个 worker 进程,
  // 瞬间杀掉所有正在进行的 SSE 长连接 (浏览器侧 ERR_HTTP2_PROTOCOL_ERROR).
  if (!modelAccess || typeof modelAccess.findClaudeCodeModel !== 'function') return null
  const m = modelAccess.findClaudeCodeModel(modelOrKey)
  if (!m || !m.enabled) return null
  if (!fileExists(m.settings_path)) return null
  const useProxy = modelUseProxy(m.session_model, false)
  return {
    key: m.session_model,
    value: m.session_model,
    sessionModelValue: m.session_model,
    model: m.session_model,
    label: m.label,
    title: m.label,
    sub: 'Claude Code',
    backend: 'tmux-claude-code',
    imported: true,
    native: false,
    useProxy,
    settingsPath: m.settings_path,
    settingsFile: m.settings_file,
    settingsExists: m.settings_exists,
    codexConfigPath: null,
    codexSecretEnvKey: null,
    codexSecretValue: null,
    codexModel: null,
    claudeModel: m.claude_model,
  }
}

function dynamicCodexEntryFor(modelOrKey: any): any {
  // 同 dynamicEntryFor: modelAccess 偶发 undefined 时不抛, 返回 null.
  if (!modelAccess || typeof modelAccess.findCodexModel !== 'function') return null
  // Bare `codex` is the stable native/default key. Administrator channels are
  // persisted and selected as `codex:<letters>`, so they cannot capture it.
  if (String(modelOrKey || '').trim() === 'codex') return null
  const m = modelAccess.findCodexModel(modelOrKey, { includeSecret: true })
  if (!m || !m.enabled) return null
  if (!fileExists(m.config_path)) return null
  const useProxy = modelUseProxy(m.session_model, false)
  return {
    key: m.session_model,
    value: m.session_model,
    sessionModelValue: m.session_model,
    model: m.channel || m.key,     // 传给 --profile
    label: m.label,
    title: m.label,
    sub: 'Codex',
    backend: 'tmux-codex',
    imported: true,
    native: false,
    useProxy,
    settingsPath: null,
    codexConfigPath: m.config_path,
    codexSecretEnvKey: m.secret_env_key,
    codexSecretValue: m.secret_value,
    codexModel: m.codex_model,
    claudeModel: null,
  }
}

function dynamicHarnessEntryFor(modelOrKey: any): any {
  if (!modelAccess || typeof modelAccess.findHarnessModel !== 'function') return null
  const m = modelAccess.findHarnessModel(modelOrKey, { includeSecret: true })
  if (!m || !m.enabled || !m.secret_value) return null
  const useProxy = modelUseProxy(m.session_model, m.use_proxy === true)
  return {
    key: m.session_model,
    value: m.session_model,
    sessionModelValue: m.session_model,
    model: m.model,
    label: m.label,
    title: m.label,
    sub: 'DeepSeek Harness',
    backend: 'deepseek-harness',
    imported: true,
    native: false,
    useProxy,
    settingsPath: null,
    harnessProvider: m.provider,
    harnessBaseUrl: m.base_url,
    harnessSecretValue: m.secret_value,
    harnessMaxTokens: m.max_tokens,
    harnessRuntimeVersion: m.runtime_version,
  }
}

function resolveSessionModel(modelOrKey: any): any {
  // 1) DeepSeek Harness 使用独立前缀, 优先解析.
  const harness = dynamicHarnessEntryFor(modelOrKey)
  if (harness) return harness
  // 2) 管理员导入的 codex 模型: 优先匹配 (key 或 'codex:<key>').
  const codex = dynamicCodexEntryFor(modelOrKey)
  if (codex) return codex
  // 3) 管理员导入的 Claude Code 模型.
  const dynamic = dynamicEntryFor(modelOrKey)
  if (dynamic) return dynamic
  // 4) 内置/本机模型: 专用配置优先；codex-native:* 始终明确
  // 指向 app-server 目录项；最后才使用其它 native built-in.
  const builtin = resolvedBuiltinEntryFor(modelOrKey)
  if (builtin) return builtin
  return null
}

// 全局默认模型偏好 (管理员在"系统设置"中选择): 返回已校验"当前可用"的模型 key,
// 未设置或指向已失效模型时返回 null. 与 /api/sessions/model-options 的 option.key 同格式.
function globalDefaultModelKey(): string | null {
  const raw = adminSettings.getGlobalDefaultModel()
  if (!raw) return null
  return resolveSessionModel(raw) ? raw : null
}

function resolveSessionModelForCreate(modelOrKey: any): any {
  // 优先级: 调用方显式传入 > 全局默认模型偏好 > 内置 DEFAULT_MODEL_KEY (codex).
  // 前端新建表单已按 (草稿>项目默认>全局默认) 预填 model, 此处兜底保证 API 直调也尊重全局默认.
  return resolveSessionModel(modelOrKey || globalDefaultModelKey() || DEFAULT_MODEL_KEY)
}

function backendNameForSessionModel(modelOrKey: any): any {
  const resolved = resolveSessionModel(modelOrKey)
  if (resolved) return resolved.backend
  // 模型配置缺失 (典型场景: 管理员删除/禁用了某些会话仍在引用的导入模型).
  // 本函数用于会话列表 / 事件流 / 历史 / flag 扫描 / bridge 解析等只读热路径,
  // 不应因单个坏模型让整条列表或 SSE 流整体失败 (会回 500 / stream failed).
  // 按模型名前缀兜底选 backend; 仍无法判断时回退默认 backend.
  // 真正启动会话的 launchOptionsForSession 仍会抛错, 这里只解决"读已有会话".
  const k = String(modelOrKey || '')
  if (k.startsWith('deepseek-harness:')) return 'deepseek-harness'
  if (k.startsWith('codex:') || k.startsWith(NATIVE_CODEX_MODEL_PREFIX) || k === 'codex' || k === 'gpt-5.5') return 'tmux-codex'
  if (k.startsWith('claude-code:') || k.startsWith('claude-') || k === 'opus') return 'tmux-claude-code'
  return DEFAULT_AGENT_BACKEND
}

function labelForSessionModel(modelOrKey: any): string {
  return resolveSessionModel(modelOrKey)?.label || String(modelOrKey || '')
}

function isImportedClaudeCodeModel(modelOrKey: any): boolean {
  return !!dynamicEntryFor(modelOrKey)
}

function isImportedCodexModel(modelOrKey: any): boolean {
  return !!dynamicCodexEntryFor(modelOrKey)
}

function isImportedHarnessModel(modelOrKey: any): boolean {
  return !!dynamicHarnessEntryFor(modelOrKey)
}

function listSessionModelOptions(): any[] {
  const builtinClaudeEntries = BUILTIN_ORDER
    .filter((key) => key !== 'codex' && (MODEL_OPTIONS as Record<string, any>)[key])
    .map((key) => resolvedBuiltinEntryFor(key))
    .filter(Boolean)

  // 内置 codex 的 profileKey (默认 'mobiusdefault') 已作为兜底 seed 进 model-access 表,
  // 供管理员在"系统配置 → 模型接入 → Codex"编辑其 启用 / 显示名称.
  // 这里读回该 seed 记录, 让 picker 尊重管理员设置:
  //   - enabled=false → 内置 codex 从选择菜单隐藏 (修复"默认 codex 无法隐藏");
  //   - 自定义 label  → 覆盖内置 codex 的 label/title (修复"显示名称不起作用").
  // 该记录跟内置 codex 共享同一份 $CODEX_HOME/<profileKey>.config.toml, 仍须从 codexDynamics
  // 剔除避免重复。enabled 同时作用于 picker、resolve 和 launch，不能通过直调创建接口绕过。
  // modelAccess 偶发 undefined (tsx/CJS 模块解析竞争) 时降级为空列表, 不要抛.
  const ma = (modelAccess && typeof modelAccess.listCodexModels === 'function') ? modelAccess : null
  const builtinCodexProfileKey = (MODEL_OPTIONS.codex && MODEL_OPTIONS.codex.profileKey) || null
  const builtinCodexSeed = (ma && builtinCodexProfileKey)
    ? ma.findCodexModel(builtinCodexProfileKey)
    : null
  const codexDynamics = ma
    ? ma.listCodexModels({ enabledOnly: true })
        .map((m: any) => dynamicCodexEntryFor(m.session_model))
        .filter(Boolean)
        .filter((m: any) => !builtinCodexProfileKey || m.model !== builtinCodexProfileKey)
    : []

  // 内置 Claude (Opus) 也已作为兜底 seed 进 model-access 表, 读回该记录让 picker 尊重管理员设置:
  //   - enabled=false → 内置 Opus 从选择菜单 + 系统设置隐藏 (满足"屏蔽内置 Opus");
  //   - 自定义 label  → 覆盖内置 Opus 的 label/title.
  // 该记录跟内置 Opus 共享同一份 ~/.claude/mobiusdefault.settings.json, 须从 claudeDynamics 剔除避免重复.
  const builtinClaudeSeed = ma ? ma.findClaudeCodeModel(BUILTIN_CLAUDE_KEY) : null
  const builtinClaudeSessionModel = ma ? ma.sessionModelForKey(BUILTIN_CLAUDE_KEY) : null

  const claudeDynamics = ma
    ? ma.listClaudeCodeModels({ enabledOnly: true })
        .map((m: any) => dynamicEntryFor(m.session_model))
        .filter(Boolean)
        .filter((m: any) => !builtinClaudeSessionModel || m.key !== builtinClaudeSessionModel)
    : []

  const harnessDynamics = ma && typeof ma.listHarnessModels === 'function'
    ? ma.listHarnessModels({ enabledOnly: true })
        .map((m: any) => dynamicHarnessEntryFor(m.session_model))
        .filter(Boolean)
    : []

  const configuredBuiltinCodex = builtinEntryFor('codex')
  const nativeCodexEntries = cachedNativeCodexModels()
    .map((model: any) => nativeCodexEntry(model, { forceNativeKey: !!configuredBuiltinCodex }))
    .filter(Boolean)
  let builtinCodex = configuredBuiltinCodex
    ? [configuredBuiltinCodex, ...nativeCodexEntries]
    : nativeCodexEntries
  if (builtinCodexSeed) {
    if (builtinCodexSeed.enabled === false) {
      // 管理员在内置 codex 上取消勾选"启用" → 从选择菜单隐藏.
      builtinCodex = []
    } else {
      // 管理员自定义"显示名称"生效: 用 seed 记录的 label 覆盖内置 codex 的 label/title.
      builtinCodex = builtinCodex.map((m) => m.key === 'codex' ? ({
        ...m,
        label: builtinCodexSeed.label || m.label,
        title: builtinCodexSeed.label || m.title,
      }) : m)
    }
  }
  let builtinClaude = builtinClaudeEntries
  if (builtinClaudeSeed) {
    if (builtinClaudeSeed.enabled === false) {
      // 管理员在内置 Opus 上取消勾选"启用" → 从选择菜单 + 系统设置隐藏.
      builtinClaude = []
    } else {
      // 管理员自定义"显示名称"生效: 用 seed 记录的 label 覆盖内置 Opus 的 label/title.
      builtinClaude = builtinClaude.map((m) => ({
        ...m,
        label: builtinClaudeSeed.label || m.label,
        title: builtinClaudeSeed.label || m.title,
      }))
    }
  }

  const ordered = applyDisplayOrder([...builtinCodex, ...codexDynamics, ...harnessDynamics, ...claudeDynamics, ...builtinClaude])
  return ordered.map((m) => ({
    key: m.key,
    value: m.value,
    model: m.model,
    label: m.label,
    title: m.title,
    sub: m.sub,
    backend: m.backend,
    imported: m.imported,
    native: m.native === true,
    description: m.description || null,
    is_default: m.isDefault === true,
    reasoning_efforts_advertised: m.reasoningEffortsAdvertised === true,
    supported_reasoning_efforts: m.supportedReasoningEfforts,
    default_reasoning_effort: m.defaultReasoningEffort,
    speeds_advertised: m.speedsAdvertised === true,
    supported_speeds: m.supportedSpeeds,
    default_speed: m.defaultSpeed,
    supports_image_input: m.supportsImageInput,
    use_proxy: m.useProxy === false ? 0 : (m.useProxy === true ? 1 : null),
    codex_config_path: m.codexConfigPath || null,
    codex_channel: m.native === true ? null : (m.codexChannel || (m.backend === 'tmux-codex' ? m.model : null)),
    codex_secret_env_key: m.codexSecretEnvKey || null,
    settings_path: m.settingsPath || null,
  }))
}

function launchOptionsForSession(session: any): any {
  const resolved = resolveSessionModel(session?.model)
  if (!resolved) {
    throw new Error(`模型未配置或配置文件缺失: ${session?.model || DEFAULT_MODEL_KEY}`)
  }
  if (resolved.backend === 'deepseek-harness') {
    return {
      backend: 'deepseek-harness',
      model: resolved.model,
      harnessProvider: resolved.harnessProvider,
      harnessBaseUrl: resolved.harnessBaseUrl,
      harnessSecretValue: resolved.harnessSecretValue,
      harnessMaxTokens: resolved.harnessMaxTokens,
      harnessRuntimeVersion: resolved.harnessRuntimeVersion,
      useProxy: resolved.useProxy,
      forceNoProxy: false,
      imported: true,
      native: false,
      label: resolved.label,
    }
  }
  // 管理员导入的 codex 模型: 走 --profile + -m <codex_model> + 模型级 use_proxy.
  if (resolved.backend === 'tmux-codex' && resolved.imported) {
    return {
      backend: 'tmux-codex',
      model: resolved.codexModel,                     // 传给 -m
      codexProfileKey: resolved.model,                // 传给 --profile (= 渠道)
      codexChannel: resolved.model,
      codexConfigPath: resolved.codexConfigPath,      // 物化的 .config.toml
      codexSecretEnvKey: resolved.codexSecretEnvKey,
      codexSecretValue: resolved.codexSecretValue,
      useProxy: resolved.useProxy,                    // 每模型独立, 不再读 admin-settings
      forceNoProxy: false,
      imported: true,
      native: false,
      label: resolved.label,
    }
  }
  // 管理员导入的 Claude Code 模型: --settings + --model + 模型级 use_proxy.
  if (resolved.imported) {
    return {
      backend: resolved.backend,
      model: resolved.claudeModel,
      settingsPath: effectiveClaudeSettingsPath(resolved),
      useProxy: resolved.useProxy,
      forceNoProxy: false,
      imported: true,
      native: false,
      label: resolved.label,
    }
  }
  // 内置模型可能走 Mobius 专用配置，也可能走不带 profile/settings 的 native 模式。
  return {
    backend: resolved.backend,
    model: resolved.model,
    settingsPath: effectiveClaudeSettingsPath(resolved) || undefined,
    useProxy: resolved.useProxy,
    codexProfileKey: resolved.codexProfileKey || undefined,
    codexChannel: resolved.codexChannel || resolved.codexProfileKey || undefined,
    codexConfigPath: resolved.codexConfigPath || undefined,
    codexSecretEnvKey: resolved.codexSecretEnvKey || undefined,
    codexSecretValue: resolved.codexSecretValue || undefined,
    forceNoProxy: false,
    imported: false,
    native: resolved.native === true,
    label: resolved.label,
  }
}

const modelRegistry = {
  MODELS,
  DEFAULT_MODEL_KEY,
  listSessionModelOptions,
  resolveSessionModel,
  resolveSessionModelForCreate,
  globalDefaultModelKey,
  backendNameForSessionModel,
  labelForSessionModel,
  isImportedClaudeCodeModel,
  isImportedCodexModel,
  isImportedHarnessModel,
  launchOptionsForSession,
}

export {
  MODELS,
  DEFAULT_MODEL_KEY,
  listSessionModelOptions,
  resolveSessionModel,
  resolveSessionModelForCreate,
  globalDefaultModelKey,
  backendNameForSessionModel,
  labelForSessionModel,
  isImportedClaudeCodeModel,
  isImportedCodexModel,
  isImportedHarnessModel,
  launchOptionsForSession,
}

export default modelRegistry
