import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { MODEL_ACCESS_PATH } from '../config'
import * as modelAccess from './model-access'

const CONNECTION_PATH = process.env.BESTAPI_CONNECTION_PATH
  || `${MODEL_ACCESS_PATH}.bestapi-connection.json`
const DEPLOYED_BESTAPI_HOST = '8.130.13.45'
const DEPLOYED_BESTAPI_PORT = '3333'
const DEFAULT_BESTAPI_BASE_URL = String(
  process.env.BESTAPI_DEFAULT_BASE_URL || `https://${DEPLOYED_BESTAPI_HOST}:${DEPLOYED_BESTAPI_PORT}`,
).trim().replace(/\/+$/, '')
const REQUEST_TIMEOUT_MS = 15_000
const MAX_MODELS = 500
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,128}$/
const API_BASE_PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/
const BESTAPI_LABEL_SUFFIX = ' · BestAPI'
const AUTO_SYNC_ENABLED = !/^(0|false|no)$/i.test(process.env.BESTAPI_AUTO_SYNC_ENABLED || '')
const AUTO_SYNC_INTERVAL_MS = durationFromEnv('BESTAPI_AUTO_SYNC_INTERVAL_MS', 60_000, 30_000)
const AUTO_SYNC_INITIAL_DELAY_MS = durationFromEnv('BESTAPI_AUTO_SYNC_INITIAL_DELAY_MS', 10_000, 1_000)

function durationFromEnv(name: string, fallback: number, minimum: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback
}

type BestApiBackend = 'codex' | 'claude_code' | 'deepseek_harness'
type BestApiHarnessId = 'codex' | 'claude-code' | 'deepseek-harness'
type BestApiProtocol = 'openai_responses' | 'anthropic_messages' | 'openai_chat_completions'
type BestApiConfigProfile =
  | 'codex_responses_v1'
  | 'claude_code_messages_v1'
  | 'deepseek_harness_openai_v1'

type BestApiHarnessSpec = {
  id?: string
  backend?: string
  protocol?: string
  endpoint_path?: string
  config_profile?: string
}

type BestApiMobiusContract = {
  schema_version?: number
  preferred_harness?: string
  harnesses?: BestApiHarnessSpec[]
}

type SupportedHarnessProfile = {
  id: BestApiHarnessId
  backend: BestApiBackend
  protocol: BestApiProtocol
  endpoint_path: string
  config_profile: BestApiConfigProfile
  catalog_endpoint: 'responses' | 'messages' | 'chat_completions'
}

const SUPPORTED_HARNESS_PROFILES: Record<BestApiHarnessId, SupportedHarnessProfile> = {
  codex: {
    id: 'codex',
    backend: 'codex',
    protocol: 'openai_responses',
    endpoint_path: '/v1/responses',
    config_profile: 'codex_responses_v1',
    catalog_endpoint: 'responses',
  },
  'claude-code': {
    id: 'claude-code',
    backend: 'claude_code',
    protocol: 'anthropic_messages',
    endpoint_path: '/v1/messages',
    config_profile: 'claude_code_messages_v1',
    catalog_endpoint: 'messages',
  },
  'deepseek-harness': {
    id: 'deepseek-harness',
    backend: 'deepseek_harness',
    protocol: 'openai_chat_completions',
    endpoint_path: '/v1/chat/completions',
    config_profile: 'deepseek_harness_openai_v1',
    catalog_endpoint: 'chat_completions',
  },
}
const HARNESS_ORDER: BestApiHarnessId[] = ['codex', 'claude-code', 'deepseek-harness']

type BestApiCatalogModel = {
  id: string
  display_name?: string
  summary?: string
  endpoints?: string[]
  capabilities?: string[]
  preferred_backend?: BestApiBackend
  mobius?: BestApiMobiusContract
  limits?: { context_tokens?: number | null; max_output_tokens?: number | null }
  recommended?: boolean
}

type ManagedModel = {
  id: string
  display_name: string
  backend: BestApiBackend
  harness_id: BestApiHarnessId
  protocol: BestApiProtocol
  config_profile: BestApiConfigProfile
  supported_harnesses: BestApiHarnessId[]
  key: string
  session_model: string
  endpoints: string[]
  capabilities: string[]
}

