import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { ArrowUpRight, Bot, Paperclip, Pin, PinOff, RefreshCw, Send, X } from 'lucide-react'
import { api } from '../store'
import { uploadAttachmentFile } from './attachments'
import { EntryCardWithImages } from './viewer/RoundGroups'
import { mergeBashToolResultItems } from './viewer/entry-extract'
import { isHiddenJsonlNoiseEntry } from './viewer/entry-classify'
import { pollRecursive } from '../services/polling'
import { clampOverlayToBounds, resolveOverlayCollisions, type OverlayCollisionItem } from '../services/overlay-collision'
import { readJsonlCacheFromIdb, readJsonlCacheSync, writeJsonlCache } from '../services/session-jsonl-cache'
import { preloadSessionInputCache, prependSessionInputCache, readSessionInputCache, refreshSessionInputCache, type SessionInputEntry } from '../services/session-input-cache'
import { RemoteFileMentionDrawer, type AgentMentionMode, type MentionAgentSession } from './chat'
import type { AnyEntry } from './viewer/types'

type OverlaySession = { id: string; title: string; projectId: string; projectName: string; creatorId?: string; parentId: string; parentKind: 'issue' | 'research'; color: string; x: number; y: number; active: boolean }
type OverlayTransform = { offset: { x: number; y: number }; zoom: number; width: number; height: number }

export type AgentConversationOverlaysProps = {
  sessions: OverlaySession[]
  enabled: boolean
  compact: boolean
  modelRef: MutableRefObject<{ nodes: any[] }>
  transformRef: MutableRefObject<OverlayTransform>
  onClose: (sessionId: string) => void
  onOpenSession: (session: OverlaySession) => void
}

type OverlayState = { pinned: boolean; entries: AnyEntry[]; draft: string; sending: boolean; attached?: string[]; error?: string }
type OverlayPosition = { left: number; top: number; targetX: number; targetY: number; manual?: boolean }
type OverlayLayoutItem = OverlayPosition & OverlayCollisionItem
type OverlayAnchor = { x: number; y: number; side: 'top' | 'bottom' | 'left' | 'right' }
type ScreenPoint = { x: number; y: number }
type OverlayAttractionTarget = { left: number; top: number }
type OverlayAttractionLayout = { center: ScreenPoint; targets: Map<string, OverlayAttractionTarget> }
const STORAGE_KEY = 'mobius:overview-conversation-pins'
// The canvas begins below the 40px overview header, while the overlay layer is
// positioned against the full page main element. Keep line endpoints in the
// same coordinate space as the floating windows.
const CANVAS_TOP_OFFSET = 40
const OVERLAY_WIDTH = 312
const COMPACT_OVERLAY_WIDTH = Math.round((OVERLAY_WIDTH / 2) * 1.3)
const MIN_VISIBLE_HEADER_WIDTH = 72
const MIN_VISIBLE_HEADER_HEIGHT = 16
const OVERLAY_COLLISION_PASSES = 2
const OVERLAY_COLLISION_GAP = 3
const COMPACT_OVERLAY_COLLISION_GAP = 2
const OVERLAY_COLLISION_STRENGTH = 0.06
const OVERLAY_COLLISION_MAX_PUSH = 3
const COMPACT_OVERLAY_COLLISION_MAX_PUSH = 2
const OVERLAY_ANCHOR_PULL = 0.045
const OVERLAY_EDGE_RETRACT_GAP = 12
const OVERLAY_ATTRACTION_OMEGA_DEG = 70
const OVERLAY_ATTRACTION_UPDATE_MS = 2_000
const OVERLAY_ATTRACTION_TRANSITION_MS = 2_000

function clampOverlayPosition(left: number, top: number, viewport: OverlayTransform, compact: boolean) {
  const overlayWidth = compact ? COMPACT_OVERLAY_WIDTH : OVERLAY_WIDTH
  const minLeft = MIN_VISIBLE_HEADER_WIDTH - overlayWidth
  const maxLeft = Math.max(minLeft, viewport.width - MIN_VISIBLE_HEADER_WIDTH)
  const minTop = CANVAS_TOP_OFFSET
  const maxTop = Math.max(minTop, CANVAS_TOP_OFFSET + viewport.height - MIN_VISIBLE_HEADER_HEIGHT)
  return {
    left: Math.max(minLeft, Math.min(maxLeft, left)),
    top: Math.max(minTop, Math.min(maxTop, top)),
  }
}

function clampAutoOverlayPosition(left: number, top: number, width: number, height: number, viewport: OverlayTransform) {
  return clampOverlayToBounds({ left, top, width, height }, {
    left: 8,
    top: CANVAS_TOP_OFFSET + 8,
    right: viewport.width - 8,
    bottom: CANVAS_TOP_OFFSET + viewport.height - 8,
  })
}

function normalizeAngle360(degrees: number) {
  const normalized = degrees % 360
  return normalized < 0 ? normalized + 360 : normalized
}

function convexHull(points: ScreenPoint[]): ScreenPoint[] {
  if (points.length <= 1) return points.slice()
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: ScreenPoint, a: ScreenPoint, b: ScreenPoint) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: ScreenPoint[] = []
  sorted.forEach((point) => {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop()
    lower.push(point)
  })
  const upper: ScreenPoint[] = []
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop()
    upper.push(point)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

