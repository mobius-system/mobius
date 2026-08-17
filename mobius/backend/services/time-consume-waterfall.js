const fs = require('fs')
const path = require('path')

const { mobiusJsonlPathOf, readMergedJsonlHistory } = require('./mobius-jsonl')

const TIME_CONSUME_WATERFALL_VERSION = 1
const MIN_STEP_MS = 1000

function timeConsumeWaterfallCachePathOf(jsonlPath) {
  if (!jsonlPath || typeof jsonlPath !== 'string') return null
  return jsonlPath.endsWith('.jsonl')
    ? jsonlPath.slice(0, -'.jsonl'.length) + '.time-consume-waterfall.json'
    : `${jsonlPath}.time-consume-waterfall.json`
}

function currentSourceSizes(jsonlPath) {
  const primary = jsonlPath ? safeSize(jsonlPath) : 0
  const mobius = jsonlPath ? safeSize(mobiusJsonlPathOf(jsonlPath)) : 0
  return { primary, mobius }
}

function safeSize(filePath) {
  if (!filePath) return 0
  try {
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0
  } catch {
    return 0
  }
}

function safeMkdir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function loadCache(cachePath) {
  if (!cachePath || !fs.existsSync(cachePath)) return null
  try {
    const raw = fs.readFileSync(cachePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (Number(parsed.version) !== TIME_CONSUME_WATERFALL_VERSION) return null
    return parsed
  } catch {
    return null
  }
}

function saveCache(cachePath, cache) {
  if (!cachePath) return
  try {
    safeMkdir(cachePath)
    const tmp = `${cachePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`)
    fs.renameSync(tmp, cachePath)
  } catch (error) {
    console.warn(`[time-consume-waterfall] save cache failed: ${error.message}`)
  }
}

function parseEntryTimestampMs(entry) {
  const candidates = [
    entry?.timestamp,
    entry?.created_at,
    entry?.payload?.timestamp,
    entry?.message?.created_at,
    entry?.mobius?.captured_at,
  ]
  for (const raw of candidates) {
    if (!raw) continue
    const ms = new Date(raw).getTime()
    if (Number.isFinite(ms)) return ms
  }
  return null
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function joinContentText(content) {
  if (typeof content === 'string') return normalizeText(content)
  if (!Array.isArray(content)) return ''
  return normalizeText(content.map((block) => {
    if (!block || typeof block !== 'object') return ''
    if (block.type === 'text' || block.type === 'thinking' || block.type === 'reasoning') {
      return block.text ?? block.thinking ?? block.reasoning ?? ''
    }
    return ''
  }).filter(Boolean).join(' '))
}

function classifyEntry(entry) {
  if (!entry || typeof entry !== 'object') return { kind: 'other', label: '其他' }

  if (entry.type === 'error') return { kind: 'error', label: '错误' }
  if (entry.type === 'system') return { kind: 'system', label: '系统' }
  if (entry.type === 'attachment') return { kind: 'attachment', label: '附件' }

  if (entry.type === 'user') {
    const content = entry?.message?.content
    if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) {
      return { kind: 'tool_result', label: '工具结果' }
    }
    return { kind: 'user', label: '用户' }
  }

  if (entry.type === 'assistant') {
    const content = entry?.message?.content
    if (Array.isArray(content)) {
      if (content.some((block) => block?.type === 'tool_use')) return { kind: 'tool_use', label: '工具调用' }
      if (content.some((block) => block?.type === 'thinking' || block?.type === 'reasoning')) {
        return { kind: 'thinking', label: '思考' }
      }
    }
    return { kind: 'assistant', label: '智能体' }
  }

  if (entry.type === 'event_msg') {
    const payloadType = entry?.payload?.type || ''
    if (payloadType === 'user_message') return { kind: 'user', label: '用户' }
    if (payloadType === 'agent_message') return { kind: 'assistant', label: '智能体' }
    if (payloadType === 'turn/end') return { kind: 'assistant', label: '智能体' }
    if (payloadType === 'error') return { kind: 'error', label: '错误' }
    return { kind: `event:${payloadType || 'other'}`, label: '事件' }
  }

  if (entry.type === 'response_item') {
    const payloadType = entry?.payload?.type || ''
    if (payloadType === 'message') {
      return entry?.payload?.role === 'user'
        ? { kind: 'user', label: '用户' }
        : { kind: 'assistant', label: '智能体' }
    }
    if (payloadType === 'reasoning') return { kind: 'thinking', label: '思考' }
    if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
      return { kind: 'tool_use', label: '工具调用' }
    }
    if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
      return { kind: 'tool_result', label: '工具结果' }
    }
    return { kind: `response:${payloadType || 'other'}`, label: '响应' }
  }

  return { kind: 'other', label: '其他' }
}

