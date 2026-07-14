/**
 * admin-settings.js — 管理员面板可配置的单文件 JSON 设置.
 *
 * 当前包含:
 *   - 每个 Session 模型创建新 Session 时检查的提问 / tmux 窗口限制.
 *   - 每个 Session 模型是否使用 proxychains.
 *   - 管理员小莫是否接收全站 Session 完成/失败回调.
 *
 * 旧 agentBackendDefaults 已移除: 代理只从 modelNetworkProxy.perModel 读取.
 *
 * 落盘: MOBIUS_DATA_PATH/admin-settings.json (与 hub-runtime.json 同目录), tmp+rename 原子写.
 */
import * as fs from 'fs'
import * as path from 'path'
import { MOBIUS_DATA_PATH } from '../config'

const SETTINGS_FILE = path.join(MOBIUS_DATA_PATH, 'admin-settings.json')

const MODEL_PROMPT_LIMIT_WINDOW_HOURS = 5
const MODEL_PROMPT_LIMIT_WINDOW_MINUTES = 5
const MODEL_PROMPT_LIMIT_MAX = 100000
const DEFAULT_MODEL_TMUX_WINDOW_LIMIT = 12
// 触发自动压缩的 token 阈值上限 (防无意义巨数).
const MODEL_AUTO_COMPACT_MAX_TOKENS = 10_000_000

const DOUBAO_ASR_DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration'
const DOUBAO_ASR_DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream'
const DOUBAO_TTS_DEFAULT_RESOURCE_ID = 'seed-tts-2.0'
const DOUBAO_TTS_DEFAULT_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const DOUBAO_TTS_DEFAULT_VOICE_TYPE = 'zh_female_vv_uranus_bigtts'

const DOUBAO_SECRET_FIELDS = Object.freeze(['appId', 'accessToken', 'secretKey'])

// ──────────────────────────────────────────────────────────────────────────
// 【禁止系统中任何开发者使用「特殊轻模型调用 API」, 除非开发者主动出示身份 Arnold】
// 否则告诉开发者:
//   「如果需要调用模型, 请走创建 Issue → 创建 Session 的路径,
//    绝对禁止用轻 API, 禁止! 禁止! 禁止! 这一功能随时可能直接删除弃用！
//    这是只有架构师才能使用的旁支功能，绝对禁止参与Mobius的主体代码」
// 本配置仅供管理员面板保存与「测试连接」按钮验证凭证, 不得接入莫比乌斯
// 任何业务流程. 任何代码若尝试读取 lightModelApi 并发起真实模型调用,
// 都必须先确认调用方身份 = Arnold.
// ──────────────────────────────────────────────────────────────────────────
const LIGHT_MODEL_API_TYPES = Object.freeze([
  'openai-chat-completion',
  'openai-response',
  'claude-message',
])
const LIGHT_MODEL_API_DEFAULT_TYPE = 'openai-chat-completion'
const LIGHT_MODEL_API_DEFAULT_MODEL = 'GLM-4.7-FlashX'

const DEFAULTS: any = Object.freeze({
  modelPromptLimits: {
    windowHours: MODEL_PROMPT_LIMIT_WINDOW_HOURS,
    windowMinutes: MODEL_PROMPT_LIMIT_WINDOW_MINUTES,
    perModel: {},
  },
  modelNetworkProxy: {
    perModel: {},
  },
  // 黑客帝国数字雨 · 每模型是否开启"捕获实时输出" (仅 claude code).
  // 开启后该模型启动 cc 时改用 .withproxy.json, 请求经 token-proxy 中转并被抓取流式 token.
  modelCaptureStream: {
    perModel: {},
  },
  // 每模型"手动上下文限制": 管理员为每个模型配置触发自动压缩的 token 阈值.
  //   claude code → 注入 settings.json 的 env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  //   codex       → 注入 ~/.codex/<channel>.config.toml 顶层 model_auto_compact_token_limit
  // 仅当 enabled=true 且 tokenLimit>0 时才注入; 关闭/留空 → 移除该字段 (恢复模型默认 auto-compact 行为).
  modelAutoCompact: {
    perModel: {},
  },
  // 全局默认模型偏好: 管理员在"管理中心-系统设置"中选择一个模型作为系统级默认.
  // 优先级 (新建 Session / 快捷新建 / 小莫): 用户/草稿选择 > 项目级 default_model > 全局默认 > 内置 'codex'.
  // null/空串 = 未设置, 系统沿用原行为 (内置 codex / 小莫 MiniMax 启发式).
  globalDefaultModel: null,
  // 自动生成 Session 标题: 默认关闭. 开启后后端订阅 agent raw JSONL 事件,
  // 仅在收到 type='ai-title' 这类明确标题事件时更新 sessions_v2.name.
  autoGenerateSessionTitle: {
    enabled: false,
  },
  adminAssistantCallbacks: {
    enabledAdminUserIds: [],
  },
  doubaoVoice: {
    asr: {
      appId: '',
      accessToken: '',
      secretKey: '',
      resourceId: DOUBAO_ASR_DEFAULT_RESOURCE_ID,
      endpoint: DOUBAO_ASR_DEFAULT_ENDPOINT,
    },
    tts: {
      appId: '',
      accessToken: '',
      secretKey: '',
      resourceId: DOUBAO_TTS_DEFAULT_RESOURCE_ID,
      endpoint: DOUBAO_TTS_DEFAULT_ENDPOINT,
      voiceType: DOUBAO_TTS_DEFAULT_VOICE_TYPE,
    },
  },
  lightModelApi: {
    type: LIGHT_MODEL_API_DEFAULT_TYPE,
    baseUrl: '',
    apiKey: '',
    model: LIGHT_MODEL_API_DEFAULT_MODEL,
  },
  textRedaction: {
    rules: [],
    updatedAt: null,
    updatedBy: null,
  },
  // 首登引导已看标记 (per-user 字典). 替代旧 localStorage 设备隔离门禁,
  // 按用户维度持久化: 换设备/换浏览器不再重复触发首登引导. value=true 表示该用户已看过;
  // 管理员在本文件清掉某用户条目后, 该用户下次登录会重新看到首登引导.
  userFirstLoginSeen: {},
  // 场景级首触引导已看标记 (per-user × per-scene 嵌套字典). 与 userFirstLoginSeen 并行,
  // 不影响首登引导. scene 取自 SCENE_SEEN_WHITELIST (admin-center/research-page/self-cognition).
  // 结构: { [userId]: { [scene]: true } }. 清掉某用户某 scene 条目后, 该用户下次进入该场景重新触发引导.
  userSceneSeen: {},
})