function polygonCentroid(points: ScreenPoint[]): ScreenPoint {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length < 3) {
    return points.reduce((center, point) => ({ x: center.x + point.x / points.length, y: center.y + point.y / points.length }), { x: 0, y: 0 })
  }
  let areaTwice = 0
  let x = 0
  let y = 0
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length]
    const cross = point.x * next.y - next.x * point.y
    areaTwice += cross
    x += (point.x + next.x) * cross
    y += (point.y + next.y) * cross
  })
  if (Math.abs(areaTwice) < 1e-6) {
    return points.reduce((center, point) => ({ x: center.x + point.x / points.length, y: center.y + point.y / points.length }), { x: 0, y: 0 })
  }
  return { x: x / (3 * areaTwice), y: y / (3 * areaTwice) }
}

function rayToBounds(center: ScreenPoint, direction: ScreenPoint, bounds: { left: number; top: number; right: number; bottom: number }): ScreenPoint {
  const epsilon = 1e-6
  let distance = Number.POSITIVE_INFINITY
  if (direction.x > epsilon) distance = Math.min(distance, (bounds.right - center.x) / direction.x)
  else if (direction.x < -epsilon) distance = Math.min(distance, (bounds.left - center.x) / direction.x)
  if (direction.y > epsilon) distance = Math.min(distance, (bounds.bottom - center.y) / direction.y)
  else if (direction.y < -epsilon) distance = Math.min(distance, (bounds.top - center.y) / direction.y)
  if (!Number.isFinite(distance) || distance < 0) return center
  return { x: center.x + direction.x * distance, y: center.y + direction.y * distance }
}

function computeOverlayAttractionTargets(sessions: OverlaySession[], nodeById: Map<string, any>, transform: OverlayTransform, compact: boolean, heights: Map<string, number>): OverlayAttractionLayout {
  const nodePoints = sessions
    .map((session) => {
      const node = nodeById.get(session.id)
      return node ? { id: session.id, point: { x: node.x * transform.zoom + transform.offset.x, y: node.y * transform.zoom + transform.offset.y + CANVAS_TOP_OFFSET } } : null
    })
    .filter((item): item is { id: string; point: ScreenPoint } => Boolean(item))
  const targets = new Map<string, OverlayAttractionTarget>()
  if (nodePoints.length === 0) return { center: { x: transform.width / 2, y: CANVAS_TOP_OFFSET + transform.height / 2 }, targets }
  const center = polygonCentroid(convexHull(nodePoints.map((item) => item.point)))
  const bounds = {
    left: 8,
    top: CANVAS_TOP_OFFSET + 8,
    right: Math.max(8, transform.width - 8),
    bottom: Math.max(CANVAS_TOP_OFFSET + 8, CANVAS_TOP_OFFSET + transform.height - 8),
  }
  const right: Array<{ id: string; angle: number }> = []
  const left: Array<{ id: string; angle: number }> = []
  nodePoints.forEach(({ id, point }) => {
    const angle = normalizeAngle360(Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI)
    if (angle < 90 || angle >= 270) right.push({ id, angle: angle >= 270 ? angle - 360 : angle })
    else left.push({ id, angle })
  })
  right.sort((a, b) => a.angle - b.angle || a.id.localeCompare(b.id))
  left.sort((a, b) => a.angle - b.angle || a.id.localeCompare(b.id))
  const overlayWidth = compact ? COMPACT_OVERLAY_WIDTH : OVERLAY_WIDTH
  const assign = (group: Array<{ id: string; angle: number }>, baseAngle: number) => {
    const count = group.length
    if (count === 0) return
    const delta = (2 * OVERLAY_ATTRACTION_OMEGA_DEG) / (count + 1)
    group.forEach(({ id }, index) => {
      const beta = -OVERLAY_ATTRACTION_OMEGA_DEG + (index + 1) * delta
      const radians = (baseAngle + beta) * Math.PI / 180
      const direction = { x: Math.cos(radians), y: Math.sin(radians) }
      const boundary = rayToBounds(center, direction, bounds)
      const overlayHeight = heights.get(id) || (compact ? 210 : 390)
      const margin = Math.abs(direction.x) * overlayWidth / 2 + Math.abs(direction.y) * overlayHeight / 2 + OVERLAY_EDGE_RETRACT_GAP
      const attractionCenter = { x: boundary.x - direction.x * margin, y: boundary.y - direction.y * margin }
      const clamped = clampAutoOverlayPosition(attractionCenter.x - overlayWidth / 2, attractionCenter.y - overlayHeight / 2, overlayWidth, overlayHeight, transform)
      targets.set(id, clamped)
    })
  }
  assign(right, 0)
  assign(left, 180)
  return { center, targets }
}

function shiftAttractionTargets(targets: Map<string, OverlayAttractionTarget>, dx: number, dy: number) {
  targets.forEach((target, id) => { targets.set(id, { left: target.left + dx, top: target.top + dy }) })
}

function interpolateAttractionTargets(result: Map<string, OverlayAttractionTarget>, from: Map<string, OverlayAttractionTarget>, to: Map<string, OverlayAttractionTarget>, progress: number) {
  result.clear()
  to.forEach((target, id) => {
    const start = from.get(id) || target
    result.set(id, { left: start.left + (target.left - start.left) * progress, top: start.top + (target.top - start.top) * progress })
  })
}

