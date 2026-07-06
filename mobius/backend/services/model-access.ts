/**
 * model-access.ts — 管理员导入模型配置 (Claude Code + Codex).
 *
 * Claude Code: settings JSON 原样写入 ~/.claude/settings-<key>.json
 * Codex: TOML 配置原样写入 ~/.codex/<channel>.config.toml (codex --profile 会加载它);
 *        API key 不写 auth.json, 启动 tmux 时由 tmux-codex export env_key 对应的环境变量.
 *
 * 管理员写入的 Codex 秘钥值仅用于启动时 export, 普通用户只读启用后的模型选项.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { MODEL_ACCESS_PATH, MODEL_OPTIONS, TOKEN_PROXY_BASE_URL } from '../config'
import { encodeProxyToken } from '../token-proxy/encoding'
import adminSettings from './admin-settings'

const DATA_FILE = MODEL_ACCESS_PATH
const HOME = os.homedir()
const CLAUDE_DIR = path.join(HOME, '.claude')
const CODEX_DIR = path.join(HOME, '.codex')
const SESSION_MODEL_PREFIX = 'claude-code:'
const SESSION_MODEL_PREFIX_CODEX = 'codex:'
// Codex 渠道就是 --profile 的 plain name, 业务约束为纯英文字母.
const CODEX_CHANNEL_RE = /^[A-Za-z]+$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function nowIso(): string {
  return new Date().toISOString()
}

function defaultData(): { claudeCodeModels: any[]; codexModels: any[] } {
  return { claudeCodeModels: [], codexModels: [] }
}

function clone(obj: any): any {
  return JSON.parse(JSON.stringify(obj))
}

function normalizeKey(value: any): string {
  const key = String(value || '').trim()
  if (!key) throw new Error('模型 Key 不能为空')
  return key
}

function normalizeCodexChannel(value: any): string {
  const key = normalizeKey(value)
  if (key.length > 80) throw new Error('Codex 渠道最多 80 个字符')
  if (!CODEX_CHANNEL_RE.test(key)) {
    throw new Error('Codex 渠道只能包含英文字母, 例如 mobiusdefault')
  }
  return key
}

function normalizeSecretEnvKey(value: any): string {
  const key = normalizeKey(value)
  if (key.length > 120) throw new Error('秘钥名最多 120 个字符')
  if (!ENV_KEY_RE.test(key)) {
    throw new Error('秘钥名必须是合法环境变量名, 例如 RIGHTCODE_API_KEY')
  }
  return key
}

function normalizeSecretValue(value: any): string {
  const secret = String(value || '').trim()
  if (!secret) throw new Error('秘钥值不能为空')
  return secret
}

function settingsFilenameForKey(key: string): string {
  return `settings-${encodeURIComponent(normalizeKey(key))}.json`
}

function sessionModelForKey(key: string): string {
  return `${SESSION_MODEL_PREFIX}${normalizeKey(key)}`
}

function keyFromSessionModel(model: any): string | null {
  const s = String(model || '').trim()
  if (!s.startsWith(SESSION_MODEL_PREFIX)) return null
  try { return normalizeKey(s.slice(SESSION_MODEL_PREFIX.length)) }
  catch { return null }
}

function settingsPathForKey(key: string): string {
  return path.join(CLAUDE_DIR, settingsFilenameForKey(key))
}

function displaySettingsPathForKey(key: string): string {
  return `~/.claude/${settingsFilenameForKey(key)}`
}

function codexConfigFilenameForKey(key: string): string {
  return `${normalizeCodexChannel(key)}.config.toml`
}

function codexConfigPathForKey(key: string): string {
  return path.join(CODEX_DIR, codexConfigFilenameForKey(key))
}

function displayCodexConfigPathForKey(key: string): string {
  return `~/.codex/${codexConfigFilenameForKey(key)}`
}

function sessionModelForCodexKey(key: string): string {
  return `${SESSION_MODEL_PREFIX_CODEX}${normalizeCodexChannel(key)}`
}

function keyFromCodexSessionModel(model: any): string | null {
  const s = String(model || '').trim()
  if (!s.startsWith(SESSION_MODEL_PREFIX_CODEX)) return null
  try { return normalizeCodexChannel(s.slice(SESSION_MODEL_PREFIX_CODEX.length)) }
  catch { return null }
}

function parseSettingsJson(settingsJson: any): any {
  const text = typeof settingsJson === 'string'
    ? settingsJson
    : JSON.stringify(settingsJson || {}, null, 2)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`settings JSON 非法: ${e.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('settings JSON 必须是对象')
  }
  return parsed
}

function inferClaudeModel(input: any, parsedSettings: any, key: string): string {
  const explicit = String(input?.claude_model || input?.claudeModel || '').trim()
  const fromModel = typeof parsedSettings?.model === 'string' ? parsedSettings.model.trim() : ''
  const fromEnv = typeof parsedSettings?.env?.ANTHROPIC_MODEL === 'string' ? parsedSettings.env.ANTHROPIC_MODEL.trim() : ''
  const model = explicit || fromModel || fromEnv
  if (!model) throw new Error(`请填写 Claude 模型名, 或在 settings JSON 中设置 model / env.ANTHROPIC_MODEL (${key})`)
  return model
}

function inferCodexModel(input: any, key: string): string {
  const explicit = String(input?.codex_model || input?.codexModel || '').trim()
  if (!explicit) throw new Error(`请填写 Codex 模型名 (${key})`)
  return explicit
}

function normalizeConfigToml(text: any): string {
  if (text == null) return ''
  const t = String(text)
  if (!t.trim()) throw new Error('config_toml 不能为空')
  return t.endsWith('\n') ? t : `${t}\n`
}

function envKeyFromConfigToml(tomlText: any): string {
  const match = String(tomlText || '').match(/(?:^|\n)\s*env_key\s*=\s*(['"])([^'"]+)\1/)
  return match ? match[2].trim() : ''
}

function apiKeyFromConfigToml(tomlText: any): string {
  const match = String(tomlText || '').match(/(?:^|\n)\s*api_key\s*=\s*(['"])([^'"]+)\1/)
  return match ? match[2].trim() : ''
}

// 顶层 `model = "..."` 字段 (不能匹配 [model_providers.xxx] 段, 也不匹配 model_reasoning_effort).
function modelFromCodexToml(tomlText: any): string {
  const match = String(tomlText || '').match(/(?:^|\n)\s*model\s*=\s*(['"])([^'"]+)\1/)
  return match ? match[2].trim() : ''
}

function assertConfigEnvKeyMatches(tomlText: any, secretEnvKey: string, key: string): void {
  const envKey = envKeyFromConfigToml(tomlText)
  if (!envKey) return
  if (envKey !== secretEnvKey) {
    throw new Error(`config_toml 的 env_key (${envKey}) 必须和秘钥名 (${secretEnvKey}) 一致`)
  }
  if (!apiKeyFromConfigToml(tomlText)) {
    throw new Error(`config_toml 必须包含 api_key (${key})`)
  }
}

function normalizeLabel(value: any, fallback: string): string {
  const label = String(value || '').trim() || fallback
  if (label.length > 80) throw new Error('显示名称最多 80 个字符')
  return label
}

function loadData(): { claudeCodeModels: any[]; codexModels: any[] } {
  if (!fs.existsSync(DATA_FILE)) return defaultData()
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const data = defaultData()
    const rows = Array.isArray(parsed?.claudeCodeModels) ? parsed.claudeCodeModels : []
    for (const row of rows) {
      try {
        const key = normalizeKey(row.key)
        data.claudeCodeModels.push({
          key,
          label: normalizeLabel(row.label, key),
          claude_model: String(row.claude_model || row.claudeModel || '').trim(),
          settings_file: displaySettingsPathForKey(key),
          enabled: row.enabled !== false,
          imported: true,
          backend: 'tmux-claude-code',
          use_proxy: false,
          created_at: row.created_at || nowIso(),
          updated_at: row.updated_at || row.created_at || nowIso(),
        })
      } catch (e) {
        console.warn(`[model-access] 跳过非法模型配置: ${e.message}`)
      }
    }
    const codexRows = Array.isArray(parsed?.codexModels) ? parsed.codexModels : []
    for (const row of codexRows) {
      try {
        const key = normalizeCodexChannel(row.channel || row.key)
        data.codexModels.push({
          key,
          channel: key,
          label: normalizeLabel(row.label, key),
          codex_model: String(row.codex_model || row.codexModel || '').trim(),
          secret_env_key: String(row.secret_env_key || row.secretEnvKey || row.env_key || row.envKey || '').trim(),
          secret_value: String(row.secret_value || row.secretValue || '').trim(),
          config_file: displayCodexConfigPathForKey(key),
          enabled: row.enabled !== false,
          use_proxy: row.use_proxy === true,
          imported: true,
          backend: 'tmux-codex',
          created_at: row.created_at || nowIso(),
          updated_at: row.updated_at || row.created_at || nowIso(),
        })
      } catch (e) {
        console.warn(`[model-access] 跳过非法 codex 模型配置: ${e.message}`)
      }
    }
    seedBuiltinCodexIfNeeded(data)
    return data
  } catch (e) {
    console.warn(`[model-access] 读取失败, 回退空配置: ${e.message}`)
    return defaultData()
  }
}

// 把内置 codex (短键 'codex', profileKey 默认 'mobiusdefault') seed 进 codexModels 表,
// 这样前端 "系统配置 → 模型接入 → Codex" 就能列出并编辑这一条.
// 仅在表里缺该 key 且 $CODEX_HOME/<profileKey>.config.toml 存在时执行; 解析后立即落盘,
// 后续读取直接从 JSON 走, 不会再触发 seed. seed 失败 (TOML 缺字段) 只 warn, 不抛.
function seedBuiltinCodexIfNeeded(data: { claudeCodeModels: any[]; codexModels: any[] }): void {
  const builtin = MODEL_OPTIONS && MODEL_OPTIONS.codex
  if (!builtin || !builtin.profileKey) return
  const key = builtin.profileKey
  if (data.codexModels.some((m) => m.key === key)) return
  const configPath = codexConfigPathForKey(key)
  if (!fs.existsSync(configPath)) return
  const toml = readCodexConfigToml(key)
  if (!toml.trim()) return
  const codexModel = modelFromCodexToml(toml) || builtin.id || 'gpt-5.5'
  const secretEnvKey = envKeyFromConfigToml(toml) || builtin.secretEnvKey || ''
  const secretValue = apiKeyFromConfigToml(toml) || ''
  const now = nowIso()
  data.codexModels.push({
    key,
    channel: key,
    label: builtin.label || `GPT-5.5 (${key})`,
    codex_model: codexModel,
    secret_env_key: secretEnvKey,
    secret_value: secretValue,
    config_file: displayCodexConfigPathForKey(key),
    enabled: true,
    use_proxy: false,
    imported: true,
    backend: 'tmux-codex',
    created_at: now,
    updated_at: now,
  })
  data.codexModels.sort((a, b) => a.key.localeCompare(b.key))
  try {
    saveData(data)
    console.log(`[model-access] seeded builtin codex channel '${key}' from ${configPath}`)
  } catch (e) {
    console.warn(`[model-access] seed builtin codex 落盘失败 (${key}): ${e.message}`)
  }
}

function saveData(data: any): void {
  const dir = path.dirname(DATA_FILE)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${DATA_FILE}.imac-tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, DATA_FILE)
}

function readSettingsJson(key: string): string {
  const file = settingsPathForKey(key)
  if (!fs.existsSync(file)) return '{}'
  return fs.readFileSync(file, 'utf8')
}

function writeSettingsJson(key: string, parsedSettings: any): string {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true })
  const file = settingsPathForKey(key)
  const tmp = `${file}.imac-tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(parsedSettings, null, 2))
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch {}
  return file
}

// ── 黑客帝国数字雨 · .withproxy.json 生成 ─────────────────────────────────
// 把一份原始 settings 克隆成"走 token-proxy"的变体: BASE_URL 指向本机 token-proxy,
// AUTH_TOKEN 替换成 mpx1.<编码整个原始 settings> (server.ts 解码后还原真实上游).
// 用户要求: 保存开关时把原 settings-<key>.json 复制成 settings-<key>.withproxy.json.
// 按 settings 路径操作 (而非 key), 对导入模型和内置 claude 模型 (mobiusdefault) 都通用.
function withProxyPathFor(settingsPath: string): string {
  return String(settingsPath || '').replace(/\.json$/, '.withproxy.json')
}

function writeJsonPrivate(filePath: string, obj: any): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.imac-tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, filePath)
  try { fs.chmodSync(filePath, 0o600) } catch {}
}

function ensureWithProxyForSettingsPath(settingsPath: string): string {
  const src = String(settingsPath || '').trim()
  if (!src) throw new Error('settings 路径为空, 无法生成 withproxy 变体')
  let original: any = { env: {} }
  if (fs.existsSync(src)) {
    try {
      original = JSON.parse(fs.readFileSync(src, 'utf8')) || { env: {} }
    } catch {
      original = { env: {} }
    }
  }
  let cloned: any = JSON.parse(JSON.stringify(original))
  if (!cloned || typeof cloned !== 'object') cloned = {}
  if (!cloned.env || typeof cloned.env !== 'object') cloned.env = {}
  // 用"原始 settings"编码进 token —— server.ts 依赖它还原真实 BASE_URL + AUTH_TOKEN.
  cloned.env.ANTHROPIC_BASE_URL = TOKEN_PROXY_BASE_URL
  cloned.env.ANTHROPIC_AUTH_TOKEN = encodeProxyToken(original)
  // 显式删掉 ANTHROPIC_API_KEY (若存在), 避免 cc 同时发 x-api-key 与编码 bearer 造成歧义.
  delete cloned.env.ANTHROPIC_API_KEY
  const out = withProxyPathFor(src)
  writeJsonPrivate(out, cloned)
  return out
}

function removeWithProxyForSettingsPath(settingsPath: string): boolean {
  const out = withProxyPathFor(String(settingsPath || ''))
  try {
    if (fs.existsSync(out)) { fs.unlinkSync(out); return true }
  } catch (e) {
    console.warn(`[model-access] 删除 withproxy 失败 (${out}): ${e.message}`)
  }
  return false
}

// ── 手动上下文限制 · 注入 settings.json / codex toml ─────────────────────────
// 管理员在"系统设置 → 模型创建限制"为每个模型配置触发自动压缩的 token 阈值.
//   claude code → settings-<key>.json 的 env.CLAUDE_CODE_AUTO_COMPACT_WINDOW (字符串值)
//   codex       → ~/.codex/<channel>.config.toml 顶层 model_auto_compact_token_limit (字符串值)
// 仅当 enabled && tokenLimit>0 时注入; 否则移除该字段. 文件不存在 / 解析失败 → 静默跳过返回 false.
function applyAutoCompactToClaudeSettings(settingsPath: any, enabled: any, tokenLimit: any): boolean {
  const src = String(settingsPath || '').trim()
  if (!src) return false
  if (!fs.existsSync(src)) return false
  let parsed: any = {}
  try {
    parsed = JSON.parse(fs.readFileSync(src, 'utf8')) || {}
  } catch {
    parsed = {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {}
  const inject = enabled === true && Number(tokenLimit) > 0
  if (inject) {
    if (!parsed.env || typeof parsed.env !== 'object') parsed.env = {}
    parsed.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Number(tokenLimit))
  } else if (parsed.env && typeof parsed.env === 'object') {
    delete parsed.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  }
  writeJsonPrivate(src, parsed)
  // 若该模型同时开启"捕获实时输出", cc 实际加载 .withproxy.json (本文件的克隆);
  // 需重新克隆让 auto-compact 字段同步进 withproxy, 否则压缩阈值不生效.
  const withProxy = withProxyPathFor(src)
  if (fs.existsSync(withProxy)) {
    try {
      ensureWithProxyForSettingsPath(src)
    } catch (e) {
      console.warn(`[model-access] 同步 auto-compact 到 withproxy 失败 (${withProxy}): ${(e as Error).message}`)
    }
  }
  return true
}

// codex toml 顶层 model_auto_compact_token_limit 行级增删.
// 不解析整个 toml (保留用户注释/格式), 只动顶层这一行; [section] 内的同名字段不动.
function applyAutoCompactToCodexConfig(codexKey: any, enabled: any, tokenLimit: any): boolean {
  let key: string
  try { key = normalizeCodexChannel(codexKey) } catch { return false }
  const file = codexConfigPathForKey(key)
  if (!fs.existsSync(file)) return false
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split(/\r?\n/)
  // 第一个 [section] 行之前为顶层区; model_auto_compact_token_limit 必须放顶层.
  let sectionStart = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) { sectionStart = i; break }
  }
  let existingIdx = -1
  for (let i = 0; i < sectionStart; i += 1) {
    if (/^\s*model_auto_compact_token_limit\s*=/.test(lines[i])) { existingIdx = i; break }
  }
  const inject = enabled === true && Number(tokenLimit) > 0
  if (inject) {
    const newLine = `model_auto_compact_token_limit = "${String(Number(tokenLimit))}"`
    if (existingIdx >= 0) lines[existingIdx] = newLine
    else lines.splice(sectionStart, 0, newLine)
  } else {
    if (existingIdx < 0) return false  // 无字段可删, 视为无变更.
    lines.splice(existingIdx, 1)
  }
  let next = lines.join('\n')
  if (!next.endsWith('\n')) next += '\n'
  writeCodexConfigToml(key, next)
  return true
}

function readCodexConfigToml(key: string): string {
  const file = codexConfigPathForKey(key)
  if (!fs.existsSync(file)) return ''
  return fs.readFileSync(file, 'utf8')
}

function writeCodexConfigToml(key: string, tomlText: string): string {
  fs.mkdirSync(CODEX_DIR, { recursive: true })
  const file = codexConfigPathForKey(key)
  const tmp = `${file}.imac-tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, tomlText)
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch {}
  return file
}

function publicModel(row: any, { includeSettings = false }: any = {}): any {
  const key = normalizeKey(row.key)
  const settingsPath = settingsPathForKey(key)
  const out: any = {
    key,
    session_model: sessionModelForKey(key),
    label: row.label,
    claude_model: row.claude_model,
    settings_file: displaySettingsPathForKey(key),
    settings_path: settingsPath,
    settings_exists: fs.existsSync(settingsPath),
    enabled: row.enabled !== false,
    imported: true,
    backend: 'tmux-claude-code',
    use_proxy: false,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  }
  if (includeSettings) out.settings_json = readSettingsJson(key)
  return out
}

function listClaudeCodeModels({ enabledOnly = false, includeSettings = false }: any = {}): any[] {
  const rows = loadData().claudeCodeModels
  return rows
    .filter((row) => !enabledOnly || row.enabled !== false)
    .map((row) => publicModel(row, { includeSettings }))
}

function findClaudeCodeModel(keyOrSessionModel: any, opts: any = {}): any {
  let key
  try {
    key = keyFromSessionModel(keyOrSessionModel) || normalizeKey(keyOrSessionModel)
  } catch {
    return null
  }
  const row = loadData().claudeCodeModels.find((m) => m.key === key)
  return row ? publicModel(row, opts) : null
}

function upsertClaudeCodeModel(input: any, { existingKey = null }: any = {}): any {
  const key = existingKey ? normalizeKey(existingKey) : normalizeKey(input?.key)
  const data = loadData()
  const idx = data.claudeCodeModels.findIndex((m) => m.key === key)
  const existing = idx >= 0 ? data.claudeCodeModels[idx] : null
  const hasSettings = Object.prototype.hasOwnProperty.call(input || {}, 'settings_json')
    || Object.prototype.hasOwnProperty.call(input || {}, 'settingsJson')
    || Object.prototype.hasOwnProperty.call(input || {}, 'settings')
  const settingsJson = input?.settings_json ?? input?.settingsJson ?? input?.settings
  const parsedSettings = hasSettings ? parseSettingsJson(settingsJson) : parseSettingsJson(readSettingsJson(key))
  const next = {
    key,
    label: normalizeLabel(input?.label ?? input?.name ?? existing?.label, key),
    claude_model: inferClaudeModel(input, parsedSettings, key),
    settings_file: displaySettingsPathForKey(key),
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : (existing?.enabled ?? true),
    imported: true,
    backend: 'tmux-claude-code',
    use_proxy: false,
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
  }
  writeSettingsJson(key, parsedSettings)
  // 用户编辑模型 settings 会覆盖整个文件, 重新应用管理员配置的 auto-compact (若开启), 防字段丢失.
  try {
    const ac = adminSettings.getModelAutoCompact(sessionModelForKey(key))
    if (ac.enabled) applyAutoCompactToClaudeSettings(settingsPathForKey(key), ac.enabled, ac.tokenLimit)
  } catch (e) {
    console.warn(`[model-access] upsert 后重应用 auto-compact 失败 (${key}): ${(e as Error).message}`)
  }
  if (idx >= 0) data.claudeCodeModels[idx] = next
  else data.claudeCodeModels.push(next)
  data.claudeCodeModels.sort((a, b) => a.key.localeCompare(b.key))
  saveData(data)
  return publicModel(next, { includeSettings: true })
}

function deleteClaudeCodeModel(keyOrSessionModel: any): boolean {
  const key = keyFromSessionModel(keyOrSessionModel) || normalizeKey(keyOrSessionModel)
  const data = loadData()
  const before = data.claudeCodeModels.length
  data.claudeCodeModels = data.claudeCodeModels.filter((m) => m.key !== key)
  if (data.claudeCodeModels.length === before) return false
  saveData(data)
  const file = settingsPathForKey(key)
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch (e) {
    console.warn(`[model-access] 删除 settings 文件失败 (${file}): ${e.message}`)
  }
  return true
}

// ── Codex 模型 CRUD ───────────────────────────────────────────────────────

function publicCodexModel(row: any, { includeConfig = false, includeSecret = false }: any = {}): any {
  const key = normalizeCodexChannel(row.channel || row.key)
  const configPath = codexConfigPathForKey(key)
  const out: any = {
    key,
    channel: key,
    session_model: sessionModelForCodexKey(key),
    label: row.label,
    codex_model: row.codex_model,
    secret_env_key: row.secret_env_key || '',
    secret_value_set: !!row.secret_value,
    config_file: displayCodexConfigPathForKey(key),
    config_path: configPath,
    config_exists: fs.existsSync(configPath),
    enabled: row.enabled !== false,
    use_proxy: row.use_proxy === true,
    imported: true,
    backend: 'tmux-codex',
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  }
  if (includeConfig) out.config_toml = readCodexConfigToml(key)
  if (includeSecret) out.secret_value = row.secret_value || ''
  return out
}

function listCodexModels({ enabledOnly = false, includeConfig = false, includeSecret = false }: any = {}): any[] {
  return loadData().codexModels
    .filter((row) => !enabledOnly || row.enabled !== false)
    .map((row) => publicCodexModel(row, { includeConfig, includeSecret }))
}

function findCodexModel(keyOrSessionModel: any, opts: any = {}): any {
  let key
  try {
    key = keyFromCodexSessionModel(keyOrSessionModel) || normalizeCodexChannel(keyOrSessionModel)
  } catch {
    return null
  }
  const row = loadData().codexModels.find((m) => m.key === key)
  return row ? publicCodexModel(row, opts) : null
}

function upsertCodexModel(input: any, { existingKey = null }: any = {}): any {
  const key = existingKey
    ? normalizeCodexChannel(existingKey)
    : normalizeCodexChannel(input?.channel ?? input?.key)
  const data = loadData()
  const idx = data.codexModels.findIndex((m) => m.key === key)
  const existing = idx >= 0 ? data.codexModels[idx] : null
  const hasSecretValue = Object.prototype.hasOwnProperty.call(input || {}, 'secret_value')
    || Object.prototype.hasOwnProperty.call(input || {}, 'secretValue')
  const rawSecretValue = input?.secret_value ?? input?.secretValue
  const hasConfig = Object.prototype.hasOwnProperty.call(input || {}, 'config_toml')
    || Object.prototype.hasOwnProperty.call(input || {}, 'configToml')
  const configText = input?.config_toml ?? input?.configToml
  const toml = hasConfig ? normalizeConfigToml(configText) : readCodexConfigToml(key)
  if (!toml.trim()) throw new Error(`config_toml 不能为空, 请填写 TOML 配置 (${key})`)
  const configEnvKey = envKeyFromConfigToml(toml)
  const secretEnvKey = configEnvKey
    ? normalizeSecretEnvKey(input?.secret_env_key ?? input?.secretEnvKey ?? input?.env_key ?? input?.envKey ?? existing?.secret_env_key ?? configEnvKey)
    : ''
  assertConfigEnvKeyMatches(toml, secretEnvKey, key)
  const configApiKey = apiKeyFromConfigToml(toml)
  const secretValue = hasSecretValue && String(rawSecretValue || '').trim()
    ? normalizeSecretValue(rawSecretValue)
    : (configApiKey || existing?.secret_value || '')
  if (configEnvKey && !secretValue) throw new Error(`请填写秘钥值或在 config_toml 中填写 api_key (${secretEnvKey})`)
  const next = {
    key,
    channel: key,
    label: normalizeLabel(input?.label ?? input?.name ?? existing?.label, key),
    codex_model: inferCodexModel(input, key),
    secret_env_key: secretEnvKey,
    secret_value: secretValue,
    config_file: displayCodexConfigPathForKey(key),
    enabled: typeof input?.enabled === 'boolean' ? input.enabled : (existing?.enabled ?? true),
    use_proxy: typeof input?.use_proxy === 'boolean'
      ? input.use_proxy
      : (typeof input?.useProxy === 'boolean' ? input.useProxy : (existing?.use_proxy ?? false)),
    imported: true,
    backend: 'tmux-codex',
    created_at: existing?.created_at || nowIso(),
    updated_at: nowIso(),
  }
  writeCodexConfigToml(key, toml)
  // 用户编辑 codex config 会覆盖整个 toml, 重新应用管理员配置的 auto-compact (若开启), 防字段丢失.
  try {
    const ac = adminSettings.getModelAutoCompact(sessionModelForCodexKey(key))
    if (ac.enabled) applyAutoCompactToCodexConfig(key, ac.enabled, ac.tokenLimit)
  } catch (e) {
    console.warn(`[model-access] upsert codex 后重应用 auto-compact 失败 (${key}): ${(e as Error).message}`)
  }
  if (idx >= 0) data.codexModels[idx] = next
  else data.codexModels.push(next)
  data.codexModels.sort((a, b) => a.key.localeCompare(b.key))
  saveData(data)
  return publicCodexModel(next, { includeConfig: true })
}

function deleteCodexModel(keyOrSessionModel: any): boolean {
  const key = keyFromCodexSessionModel(keyOrSessionModel) || normalizeCodexChannel(keyOrSessionModel)
  const data = loadData()
  const before = data.codexModels.length
  data.codexModels = data.codexModels.filter((m) => m.key !== key)
  if (data.codexModels.length === before) return false
  saveData(data)
  const file = codexConfigPathForKey(key)
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch (e) {
    console.warn(`[model-access] 删除 codex config 文件失败 (${file}): ${e.message}`)
  }
  return true
}

// Codex 模型不再自动 seed: picker 里的 Codex 默认项由 ``listSessionModelOptions``
// 中的内置 ``codex`` 兜底; 管理员自定义 Codex 模型走管理中心的 Codex tab.

export {
  SESSION_MODEL_PREFIX,
  SESSION_MODEL_PREFIX_CODEX,
  listClaudeCodeModels,
  findClaudeCodeModel,
  upsertClaudeCodeModel,
  deleteClaudeCodeModel,
  sessionModelForKey,
  keyFromSessionModel,
  settingsPathForKey,
  withProxyPathFor,
  ensureWithProxyForSettingsPath,
  removeWithProxyForSettingsPath,
  applyAutoCompactToClaudeSettings,
  applyAutoCompactToCodexConfig,
  listCodexModels,
  findCodexModel,
  upsertCodexModel,
  deleteCodexModel,
  sessionModelForCodexKey,
  keyFromCodexSessionModel,
  codexConfigPathForKey,
  displayCodexConfigPathForKey,
}
