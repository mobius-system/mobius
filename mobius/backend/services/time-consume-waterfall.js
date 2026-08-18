const fs = require('fs')
const path = require('path')

const { mobiusJsonlPathOf } = require('./mobius-jsonl')

const TIME_CONSUME_WATERFALL_VERSION = 5
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

function normalizeCallId(value) {
  return value == null ? null : String(value)
}

function callIdOfPayload(payload) {
  return normalizeCallId(payload?.call_id || payload?.id || payload?.tool_call_id || payload?.tool_use_id)
}

function callNameOfPayload(payload) {
  return String(payload?.name || payload?.tool_name || payload?.action?.type || 'tool')
}

function contentBlocks(entry) {
  const content = entry?.message?.content || entry?.payload?.content
  return Array.isArray(content) ? content : []
}

function eventsFromEntry(entry, lineNo = null, source = 'history') {
  const tsMs = parseEntryTimestampMs(entry)
  if (!Number.isFinite(tsMs)) return []
  const base = { tsMs, lineNo, source }
  const events = []

  if (entry?.type === 'event_msg') {
    const payload = entry.payload || {}
    if (payload.type === 'task_started') events.push({ ...base, type: 'model_start' })
    if (payload.type === 'task_complete' || payload.type === 'turn/end') events.push({ ...base, type: 'model_end' })
    if (payload.type === 'agent_message') events.push({ ...base, type: 'model_observed' })
    if (payload.type === 'patch_apply_end' || payload.type === 'web_search_end') {
      events.push({
        ...base,
        type: 'tool_end',
        callId: callIdOfPayload(payload),
        toolName: callNameOfPayload(payload),
      })
    }
    return events
  }

  if (entry?.type === 'response_item') {
    const payload = entry.payload || {}
    if (payload.type === 'message') {
      if (payload.role === 'user') events.push({ ...base, type: 'user_start' })
      if (payload.role === 'assistant') events.push({ ...base, type: 'model_observed' })
    }
    if (payload.type === 'reasoning') events.push({ ...base, type: 'model_observed' })
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      events.push({
        ...base,
        type: 'tool_start',
        callId: callIdOfPayload(payload),
        toolName: callNameOfPayload(payload),
      })
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      events.push({
        ...base,
        type: 'tool_end',
        callId: callIdOfPayload(payload),
        toolName: callNameOfPayload(payload),
      })
    }
    return events
  }

  if (entry?.type === 'assistant') {
    const blocks = contentBlocks(entry)
    if (blocks.some((block) => block?.type === 'text' || block?.type === 'thinking' || block?.type === 'reasoning')) {
      events.push({ ...base, type: 'model_observed' })
    }
    for (const block of blocks) {
      if (block?.type === 'tool_use') {
        events.push({
          ...base,
          type: 'tool_start',
          callId: normalizeCallId(block.id || block.call_id),
          toolName: callNameOfPayload(block),
        })
      }
    }
    if (!events.length) events.push({ ...base, type: 'model_observed' })
    return events
  }

  if (entry?.type === 'user') {
    const blocks = contentBlocks(entry)
    const toolResults = blocks.filter((block) => block?.type === 'tool_result')
    if (toolResults.length) {
      for (const block of toolResults) {
        events.push({
          ...base,
          type: 'tool_end',
          callId: normalizeCallId(block.tool_use_id || block.call_id || block.id),
          toolName: 'tool',
        })
      }
      return events
    }
    events.push({ ...base, type: 'user_start' })
    return events
  }

  return events
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
    modelStartMs: null,
    modelStartOffsetMs: null,
    modelLastObservedMs: null,
    activeTools: {},
    toolPhaseStartMs: null,
    toolPhaseStartOffsetMs: null,
  }
}