// 场景级首触引导白名单 (防任意 scene 写入).
const SCENE_SEEN_WHITELIST = ['admin-center', 'research-page', 'self-cognition'] as const
function normalizeSceneForSeen(scene: any): string | null {
  const s = typeof scene === 'string' ? scene : ''
  return (SCENE_SEEN_WHITELIST as readonly string[]).includes(s) ? s : null
}

function defaultsClone(): any {
  return JSON.parse(JSON.stringify(DEFAULTS))
}

function normalizeModelLimitForRead(value: any): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.min(Math.floor(n), MODEL_PROMPT_LIMIT_MAX)
}

function normalizeModelLimitForWrite(value: any): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error('模型限额必须是非负整数, 留空表示不限')
  }
  return Math.min(Math.floor(n), MODEL_PROMPT_LIMIT_MAX)
}

function normalizeTmuxWindowLimitForRead(value: any): number {
  const n = normalizeModelLimitForRead(value)
  return n === null ? DEFAULT_MODEL_TMUX_WINDOW_LIMIT : n
}

function normalizeTmuxWindowLimitForWrite(value: any): number {
  if (value === null || value === undefined || value === '') return DEFAULT_MODEL_TMUX_WINDOW_LIMIT
  return normalizeModelLimitForWrite(value) as number
}

function normalizeModelKey(value: any): string {
  const key = String(value || '').trim()
  if (!key) throw new Error('模型 key 不能为空')
  if (key.length > 160) throw new Error('模型 key 最多 160 个字符')
  if (key.includes('\0')) throw new Error('模型 key 包含非法字符')
  return key
}

function normalizeModelLimitConfigForRead(value: any): any {
  if (typeof value === 'number' || typeof value === 'string' || value === null) {
    const migrated = normalizeModelLimitForRead(value)
    return {
      allUsers5h: null,
      allUsers5m: null,
      perUser5h: migrated,
      perUser5m: null,
      tmuxWindows: DEFAULT_MODEL_TMUX_WINDOW_LIMIT,
    }
  }
  const obj = value && typeof value === 'object' ? value : {}
  return {
    allUsers5h: normalizeModelLimitForRead(
      obj.allUsers5h ?? obj.all_users_5h ?? obj.maxPromptsPer5hAllUsers ?? obj.max_prompts_per_5h_all_users,
    ),
    allUsers5m: normalizeModelLimitForRead(
      obj.allUsers5m ?? obj.all_users_5m ?? obj.maxPromptsPer5mAllUsers ?? obj.max_prompts_per_5m_all_users,
    ),
    perUser5h: normalizeModelLimitForRead(
      obj.perUser5h ?? obj.per_user_5h ?? obj.maxPromptsPer5hPerUser ?? obj.max_prompts_per_5h_per_user
        ?? obj.maxPromptsPerWindow ?? obj.max_prompts_per_5h ?? obj.limit,
    ),
    perUser5m: normalizeModelLimitForRead(
      obj.perUser5m ?? obj.per_user_5m ?? obj.maxPromptsPer5mPerUser ?? obj.max_prompts_per_5m_per_user,
    ),
    tmuxWindows: normalizeTmuxWindowLimitForRead(
      obj.tmuxWindows ?? obj.tmux_windows ?? obj.tmuxWindowLimit ?? obj.tmux_window_limit,
    ),
  }
}

function normalizeModelLimitConfigForWrite(value: any): any {
  const obj = value && typeof value === 'object' ? value : {}
  return {
    allUsers5h: normalizeModelLimitForWrite(obj.allUsers5h ?? obj.all_users_5h),
    allUsers5m: normalizeModelLimitForWrite(obj.allUsers5m ?? obj.all_users_5m),
    perUser5h: normalizeModelLimitForWrite(obj.perUser5h ?? obj.per_user_5h),
    perUser5m: normalizeModelLimitForWrite(obj.perUser5m ?? obj.per_user_5m),
    tmuxWindows: normalizeTmuxWindowLimitForWrite(obj.tmuxWindows ?? obj.tmux_windows),
  }
}

function isDefaultModelLimitConfig(cfg: any): boolean {
  return cfg.allUsers5h === null
    && cfg.allUsers5m === null
    && cfg.perUser5h === null
    && cfg.perUser5m === null
    && cfg.tmuxWindows === DEFAULT_MODEL_TMUX_WINDOW_LIMIT
}

function normalizeModelPromptLimitsForRead(value: any): any {
  const out = {
    windowHours: MODEL_PROMPT_LIMIT_WINDOW_HOURS,
    windowMinutes: MODEL_PROMPT_LIMIT_WINDOW_MINUTES,
    perModel: {} as Record<string, any>,
  }
  const rawMap = value?.perModel || value?.models || {}
  if (rawMap && typeof rawMap === 'object') {
    for (const [rawKey, rawValue] of Object.entries(rawMap)) {
      try {
        const key = normalizeModelKey(rawKey)
        const cfg = normalizeModelLimitConfigForRead(rawValue)
        if (!isDefaultModelLimitConfig(cfg)) out.perModel[key] = cfg
      } catch {}
    }
  }
  return out
}

function normalizeModelNetworkProxyForRead(value: any): any {
  const out: { perModel: Record<string, any> } = { perModel: {} }
  const rawMap: any = value?.perModel || value?.models || {}
  if (rawMap && typeof rawMap === 'object') {
    for (const [rawKey, rawValue] of Object.entries(rawMap)) {
      try {
        const key = normalizeModelKey(rawKey)
        const value = rawValue && typeof rawValue === 'object'
          ? ((rawValue as any).useProxy ?? (rawValue as any).use_proxy)
          : rawValue
        if (typeof value === 'boolean') out.perModel[key] = value
      } catch {}
    }
  }
  return out
}