type StoredConnection = {
  schema_version: 1
  id: 'bestapi'
  base_url: string
  api_base_url: string
  account_username: string | null
  account_display_name: string | null
  api_key: string
  key_prefix: string
  catalog_version: string | null
  integration_schema_version?: number | null
  connected_at: string
  synced_at: string
  models: ManagedModel[]
}

let autoSyncTimer: NodeJS.Timeout | null = null
let autoSyncInitialTimer: NodeJS.Timeout | null = null
let autoSyncRunning = false
let autoSyncLastCheckedAt: string | null = null
let autoSyncLastUpdatedAt: string | null = null
let autoSyncLastError: string | null = null
let autoSyncNextCheckAt: string | null = null

function safeMessage(payload: any, fallback: string): string {
  const candidate = payload?.detail?.message || payload?.detail || payload?.error?.message || payload?.error
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim().slice(0, 300) : fallback
}

export function normalizeBestApiServerUrl(value: any): string {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('请填写 BestAPI 服务地址')
  let parsed: URL
  try { parsed = new URL(raw) } catch { throw new Error('BestAPI 服务地址不是合法 URL') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('BestAPI 服务地址仅支持 http/https')
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('BestAPI 服务地址不能包含账号、查询参数或片段')
  }
  // 用户最初公布的是 http://8.130.13.45:3333，但线上 nginx 的该端口实际只
  // 接受 HTTPS。保留这个输入别名，避免用户照着公布地址填写后得到 400。
  if (
    parsed.protocol === 'http:'
    && parsed.hostname === DEPLOYED_BESTAPI_HOST
    && parsed.port === DEPLOYED_BESTAPI_PORT
  ) parsed.protocol = 'https:'
  let pathname = parsed.pathname.replace(/\/+$/, '')
  if (pathname.endsWith('/v1')) pathname = pathname.slice(0, -3)
  parsed.pathname = pathname || '/'
  return parsed.toString().replace(/\/$/, '')
}

function resolveApiBaseUrl(serverUrl: string, apiBasePath: any): string {
  const pathValue = String(apiBasePath || '/v1').trim()
  if (!API_BASE_PATH_RE.test(pathValue) || pathValue.includes('..') || pathValue.includes('//')) {
    throw new Error('BestAPI 返回了无效 API 路径')
  }
  return `${serverUrl}${pathValue}`.replace(/\/$/, '')
}

async function requestJson(url: string, init: RequestInit): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal })
    const declaredLength = Number(response.headers.get('content-length') || 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error('BestAPI 响应体过大，已拒绝处理')
    }
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {})
          throw new Error('BestAPI 响应体过大，已拒绝处理')
        }
        chunks.push(value)
      }
    }
    const raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : ''
    let payload: any = null
    try { payload = raw ? JSON.parse(raw) : null } catch {}
    if (!response.ok) throw new Error(safeMessage(payload, `BestAPI 请求失败（HTTP ${response.status}）`))
    if (!payload || typeof payload !== 'object') throw new Error('BestAPI 返回了无效响应')
    return payload
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('连接 BestAPI 超时，请检查服务地址和网络')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function alphaDigest(value: string, length = 16): string {
  const hex = crypto.createHash('sha256').update(value).digest('hex').slice(0, length)
  return hex.replace(/[0-9]/g, (digit) => String.fromCharCode(97 + Number(digit)))
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return (normalized || 'model').slice(0, 36)
}

function legacyHarnessProfiles(
  endpoints: string[],
  preferredBackend?: BestApiBackend,
): SupportedHarnessProfile[] {
  const supported = HARNESS_ORDER
    .map((harnessId) => SUPPORTED_HARNESS_PROFILES[harnessId])
    .filter((profile) => endpoints.includes(profile.catalog_endpoint))
  if (!preferredBackend) return supported
  const preferred = supported.find((profile) => profile.backend === preferredBackend)
  return preferred
    ? [preferred, ...supported.filter((profile) => profile.id !== preferred.id)]
    : supported
}