/**
 * Pick the nearest side-center for the connector endpoint. Keeping this as a
 * pure calculation makes the anchor stable while dragging and lets the same
 * geometry be used for every animation-frame paint without React state.
 */
function selectOverlayAnchor(position: Pick<OverlayPosition, 'left' | 'top'>, width: number, height: number, targetX: number, targetY: number): OverlayAnchor {
  const candidates: OverlayAnchor[] = [
    { side: 'top', x: position.left + width / 2, y: position.top },
    { side: 'bottom', x: position.left + width / 2, y: position.top + height },
    { side: 'left', x: position.left, y: position.top + height / 2 },
    { side: 'right', x: position.left + width, y: position.top + height / 2 },
  ]
  let nearest = candidates[0]
  let nearestDistance = Number.POSITIVE_INFINITY
  candidates.forEach((candidate) => {
    const dx = candidate.x - targetX
    const dy = candidate.y - targetY
    const distance = dx * dx + dy * dy
    if (distance < nearestDistance) {
      nearest = candidate
      nearestDistance = distance
    }
  })
  return nearest
}

function readPins() {
  try { return new Set<string>(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')) } catch { return new Set<string>() }
}
function writePins(value: Set<string>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...value])) } catch {}
}
function isExecuting(session: OverlaySession) { return session.active }

function visibleOverlayEntries(raw: AnyEntry[]): AnyEntry[] {
  const source = Array.isArray(raw) ? raw : []
  const merged = mergeBashToolResultItems(source.slice(-80), Math.max(0, source.length - 80))
  return merged.filter((item) => !isHiddenJsonlNoiseEntry(item.entry)).slice(-10).map((item) => item.entry)
}