// "捕获实时输出" (数字雨) 的 perModel 布尔归一化, 结构与 modelNetworkProxy 完全一致.
function normalizeModelCaptureStreamForRead(value: any): any {
  const out: { perModel: Record<string, any> } = { perModel: {} }
  const rawMap: any = value?.perModel || value?.models || {}
  if (rawMap && typeof rawMap === 'object') {
    for (const [rawKey, rawValue] of Object.entries(rawMap)) {
      try {
        const key = normalizeModelKey(rawKey)
        const value = rawValue && typeof rawValue === 'object'
          ? ((rawValue as any).captureStream ?? (rawValue as any).capture_stream)
          : rawValue
        if (typeof value === 'boolean') out.perModel[key] = value
      } catch {}
    }
  }
  return out
}

// ── 手动上下文限制 (auto-compact token 阈值) ──────────────────────────────────
function normalizeAutoCompactTokenLimitForRead(value: any): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(Math.floor(n), MODEL_AUTO_COMPACT_MAX_TOKENS)
}

function normalizeAutoCompactTokenLimitForWrite(value: any): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('触发压缩的 Token 数量必须是正整数, 留空表示不注入')
  }
  return Math.min(Math.floor(n), MODEL_AUTO_COMPACT_MAX_TOKENS)
}

// 单条 auto-compact 配置归一化 (读取用). 兼容三种历史/简写形态:
//   boolean → { enabled: b, tokenLimit: null }
//   number  → { enabled: true, tokenLimit: n }
//   { enabled, tokenLimit } → 原样清洗
function normalizeModelAutoCompactEntryForRead(rawValue: any): { enabled: boolean; tokenLimit: number | null } {
  if (typeof rawValue === 'boolean') return { enabled: rawValue, tokenLimit: null }
  if (typeof rawValue === 'number' || typeof rawValue === 'string') {
    const t = normalizeAutoCompactTokenLimitForRead(rawValue)
    return { enabled: t !== null, tokenLimit: t }
  }
  const obj = rawValue && typeof rawValue === 'object' ? rawValue : {}
  const enabled = parseBooleanSetting(obj.enabled, false)
  const tokenLimit = normalizeAutoCompactTokenLimitForRead(
    obj.tokenLimit ?? obj.token_limit ?? obj.tokens ?? obj.limit,
  )
  return { enabled, tokenLimit }
}

// perModel 字典归一化 (读取用). 只保留 enabled=true 的条目, 关闭的视为未配置.
function normalizeModelAutoCompactForRead(value: any): any {
  const out: { perModel: Record<string, any> } = { perModel: {} }
  const rawMap: any = value?.perModel || value?.models || {}
  if (rawMap && typeof rawMap === 'object') {
    for (const [rawKey, rawValue] of Object.entries(rawMap)) {
      try {
        const key = normalizeModelKey(rawKey)
        const entry = normalizeModelAutoCompactEntryForRead(rawValue)
        if (entry.enabled) out.perModel[key] = entry
      } catch {}
    }
  }
  return out
}

// 全局默认模型偏好: 存"模型 key"字符串 (与 /api/sessions/model-options 返回的 option.key 同格式,
// 也与 projects.default_model 同格式), 或 null 表示未设置. 仅做轻量字符串清洗,
// 真实"是否为已配置模型"的校验由调用方 (admin 路由 / model-registry.resolveSessionModel) 负责.
function normalizeGlobalDefaultModelForRead(value: any): string | null {
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  if (trimmed.length > 200) return null
  if (trimmed.includes('\0')) return null
  return trimmed
}

function normalizeGlobalDefaultModelForWrite(value: any): string | null {
  if (value === null || value === undefined || value === '') return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  if (trimmed.length > 200) throw new Error('模型 key 最多 200 个字符')
  if (trimmed.includes('\0')) throw new Error('模型 key 包含非法字符')
  return trimmed
}

function parseBooleanSetting(value: any, fallback: boolean = false): boolean {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const normalized = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on', 'enabled', '启用', '开启', '是'].includes(normalized)) return true
  if (['false', '0', 'no', 'off', 'disabled', '停用', '禁用', '关闭', '否'].includes(normalized)) return false
  return fallback
}

function normalizeAutoGenerateSessionTitleForRead(value: any): any {
  const obj = value && typeof value === 'object' ? value : { enabled: value }
  return {
    enabled: parseBooleanSetting(obj.enabled ?? obj.autoGenerateSessionTitle ?? obj.auto_generate_session_title, false),
  }
}

function normalizeAutoGenerateSessionTitleForWrite(value: any): any {
  const obj = value && typeof value === 'object' ? value : { enabled: value }
  const raw = obj.enabled ?? obj.autoGenerateSessionTitle ?? obj.auto_generate_session_title
  if (typeof raw !== 'boolean') {
    throw new Error(`enabled 必须是 boolean, 收到: ${typeof raw}`)
  }
  return { enabled: raw }
}

function normalizeUserId(value: any): string {
  const id = String(value || '').trim()
  if (!id) throw new Error('用户 ID 不能为空')
  if (id.length > 64) throw new Error('用户 ID 最多 64 个字符')
  if (id.includes('\0')) throw new Error('用户 ID 包含非法字符')
  return id
}