function selectHarnessProfile(
  model: BestApiCatalogModel,
  modelId: string,
  endpoints: string[],
): { selected: SupportedHarnessProfile; supported: BestApiHarnessId[] } {
  // Backward compatibility for a BestAPI server that has not yet deployed the
  // versioned Mobius contract. New servers are validated strictly below.
  if (model.mobius == null) {
    const legacy = legacyHarnessProfiles(endpoints, model.preferred_backend)
    if (!legacy.length) throw new Error(`BestAPI 模型 ${modelId} 没有 Mobius 支持的调用协议`)
    return { selected: legacy[0], supported: legacy.map((profile) => profile.id) }
  }

  const contract = model.mobius
  if (
    typeof contract !== 'object'
    || contract.schema_version !== 1
    || !Array.isArray(contract.harnesses)
    || contract.harnesses.length < 1
    || contract.harnesses.length > 8
    || typeof contract.preferred_harness !== 'string'
  ) throw new Error(`BestAPI 模型 ${modelId} 的 Mobius Harness 契约无效`)

  const supported: SupportedHarnessProfile[] = []
  const seen = new Set<string>()
  for (const raw of contract.harnesses) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || seen.has(raw.id)) {
      throw new Error(`BestAPI 模型 ${modelId} 的 Harness 列表无效`)
    }
    seen.add(raw.id)
    const expected = SUPPORTED_HARNESS_PROFILES[raw.id as BestApiHarnessId]
    // Unknown future harnesses are ignored. They can never select a local
    // template until this Mobius version explicitly adds them to the whitelist.
    if (!expected) continue
    if (
      raw.backend !== expected.backend
      || raw.protocol !== expected.protocol
      || raw.endpoint_path !== expected.endpoint_path
      || raw.config_profile !== expected.config_profile
      || !endpoints.includes(expected.catalog_endpoint)
    ) throw new Error(`BestAPI 模型 ${modelId} 的 Harness ${raw.id} 配置与 Mobius 模板不匹配`)
    supported.push(expected)
  }
  if (!supported.length) throw new Error(`BestAPI 模型 ${modelId} 没有当前 Mobius 可用的 Harness`)

  const preferred = supported.find((profile) => profile.id === contract.preferred_harness)
  const preferredIsKnown = Object.prototype.hasOwnProperty.call(
    SUPPORTED_HARNESS_PROFILES,
    contract.preferred_harness,
  )
  if (!preferred && preferredIsKnown) {
    throw new Error(`BestAPI 模型 ${modelId} 的首选 Harness 不在支持列表中`)
  }
  return {
    selected: preferred || supported[0],
    supported: supported.map((profile) => profile.id),
  }
}

export function planBestApiModel(model: BestApiCatalogModel): Omit<ManagedModel, 'session_model'> {
  const id = String(model?.id || '').trim()
  if (!MODEL_ID_RE.test(id)) throw new Error('BestAPI 模型目录包含无效模型 ID')
  if (
    !Array.isArray(model.endpoints)
    || model.endpoints.length > 16
    || !model.endpoints.every((value) => typeof value === 'string' && value.length <= 64)
  ) throw new Error(`BestAPI 模型 ${id} 的协议列表无效`)
  if (
    model.capabilities != null
    && (!Array.isArray(model.capabilities)
      || model.capabilities.length > 32
      || !model.capabilities.every((value) => typeof value === 'string' && value.length <= 64))
  ) throw new Error(`BestAPI 模型 ${id} 的能力列表无效`)
  const endpoints = [...new Set(model.endpoints)]
  const capabilities = Array.isArray(model.capabilities) ? [...new Set(model.capabilities)] : []
  const harness = selectHarnessProfile(model, id, endpoints)
  const { backend } = harness.selected
  const digest = crypto.createHash('sha256').update(id).digest('hex').slice(0, 10)
  const key = backend === 'codex'
    ? `bestapi${alphaDigest(id)}`
    : `bestapi-${slug(id)}-${digest}`
  return {
    id,
    display_name: String(model.display_name || id).trim().slice(0, 80) || id,
    backend,
    harness_id: harness.selected.id,
    protocol: harness.selected.protocol,
    config_profile: harness.selected.config_profile,
    supported_harnesses: harness.supported,
    key,
    endpoints,
    capabilities,
  }
}

