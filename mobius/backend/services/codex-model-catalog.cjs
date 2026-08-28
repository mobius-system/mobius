/**
 * Bounded, read-only Codex model discovery through `codex app-server`.
 *
 * This module never reads Codex config/auth files. It launches the absolute
 * executable and environment already resolved by provider-cli-detection, then
 * performs the JSONL RPC handshake in the required order:
 * initialize -> initialized -> model/list({ limit: 200 }).
 */
const childProcess = require('child_process')
const path = require('path')
const providerCliDetection = require('./provider-cli-detection.cjs')

const SOURCE_APP_SERVER = 'codex-app-server'
const SOURCE_LAST_KNOWN_GOOD = 'last-known-good'
const SOURCE_COMPATIBILITY_FALLBACK = 'compatibility-fallback'
const COMPATIBILITY_MODEL_ID = 'gpt-5.5'

const DEFAULT_TTL_MS = 5 * 60 * 1000
const DEFAULT_ERROR_TTL_MS = 5 * 1000
const DEFAULT_TIMEOUT_MS = 5 * 1000
const DEFAULT_STOP_TIMEOUT_MS = 150
const DEFAULT_MAX_STDOUT_BYTES = 512 * 1024
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024
const DEFAULT_MAX_LINE_BYTES = 256 * 1024
const DEFAULT_MAX_MODELS = 200
const MAX_ID_LENGTH = 128
const MAX_LABEL_LENGTH = 160
const MAX_DESCRIPTION_LENGTH = 1000
const SAFE_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/

class CatalogError extends Error {
  constructor(code) {
    super(code)
    this.name = 'CatalogError'
    this.code = code
  }
}

function safeText(value, maxLength) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f-\u009f]/u.test(text)) return ''
  return text
}

function safeModelId(value) {
  const id = safeText(value, MAX_ID_LENGTH)
  return id && SAFE_MODEL_ID_RE.test(id) ? id : ''
}

function firstSafeText(object, keys, maxLength) {
  for (const key of keys) {
    const value = safeText(object?.[key], maxLength)
    if (value) return value
  }
  return ''
}

function firstBoolean(object, keys) {
  for (const key of keys) {
    if (typeof object?.[key] === 'boolean') return object[key]
  }
  return undefined
}

function normalizeCapabilityOptions(value, kind) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const raw of value.slice(0, 32)) {
    let option
    if (typeof raw === 'string') {
      option = { value: safeText(raw, 64) }
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const valueKeys = kind === 'reasoning'
        ? ['reasoningEffort', 'reasoning_effort', 'effort', 'value', 'id']
        : ['id', 'value', 'tier']
      option = {
        value: firstSafeText(raw, valueKeys, 64),
        label: firstSafeText(raw, ['label', 'name'], 120) || undefined,
        description: firstSafeText(raw, ['description'], 500) || undefined,
      }
      if (kind === 'reasoning') {
        const isDefault = firstBoolean(raw, ['isDefault', 'is_default', 'default'])
        if (isDefault !== undefined) option.isDefault = isDefault
      }
    } else {
      continue
    }
    if (!option.value || !/^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,63}$/.test(option.value)) continue
    if (seen.has(option.value)) continue
    seen.add(option.value)
    out.push(option)
  }
  return out
}

function advertisedValue(object, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object || {}, key)) {
      return { advertised: true, value: object[key] }
    }
  }
  return { advertised: false, value: undefined }
}

function normalizeSpeed(value) {
  const raw = safeText(value, 64)
  if (!raw || raw === 'default' || raw === 'standard') return 'standard'
  if (raw === 'priority' || raw === 'fast') return 'fast'
  return raw
}

function normalizeSpeedOptions(...values) {
  const out = []
  const seen = new Set()
  for (const value of values) {
    for (const option of normalizeCapabilityOptions(value, 'speed')) {
      const canonical = normalizeSpeed(option.value)
      if (!canonical || seen.has(canonical)) continue
      seen.add(canonical)
      out.push({ ...option, value: canonical })
    }
  }
  return out
}