function normalizeAdminAssistantCallbacksForRead(value: any): any {
  const rawIds = Array.isArray(value?.enabledAdminUserIds)
    ? value.enabledAdminUserIds
    : (Array.isArray(value?.enabled_admin_user_ids) ? value.enabled_admin_user_ids : [])
  const ids: string[] = []
  const seen = new Set()
  for (const rawId of rawIds) {
    try {
      const id = normalizeUserId(rawId)
      if (!seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    } catch {}
  }
  ids.sort()
  return { enabledAdminUserIds: ids }
}

function normalizeDoubaoString(value: any, maxLength: number = 512): string {
  const trimmed = String(value ?? '').trim()
  if (trimmed.length > maxLength) {
    throw new Error(`字段长度不能超过 ${maxLength} 个字符`)
  }
  if (trimmed.includes('\0')) throw new Error('字段包含非法字符')
  return trimmed
}

function normalizeDoubaoEndpoint(value: any, expectedProtocol: string): string {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return ''
  const re = expectedProtocol === 'wss'
    ? /^wss:\/\/[^\s"'`]+/i
    : /^https:\/\/[^\s"'`]+/i
  if (!re.test(trimmed)) {
    throw new Error(`endpoint 必须以 ${expectedProtocol}:// 开头`)
  }
  if (trimmed.length > 1024) throw new Error('endpoint 过长')
  return trimmed
}

function normalizeDoubaoVoiceSubForRead(value: any, defaults: any): any {
  const obj = value && typeof value === 'object' ? value : {}
  return {
    appId: String(obj.appId ?? obj.app_id ?? '').trim(),
    accessToken: String(obj.accessToken ?? obj.access_token ?? '').trim(),
    secretKey: String(obj.secretKey ?? obj.secret_key ?? '').trim(),
    resourceId: String(obj.resourceId ?? obj.resource_id ?? '').trim() || defaults.resourceId,
    endpoint: String(obj.endpoint ?? '').trim() || defaults.endpoint,
    ...(defaults.voiceType !== undefined
      ? { voiceType: String(obj.voiceType ?? obj.voice_type ?? '').trim() || defaults.voiceType }
      : {}),
  }
}

function normalizeDoubaoVoiceSubForWrite(value: any, defaults: any, expectedProtocol: string): any {
  const obj = value && typeof value === 'object' ? value : {}
  const out: any = {
    appId: normalizeDoubaoString(obj.appId ?? obj.app_id ?? ''),
    accessToken: normalizeDoubaoString(obj.accessToken ?? obj.access_token ?? ''),
    secretKey: normalizeDoubaoString(obj.secretKey ?? obj.secret_key ?? ''),
    resourceId: normalizeDoubaoString(obj.resourceId ?? obj.resource_id ?? '') || defaults.resourceId,
    endpoint: normalizeDoubaoEndpoint(obj.endpoint ?? '', expectedProtocol) || defaults.endpoint,
  }
  if (defaults.voiceType !== undefined) {
    out.voiceType = normalizeDoubaoString(obj.voiceType ?? obj.voice_type ?? '') || defaults.voiceType
  }
  return out
}

function normalizeDoubaoVoiceForRead(value: any): any {
  const obj = value && typeof value === 'object' ? value : {}
  return {
    asr: normalizeDoubaoVoiceSubForRead(obj.asr, DEFAULTS.doubaoVoice.asr),
    tts: normalizeDoubaoVoiceSubForRead(obj.tts, DEFAULTS.doubaoVoice.tts),
  }
}

function maskSecret(value: any): any {
  const str = String(value ?? '')
  if (!str) return { isSet: false, preview: '' }
  const last = str.slice(-4)
  return { isSet: true, preview: `••••${last}` }
}

function maskDoubaoVoiceSub(sub: any): any {
  const out: any = {}
  for (const [key, value] of Object.entries(sub)) {
    if (DOUBAO_SECRET_FIELDS.includes(key)) {
      out[key] = maskSecret(value)
    } else {
      out[key] = value
    }
  }
  return out
}

function maskDoubaoVoice(value: any): any {
  const normalized = normalizeDoubaoVoiceForRead(value)
  return {
    asr: maskDoubaoVoiceSub(normalized.asr),
    tts: maskDoubaoVoiceSub(normalized.tts),
  }
}

function normalizeLightModelApiType(value: any): string {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return LIGHT_MODEL_API_DEFAULT_TYPE
  if (LIGHT_MODEL_API_TYPES.includes(trimmed)) return trimmed
  throw new Error(`type 必须是 ${LIGHT_MODEL_API_TYPES.join(' / ')} 中的一个`)
}

function normalizeLightModelApiBaseUrl(value: any): string {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return ''
  if (trimmed.length > 1024) throw new Error('base_url 长度不能超过 1024 个字符')
  if (!/^https?:\/\/[^\s"'`]+/i.test(trimmed)) {
    throw new Error('base_url 必须以 http:// 或 https:// 开头')
  }
  if (trimmed.includes('\0')) throw new Error('base_url 包含非法字符')
  return trimmed
}

function normalizeLightModelApiKeyValue(value: any): string {
  const trimmed = String(value ?? '').trim()
  if (trimmed.length > 512) throw new Error('api_key 长度不能超过 512 个字符')
  if (trimmed.includes('\0')) throw new Error('api_key 包含非法字符')
  return trimmed
}

function normalizeLightModelApiModel(value: any): string {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) return LIGHT_MODEL_API_DEFAULT_MODEL
  if (trimmed.length > 200) throw new Error('model 长度不能超过 200 个字符')
  if (trimmed.includes('\0')) throw new Error('model 包含非法字符')
  return trimmed
}

const TEXT_REDACTION_MAX_RULES = 500
const TEXT_REDACTION_MAX_KEYWORD_LEN = 200
const TEXT_REDACTION_MAX_REPLACEMENT_LEN = 200

function parseTextRedactionEnabled(value: any): boolean {
  if (value === null || value === undefined || value === '') return true
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const normalized = String(value).trim().toLowerCase()
  if (['false', '0', 'no', 'off', 'disabled', '停用', '禁用', '否'].includes(normalized)) return false
  return true
}

function normalizeTextRedactionRule(value: any, index: number): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keyword = String(value.keyword ?? '').trim()
  if (!keyword) return null
  if (keyword.length > TEXT_REDACTION_MAX_KEYWORD_LEN) {
    throw new Error(`关键词长度不能超过 ${TEXT_REDACTION_MAX_KEYWORD_LEN} 个字符`)
  }
  if (keyword.includes('\0')) throw new Error('关键词包含非法字符')
  const replacement = String(value.replacement ?? '').slice(0, TEXT_REDACTION_MAX_REPLACEMENT_LEN)
  if (replacement.includes('\0')) throw new Error('替换词包含非法字符')
  const id = typeof value.id === 'string' && value.id.trim()
    ? value.id.trim().slice(0, 64)
    : `rule-${index}`
  return { id, keyword, replacement, enabled: parseTextRedactionEnabled(value.enabled) }
}

function normalizeTextRedactionRulesForRead(value: any): any[] {
  if (!Array.isArray(value)) return []
  const out = []
  for (let i = 0; i < value.length && out.length < TEXT_REDACTION_MAX_RULES; i += 1) {
    try {
      const rule = normalizeTextRedactionRule(value[i], i)
      if (rule) out.push(rule)
    } catch {}
  }
  return out
}

function normalizeTextRedactionRulesForWrite(value: any): any[] {
  if (!Array.isArray(value)) throw new Error('rules 必须是数组')
  if (value.length > TEXT_REDACTION_MAX_RULES) {
    throw new Error(`规则数量不能超过 ${TEXT_REDACTION_MAX_RULES} 条`)
  }
  const out = []
  const seenIds = new Set()
  for (let i = 0; i < value.length; i += 1) {
    const rule = normalizeTextRedactionRule(value[i], i)
    if (!rule) continue
    if (seenIds.has(rule.id)) rule.id = `rule-${i}`
    seenIds.add(rule.id)
    out.push(rule)
  }
  return out
}

function normalizeTextRedactionForRead(value: any): any {
  const obj = value && typeof value === 'object' ? value : {}
  return {
    rules: normalizeTextRedactionRulesForRead(obj.rules),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt
      : (typeof obj.updated_at === 'string' ? obj.updated_at : null),
    updatedBy: typeof obj.updatedBy === 'string' ? obj.updatedBy
      : (typeof obj.updated_by === 'string' ? obj.updated_by : null),
  }
}

// 首登引导已看标记 (per-user). 只保留 value=true 的条目, key 经 normalizeUserId 清洗.
function normalizeUserFirstLoginSeenForRead(value: any): Record<string, true> {
  const out: Record<string, true> = {}
  const obj = value && typeof value === 'object' ? value : {}
  for (const [rawKey, rawValue] of Object.entries(obj)) {
    try {
      const id = normalizeUserId(rawKey)
      if (rawValue === true || rawValue === 1 || rawValue === 'true') out[id] = true
    } catch {}
  }
  return out
}

// 场景级首触引导已看标记 (per-user × per-scene). 只保留白名单 scene 且 value=true 的条目.
function normalizeUserSceneSeenForRead(value: any): Record<string, Record<string, true>> {
  const out: Record<string, Record<string, true>> = {}
  const obj = value && typeof value === 'object' ? value : {}
  for (const [rawUser, rawScenes] of Object.entries(obj)) {
    try {
      const id = normalizeUserId(rawUser)
      const scenes = rawScenes && typeof rawScenes === 'object' ? rawScenes : {}
      const cleaned: Record<string, true> = {}
      for (const [rawScene, rawValue] of Object.entries(scenes)) {
        const scene = normalizeSceneForSeen(rawScene)
        if (scene && (rawValue === true || rawValue === 1 || rawValue === 'true')) cleaned[scene] = true
      }
      if (Object.keys(cleaned).length > 0) out[id] = cleaned
    } catch {}
  }
  return out
}

function normalizeLightModelApiForRead(value: any): any {
  const obj = value && typeof value === 'object' ? value : {}
  return {
    type: normalizeLightModelApiType(obj.type),
    baseUrl: normalizeLightModelApiBaseUrl(obj.baseUrl ?? obj.base_url),
    apiKey: normalizeLightModelApiKeyValue(obj.apiKey ?? obj.api_key),
    model: normalizeLightModelApiModel(obj.model),
  }
}

function maskLightModelApi(value: any): any {
  const normalized = normalizeLightModelApiForRead(value)
  return {
    type: normalized.type,
    baseUrl: normalized.baseUrl,
    apiKey: maskSecret(normalized.apiKey),
    model: normalized.model,
  }
}

function writeSettings(next: any): void {
  const dir = path.dirname(SETTINGS_FILE)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${SETTINGS_FILE}.imac-tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, SETTINGS_FILE)
}

function loadSettings(): any {
  if (!fs.existsSync(SETTINGS_FILE)) return defaultsClone()
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    const merged = defaultsClone()
    if (parsed && typeof parsed === 'object' && parsed.modelPromptLimits) {
      merged.modelPromptLimits = normalizeModelPromptLimitsForRead(parsed.modelPromptLimits)
    }
    if (parsed && typeof parsed === 'object' && parsed.modelNetworkProxy) {
      merged.modelNetworkProxy = normalizeModelNetworkProxyForRead(parsed.modelNetworkProxy)
    }
    if (parsed && typeof parsed === 'object' && parsed.modelCaptureStream) {
      merged.modelCaptureStream = normalizeModelCaptureStreamForRead(parsed.modelCaptureStream)
    }
    if (parsed && typeof parsed === 'object' && parsed.modelAutoCompact) {
      merged.modelAutoCompact = normalizeModelAutoCompactForRead(parsed.modelAutoCompact)
    }
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'globalDefaultModel')) {
      merged.globalDefaultModel = normalizeGlobalDefaultModelForRead((parsed as any).globalDefaultModel)
    }
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'autoGenerateSessionTitle')) {
      merged.autoGenerateSessionTitle = normalizeAutoGenerateSessionTitleForRead((parsed as any).autoGenerateSessionTitle)
    }
    if (parsed && typeof parsed === 'object' && parsed.adminAssistantCallbacks) {
      merged.adminAssistantCallbacks = normalizeAdminAssistantCallbacksForRead(parsed.adminAssistantCallbacks)
    }
    if (parsed && typeof parsed === 'object' && parsed.doubaoVoice) {
      merged.doubaoVoice = normalizeDoubaoVoiceForRead(parsed.doubaoVoice)
    }
    if (parsed && typeof parsed === 'object' && parsed.lightModelApi) {
      merged.lightModelApi = normalizeLightModelApiForRead(parsed.lightModelApi)
    }
    if (parsed && typeof parsed === 'object' && parsed.textRedaction) {
      merged.textRedaction = normalizeTextRedactionForRead(parsed.textRedaction)
    }
    if (parsed && typeof parsed === 'object' && parsed.userFirstLoginSeen) {
      merged.userFirstLoginSeen = normalizeUserFirstLoginSeenForRead(parsed.userFirstLoginSeen)
    }
    if (parsed && typeof parsed === 'object' && parsed.userSceneSeen) {
      merged.userSceneSeen = normalizeUserSceneSeenForRead(parsed.userSceneSeen)
    }
    return merged
  } catch (e) {
    console.warn(`[admin-settings] 读取失败, 回退默认值: ${e.message}`)
    return defaultsClone()
  }
}