function normalizeEvent(entry, lineNo = null, source = 'history') {
  const tsMs = parseEntryTimestampMs(entry)
  if (!Number.isFinite(tsMs)) return null
  const { kind, label } = classifyEntry(entry)
  return {
    tsMs,
    ts: new Date(tsMs).toISOString(),
    kind,
    label,
    lineNo,
    source,
  }
}

function createEmptyCache(jsonlPath, nowMs) {
  return {
    version: TIME_CONSUME_WATERFALL_VERSION,
    jsonlPath: jsonlPath || null,
    startAtMs: null,
    lastUpdatedAtMs: nowMs,
    lastLineCount: 0,
    sourceSizes: currentSourceSizes(jsonlPath),
    totalMs: 0,
    segments: [],
    lastEvent: null,
  }
}

function finalizeSegment(state, nextEvent, nowMs) {
  if (!state.lastEvent) return
  const start = state.lastEvent.tsMs
  const end = nextEvent ? nextEvent.tsMs : nowMs
  const durationMs = end - start
  if (durationMs < MIN_STEP_MS) {
    state.lastEvent = nextEvent || null
    return
  }

  if (state.startAtMs == null) state.startAtMs = start
  const segment = {
    kind: state.lastEvent.kind,
    label: state.lastEvent.label,
    startAtMs: start,
    endAtMs: end,
    startOffsetMs: start - state.startAtMs,
    durationMs,
    lineNo: state.lastEvent.lineNo,
    source: state.lastEvent.source,
    open: !nextEvent,
  }
  state.segments.push(segment)
  state.totalMs += durationMs
  state.lastEvent = nextEvent || null
}

function absorbEvents(state, events, nowMs) {
  const ordered = [...events]
    .map((entry, index) => ({
      raw: entry,
      meta: normalizeEvent(entry, index + 1, entry?.mobius?.backend || 'history'),
    }))
    .filter((item) => item.meta)
    .sort((a, b) => {
      if (a.meta.tsMs !== b.meta.tsMs) return a.meta.tsMs - b.meta.tsMs
      const sa = a.meta.source || ''
      const sb = b.meta.source || ''
      if (sa !== sb) return sa === 'primary' ? -1 : 1
      return a.meta.lineNo - b.meta.lineNo
    })

  for (const item of ordered) {
    finalizeSegment(state, item.meta, nowMs)
    if (!state.startAtMs) state.startAtMs = item.meta.tsMs
    state.lastEvent = item.meta
    state.lastLineCount += 1
  }

  return state
}