function validateCatalog(payload: any): {
  models: BestApiCatalogModel[]
  version: string | null
  integrationSchemaVersion: number | null
} {
  const models = payload?.catalog?.data
  if (!Array.isArray(models)) throw new Error('BestAPI 响应缺少模型目录')
  if (models.length > MAX_MODELS) throw new Error(`BestAPI 模型数量超过 ${MAX_MODELS}，已拒绝导入`)
  const rawSchemaVersion = payload?.catalog?.meta?.integration_schema_version
  if (rawSchemaVersion != null && rawSchemaVersion !== 1) {
    throw new Error(`当前 Mobius 不支持 BestAPI Harness 契约版本 ${String(rawSchemaVersion).slice(0, 20)}`)
  }
  if (rawSchemaVersion === 1 && models.some((model: any) => model?.mobius == null)) {
    throw new Error('BestAPI 声明了 Harness 契约 v1，但部分模型缺少 Mobius 配置')
  }
  return {
    models,
    version: typeof payload?.catalog?.meta?.catalog_version === 'string'
      ? payload.catalog.meta.catalog_version
      : null,
    integrationSchemaVersion: rawSchemaVersion === 1 ? 1 : null,
  }
}

function loadStoredConnection(): StoredConnection | null {
  if (!fs.existsSync(CONNECTION_PATH)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(CONNECTION_PATH, 'utf8'))
    if (
      parsed?.schema_version !== 1
      || parsed?.id !== 'bestapi'
      || !parsed?.api_key
      || !Array.isArray(parsed?.models)
      || parsed.models.some((model: any) => !['codex', 'claude_code', 'deepseek_harness'].includes(model?.backend))
    ) return null
    return parsed as StoredConnection
  } catch {
    return null
  }
}

function saveStoredConnection(connection: StoredConnection): void {
  fs.mkdirSync(path.dirname(CONNECTION_PATH), { recursive: true })
  const tmp = `${CONNECTION_PATH}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(connection, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, CONNECTION_PATH)
  try { fs.chmodSync(CONNECTION_PATH, 0o600) } catch {}
}

function autoSyncStatus(): any {
  return {
    enabled: AUTO_SYNC_ENABLED,
    running: autoSyncRunning,
    interval_seconds: Math.round(AUTO_SYNC_INTERVAL_MS / 1000),
    last_checked_at: autoSyncLastCheckedAt,
    last_updated_at: autoSyncLastUpdatedAt,
    last_error: autoSyncLastError,
    next_check_at: autoSyncNextCheckAt,
  }
}

function recordSyncSuccess(changed: boolean): void {
  const now = new Date().toISOString()
  autoSyncLastCheckedAt = now
  if (changed) autoSyncLastUpdatedAt = now
  autoSyncLastError = null
}

function recordSyncFailure(error: any): void {
  autoSyncLastCheckedAt = new Date().toISOString()
  autoSyncLastError = String(error?.message || error || '自动同步失败').slice(0, 300)
}

function publicConnection(connection: StoredConnection | null): any {
  const integration = {
    default_base_url: DEFAULT_BESTAPI_BASE_URL,
    auto_sync: autoSyncStatus(),
  }
  if (!connection) return { connected: false, ...integration }
  const counts = { codex: 0, claude_code: 0, deepseek_harness: 0 }
  for (const model of connection.models) counts[model.backend] += 1
  return {
    connected: true,
    id: connection.id,
    base_url: connection.base_url,
    api_base_url: connection.api_base_url,
    account_username: connection.account_username,
    account_display_name: connection.account_display_name,
    key_prefix: connection.key_prefix,
    credential_set: !!connection.api_key,
    catalog_version: connection.catalog_version,
    integration_schema_version: connection.integration_schema_version ?? null,
    connected_at: connection.connected_at,
    synced_at: connection.synced_at,
    model_count: connection.models.length,
    counts,
    models: connection.models,
    ...integration,
  }
}

function codexToml(channel: string, model: string, apiBaseUrl: string, envKey: string): string {
  return [
    `model_provider = "${channel}"`,
    `model = "${model.replace(/"/g, '\\"')}"`,
    '',
    `[model_providers.${channel}]`,
    `name = "BestAPI"`,
    `base_url = "${apiBaseUrl.replace(/"/g, '\\"')}"`,
    `wire_api = "responses"`,
    `env_key = "${envKey}"`,
    `api_key = "<API_KEY>"`,
    '',
  ].join('\n')
}