function addSegment(state, segment) {
  const start = Number(segment.startAtMs)
  const end = Number(segment.endAtMs)
  const durationMs = end - start
  if (!Number.isFinite(durationMs) || durationMs < MIN_STEP_MS) return
  if (state.startAtMs == null) state.startAtMs = start
  const startOffsetMs = Math.max(0, Number(segment.startOffsetMs) || 0)
  state.segments.push({
    ...segment,
    durationMs,
    startOffsetMs,
    open: false,
  })
  state.totalMs = Math.max(state.totalMs, startOffsetMs + durationMs)
}

function closeModelSegment(state, endMs, event) {
  if (state.modelStartMs == null) return
  const safeEndMs = endMs == null
    ? state.modelLastObservedMs
    : (Number.isFinite(Number(endMs)) ? Number(endMs) : state.modelLastObservedMs)
  if (safeEndMs != null) {
    addSegment(state, {
      kind: 'model',
      label: '模型推理',
      startAtMs: state.modelStartMs,
      endAtMs: safeEndMs,
      startOffsetMs: state.modelStartOffsetMs || 0,
      lineNo: event?.lineNo ?? null,
      source: event?.source ?? null,
    })
  }
  state.modelStartMs = null
  state.modelStartOffsetMs = null
  state.modelLastObservedMs = null
}

function startModelSegment(state, startMs) {
  if (state.modelStartMs == null && Object.keys(state.activeTools || {}).length === 0) {
    state.modelStartMs = startMs
    state.modelStartOffsetMs = state.totalMs
    state.modelLastObservedMs = null
  }
}

function absorbEventMeta(state, event) {
  if (!event) return
  if (state.startAtMs != null && event.tsMs < state.startAtMs) return

  if (event.type === 'user_start') {
    if (state.modelStartMs != null && state.modelLastObservedMs != null) {
      closeModelSegment(state, state.modelLastObservedMs, event)
    } else {
      state.modelStartMs = null
      state.modelStartOffsetMs = null
      state.modelLastObservedMs = null
    }
    startModelSegment(state, event.tsMs)
    return
  }

  if (event.type === 'model_start') {
    if (state.modelStartMs != null && state.modelLastObservedMs != null) {
      closeModelSegment(state, state.modelLastObservedMs, event)
    }
    state.modelStartMs = event.tsMs
    state.modelStartOffsetMs = state.totalMs
    state.modelLastObservedMs = null
    return
  }

  if (event.type === 'model_observed') {
    startModelSegment(state, event.tsMs)
    state.modelLastObservedMs = event.tsMs
    return
  }

  if (event.type === 'tool_start') {
    closeModelSegment(state, event.tsMs, event)
    if (Object.keys(state.activeTools || {}).length === 0) {
      state.toolPhaseStartMs = event.tsMs
      state.toolPhaseStartOffsetMs = state.totalMs
    }
    const callId = event.callId || `anonymous:${event.source || 'history'}:${event.lineNo || event.tsMs}`
    const phaseStartMs = state.toolPhaseStartMs == null ? event.tsMs : state.toolPhaseStartMs
    const phaseStartOffsetMs = state.toolPhaseStartOffsetMs == null ? state.totalMs : state.toolPhaseStartOffsetMs
    state.activeTools = state.activeTools || {}
    state.activeTools[callId] = {
      callId,
      toolName: event.toolName || 'tool',
      startAtMs: event.tsMs,
      startOffsetMs: phaseStartOffsetMs + Math.max(0, event.tsMs - phaseStartMs),
      lineNo: event.lineNo ?? null,
      source: event.source ?? null,
    }
    return
  }

  if (event.type === 'tool_end') {
    const callId = event.callId
    const active = callId ? state.activeTools?.[callId] : null
    if (active) {
      addSegment(state, {
        kind: 'tool',
        label: '工具调用',
        startAtMs: active.startAtMs,
        endAtMs: event.tsMs,
        startOffsetMs: active.startOffsetMs,
        lineNo: active.lineNo,
        source: active.source,
        toolName: active.toolName,
      })
      delete state.activeTools[callId]
    }
    if (Object.keys(state.activeTools || {}).length === 0) {
      state.toolPhaseStartMs = null
      state.toolPhaseStartOffsetMs = null
      startModelSegment(state, event.tsMs)
    }
    return
  }

  if (event.type === 'model_end') {
    closeModelSegment(state, event.tsMs, event)
  }
}