function responseFromState(state, nowMs, jsonlPath, mutated) {
  const segments = state.segments.map((segment) => ({
    kind: segment.kind,
    label: segment.label,
    start_at: new Date(segment.startAtMs).toISOString(),
    end_at: new Date(segment.endAtMs).toISOString(),
    start_offset_ms: segment.startOffsetMs,
    duration_ms: segment.durationMs,
    line_no: segment.lineNo,
    source: segment.source,
    open: !!segment.open,
  }))

  if (state.lastEvent) {
    const endMs = nowMs
    const durationMs = endMs - state.lastEvent.tsMs
    if (durationMs >= MIN_STEP_MS) {
      const startAtMs = state.startAtMs == null ? state.lastEvent.tsMs : state.startAtMs
      segments.push({
        kind: state.lastEvent.kind,
        label: state.lastEvent.label,
        start_at: new Date(state.lastEvent.tsMs).toISOString(),
        end_at: new Date(endMs).toISOString(),
        start_offset_ms: state.lastEvent.tsMs - startAtMs,
        duration_ms: durationMs,
        line_no: state.lastEvent.lineNo,
        source: state.lastEvent.source,
        open: true,
      })
    }
  }

  return {
    session_id: state.sessionId || null,
    jsonl_path: jsonlPath || null,
    start_at: state.startAtMs == null ? null : new Date(state.startAtMs).toISOString(),
    updated_at: new Date(nowMs).toISOString(),
    ignored_under_ms: MIN_STEP_MS,
    total_ms: state.totalMs + (state.lastEvent ? Math.max(0, nowMs - state.lastEvent.tsMs) : 0),
    line_count: state.lastLineCount,
    segments,
    cache: {
      version: TIME_CONSUME_WATERFALL_VERSION,
      line_count: state.lastLineCount,
      start_at: state.startAtMs == null ? null : new Date(state.startAtMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
      source_sizes: state.sourceSizes,
      mutated: !!mutated,
    },
  }
}

function rebuildStateFromHistory(backend, sessionId, jsonlPath, nowMs) {
  const history = backend.getHistory(sessionId, {
    maxLines: Number.MAX_SAFE_INTEGER,
    exactTotalMaxBytes: Number.MAX_SAFE_INTEGER,
  }) || {}
  const entries = Array.isArray(history.entries) ? history.entries : []
  const state = createEmptyCache(jsonlPath, nowMs)
  state.sessionId = sessionId
  state.sourceSizes = currentSourceSizes(jsonlPath)
  absorbEvents(state, entries, nowMs)
  if (state.startAtMs == null && state.lastEvent) state.startAtMs = state.lastEvent.tsMs
  return state
}

function readAppendedEntries(jsonlPath, startSize, source = 'primary') {
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return []
  let stat
  try {
    stat = fs.statSync(jsonlPath)
  } catch {
    return []
  }
  if (stat.size <= startSize) return []
  const len = stat.size - startSize
  const buf = Buffer.alloc(len)
  let fd
  try {
    fd = fs.openSync(jsonlPath, 'r')
    const n = fs.readSync(fd, buf, 0, len, startSize)
    const text = buf.slice(0, n).toString('utf8')
    return text.split('\n').filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean)
  } catch {
    return []
  } finally {
    if (fd) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

function appendFromDisk(state, jsonlPath, nowMs) {
  const currentSizes = currentSourceSizes(jsonlPath)
  const previousSizes = state.sourceSizes || { primary: 0, mobius: 0 }
  const primaryEntries = readAppendedEntries(jsonlPath, previousSizes.primary, 'primary')
  const mobiusPath = mobiusJsonlPathOf(jsonlPath)
  const mobiusEntries = readAppendedEntries(mobiusPath, previousSizes.mobius, 'mobius')
  const newEntries = [...primaryEntries, ...mobiusEntries]
  if (!newEntries.length) {
    state.sourceSizes = currentSizes
    return state
  }
  const normalized = newEntries
    .map((entry) => ({ entry, meta: normalizeEvent(entry, null, entry?.mobius?.backend === 'mobius' ? 'mobius' : 'primary') }))
    .filter((item) => item.meta)
    .sort((a, b) => {
      if (a.meta.tsMs !== b.meta.tsMs) return a.meta.tsMs - b.meta.tsMs
      const sa = a.meta.source || ''
      const sb = b.meta.source || ''
      if (sa !== sb) return sa === 'primary' ? -1 : 1
      return 0
    })

  for (const item of normalized) {
    finalizeSegment(state, item.meta, nowMs)
    if (!state.startAtMs) state.startAtMs = item.meta.tsMs
    state.lastEvent = item.meta
    state.lastLineCount += 1
  }
  state.sourceSizes = currentSizes
  return state
}

function timeConsumeWaterfallFromBackend(backend, sessionId, opts = {}) {
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now()
  const jsonlPath = typeof backend?._resolveJsonlPath === 'function'
    ? backend._resolveJsonlPath(sessionId)
    : null
  if (!jsonlPath) {
    return {
      session_id: sessionId || null,
      jsonl_path: null,
      start_at: null,
      updated_at: new Date(nowMs).toISOString(),
      ignored_under_ms: MIN_STEP_MS,
      total_ms: 0,
      line_count: 0,
      segments: [],
      cache: null,
    }
  }

  const cachePath = timeConsumeWaterfallCachePathOf(jsonlPath)
  const cached = loadCache(cachePath)
  const currentSizes = currentSourceSizes(jsonlPath)
  let state = cached && typeof cached === 'object'
    ? { ...cached }
    : null

  if (!state || state.version !== TIME_CONSUME_WATERFALL_VERSION) {
    state = rebuildStateFromHistory(backend, sessionId, jsonlPath, nowMs)
    state.sessionId = sessionId
    state.sourceSizes = currentSizes
    state.lastUpdatedAtMs = nowMs
    saveCache(cachePath, state)
    return responseFromState(state, nowMs, jsonlPath, true)
  }

  if (
    (state.sourceSizes?.primary != null && currentSizes.primary < state.sourceSizes.primary)
    || (state.sourceSizes?.mobius != null && currentSizes.mobius < state.sourceSizes.mobius)
  ) {
    state = rebuildStateFromHistory(backend, sessionId, jsonlPath, nowMs)
    state.sessionId = sessionId
    state.sourceSizes = currentSizes
    state.lastUpdatedAtMs = nowMs
    saveCache(cachePath, state)
    return responseFromState(state, nowMs, jsonlPath, true)
  }

  state.sessionId = sessionId
  state.sourceSizes = state.sourceSizes || currentSizes
  const previousLineCount = Number(state.lastLineCount || 0)
  if (currentSizes.primary > (state.sourceSizes.primary || 0) || currentSizes.mobius > (state.sourceSizes.mobius || 0)) {
    state = appendFromDisk(state, jsonlPath, nowMs)
    if (state.lastLineCount === previousLineCount) {
      // 文件变长但没有成功解析新行, 兜底全量重建.
      state = rebuildStateFromHistory(backend, sessionId, jsonlPath, nowMs)
      state.sessionId = sessionId
      state.sourceSizes = currentSizes
    }
    state.lastUpdatedAtMs = nowMs
    saveCache(cachePath, state)
    return responseFromState(state, nowMs, jsonlPath, true)
  }

  state.sourceSizes = currentSizes
  state.lastUpdatedAtMs = nowMs
  saveCache(cachePath, state)
  return responseFromState(state, nowMs, jsonlPath, false)
}

function clearTimeConsumeWaterfallForBackend(backend, sessionId, opts = {}) {
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now()
  const jsonlPath = typeof backend?._resolveJsonlPath === 'function'
    ? backend._resolveJsonlPath(sessionId)
    : null
  if (!jsonlPath) {
    return {
      session_id: sessionId || null,
      jsonl_path: null,
      start_at: new Date(nowMs).toISOString(),
      updated_at: new Date(nowMs).toISOString(),
      ignored_under_ms: MIN_STEP_MS,
      total_ms: 0,
      line_count: 0,
      segments: [],
      cache: null,
    }
  }

  const cachePath = timeConsumeWaterfallCachePathOf(jsonlPath)
  const reset = {
    version: TIME_CONSUME_WATERFALL_VERSION,
    sessionId,
    jsonlPath,
    startAtMs: nowMs,
    lastUpdatedAtMs: nowMs,
    lastLineCount: 0,
    sourceSizes: currentSourceSizes(jsonlPath),
    totalMs: 0,
    segments: [],
    lastEvent: null,
  }
  saveCache(cachePath, reset)
  return responseFromState(reset, nowMs, jsonlPath, true)
}

module.exports = {
  TIME_CONSUME_WATERFALL_VERSION,
  timeConsumeWaterfallCachePathOf,
  timeConsumeWaterfallFromBackend,
  clearTimeConsumeWaterfallForBackend,
}