function claudeSettings(model: string, apiBaseUrl: string, apiKey: string): any {
  return {
    env: {
      ANTHROPIC_BASE_URL: apiBaseUrl,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    },
    model,
  }
}

function bestApiLabel(displayName: string): string {
  return `${displayName.slice(0, 80 - BESTAPI_LABEL_SUFFIX.length)}${BESTAPI_LABEL_SUFFIX}`
}

function managedRef(model: Pick<ManagedModel, 'backend' | 'key'>): string {
  return `${model.backend}:${model.key}`
}

function findConfiguredModel(model: Pick<ManagedModel, 'backend' | 'key'>): any {
  if (model.backend === 'codex') return modelAccess.findCodexModel(model.key)
  if (model.backend === 'claude_code') return modelAccess.findClaudeCodeModel(model.key)
  return modelAccess.findHarnessModel(model.key)
}

function applyCatalog(params: {
  existing: StoredConnection | null
  baseUrl: string
  apiBaseUrl: string
  apiKey: string
  keyPrefix: string
  accountUsername: string | null
  accountDisplayName: string | null
  catalogVersion: string | null
  integrationSchemaVersion: number | null
  catalogModels: BestApiCatalogModel[]
}): StoredConnection {
  const planned = params.catalogModels.map(planBestApiModel)
  const seenIds = new Set<string>()
  const uniquePlanned: typeof planned = []
  for (const item of planned) {
    if (seenIds.has(item.id)) continue
    seenIds.add(item.id)
    uniquePlanned.push(item)
  }

  // Preflight the complete catalog before writing anything. A deterministic
  // generated key must never overwrite a model that Mobius does not own.
  const ownedRefs = new Set((params.existing?.models || []).map(managedRef))
  const plannedRefs = new Map<string, string>()
  for (const item of uniquePlanned) {
    const ref = managedRef(item)
    const previousId = plannedRefs.get(ref)
    if (previousId && previousId !== item.id) {
      throw new Error(`BestAPI 模型 ${item.id} 与 ${previousId} 生成了冲突的模型 Key`)
    }
    plannedRefs.set(ref, item.id)
    if (findConfiguredModel(item) && !ownedRefs.has(ref)) {
      throw new Error(`BestAPI 模型 ${item.id} 的自动 Key（${item.key}）与手动模型配置冲突`)
    }
  }

  const managed: ManagedModel[] = []
  const envKey = `BESTAPI_${alphaDigest(params.baseUrl, 12).toUpperCase()}_API_KEY`
  for (const item of uniquePlanned) {
    let result: any
    if (item.config_profile === 'codex_responses_v1') {
      result = modelAccess.upsertCodexModel({
        key: item.key,
        channel: item.key,
        label: bestApiLabel(item.display_name),
        codex_model: item.id,
        secret_env_key: envKey,
        secret_value: params.apiKey,
        config_toml: codexToml(item.key, item.id, params.apiBaseUrl, envKey),
        enabled: true,
        use_proxy: false,
      }, modelAccess.findCodexModel(item.key) ? { existingKey: item.key } : {})
    } else if (item.config_profile === 'claude_code_messages_v1') {
      result = modelAccess.upsertClaudeCodeModel({
        key: item.key,
        label: bestApiLabel(item.display_name),
        claude_model: item.id,
        settings_json: claudeSettings(item.id, params.apiBaseUrl, params.apiKey),
        enabled: true,
      }, modelAccess.findClaudeCodeModel(item.key) ? { existingKey: item.key } : {})
    } else if (item.config_profile === 'deepseek_harness_openai_v1') {
      result = modelAccess.upsertHarnessModel({
        key: item.key,
        label: bestApiLabel(item.display_name),
        provider: 'deepseek-official',
        model: item.id,
        base_url: params.apiBaseUrl,
        secret_value: params.apiKey,
        max_tokens: item.capabilities.includes('reasoning') ? 16384 : 8192,
        enabled: true,
        use_proxy: false,
      }, modelAccess.findHarnessModel(item.key) ? { existingKey: item.key } : {})
    } else {
      throw new Error(`BestAPI 模型 ${item.id} 使用了 Mobius 未实现的配置模板`)
    }
    managed.push({ ...item, session_model: result.session_model })
  }

  // Only remove models previously owned by this connection and no longer in the
  // remote catalog.  Manually configured models are never touched.
  const currentRefs = new Set(managed.map(managedRef))
  for (const previous of params.existing?.models || []) {
    if (currentRefs.has(managedRef(previous))) continue
    if (previous.backend === 'codex') modelAccess.deleteCodexModel(previous.key)
    else if (previous.backend === 'claude_code') modelAccess.deleteClaudeCodeModel(previous.key)
    else modelAccess.deleteHarnessModel(previous.key)
  }

  const now = new Date().toISOString()
  const connection: StoredConnection = {
    schema_version: 1,
    id: 'bestapi',
    base_url: params.baseUrl,
    api_base_url: params.apiBaseUrl,
    account_username: params.accountUsername,
    account_display_name: params.accountDisplayName,
    api_key: params.apiKey,
    key_prefix: params.keyPrefix,
    catalog_version: params.catalogVersion,
    integration_schema_version: params.integrationSchemaVersion,
    connected_at: params.existing?.connected_at || now,
    synced_at: now,
    models: managed,
  }
  saveStoredConnection(connection)
  return connection
}