function absorbEvents(state, events, nowMs) {
  const ordered = [...events]
    .flatMap((entry, index) => {
      const source = entry?.mobius?.backend || 'history'
      return eventsFromEntry(entry, index + 1, source).map((meta, order) => ({ meta, order }))
    })
    .sort((a, b) => {
      if (a.meta.tsMs !== b.meta.tsMs) return a.meta.tsMs - b.meta.tsMs
      const sa = a.meta.source || ''
      const sb = b.meta.source || ''
      if (sa !== sb) return sa === 'primary' ? -1 : 1
      if (a.meta.lineNo !== b.meta.lineNo) return a.meta.lineNo - b.meta.lineNo
      return a.order - b.order
    })

  for (const item of ordered) {
    absorbEventMeta(state, item.meta)
  }
  state.lastLineCount += events.length

  return state
}

function responseFromState(state, nowMs, jsonlPath, mutated) {
  const segments = [...state.segments]
    .sort((a, b) => {
      if (a.startOffsetMs !== b.startOffsetMs) return a.startOffsetMs - b.startOffsetMs
      if (a.startAtMs !== b.startAtMs) return a.startAtMs - b.startAtMs
      return a.endAtMs - b.endAtMs
    })
    .map((segment) => ({
      kind: segment.kind,
      label: segment.label,
      start_at: new Date(segment.startAtMs).toISOString(),
      end_at: new Date(segment.endAtMs).toISOString(),
      start_offset_ms: segment.startOffsetMs,
      duration_ms: segment.durationMs,
      line_no: segment.lineNo,
      source: segment.source,
      tool_name: segment.toolName || null,
      open: !!segment.open,
    }))

  return {
    session_id: state.sessionId || null,
    jsonl_path: jsonlPath || null,
    start_at: state.startAtMs == null ? null : new Date(state.startAtMs).toISOString(),
    updated_at: new Date(nowMs).toISOString(),
    ignored_under_ms: MIN_STEP_MS,
    total_ms: state.totalMs,
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
  return state
}

function readAppendedEntries(jsonlPath, startSize) {
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
  const primaryEntries = readAppendedEntries(jsonlPath, previousSizes.primary)
  const mobiusPath = mobiusJsonlPathOf(jsonlPath)
  const mobiusEntries = readAppendedEntries(mobiusPath, previousSizes.mobius)
  const newEntries = [
    ...primaryEntries.map((entry) => ({ entry, source: 'primary' })),
    ...mobiusEntries.map((entry) => ({ entry, source: 'mobius' })),
  ]
  if (!newEntries.length) {
    state.sourceSizes = currentSizes
    return state
  }
  const normalized = newEntries
    .flatMap(({ entry, source }) => {
      return eventsFromEntry(entry, null, source).map((meta, order) => ({ meta, order }))
    })
    .sort((a, b) => {
      if (a.meta.tsMs !== b.meta.tsMs) return a.meta.tsMs - b.meta.tsMs
      const sa = a.meta.source || ''
      const sb = b.meta.source || ''
      if (sa !== sb) return sa === 'primary' ? -1 : 1
      return a.order - b.order
    })

  for (const item of normalized) {
    absorbEventMeta(state, item.meta)
  }
  state.lastLineCount += newEntries.length
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
    modelStartMs: null,
    modelStartOffsetMs: null,
    modelLastObservedMs: null,
    activeTools: {},
    toolPhaseStartMs: null,
    toolPhaseStartOffsetMs: null,
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
