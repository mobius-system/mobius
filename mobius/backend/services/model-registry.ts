/**
 * model-registry.ts — Session 可选模型统一解析.
 *
 * 内置模型来自 config.js (opus/codex);
 * 管理员导入的 Claude Code 模型来自 model-access.js (settings JSON);
 * 管理员导入的 Codex 模型来自 model-access.js (per-channel TOML, --profile 加载).
 *
 * 没有明确配置文件的模型不进入系统, 也不能启动.
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
import modelAccess from './model-access'

const BUILTIN_ORDER = ['codex', 'opus']

function defaultUseProxyForBackend(backend: any): boolean {
  return false
}

function modelUseProxy(key: any, fallback: any): any {
  return adminSettings.getModelNetworkProxy(key, fallback)
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

function builtinEntryFor(modelOrKey: any): any {
  const key = modelKeyFor(modelOrKey)
  if (!key) return null
  const opt = MODEL_OPTIONS[key]
  if (!opt) return null
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
    sub: 'Claude Code · 自定义',
    backend: 'tmux-claude-code',
    imported: true,
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
    sub: useProxy ? 'Codex · 代理' : 'Codex · 自定义',
    backend: 'tmux-codex',
    imported: true,
    useProxy,
    settingsPath: null,
    codexConfigPath: m.config_path,
    codexSecretEnvKey: m.secret_env_key,
    codexSecretValue: m.secret_value,
    codexModel: m.codex_model,
    claudeModel: null,
  }
}

function resolveSessionModel(modelOrKey: any): any {
  // 1) 管理员导入的 codex 模型: 优先匹配 (key 或 'codex:<key>').
  const codex = dynamicCodexEntryFor(modelOrKey)
  if (codex) return codex
  // 2) 管理员导入的 Claude Code 模型.
  const dynamic = dynamicEntryFor(modelOrKey)
  if (dynamic) return dynamic
  // 3) 内置模型必须有明确配置文件.
  const builtin = builtinEntryFor(modelOrKey)
  if (builtin) return builtin
  return null
}

function resolveSessionModelForCreate(modelOrKey: any): any {
  return resolveSessionModel(modelOrKey || DEFAULT_MODEL_KEY)
}

function backendNameForSessionModel(modelOrKey: any): any {
  const resolved = resolveSessionModel(modelOrKey)
  if (!resolved) throw new Error(`模型未配置或配置文件缺失: ${modelOrKey || DEFAULT_MODEL_KEY}`)
  return resolved.backend
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

function listSessionModelOptions(): any[] {
  const builtins = BUILTIN_ORDER
    .filter((key) => MODEL_OPTIONS[key])
    .map((key) => builtinEntryFor(key))
    .filter(Boolean)

  // picker 顺序: [内置 codex] [管理员 codex ...] [动态 claude code] [内置 claude code]
  // 内置 codex 的 profileKey (默认 'mobiusdefault') 已作为兜底 seed 进 model-access 表,
  // 但它跟内置 codex 共享同一份 ~/.codex/<profileKey>.config.toml, 所以 picker 里要剔除,
  // 避免与内置 codex 重复显示. 该项仍可在 admin 面板编辑.
  const builtinCodexProfileKey = (MODEL_OPTIONS.codex && MODEL_OPTIONS.codex.profileKey) || null
  const codexDynamics = modelAccess.listCodexModels({ enabledOnly: true })
    .map((m) => dynamicCodexEntryFor(m.session_model))
    .filter(Boolean)
    .filter((m) => !builtinCodexProfileKey || m.model !== builtinCodexProfileKey)

  const claudeDynamics = modelAccess.listClaudeCodeModels({ enabledOnly: true })
    .map((m) => dynamicEntryFor(m.session_model))
    .filter(Boolean)

  const builtinCodex = builtins.filter((m) => m.key === 'codex')
  const builtinClaude = builtins.filter((m) => m.key !== 'codex')

  const ordered = [...builtinCodex, ...codexDynamics, ...claudeDynamics, ...builtinClaude]
  return ordered.map((m) => ({
    key: m.key,
    value: m.value,
    model: m.model,
    label: m.label,
    title: m.title,
    sub: m.sub,
    backend: m.backend,
    imported: m.imported,
    use_proxy: m.useProxy === false ? 0 : (m.useProxy === true ? 1 : null),
    codex_config_path: m.codexConfigPath || null,
    codex_channel: m.codexChannel || (m.backend === 'tmux-codex' ? m.model : null),
    codex_secret_env_key: m.codexSecretEnvKey || null,
    settings_path: m.settingsPath || null,
  }))
}

function launchOptionsForSession(session: any): any {
  const resolved = resolveSessionModel(session?.model)
  if (!resolved) {
    throw new Error(`模型未配置或配置文件缺失: ${session?.model || DEFAULT_MODEL_KEY}`)
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
      label: resolved.label,
    }
  }
  // 管理员导入的 Claude Code 模型: --settings + --model + 模型级 use_proxy.
  if (resolved.imported) {
    return {
      backend: resolved.backend,
      model: resolved.claudeModel,
      settingsPath: resolved.settingsPath,
      useProxy: resolved.useProxy,
      forceNoProxy: false,
      imported: true,
      label: resolved.label,
    }
  }
  // 内置模型也必须有明确配置文件.
  return {
    backend: resolved.backend,
    model: resolved.model,
    settingsPath: resolved.settingsPath || undefined,
    useProxy: resolved.useProxy,
    codexProfileKey: resolved.codexProfileKey || undefined,
    codexChannel: resolved.codexChannel || resolved.codexProfileKey || undefined,
    codexConfigPath: resolved.codexConfigPath || undefined,
    codexSecretEnvKey: resolved.codexSecretEnvKey || undefined,
    codexSecretValue: resolved.codexSecretValue || undefined,
    forceNoProxy: false,
    imported: false,
    label: resolved.label,
  }
}

const modelRegistry = {
  MODELS,
  DEFAULT_MODEL_KEY,
  listSessionModelOptions,
  resolveSessionModel,
  resolveSessionModelForCreate,
  backendNameForSessionModel,
  labelForSessionModel,
  isImportedClaudeCodeModel,
  isImportedCodexModel,
  launchOptionsForSession,
}

export {
  MODELS,
  DEFAULT_MODEL_KEY,
  listSessionModelOptions,
  resolveSessionModel,
  resolveSessionModelForCreate,
  backendNameForSessionModel,
  labelForSessionModel,
  isImportedClaudeCodeModel,
  isImportedCodexModel,
  launchOptionsForSession,
}

export default modelRegistry