function getModelPromptLimits(): any {
  return loadSettings().modelPromptLimits
}

function getModelPromptLimit(modelKey: any): number | null {
  const key = normalizeModelKey(modelKey)
  const limits = getModelPromptLimits()
  return Object.prototype.hasOwnProperty.call(limits.perModel, key) ? limits.perModel[key].perUser5h : null
}

function getModelPromptLimitConfig(modelKey: any): any {
  const key = normalizeModelKey(modelKey)
  const limits = getModelPromptLimits()
  return Object.prototype.hasOwnProperty.call(limits.perModel, key)
    ? normalizeModelLimitConfigForRead(limits.perModel[key])
    : normalizeModelLimitConfigForRead({})
}

function getModelNetworkProxy(modelKey: any, fallback: boolean = false): boolean {
  const key = normalizeModelKey(modelKey)
  const proxy = loadSettings().modelNetworkProxy || normalizeModelNetworkProxyForRead({})
  return Object.prototype.hasOwnProperty.call(proxy.perModel || {}, key)
    ? proxy.perModel[key] === true
    : !!fallback
}

function setModelNetworkProxy(modelKey: any, value: any): any {
  const key = normalizeModelKey(modelKey)
  if (typeof value !== 'boolean') {
    throw new Error(`useProxy 必须是 boolean, 收到: ${typeof value}`)
  }
  const next = loadSettings()
  if (!next.modelNetworkProxy) next.modelNetworkProxy = normalizeModelNetworkProxyForRead({})
  if (!next.modelNetworkProxy.perModel || typeof next.modelNetworkProxy.perModel !== 'object') {
    next.modelNetworkProxy.perModel = {}
  }
  next.modelNetworkProxy.perModel[key] = value
  writeSettings(next)
  return next.modelNetworkProxy
}