function SessionOverlay({ session, state, compact, setState, onClose, onOpenSession, positionRef, transformRef, register }: { session: OverlaySession; state: OverlayState; compact: boolean; setState: (updater: (prev: OverlayState) => OverlayState) => void; onClose: () => void; onOpenSession: () => void; positionRef: MutableRefObject<Record<string, OverlayPosition>>; transformRef: MutableRefObject<OverlayTransform>; register: (id: string, panel: HTMLDivElement | null, line: SVGLineElement | null) => void }) {
  const [mentionDrawerOpen, setMentionDrawerOpen] = useState(false)
  const [selectedAgentMentions, setSelectedAgentMentions] = useState<Array<{ sessionId: string; name: string; mode: AgentMentionMode }>>([])
  const start = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const lineRef = useRef<SVGLineElement | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const mentionRangeRef = useRef<{ start: number; end: number } | null>(null)
  const composingRef = useRef(false)
  const inputRecallRef = useRef<{ active: boolean; index: number; entries: SessionInputEntry[]; timer: ReturnType<typeof setTimeout> | null; fetching: boolean }>({ active: false, index: -1, entries: [], timer: null, fetching: false })
  const liveDataRef = useRef(false)
  const setStateRef = useRef(setState)
  useEffect(() => { setStateRef.current = setState }, [setState])
  useEffect(() => {
    const recall = inputRecallRef.current
    if (recall.timer) clearTimeout(recall.timer)
    recall.active = false
    recall.index = -1
    recall.entries = []
    recall.fetching = false
    preloadSessionInputCache(session.id)
    return () => { if (recall.timer) clearTimeout(recall.timer) }
  }, [session.id])
  useEffect(() => { register(session.id, panelRef.current, lineRef.current); return () => register(session.id, null, null) }, [register, session.id])
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data: any = await api(`/api/sessions/${encodeURIComponent(session.id)}/jsonl-history?tail_count=80`, signal ? { signal } : undefined)
      const raw = Array.isArray(data) ? data : (data?.entries || data?.jsonl || [])
      if (signal?.aborted) return
      liveDataRef.current = true
      const visible = visibleOverlayEntries(raw)
      writeJsonlCache(session.id, raw, Number(data?.total || raw.length), typeof data?.path === 'string' ? data.path : null)
      setStateRef.current((prev) => ({ ...prev, entries: visible, error: undefined }))
    } catch (e: any) {
      // A timed-out polling request is expected and should not surface as an error or
      // trigger another React render. pollRecursive aborts these requests after 10s.
      if (signal?.aborted || e?.name === 'AbortError' || /\babort(ed)?\b/i.test(String(e?.message || ''))) return
      setStateRef.current((prev) => ({ ...prev, error: e?.message || '读取失败' }))
    }
  }, [session.id])
  useEffect(() => {
    liveDataRef.current = false
    const cached = readJsonlCacheSync(session.id)
    if (cached?.entries?.length) setStateRef.current((prev) => ({ ...prev, entries: visibleOverlayEntries(cached.entries) }))
    let cancelled = false
    void readJsonlCacheFromIdb(session.id).then((cachedIdb) => {
      if (cancelled || liveDataRef.current || !cachedIdb?.entries?.length) return
      setStateRef.current((prev) => ({ ...prev, entries: visibleOverlayEntries(cachedIdb.entries) }))
    })
    const stop = pollRecursive((signal) => load(signal), 10_000)
    return () => { cancelled = true; stop() }
  }, [load, session.id])
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = messagesRef.current
      if (element) element.scrollTop = element.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [state.entries])
  const send = async () => {
    const text = state.draft.trim(); if (!text || state.sending) return
    const sentMentions = selectedAgentMentions
    const requestId = `overview-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const optimisticEntry: AnyEntry = {
      uuid: `overview-optimistic-${requestId}`,
      type: 'user',
      timestamp: new Date().toISOString(),
      request_id: requestId,
      message: { role: 'user', content: text },
    }
    // Match the main chat composer: acknowledge the submit immediately instead of
    // waiting for the POST response before changing the editor or message list.
    setState((prev) => ({
      ...prev,
      draft: '',
      sending: true,
      error: undefined,
      entries: [...prev.entries, optimisticEntry].slice(-10),
    }))
    setSelectedAgentMentions([])
    prependSessionInputCache(session.id, text, requestId)
    try {
      const mentions = sentMentions.map((mention) => ({ kind: 'agent', session_id: mention.sessionId, mode: mention.mode, name: mention.name }))
      await api(`/api/sessions/${encodeURIComponent(session.id)}/messages`, { method: 'POST', body: JSON.stringify({ content: text, input_text: text, request_id: requestId, mentions }) })
      setState((prev) => ({ ...prev, sending: false }))
      await load()
    } catch (e: any) {
      setState((prev) => ({
        ...prev,
        // Preserve a new draft typed while the request was in flight.
        draft: prev.draft.trim() ? prev.draft : text,
        sending: false,
        error: e?.message || '发送失败',
      }))
      setSelectedAgentMentions((current) => current.length ? current : sentMentions)
    }
  }
  const onPaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files || [])
    if (!files.length) return
    event.preventDefault()
    try {
      const uploaded = await Promise.all(files.map((file) => uploadAttachmentFile(file, session.projectId)))
      const paths = uploaded.map((item) => item.path).filter(Boolean)
      setState((prev) => ({ ...prev, draft: `${prev.draft}${prev.draft ? '\n' : ''}${paths.join('\n')}` }))
    } catch (e: any) { setState((prev) => ({ ...prev, error: e?.message || '文件上传失败' })) }
  }
  const insertDrawerText = (value: string) => {
    const currentValue = inputRef.current?.value ?? state.draft
    const range = mentionRangeRef.current
    const start = range?.start ?? (inputRef.current?.selectionStart ?? currentValue.length)
    const end = range?.end ?? start
    const suffix = currentValue.slice(end)
    const trailingSpace = suffix && !/^\s/.test(suffix) ? ' ' : ''
    const nextValue = `${currentValue.slice(0, start)}${value}${trailingSpace}${suffix}`
    const caret = start + value.length + trailingSpace.length
    setState((prev) => ({ ...prev, draft: nextValue }))
    mentionRangeRef.current = null
    setMentionDrawerOpen(false)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      try { inputRef.current?.setSelectionRange(caret, caret) } catch {}
    })
  }
  const insertAgentMention = (agent: MentionAgentSession, mode: AgentMentionMode) => {
    const name = agent.name || agent.session_id
    insertDrawerText(`@${name}`)
    setSelectedAgentMentions((current) => {
      const next = { sessionId: agent.session_id, name, mode }
      return current.some((item) => item.sessionId === agent.session_id)
        ? current.map((item) => item.sessionId === agent.session_id ? next : item)
        : [...current, next]
    })
  }
  return <>
    <RemoteFileMentionDrawer
      projectId={session.projectId}
      issueId={session.parentKind === 'issue' ? session.parentId : undefined}
      researchId={session.parentKind === 'research' ? session.parentId : undefined}
      currentSessionId={session.id}
      open={mentionDrawerOpen}
      onClose={() => { mentionRangeRef.current = null; setMentionDrawerOpen(false) }}
      onPickPath={insertDrawerText}
      onPickAgent={insertAgentMention}
    />
    <svg className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible" aria-hidden="true">
      <line ref={lineRef} className="agent-conversation-overlay__connector" stroke={session.color} strokeOpacity="0.55" strokeWidth="1.2" strokeDasharray="4 5" strokeLinecap="round" />
    </svg>
    <div ref={panelRef} data-testid="agent-conversation-overlay" data-session-id={session.id} className={`agent-conversation-overlay absolute z-10 overflow-hidden border shadow-2xl backdrop-blur-xl ${compact ? 'agent-conversation-overlay--compact rounded-md' : 'rounded-xl'}`} style={{ left: 0, top: 0, width: compact ? COMPACT_OVERLAY_WIDTH : OVERLAY_WIDTH, transform: 'translate3d(24px,84px,0)', borderColor: `${session.color}66`, background: 'color-mix(in srgb, var(--modal-bg) 72%, transparent)', boxShadow: `0 16px 42px rgba(0,0,0,.35), 0 0 0 1px ${session.color}18 inset` }}>
      <div className={`flex cursor-grab items-center border-b active:cursor-grabbing ${compact ? 'h-4 gap-1 px-1' : 'h-8 gap-2 px-2.5'}`} style={{ borderColor: `${session.color}44`, background: `${session.color}16` }}
        onPointerDown={(event) => { const current = positionRef.current[session.id] || { left: 24, top: 84, targetX: 0, targetY: 0 }; start.current = { x: event.clientX, y: event.clientY, left: current.left, top: current.top }; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={(event) => { const s = start.current; if (!s) return; const clamped = clampOverlayPosition(s.left + event.clientX - s.x, s.top + event.clientY - s.y, transformRef.current, compact); const next = { ...(positionRef.current[session.id] || { targetX: 0, targetY: 0 }), ...clamped, manual: true }; positionRef.current[session.id] = next; panelRef.current?.style.setProperty('transform', `translate3d(${next.left}px,${next.top}px,0)`) }}
        onPointerUp={() => { start.current = null }}
        onPointerCancel={() => { start.current = null }}
        onLostPointerCapture={() => { start.current = null }}>
        <span className={compact ? 'h-1.5 w-1.5 rounded-full' : 'h-2 w-2 rounded-full'} style={{ background: session.color, boxShadow: `0 0 10px ${session.color}` }} />
        <span className="agent-conversation-overlay__title min-w-0 flex-1 truncate font-semibold" style={{ color: 'var(--text-primary)' }}>{session.title}</span>
        <button type="button" aria-label={state.pinned ? '取消固定浮窗' : '固定浮窗'} title={state.pinned ? '取消固定' : '固定'} className={`rounded transition-colors hover:bg-white/10 ${compact ? 'p-0.5' : 'p-1'}`} style={{ color: state.pinned ? session.color : 'var(--text-muted)' }} onPointerDown={(e) => e.stopPropagation()} onClick={() => setState((prev) => ({ ...prev, pinned: !prev.pinned }))}>{state.pinned ? <Pin className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} /> : <PinOff className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />}</button>
        <button type="button" aria-label="打开 Session 页面" title="打开 Session 页面" className={`rounded transition-colors hover:bg-white/10 ${compact ? 'p-0.5' : 'p-1'}`} style={{ color: 'var(--text-muted)' }} onPointerDown={(e) => e.stopPropagation()} onClick={onOpenSession}><ArrowUpRight className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} /></button>
        <button type="button" aria-label="关闭对话浮窗" title="关闭" className={`rounded transition-colors hover:bg-white/10 ${compact ? 'p-0.5' : 'p-1'}`} style={{ color: 'var(--text-muted)' }} onPointerDown={(e) => e.stopPropagation()} onClick={onClose}><X className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} /></button>
      </div>
      <div ref={messagesRef} data-testid="agent-conversation-messages" className={`overflow-y-auto ${compact ? 'max-h-[140px] space-y-0.5 px-1 py-1' : 'max-h-[280px] space-y-1 px-2 py-2'}`} style={{ scrollbarWidth: 'thin' }}>
        {state.entries.length === 0 ? <div className={`agent-conversation-overlay__empty ${compact ? 'py-3' : 'py-6'} text-center`} style={{ color: 'var(--text-muted)' }}>等待最新消息…</div> : state.entries.map((entry, index) => <div key={`${entry.uuid || entry.id || entry.timestamp || index}`} className={compact ? '[&_.jsonl-entry-card]:!mb-0.5 [&_.jsonl-entry-card]:!rounded' : '[&_.jsonl-entry-card]:!mb-1 [&_.jsonl-entry-card]:!rounded-md [&_.jsonl-entry-card_summary]:!px-2 [&_.jsonl-entry-card_summary]:!py-1'}><EntryCardWithImages entry={entry} lineNo={index + 1} showMeta={false} dense={compact} parentOrderedCollapse /></div>)}
      </div>
      <div className="mobius-chat-input border-t" style={{ borderColor: `${session.color}33`, background: 'transparent' }}>
        <div className={`mobius-chat-input-editor min-w-0 flex-shrink-0 ${compact ? 'p-1' : 'p-2'}`}>
          {selectedAgentMentions.length > 0 && (
            <div className={`${compact ? 'mb-1 max-h-8 gap-0.5' : 'mb-1.5 max-h-14 gap-1'} flex flex-wrap overflow-y-auto`}>
              {selectedAgentMentions.map((mention) => (
                <span key={mention.sessionId} className={`agent-conversation-overlay__mention inline-flex max-w-full items-center rounded border ${compact ? 'gap-0.5 px-1 py-0' : 'gap-1 px-1.5 py-0.5'}`} style={{ borderColor: `${session.color}44`, color: 'var(--text-secondary)', background: `${session.color}12` }}>
                  <Bot className={compact ? 'h-2.5 w-2.5 flex-shrink-0' : 'h-3 w-3 flex-shrink-0'} />
                  <span className={compact ? 'max-w-16 truncate' : 'max-w-32 truncate'}>@{mention.name}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{mention.mode === 'bidirectional' ? '双向' : '只读'}</span>
                  <button type="button" aria-label={`移除引用 ${mention.name}`} onClick={() => setSelectedAgentMentions((current) => current.filter((item) => item.sessionId !== mention.sessionId))} className="rounded p-0.5 hover:bg-white/10"><X className={compact ? 'h-2 w-2' : 'h-2.5 w-2.5'} /></button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={state.draft}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={() => { composingRef.current = false }}
            onChange={(event) => {
              const value = event.target.value
              const caret = event.target.selectionStart ?? value.length
              setState((prev) => ({ ...prev, draft: value }))
              if (value.slice(0, caret).endsWith('@')) {
                mentionRangeRef.current = { start: caret - 1, end: caret }
                setMentionDrawerOpen(true)
              } else {
                mentionRangeRef.current = null
                setMentionDrawerOpen(false)
              }
            }}
            onPaste={onPaste}
            onKeyDown={async (event) => {
              if (event.key === 'ArrowUp' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
                const recall = inputRecallRef.current
                const put = (index: number) => {
                  const item = recall.entries[index]
                  const text = typeof item?.input_text === 'string' && item.input_text.trim() ? item.input_text : (item?.content || '')
                  if (!text) return false
                  recall.index = index
                  recall.active = true
                  setState((prev) => ({ ...prev, draft: text }))
                  requestAnimationFrame(() => { const el = inputRef.current; if (el) { el.focus(); try { el.setSelectionRange(text.length, text.length) } catch {} } })
                  if (recall.timer) clearTimeout(recall.timer)
                  recall.timer = setTimeout(() => { recall.active = false; recall.index = -1; recall.timer = null }, 2000)
                  return true
                }
                if (recall.active) {
                  event.preventDefault()
                  put(Math.min(recall.index + 1, recall.entries.length - 1))
                  return
                }
                if (event.currentTarget.value.trim()) return
                event.preventDefault()
                const cached = readSessionInputCache(session.id)
                if (cached?.length) {
                  recall.entries = cached.filter((item) => ((item.input_text || item.content || '').trim().length > 0))
                  if (recall.entries.length) put(0)
                  return
                }
                if (recall.fetching) return
                recall.fetching = true
                try {
                  const entries = await refreshSessionInputCache(session.id)
                  if (!inputRef.current?.value.trim()) {
                    recall.entries = entries.filter((item) => ((item.input_text || item.content || '').trim().length > 0))
                    if (recall.entries.length) put(0)
                  }
                } catch {} finally { recall.fetching = false }
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                const nativeEvent = event.nativeEvent as KeyboardEvent
                if (composingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) return
                event.preventDefault()
                void send()
              }
            }}
            placeholder="发送指令… @引用 · ↑回溯"
            className={`agent-conversation-overlay__input w-full resize-none bg-transparent px-1 outline-none placeholder:text-[var(--text-muted)] ${compact ? 'min-h-[24px] py-0 leading-3' : 'min-h-[42px] py-1 leading-5'}`}
            style={{ color: 'var(--text-primary)' }}
          />
          <div className={`flex items-center justify-between ${compact ? 'pt-0.5' : 'pt-1'}`}>
            <span className="agent-conversation-overlay__status truncate" style={{ color: state.error ? '#f87171' : state.sending ? session.color : 'var(--text-muted)' }}>{state.error || (state.sending ? '发送中…' : `${session.projectName} · 最近 ${state.entries.length} 条`)}</span>
            <div className="flex items-center gap-1">
              <label className={`cursor-pointer rounded transition-colors hover:bg-white/10 ${compact ? 'p-0.5' : 'p-1.5'}`} title="粘贴或选择文件" style={{ color: 'var(--text-muted)' }}>
                <Paperclip className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
                <input type="file" multiple className="hidden" onChange={async (event) => { const files = Array.from(event.target.files || []); if (!files.length) return; try { const uploaded = await Promise.all(files.map((file) => uploadAttachmentFile(file, session.projectId))); setState((prev) => ({ ...prev, draft: `${prev.draft}${prev.draft ? '\n' : ''}${uploaded.map((item) => item.path).join('\n')}` })) } catch (error: any) { setState((prev) => ({ ...prev, error: error?.message || '文件上传失败' })) } event.currentTarget.value = '' }} />
              </label>
              <button type="button" aria-label={state.sending ? '发送中' : '发送指令'} title={state.sending ? '发送中…' : '发送指令'} disabled={state.sending || !state.draft.trim()} onClick={() => { void send() }} className={`rounded-md transition-colors disabled:opacity-40 ${compact ? 'p-0.5' : 'p-1.5'}`} style={{ color: session.color, background: `${session.color}18` }}>{state.sending ? <RefreshCw className={`${compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} animate-spin`} /> : <Send className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </>
}

export function AgentConversationOverlays({ sessions, enabled, compact, modelRef, transformRef, onClose, onOpenSession }: AgentConversationOverlaysProps) {
  const [pins, setPins] = useState<Set<string>>(readPins)
  const [states, setStates] = useState<Record<string, OverlayState>>({})
  const positionRef = useRef<Record<string, OverlayPosition>>({})
  const elementRefs = useRef<Record<string, { panel: HTMLDivElement | null; line: SVGLineElement | null; height: number; observer?: ResizeObserver }>>({})
  const attractionTargetsRef = useRef<{
    key: string
    width: number
    height: number
    zoom: number
    offsetX: number
    offsetY: number
    compact: boolean
    targets: Map<string, OverlayAttractionTarget>
    transitionFrom: Map<string, OverlayAttractionTarget>
    transitionTo: Map<string, OverlayAttractionTarget>
    center: ScreenPoint
    transitionFromCenter: ScreenPoint
    transitionToCenter: ScreenPoint
    transitionStartedAt: number
    lastUpdateAt: number
  }>({ key: '', width: 0, height: 0, zoom: 0, offsetX: 0, offsetY: 0, compact, targets: new Map(), transitionFrom: new Map(), transitionTo: new Map(), center: { x: 0, y: 0 }, transitionFromCenter: { x: 0, y: 0 }, transitionToCenter: { x: 0, y: 0 }, transitionStartedAt: 0, lastUpdateAt: 0 })
  const knownSessionsRef = useRef<Record<string, OverlaySession>>({})
  sessions.forEach((session) => { knownSessionsRef.current[session.id] = session })
  const setSessionState = (id: string, updater: (prev: OverlayState) => OverlayState) => setStates((prev) => ({ ...prev, [id]: updater(prev[id] || { pinned: pins.has(id), entries: [], draft: '', sending: false }) }))
  const openSessions = useMemo(() => {
    if (!enabled) return []
    const merged = new Map<string, OverlaySession>()
    sessions.forEach((session) => merged.set(session.id, session))
    pins.forEach((id) => { const previous = knownSessionsRef.current[id]; if (previous) merged.set(id, { ...previous, active: false }) })
    return [...merged.values()].filter((session) => isExecuting(session) || pins.has(session.id))
  }, [enabled, sessions, pins])
  useEffect(() => { setStates((prev) => { const next = { ...prev }; openSessions.forEach((s) => { if (!next[s.id]) next[s.id] = { pinned: pins.has(s.id), entries: [], draft: '', sending: false } }); return next }) }, [openSessions, pins])
  useEffect(() => { writePins(pins) }, [pins])
  useEffect(() => {
    const onPin = (event: Event) => {
      const id = (event as CustomEvent).detail?.sessionId
      if (!id) return
      setPins((current) => { const next = new Set(current); next.add(id); return next })
      setStates((current) => ({ ...current, [id]: { ...(current[id] || { entries: [], draft: '', sending: false }), pinned: true } }))
    }
    window.addEventListener('mobius:pin-overlay', onPin)
    return () => window.removeEventListener('mobius:pin-overlay', onPin)
  }, [])
  const register = useCallback((id: string, panel: HTMLDivElement | null, line: SVGLineElement | null) => {
    const previous = elementRefs.current[id]
    if (!panel && !line) {
      previous?.observer?.disconnect()
      delete elementRefs.current[id]
      delete positionRef.current[id]
      return
    }
    if (previous?.panel === panel && previous?.line === line) return
    previous?.observer?.disconnect()
    const record = { panel, line, height: panel?.offsetHeight || previous?.height || 0, observer: undefined as ResizeObserver | undefined }
    if (panel && typeof ResizeObserver !== 'undefined') {
      record.observer = new ResizeObserver(() => { record.height = panel.offsetHeight })
      record.observer.observe(panel)
    }
    elementRefs.current[id] = record
  }, [])
  useEffect(() => {
    if (!enabled || openSessions.length === 0) return
    let frame = 0
    let lastPaint = 0
    const tick = (now: number) => {
      // Position updates are intentionally kept outside React state. The overlay cards are
      // relatively expensive; reconciling them on every animation frame was the source of
      // severe jank and browser crashes when several sessions were visible.
      if (now - lastPaint >= 16) {
        lastPaint = now
        const t = transformRef.current
        const nodeById = new Map<string, any>()
        modelRef.current.nodes.forEach((node: any) => { if (node?.id) nodeById.set(node.id, node) })
        const overlayWidth = compact ? COMPACT_OVERLAY_WIDTH : OVERLAY_WIDTH
        const targetKey = openSessions.map((session) => `${session.id}:${elementRefs.current[session.id]?.height || 0}`).join('|')
        const targetCache = attractionTargetsRef.current
        const zoomChanged = Math.abs(targetCache.zoom - t.zoom) > 1e-4
        const offsetChanged = targetCache.offsetX !== t.offset.x || targetCache.offsetY !== t.offset.y
        if (targetCache.transitionTo.size > 0) {
          const rawProgress = Math.min(1, Math.max(0, (now - targetCache.transitionStartedAt) / OVERLAY_ATTRACTION_TRANSITION_MS))
          const smoothProgress = rawProgress * rawProgress * (3 - 2 * rawProgress)
          interpolateAttractionTargets(targetCache.targets, targetCache.transitionFrom, targetCache.transitionTo, smoothProgress)
          targetCache.center = {
            x: targetCache.transitionFromCenter.x + (targetCache.transitionToCenter.x - targetCache.transitionFromCenter.x) * smoothProgress,
            y: targetCache.transitionFromCenter.y + (targetCache.transitionToCenter.y - targetCache.transitionFromCenter.y) * smoothProgress,
          }
        }
        if (offsetChanged && targetCache.targets.size > 0) {
          // A pure canvas pan should carry the cached initial/attraction points
          // and both ends of an active transition with the viewport.
          const dx = t.offset.x - targetCache.offsetX
          const dy = t.offset.y - targetCache.offsetY
          shiftAttractionTargets(targetCache.targets, dx, dy)
          shiftAttractionTargets(targetCache.transitionFrom, dx, dy)
          shiftAttractionTargets(targetCache.transitionTo, dx, dy)
          targetCache.center = { x: targetCache.center.x + dx, y: targetCache.center.y + dy }
          targetCache.transitionFromCenter = { x: targetCache.transitionFromCenter.x + dx, y: targetCache.transitionFromCenter.y + dy }
          targetCache.transitionToCenter = { x: targetCache.transitionToCenter.x + dx, y: targetCache.transitionToCenter.y + dy }
        }
        const structureChanged = targetCache.key !== targetKey || targetCache.width !== t.width || targetCache.height !== t.height || targetCache.compact !== compact || zoomChanged
        if (targetCache.targets.size === 0 || structureChanged || now - targetCache.lastUpdateAt >= OVERLAY_ATTRACTION_UPDATE_MS) {
          const heights = new Map<string, number>()
          openSessions.forEach((session) => { heights.set(session.id, elementRefs.current[session.id]?.height || (compact ? 210 : 390)) })
          const nextLayout = computeOverlayAttractionTargets(openSessions, nodeById, t, compact, heights)
          const initial = targetCache.targets.size === 0
          const transitionFrom = new Map<string, OverlayAttractionTarget>()
          nextLayout.targets.forEach((target, id) => { transitionFrom.set(id, initial ? target : (targetCache.targets.get(id) || target)) })
          targetCache.targets = transitionFrom
          targetCache.transitionFrom = new Map(transitionFrom)
          targetCache.transitionTo = nextLayout.targets
          targetCache.transitionFromCenter = initial ? nextLayout.center : targetCache.center
          targetCache.transitionToCenter = nextLayout.center
          targetCache.center = targetCache.transitionFromCenter
          targetCache.transitionStartedAt = now
          targetCache.lastUpdateAt = now
          targetCache.key = targetKey
          targetCache.width = t.width
          targetCache.height = t.height
          targetCache.zoom = t.zoom
          targetCache.compact = compact
        }
        targetCache.offsetX = t.offset.x
        targetCache.offsetY = t.offset.y
        const layouts = openSessions.map((session, index): OverlayLayoutItem => {
          const node = nodeById.get(session.id)
          const targetX = node ? node.x * t.zoom + t.offset.x : 120 + (index % 3) * 330
          const targetY = node ? node.y * t.zoom + t.offset.y + CANVAS_TOP_OFFSET : 120 + Math.floor(index / 3) * 230 + CANVAS_TOP_OFFSET
          const elements = elementRefs.current[session.id]
          const overlayHeight = elements?.height || (compact ? 210 : 390)
          const automatic = targetCache.targets.get(session.id) || clampAutoOverlayPosition(targetX + 18, targetY - 30, overlayWidth, overlayHeight, t)
          const previous = positionRef.current[session.id]
          const manualPosition = previous?.manual ? clampOverlayPosition(previous.left, previous.top, t, compact) : null
          const trackedPosition = previous && !previous.manual
            ? {
                // Keep the overlay attached to the moving/panned node while
                // the cached edge target provides the slow restoring force.
                left: previous.left + targetX - previous.targetX,
                top: previous.top + targetY - previous.targetY,
              }
            : automatic
          const restingPosition = clampAutoOverlayPosition(
            trackedPosition.left + (automatic.left - trackedPosition.left) * OVERLAY_ANCHOR_PULL,
            trackedPosition.top + (automatic.top - trackedPosition.top) * OVERLAY_ANCHOR_PULL,
            overlayWidth,
            overlayHeight,
            t,
          )
          return {
            id: session.id,
            left: manualPosition?.left ?? restingPosition.left,
            top: manualPosition?.top ?? restingPosition.top,
            targetX,
            targetY,
            width: overlayWidth,
            height: overlayHeight,
            manual: Boolean(previous?.manual),
          }
        })
        const resolved = resolveOverlayCollisions(layouts, {
          left: 8,
          top: CANVAS_TOP_OFFSET + 8,
          right: t.width - 8,
          bottom: CANVAS_TOP_OFFSET + t.height - 8,
        }, compact ? COMPACT_OVERLAY_COLLISION_GAP : OVERLAY_COLLISION_GAP, OVERLAY_COLLISION_PASSES, OVERLAY_COLLISION_STRENGTH, compact ? COMPACT_OVERLAY_COLLISION_MAX_PUSH : OVERLAY_COLLISION_MAX_PUSH)
        resolved.forEach((next) => {
          positionRef.current[next.id] = next
          const elements = elementRefs.current[next.id]
          elements?.panel?.style.setProperty('transform', `translate3d(${next.left}px,${next.top}px,0)`)
          const anchor = selectOverlayAnchor(next, next.width, next.height, next.targetX, next.targetY)
          // The SVG path starts at the agent node and ends at the selected
          // overlay side, so the animated dash visibly travels toward the
          // conversation window.
          elements?.line?.setAttribute('x1', String(next.targetX))
          elements?.line?.setAttribute('y1', String(next.targetY))
          elements?.line?.setAttribute('x2', String(anchor.x))
          elements?.line?.setAttribute('y2', String(anchor.y))
        })
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [compact, enabled, openSessions, modelRef, transformRef])
  if (!enabled) return null
  return <div className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">{openSessions.map((session) => <div key={session.id} className="pointer-events-auto"><SessionOverlay session={session} compact={compact} state={states[session.id] || { pinned: pins.has(session.id), entries: [], draft: '', sending: false }} setState={(updater) => { setSessionState(session.id, (prev) => { const next = updater(prev); if (next.pinned !== prev.pinned) { setPins((current) => { const copy = new Set(current); if (next.pinned) copy.add(session.id); else copy.delete(session.id); return copy }) } return next }) }} onClose={() => { if (pins.has(session.id)) setPins((current) => { const copy = new Set(current); copy.delete(session.id); return copy }); onClose(session.id) }} onOpenSession={() => onOpenSession(session)} positionRef={positionRef} transformRef={transformRef} register={register} /></div>)}</div>
}