export function getBestApiConnection(): any {
  return publicConnection(loadStoredConnection())
}

let mutationTail: Promise<void> = Promise.resolve()

function serializeMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(task, task)
  mutationTail = result.then(() => undefined, () => undefined)
  return result
}

async function connectBestApiInternal(input: any): Promise<any> {
  const baseUrl = normalizeBestApiServerUrl(input?.base_url ?? input?.baseUrl ?? DEFAULT_BESTAPI_BASE_URL)
  const apiKey = String(input?.api_key ?? input?.apiKey ?? '').trim()
  if (!apiKey) throw new Error('请填写 BestAPI API Key')
  if (apiKey.length > 512 || /[\r\n]/.test(apiKey)) throw new Error('BestAPI API Key 格式无效')
  const existing = loadStoredConnection()
  const payload = await requestJson(`${baseUrl}/api/integrations/mobius/catalog`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  })
  const catalog = validateCatalog(payload)
  const connection = applyCatalog({
    existing,
    baseUrl,
    apiBaseUrl: resolveApiBaseUrl(baseUrl, payload?.api_base_path),
    apiKey,
    keyPrefix: apiKey.slice(0, 11),
    accountUsername: payload?.account?.username == null ? null : String(payload.account.username).slice(0, 254),
    accountDisplayName: payload?.account?.display_name == null ? null : String(payload.account.display_name).slice(0, 80),
    catalogVersion: catalog.version,
    integrationSchemaVersion: catalog.integrationSchemaVersion,
    catalogModels: catalog.models,
  })
  recordSyncSuccess(true)
  return { ...publicConnection(connection), catalog_changed: true }
}