function getModelCaptureStream(modelKey: any, fallback: boolean = false): boolean {
  const key = normalizeModelKey(modelKey)
  const cap = loadSettings().modelCaptureStream || normalizeModelCaptureStreamForRead({})
  return Object.prototype.hasOwnProperty.call(cap.perModel || {}, key)
    ? cap.perModel[key] === true
    : !!fallback
}

function setModelCaptureStream(modelKey: any, value: any): any {
  const key = normalizeModelKey(modelKey)
  if (typeof value !== 'boolean') {
    throw new Error(`captureStream 必须是 boolean, 收到: ${typeof value}`)
  }
  const next = loadSettings()
  if (!next.modelCaptureStream) next.modelCaptureStream = normalizeModelCaptureStreamForRead({})
  if (!next.modelCaptureStream.perModel || typeof next.modelCaptureStream.perModel !== 'object') {
    next.modelCaptureStream.perModel = {}
  }
  next.modelCaptureStream.perModel[key] = value
  writeSettings(next)
  return next.modelCaptureStream
}

// 手动上下文限制: 读取某模型的 { enabled, tokenLimit }. 未配置返回 { enabled:false, tokenLimit:null }.
function getModelAutoCompact(modelKey: any): { enabled: boolean; tokenLimit: number | null } {
  const key = normalizeModelKey(modelKey)
  const cap = loadSettings().modelAutoCompact || normalizeModelAutoCompactForRead({})
  if (Object.prototype.hasOwnProperty.call(cap.perModel || {}, key)) {
    return normalizeModelAutoCompactEntryForRead(cap.perModel[key])
  }
  return { enabled: false, tokenLimit: null }
}

// 设置/清除某模型的手动上下文限制. value 形态: { enabled: boolean, tokenLimit?: number|null }.
// enabled=false → 删除条目 (并由调用方负责移除 settings/toml 里的字段).
// enabled=true 且 tokenLimit 为空 → 仅记 enabled=true, 不注入 tokenLimit (调用方据此跳过注入).
function setModelAutoCompact(modelKey: any, value: any): { enabled: boolean; tokenLimit: number | null } {
  const key = normalizeModelKey(modelKey)
  const obj = value && typeof value === 'object' ? value : { enabled: value }
  const enabled = parseBooleanSetting(obj.enabled ?? obj.autoCompact ?? obj.auto_compact, false)
  // 仅在开启时校验/清洗 tokenLimit; 关闭时直接丢弃, 避免旧值残留.
  const tokenLimit = enabled
    ? normalizeAutoCompactTokenLimitForWrite(obj.tokenLimit ?? obj.token_limit ?? obj.tokens ?? obj.limit)
    : null
  const next = loadSettings()
  if (!next.modelAutoCompact) next.modelAutoCompact = normalizeModelAutoCompactForRead({})
  if (!next.modelAutoCompact.perModel || typeof next.modelAutoCompact.perModel !== 'object') {
    next.modelAutoCompact.perModel = {}
  }
  if (enabled) next.modelAutoCompact.perModel[key] = { enabled: true, tokenLimit }
  else delete next.modelAutoCompact.perModel[key]
  writeSettings(next)
  return normalizeModelAutoCompactEntryForRead(next.modelAutoCompact.perModel[key] || { enabled: false, tokenLimit: null })
}