function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = safeModelId(raw.model) || safeModelId(raw.id)
  if (!id) return null
  const displayName = firstSafeText(raw, ['displayName', 'display_name'], MAX_LABEL_LENGTH) || id
  const description = firstSafeText(raw, ['description'], MAX_DESCRIPTION_LENGTH)
  const reasoning = advertisedValue(raw, ['supportedReasoningEfforts', 'supported_reasoning_efforts'])
  const serviceTiers = advertisedValue(raw, ['serviceTiers', 'service_tiers'])
  const additionalTiers = advertisedValue(raw, ['additionalSpeedTiers', 'additional_speed_tiers'])
  const modalities = advertisedValue(raw, ['inputModalities', 'input_modalities'])
  const directImage = firstBoolean(raw, ['supportsImageInput', 'supports_image_input'])
  const model = {
    id,
    value: id,
    displayName,
    label: displayName,
    description,
    isDefault: firstBoolean(raw, ['isDefault', 'is_default']) === true,
  }

  if (reasoning.advertised) {
    model.reasoningEffortsAdvertised = true
    model.supportedReasoningEfforts = normalizeCapabilityOptions(reasoning.value, 'reasoning')
    model.defaultReasoningEffort = firstSafeText(raw, ['defaultReasoningEffort', 'default_reasoning_effort'], 64) || null
  }
  if (serviceTiers.advertised || additionalTiers.advertised) {
    model.speedsAdvertised = true
    model.supportedSpeeds = normalizeSpeedOptions(serviceTiers.value, additionalTiers.value)
    const defaultSpeed = normalizeSpeed(firstSafeText(raw, ['defaultServiceTier', 'default_service_tier'], 64))
    model.defaultSpeed = model.supportedSpeeds.some((option) => option.value === defaultSpeed)
      ? defaultSpeed
      : null
  }
  if (modalities.advertised) {
    model.supportsImageInput = Array.isArray(modalities.value)
      && modalities.value.some((entry) => typeof entry === 'string' && entry.trim().toLowerCase() === 'image')
  } else if (directImage !== undefined) {
    model.supportsImageInput = directImage
  }
  return model
}

function normalizeModels(rawModels, maxModels = DEFAULT_MAX_MODELS) {
  if (!Array.isArray(rawModels)) throw new CatalogError('invalid_response')
  if (rawModels.length > maxModels) throw new CatalogError('model_limit')
  const out = []
  const seen = new Set()
  for (const raw of rawModels) {
    const model = normalizeModel(raw)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    out.push(model)
  }
  if (out.length === 0) throw new CatalogError('empty_catalog')
  const advertisedDefault = out.findIndex((model) => model.isDefault)
  const defaultIndex = advertisedDefault >= 0 ? advertisedDefault : 0
  return out.map((model, index) => ({ ...model, isDefault: index === defaultIndex }))
}

function compatibilityModels() {
  return [{
    id: COMPATIBILITY_MODEL_ID,
    value: COMPATIBILITY_MODEL_ID,
    displayName: 'GPT-5.5',
    label: 'GPT-5.5',
    description: 'Codex compatibility fallback',
    isDefault: true,
  }]
}

function reasonForError(error) {
  switch (error?.code) {
    case 'timeout': return 'Codex app-server model/list 超时'
    case 'native_unavailable': return '本机 Codex native 模式当前不可用'
    case 'invalid_executable': return 'Codex CLI executable 无效'
    case 'spawn_failed': return 'Codex app-server 启动失败'
    case 'stdout_limit': return 'Codex app-server stdout 超过安全上限'
    case 'stderr_limit': return 'Codex app-server stderr 超过安全上限'
    case 'line_limit': return 'Codex app-server 单行输出超过安全上限'
    case 'model_limit': return 'Codex app-server 返回模型数量超过安全上限'
    case 'initialize_failed': return 'Codex app-server initialize 失败'
    case 'model_list_failed': return 'Codex app-server model/list 失败或不受支持'
    case 'invalid_response': return 'Codex app-server model/list 响应格式无效'
    case 'empty_catalog': return 'Codex app-server 未返回可用模型'
    case 'exited': return 'Codex app-server 在返回模型前退出'
    default: return 'Codex app-server 模型目录刷新失败'
  }
}