async function syncBestApiInternal(onlyIfCatalogChanged = false): Promise<any> {
  const existing = loadStoredConnection()
  if (!existing) throw new Error('尚未连接 BestAPI，请先填写 API Key 并同步')
  const baseUrl = normalizeBestApiServerUrl(existing.base_url)
  const payload = await requestJson(`${baseUrl}/api/integrations/mobius/catalog`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${existing.api_key}`, Accept: 'application/json' },
  })
  const catalog = validateCatalog(payload)
  const apiBaseUrl = resolveApiBaseUrl(baseUrl, payload?.api_base_path)
  const catalogChanged = !catalog.version || catalog.version !== existing.catalog_version
  const configurationChanged = catalogChanged
    || baseUrl !== existing.base_url
    || apiBaseUrl !== existing.api_base_url
  if (onlyIfCatalogChanged && !configurationChanged) {
    recordSyncSuccess(false)
    return { ...publicConnection(existing), catalog_changed: false, configuration_changed: false }
  }
  const connection = applyCatalog({
    existing,
    baseUrl,
    apiBaseUrl,
    apiKey: existing.api_key,
    keyPrefix: existing.key_prefix,
    accountUsername: payload?.account?.username == null
      ? existing.account_username
      : String(payload.account.username).slice(0, 254),
    accountDisplayName: existing.account_display_name,
    catalogVersion: catalog.version,
    integrationSchemaVersion: catalog.integrationSchemaVersion,
    catalogModels: catalog.models,
  })
  recordSyncSuccess(configurationChanged)
  return {
    ...publicConnection(connection),
    catalog_changed: catalogChanged,
    configuration_changed: configurationChanged,
  }
}

export function connectBestApi(input: any): Promise<any> {
  return serializeMutation(async () => {
    try {
      return await connectBestApiInternal(input)
    } catch (error) {
      recordSyncFailure(error)
      throw error
    }
  })
}

export function syncBestApi(): Promise<any> {
  return serializeMutation(async () => {
    try {
      return await syncBestApiInternal(false)
    } catch (error) {
      recordSyncFailure(error)
      throw error
    }
  })
}

export function runBestApiAutoSyncOnce(): Promise<any> {
  return serializeMutation(async () => {
    if (!loadStoredConnection()) {
      return { ...publicConnection(null), catalog_changed: false, skipped: 'not_connected' }
    }
    try {
      const result = await syncBestApiInternal(true)
      if (result.configuration_changed) {
        console.log(`[bestapi-auto-sync] 模型目录已更新: ${result.model_count} 个模型 (${result.catalog_version || 'no-version'})`)
      }
      return result
    } catch (error) {
      recordSyncFailure(error)
      throw error
    }
  })
}

export function stopBestApiAutoSync(): void {
  if (autoSyncInitialTimer) clearTimeout(autoSyncInitialTimer)
  if (autoSyncTimer) clearInterval(autoSyncTimer)
  autoSyncInitialTimer = null
  autoSyncTimer = null
  autoSyncRunning = false
  autoSyncNextCheckAt = null
}

export function startBestApiAutoSync(options: {
  initialDelayMs?: number
  intervalMs?: number
} = {}): (() => void) | null {
  if (!AUTO_SYNC_ENABLED) return null
  // PM2 cluster 下只允许 0 号实例写共享模型配置文件。
  if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== '0') return null
  if (autoSyncRunning) return stopBestApiAutoSync

  const initialDelayMs = Number.isFinite(options.initialDelayMs)
    ? Math.max(0, Number(options.initialDelayMs))
    : AUTO_SYNC_INITIAL_DELAY_MS
  const intervalMs = Number.isFinite(options.intervalMs)
    ? Math.max(100, Number(options.intervalMs))
    : AUTO_SYNC_INTERVAL_MS
  const run = () => {
    autoSyncNextCheckAt = new Date(Date.now() + intervalMs).toISOString()
    runBestApiAutoSyncOnce().catch((error) => {
      console.warn(`[bestapi-auto-sync] 检查失败，下个周期重试: ${String(error?.message || error).slice(0, 300)}`)
    })
  }

  autoSyncRunning = true
  autoSyncNextCheckAt = new Date(Date.now() + initialDelayMs).toISOString()
  autoSyncInitialTimer = setTimeout(() => {
    autoSyncInitialTimer = null
    run()
    autoSyncTimer = setInterval(run, intervalMs)
    autoSyncTimer.unref?.()
  }, initialDelayMs)
  autoSyncInitialTimer.unref?.()
  console.log(`[bestapi-auto-sync] 已启动: 首次 ${initialDelayMs / 1000}s 后，之后每 ${intervalMs / 1000}s 检查目录版本`)
  return stopBestApiAutoSync
}