// 全局默认模型偏好: 返回已清洗的模型 key, 未设置返回 null.
function getGlobalDefaultModel(): string | null {
  return normalizeGlobalDefaultModelForRead(loadSettings().globalDefaultModel)
}

// 设置/清除全局默认模型偏好. value 为模型 key 字符串或 null/空串 (清除).
// 是否为真实已配置模型的校验由调用方负责 (admin 路由用 modelRegistry.resolveSessionModel 校验).
function setGlobalDefaultModel(value: any): string | null {
  const normalized = normalizeGlobalDefaultModelForWrite(value)
  const next = loadSettings()
  next.globalDefaultModel = normalized
  writeSettings(next)
  return next.globalDefaultModel
}

function getAutoGenerateSessionTitle(): any {
  return normalizeAutoGenerateSessionTitleForRead(loadSettings().autoGenerateSessionTitle)
}

function isAutoGenerateSessionTitleEnabled(): boolean {
  return getAutoGenerateSessionTitle().enabled === true
}

function setAutoGenerateSessionTitle(value: any): any {
  const normalized = normalizeAutoGenerateSessionTitleForWrite(value)
  const next = loadSettings()
  next.autoGenerateSessionTitle = normalized
  writeSettings(next)
  return next.autoGenerateSessionTitle
}

function setModelPromptLimit(modelKey: any, value: any): any {
  const key = normalizeModelKey(modelKey)
  const limit = normalizeModelLimitForWrite(value)
  const current = getModelPromptLimitConfig(key)
  return setModelPromptLimitConfig(key, { ...current, perUser5h: limit })
}

function setModelPromptLimitConfig(modelKey: any, value: any): any {
  const key = normalizeModelKey(modelKey)
  const cfg = normalizeModelLimitConfigForWrite(value)
  const next = loadSettings()
  if (!next.modelPromptLimits) next.modelPromptLimits = normalizeModelPromptLimitsForRead({})
  next.modelPromptLimits.windowHours = MODEL_PROMPT_LIMIT_WINDOW_HOURS
  next.modelPromptLimits.windowMinutes = MODEL_PROMPT_LIMIT_WINDOW_MINUTES
  if (!next.modelPromptLimits.perModel || typeof next.modelPromptLimits.perModel !== 'object') {
    next.modelPromptLimits.perModel = {}
  }
  if (isDefaultModelLimitConfig(cfg)) delete next.modelPromptLimits.perModel[key]
  else next.modelPromptLimits.perModel[key] = cfg
  writeSettings(next)
  return next.modelPromptLimits
}

function getAdminAssistantCallbacks(): any {
  return loadSettings().adminAssistantCallbacks
}

function listAdminAssistantCallbackUserIds(): string[] {
  return getAdminAssistantCallbacks().enabledAdminUserIds.slice()
}

function getAdminAssistantCallbackForUser(userId: any): any {
  const id = normalizeUserId(userId)
  return {
    enabled: listAdminAssistantCallbackUserIds().includes(id),
  }
}

function setAdminAssistantCallbackForUser(userId: any, enabled: any): any {
  const id = normalizeUserId(userId)
  if (typeof enabled !== 'boolean') {
    throw new Error(`enabled 必须是 boolean, 收到: ${typeof enabled}`)
  }
  const next = loadSettings()
  const callbacks = normalizeAdminAssistantCallbacksForRead(next.adminAssistantCallbacks)
  const ids = new Set(callbacks.enabledAdminUserIds)
  if (enabled) ids.add(id)
  else ids.delete(id)
  next.adminAssistantCallbacks = { enabledAdminUserIds: Array.from(ids).sort() }
  writeSettings(next)
  return getAdminAssistantCallbackForUser(id)
}

function getDoubaoVoice(): any {
  return loadSettings().doubaoVoice
}

function getDoubaoVoiceMasked(): any {
  return maskDoubaoVoice(loadSettings().doubaoVoice)
}

function setDoubaoVoiceAsr(payload: any): any {
  const next = loadSettings()
  const current = normalizeDoubaoVoiceForRead(next.doubaoVoice).asr
  const merged = { ...current, ...normalizeDoubaoVoiceSubForWrite(payload, DEFAULTS.doubaoVoice.asr, 'wss') }
  if (!next.doubaoVoice || typeof next.doubaoVoice !== 'object') next.doubaoVoice = normalizeDoubaoVoiceForRead({})
  next.doubaoVoice.asr = merged
  writeSettings(next)
  return maskDoubaoVoiceSub(next.doubaoVoice.asr)
}

function setDoubaoVoiceTts(payload: any): any {
  const next = loadSettings()
  const current = normalizeDoubaoVoiceForRead(next.doubaoVoice).tts
  const merged = { ...current, ...normalizeDoubaoVoiceSubForWrite(payload, DEFAULTS.doubaoVoice.tts, 'https') }
  if (!next.doubaoVoice || typeof next.doubaoVoice !== 'object') next.doubaoVoice = normalizeDoubaoVoiceForRead({})
  next.doubaoVoice.tts = merged
  writeSettings(next)
  return maskDoubaoVoiceSub(next.doubaoVoice.tts)
}

function getLightModelApi(): any {
  return loadSettings().lightModelApi
}

function getLightModelApiMasked(): any {
  return maskLightModelApi(loadSettings().lightModelApi)
}

// 【禁止任何开发者使用轻 API — 仅架构师 Arnold 可调用, 见文件顶部告示】
function setLightModelApi(payload: any): any {
  const obj = payload && typeof payload === 'object' ? payload : {}
  const next = loadSettings()
  const current = normalizeLightModelApiForRead(next.lightModelApi)
  const merged = {
    type: obj.type !== undefined ? normalizeLightModelApiType(obj.type) : current.type,
    baseUrl: obj.baseUrl !== undefined || obj.base_url !== undefined
      ? normalizeLightModelApiBaseUrl(obj.baseUrl ?? obj.base_url)
      : current.baseUrl,
    apiKey: obj.apiKey !== undefined || obj.api_key !== undefined
      ? normalizeLightModelApiKeyValue(obj.apiKey ?? obj.api_key)
      : current.apiKey,
    model: obj.model !== undefined ? normalizeLightModelApiModel(obj.model) : current.model,
  }
  next.lightModelApi = merged
  writeSettings(next)
  return maskLightModelApi(next.lightModelApi)
}