function cloneModel(model) {
  const out = {
    id: model.id,
    value: model.value,
    displayName: model.displayName,
    label: model.label,
    description: model.description,
    isDefault: model.isDefault === true,
  }
  if (model.reasoningEffortsAdvertised === true) {
    out.reasoningEffortsAdvertised = true
    out.supportedReasoningEfforts = (model.supportedReasoningEfforts || []).map((option) => ({ ...option }))
    out.defaultReasoningEffort = model.defaultReasoningEffort || null
  }
  if (model.speedsAdvertised === true) {
    out.speedsAdvertised = true
    out.supportedSpeeds = (model.supportedSpeeds || []).map((option) => ({ ...option }))
    out.defaultSpeed = model.defaultSpeed || null
  }
  if (typeof model.supportsImageInput === 'boolean') out.supportsImageInput = model.supportsImageInput
  return out
}

function cloneSnapshot(snapshot) {
  return {
    models: (snapshot?.models || []).map(cloneModel),
    source: snapshot?.source || SOURCE_COMPATIBILITY_FALLBACK,
    fallback: snapshot?.fallback === true,
    checkedAt: snapshot?.checkedAt || null,
    reason: snapshot?.reason || null,
  }
}

function toPublicCatalogSnapshot(snapshot) {
  return cloneSnapshot(snapshot)
}

function rpcIdMatches(value, wanted) {
  return String(value) === String(wanted) && (typeof value === 'string' || typeof value === 'number')
}

function hasRpcError(payload) {
  return Object.prototype.hasOwnProperty.call(payload || {}, 'error') && payload.error != null
}

async function stopChild(child, stopTimeoutMs) {
  if (!child) return
  try { child.stdin?.end() } catch {}
  if (child.exitCode != null || child.signalCode != null) return
  let closed = false
  const closePromise = new Promise((resolve) => {
    const done = () => { closed = true; resolve() }
    child.once('close', done)
    child.once('exit', done)
  })
  try { child.kill('SIGTERM') } catch {}
  await Promise.race([
    closePromise,
    new Promise((resolve) => {
      setTimeout(resolve, stopTimeoutMs)
    }),
  ])
  if (!closed && child.exitCode == null && child.signalCode == null) {
    try { child.kill('SIGKILL') } catch {}
    await Promise.race([
      closePromise,
      new Promise((resolve) => {
        setTimeout(resolve, stopTimeoutMs)
      }),
    ])
  }
}

class CodexModelCatalogService {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now())
    this.ttlMs = Number.isFinite(options.ttlMs) ? Math.max(0, options.ttlMs) : DEFAULT_TTL_MS
    this.errorTtlMs = Number.isFinite(options.errorTtlMs) ? Math.max(0, options.errorTtlMs) : DEFAULT_ERROR_TTL_MS
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : DEFAULT_TIMEOUT_MS
    this.stopTimeoutMs = Number.isFinite(options.stopTimeoutMs) ? Math.max(1, options.stopTimeoutMs) : DEFAULT_STOP_TIMEOUT_MS
    this.maxStdoutBytes = options.maxStdoutBytes || DEFAULT_MAX_STDOUT_BYTES
    this.maxStderrBytes = options.maxStderrBytes || DEFAULT_MAX_STDERR_BYTES
    this.maxLineBytes = options.maxLineBytes || DEFAULT_MAX_LINE_BYTES
    this.maxModels = options.maxModels || DEFAULT_MAX_MODELS
    this.spawnProcess = options.spawnProcess || childProcess.spawn
    this.getRuntime = options.getRuntime || (() => providerCliDetection.getCachedProviderRuntime('codex', { nativeOnly: true }))
    this.fetchRawModels = options.fetchRawModels || ((runtime) => this._requestModels(runtime))
    this.cache = null
    this.lastGood = null
    this.inFlight = null
    this.generation = 0
  }

  invalidate() {
    this.generation += 1
    if (this.cache) this.cache.expiresAt = 0
  }

  clearForTests() {
    this.cache = null
    this.lastGood = null
    this.inFlight = null
    this.generation += 1
  }

  setSnapshotForTests(snapshot) {
    const normalized = normalizeModels(snapshot?.models || compatibilityModels(), this.maxModels)
    const next = {
      models: normalized,
      source: snapshot?.source || SOURCE_APP_SERVER,
      fallback: snapshot?.fallback === true,
      checkedAt: snapshot?.checkedAt || new Date(this.now()).toISOString(),
      reason: snapshot?.reason || null,
    }
    this.cache = { snapshot: next, expiresAt: this.now() + this.ttlMs }
    if (!next.fallback && next.source === SOURCE_APP_SERVER) this.lastGood = cloneSnapshot(next)
  }

  peekCatalog() {
    if (this.cache?.snapshot) return cloneSnapshot(this.cache.snapshot)
    return {
      models: compatibilityModels(),
      source: SOURCE_COMPATIBILITY_FALLBACK,
      fallback: true,
      checkedAt: null,
      reason: 'Codex 模型目录尚未预热',
    }
  }

  async getCatalog({ force = false } = {}) {
    const now = this.now()
    if (!force && this.cache && this.cache.expiresAt > now) return cloneSnapshot(this.cache.snapshot)
    const generation = this.generation
    if (this.inFlight && this.inFlight.generation === generation) {
      return cloneSnapshot(await this.inFlight.promise)
    }
    const holder = {
      generation,
      promise: this._refresh(generation),
    }
    this.inFlight = holder
    try {
      return cloneSnapshot(await holder.promise)
    } finally {
      if (this.inFlight === holder) this.inFlight = null
    }
  }

  async _refresh(generation) {
    const checkedAt = new Date(this.now()).toISOString()
    let snapshot
    let expiresAt
    try {
      let runtime
      try {
        runtime = this.getRuntime()
      } catch {
        throw new CatalogError('native_unavailable')
      }
      if (!runtime || !path.isAbsolute(runtime.executable || '')) throw new CatalogError('invalid_executable')
      const rawModels = await this.fetchRawModels(runtime)
      const models = normalizeModels(rawModels, this.maxModels)
      snapshot = {
        models,
        source: SOURCE_APP_SERVER,
        fallback: false,
        checkedAt,
        reason: null,
      }
      expiresAt = this.now() + this.ttlMs
      if (generation === this.generation) this.lastGood = cloneSnapshot(snapshot)
    } catch (error) {
      const reason = reasonForError(error)
      snapshot = this.lastGood
        ? {
            models: this.lastGood.models.map(cloneModel),
            source: SOURCE_LAST_KNOWN_GOOD,
            fallback: true,
            checkedAt,
            reason,
          }
        : {
            models: compatibilityModels(),
            source: SOURCE_COMPATIBILITY_FALLBACK,
            fallback: true,
            checkedAt,
            reason,
          }
      expiresAt = this.now() + this.errorTtlMs
    }
    if (generation === this.generation) this.cache = { snapshot: cloneSnapshot(snapshot), expiresAt }
    return snapshot
  }

  _requestModels(runtime) {
    const executable = runtime.executable
    const env = { ...(runtime.env || {}) }
    return new Promise((resolve, reject) => {
      let child
      try {
        child = this.spawnProcess(executable, ['app-server'], {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        })
      } catch {
        reject(new CatalogError('spawn_failed'))
        return
      }

      let settled = false
      let state = 'initialize'
      let stdoutBytes = 0
      let stderrBytes = 0
      let pending = Buffer.alloc(0)
      const timer = setTimeout(() => finish(new CatalogError('timeout')), this.timeoutMs)
      timer.unref?.()

      const cleanup = () => {
        clearTimeout(timer)
        try { child.stdout?.removeListener('data', onStdout) } catch {}
        try { child.stderr?.removeListener('data', onStderr) } catch {}
      }

      const finish = (error, models) => {
        if (settled) return
        settled = true
        cleanup()
        Promise.resolve(stopChild(child, this.stopTimeoutMs)).then(() => {
          if (error) reject(error)
          else resolve(models)
        }, () => {
          if (error) reject(error)
          else resolve(models)
        })
      }

      const writeMessage = (payload) => {
        if (settled || !child.stdin?.writable) {
          finish(new CatalogError('exited'))
          return false
        }
        try {
          child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
            if (error) finish(new CatalogError('exited'))
          })
          return true
        } catch {
          finish(new CatalogError('exited'))
          return false
        }
      }

      const handleLine = (line) => {
        if (line.length === 0) return
        let payload
        try { payload = JSON.parse(line.toString('utf8')) } catch { return }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
        if (state === 'initialize' && rpcIdMatches(payload.id, '1')) {
          if (hasRpcError(payload) || !Object.prototype.hasOwnProperty.call(payload, 'result') || payload.result == null) {
            finish(new CatalogError('initialize_failed'))
            return
          }
          state = 'model-list'
          if (!writeMessage({ method: 'initialized', params: {} })) return
          writeMessage({ id: '2', method: 'model/list', params: { limit: 200 } })
          return
        }
        if (state === 'model-list' && rpcIdMatches(payload.id, '2')) {
          if (hasRpcError(payload)) {
            finish(new CatalogError('model_list_failed'))
            return
          }
          if (!payload.result || !Array.isArray(payload.result.data)) {
            finish(new CatalogError('invalid_response'))
            return
          }
          finish(null, payload.result.data)
        }
      }

      const onStdout = (chunk) => {
        if (settled) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        stdoutBytes += buffer.length
        if (stdoutBytes > this.maxStdoutBytes) {
          finish(new CatalogError('stdout_limit'))
          return
        }
        pending = pending.length ? Buffer.concat([pending, buffer]) : buffer
        let newline
        while ((newline = pending.indexOf(0x0a)) >= 0) {
          let line = pending.subarray(0, newline)
          pending = pending.subarray(newline + 1)
          if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1)
          if (line.length > this.maxLineBytes) {
            finish(new CatalogError('line_limit'))
            return
          }
          handleLine(line)
          if (settled) return
        }
        if (pending.length > this.maxLineBytes) finish(new CatalogError('line_limit'))
      }

      const onStderr = (chunk) => {
        if (settled) return
        stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
        if (stderrBytes > this.maxStderrBytes) finish(new CatalogError('stderr_limit'))
      }

      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)
      child.once('error', () => finish(new CatalogError('spawn_failed')))
      child.once('exit', () => {
        if (!settled) finish(new CatalogError('exited'))
      })

      writeMessage({
        id: '1',
        method: 'initialize',
        params: { clientInfo: { name: 'mobius', version: '1.0.0' } },
      })
    })
  }
}

const codexModelCatalog = new CodexModelCatalogService()
if (typeof providerCliDetection.onProviderStatusRefresh === 'function') {
  providerCliDetection.onProviderStatusRefresh((provider) => {
    if (provider === 'codex') codexModelCatalog.invalidate()
  })
}

module.exports = {
  CodexModelCatalogService,
  getCatalog: (...args) => codexModelCatalog.getCatalog(...args),
  getCachedCatalog: (...args) => codexModelCatalog.peekCatalog(...args),
  invalidateCodexModelCatalog: (...args) => codexModelCatalog.invalidate(...args),
  toPublicCatalogSnapshot,
  constants: {
    SOURCE_APP_SERVER,
    SOURCE_LAST_KNOWN_GOOD,
    SOURCE_COMPATIBILITY_FALLBACK,
    COMPATIBILITY_MODEL_ID,
    DEFAULT_MAX_MODELS,
  },
  _private: {
    normalizeModel,
    normalizeModels,
    reasonForError,
    clearForTests: () => codexModelCatalog.clearForTests(),
    setSnapshotForTests: (snapshot) => codexModelCatalog.setSnapshotForTests(snapshot),
  },
}