function getTextRedactionGlobal(): any {
  return normalizeTextRedactionForRead(loadSettings().textRedaction)
}

function setTextRedactionGlobal({ rules, adminUserId }: any): any {
  const next = loadSettings()
  next.textRedaction = {
    rules: normalizeTextRedactionRulesForWrite(rules || []),
    updatedAt: new Date().toISOString(),
    updatedBy: adminUserId || null,
  }
  writeSettings(next)
  return normalizeTextRedactionForRead(next.textRedaction)
}

// 首登引导是否已看过 (按用户维度持久化, 跨设备生效). 仅普通 auth 的 profile 路由使用,
// 不复用 admin 接口逻辑, 避免污染 admin 权限模型.
function getUserFirstLoginSeen(userId: any): boolean {
  const id = normalizeUserId(userId)
  const map = loadSettings().userFirstLoginSeen || {}
  return map[id] === true
}

// 标记某用户已看过首登引导. 只置 true, 不提供清除 (清除由管理员直接编辑本文件实现).
function setUserFirstLoginSeen(userId: any): void {
  const id = normalizeUserId(userId)
  const next = loadSettings()
  if (!next.userFirstLoginSeen || typeof next.userFirstLoginSeen !== 'object') {
    next.userFirstLoginSeen = {}
  }
  next.userFirstLoginSeen[id] = true
  writeSettings(next)
}

// 场景级首触引导: 某用户是否已看过某场景引导 (按用户×场景维度持久化, 跨设备生效).
// scene 必须在白名单内, 否则一律返回 false (视为未看过).
function getUserSceneSeen(userId: any, scene: any): boolean {
  const id = normalizeUserId(userId)
  const sceneKey = normalizeSceneForSeen(scene)
  if (!sceneKey) return false
  const map = loadSettings().userSceneSeen || {}
  return map[id]?.[sceneKey] === true
}

// 标记某用户已看过某场景引导. scene 不在白名单则忽略. 只置 true, 不提供清除.
function markUserSceneSeen(userId: any, scene: any): void {
  const id = normalizeUserId(userId)
  const sceneKey = normalizeSceneForSeen(scene)
  if (!sceneKey) return
  const next = loadSettings()
  if (!next.userSceneSeen || typeof next.userSceneSeen !== 'object') {
    next.userSceneSeen = {}
  }
  if (!next.userSceneSeen[id] || typeof next.userSceneSeen[id] !== 'object') {
    next.userSceneSeen[id] = {}
  }
  next.userSceneSeen[id][sceneKey] = true
  writeSettings(next)
}

const adminSettings = {
  MODEL_PROMPT_LIMIT_WINDOW_HOURS,
  MODEL_PROMPT_LIMIT_WINDOW_MINUTES,
  DEFAULT_MODEL_TMUX_WINDOW_LIMIT,
  LIGHT_MODEL_API_TYPES,
  LIGHT_MODEL_API_DEFAULT_TYPE,
  loadSettings,
  getModelPromptLimits,
  getModelPromptLimit,
  getModelPromptLimitConfig,
  setModelPromptLimit,
  setModelPromptLimitConfig,
  getModelNetworkProxy,
  setModelNetworkProxy,
  getModelCaptureStream,
  setModelCaptureStream,
  getModelAutoCompact,
  setModelAutoCompact,
  getGlobalDefaultModel,
  setGlobalDefaultModel,
  getAutoGenerateSessionTitle,
  isAutoGenerateSessionTitleEnabled,
  setAutoGenerateSessionTitle,
  getAdminAssistantCallbacks,
  listAdminAssistantCallbackUserIds,
  getAdminAssistantCallbackForUser,
  setAdminAssistantCallbackForUser,
  getDoubaoVoice,
  getDoubaoVoiceMasked,
  setDoubaoVoiceAsr,
  setDoubaoVoiceTts,
  getLightModelApi,
  getLightModelApiMasked,
  setLightModelApi,
  getTextRedactionGlobal,
  setTextRedactionGlobal,
  getUserFirstLoginSeen,
  setUserFirstLoginSeen,
  getUserSceneSeen,
  markUserSceneSeen,
}

export {
  MODEL_PROMPT_LIMIT_WINDOW_HOURS,
  MODEL_PROMPT_LIMIT_WINDOW_MINUTES,
  DEFAULT_MODEL_TMUX_WINDOW_LIMIT,
  LIGHT_MODEL_API_TYPES,
  LIGHT_MODEL_API_DEFAULT_TYPE,
  loadSettings,
  getModelPromptLimits,
  getModelPromptLimit,
  getModelPromptLimitConfig,
  setModelPromptLimit,
  setModelPromptLimitConfig,
  getModelNetworkProxy,
  setModelNetworkProxy,
  getModelCaptureStream,
  setModelCaptureStream,
  getModelAutoCompact,
  setModelAutoCompact,
  getGlobalDefaultModel,
  setGlobalDefaultModel,
  getAutoGenerateSessionTitle,
  isAutoGenerateSessionTitleEnabled,
  setAutoGenerateSessionTitle,
  getAdminAssistantCallbacks,
  listAdminAssistantCallbackUserIds,
  getAdminAssistantCallbackForUser,
  setAdminAssistantCallbackForUser,
  getDoubaoVoice,
  getDoubaoVoiceMasked,
  setDoubaoVoiceAsr,
  setDoubaoVoiceTts,
  getLightModelApi,
  getLightModelApiMasked,
  setLightModelApi,
  getTextRedactionGlobal,
  setTextRedactionGlobal,
  getUserFirstLoginSeen,
  setUserFirstLoginSeen,
  getUserSceneSeen,
  markUserSceneSeen,
}

export default adminSettings
