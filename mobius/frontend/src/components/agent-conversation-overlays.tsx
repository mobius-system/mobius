import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Paperclip, Pin, PinOff, Send, X } from 'lucide-react'
import { api } from '../store'
import { uploadAttachmentFile } from './attachments'
import { EntryCardWithImages } from './viewer/RoundGroups'
import { mergeBashToolResultItems } from './viewer/entry-extract'
import { isHiddenJsonlNoiseEntry } from './viewer/entry-classify'
import { pollRecursive } from '../services/polling'
import type { AnyEntry } from './viewer/types'

type OverlaySession = { id: string; title: string; projectId: string; projectName: string; color: string; x: number; y: number; active: boolean }
type OverlayTransform = { offset: { x: number; y: number }; zoom: number; width: number; height: number }

export type AgentConversationOverlaysProps = {
  sessions: OverlaySession[]
  enabled: boolean
  modelRef: MutableRefObject<{ nodes: any[] }>
  transformRef: MutableRefObject<OverlayTransform>
  onClose: (sessionId: string) => void
}

type OverlayState = { pinned: boolean; entries: AnyEntry[]; draft: string; sending: boolean; attached?: string[]; error?: string }
const STORAGE_KEY = 'mobius:overview-conversation-pins'

function readPins() {
  try { return new Set<string>(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')) } catch { return new Set<string>() }
}
function writePins(value: Set<string>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...value])) } catch {}
}
function isExecuting(session: OverlaySession) { return session.active }

function SessionOverlay({ session, state, setState, onClose, position }: { session: OverlaySession; state: OverlayState; setState: (updater: (prev: OverlayState) => OverlayState) => void; onClose: () => void; position: { left: number; top: number; targetX?: number; targetY?: number } }) {
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const [pos, setPos] = useState(position)
  const [mentionOpen, setMentionOpen] = useState(false)
  const start = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  useEffect(() => { if (!drag) setPos(position) }, [position, drag])
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data: any = await api(`/api/sessions/${encodeURIComponent(session.id)}/jsonl-history?from=0&limit=80`, signal ? { signal } : undefined)
      const raw = Array.isArray(data) ? data : (data?.entries || data?.jsonl || [])
      const merged = mergeBashToolResultItems(raw.slice(-80), Math.max(0, raw.length - 80))
      const visible = merged.filter((item) => !isHiddenJsonlNoiseEntry(item.entry)).slice(-10).map((item) => item.entry)
      setState((prev) => ({ ...prev, entries: visible }))
    } catch (e: any) { setState((prev) => ({ ...prev, error: e?.message || '读取失败' })) }
  }, [session.id, setState])
  useEffect(() => { load(); const stop = pollRecursive((signal) => load(signal), 10_000); return stop }, [load])
  const send = async () => {
    const text = state.draft.trim(); if (!text || state.sending) return
    setState((prev) => ({ ...prev, sending: true, error: undefined }))
    try {
      await api(`/api/sessions/${encodeURIComponent(session.id)}/messages`, { method: 'POST', body: JSON.stringify({ content: text, input_text: text, request_id: `overview-${Date.now()}-${Math.random().toString(16).slice(2)}` }) })
      setState((prev) => ({ ...prev, draft: '', sending: false }))
      await load()
    } catch (e: any) { setState((prev) => ({ ...prev, sending: false, error: e?.message || '发送失败' })) }
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
  return <>
    <svg className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible" aria-hidden="true">
      <line x1={position.left + 154} y1={position.top + 4} x2={position.targetX ?? position.left - 18} y2={position.targetY ?? position.top + 30} stroke={session.color} strokeOpacity="0.55" strokeWidth="1.2" strokeDasharray="4 5" />
    </svg>
    <div className="absolute z-10 w-[312px] overflow-hidden rounded-xl border shadow-2xl backdrop-blur-xl" style={{ left: pos.left, top: pos.top, borderColor: `${session.color}66`, background: 'color-mix(in srgb, var(--modal-bg) 72%, transparent)', boxShadow: `0 16px 42px rgba(0,0,0,.35), 0 0 0 1px ${session.color}18 inset` }}>
      <div className="flex h-8 cursor-grab items-center gap-2 border-b px-2.5 active:cursor-grabbing" style={{ borderColor: `${session.color}44`, background: `${session.color}16` }}
        onPointerDown={(event) => { start.current = { x: event.clientX, y: event.clientY, left: pos.left, top: pos.top }; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={(event) => { const s = start.current; if (!s) return; setDrag({ x: event.clientX, y: event.clientY }); setPos({ left: s.left + event.clientX - s.x, top: s.top + event.clientY - s.y }) }}
        onPointerUp={() => { start.current = null; setDrag(null) }}>
        <span className="h-2 w-2 rounded-full" style={{ background: session.color, boxShadow: `0 0 10px ${session.color}` }} />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>{session.title}</span>
        <button type="button" aria-label={state.pinned ? '取消固定浮窗' : '固定浮窗'} title={state.pinned ? '取消固定' : '固定'} className="rounded p-1 transition-colors hover:bg-white/10" style={{ color: state.pinned ? session.color : 'var(--text-muted)' }} onPointerDown={(e) => e.stopPropagation()} onClick={() => setState((prev) => ({ ...prev, pinned: !prev.pinned }))}>{state.pinned ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}</button>
        <button type="button" aria-label="关闭对话浮窗" title="关闭" className="rounded p-1 transition-colors hover:bg-white/10" style={{ color: 'var(--text-muted)' }} onPointerDown={(e) => e.stopPropagation()} onClick={onClose}><X className="h-3.5 w-3.5" /></button>
      </div>
      <div className="max-h-[280px] space-y-1 overflow-y-auto px-2 py-2" style={{ scrollbarWidth: 'thin' }}>
        {state.entries.length === 0 ? <div className="py-6 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>等待最新消息…</div> : state.entries.map((entry, index) => <div key={`${entry.uuid || entry.id || entry.timestamp || index}`} className="[&_.jsonl-entry-card]:!mb-1 [&_.jsonl-entry-card]:!rounded-md [&_.jsonl-entry-card_summary]:!px-2 [&_.jsonl-entry-card_summary]:!py-1"><EntryCardWithImages entry={entry} lineNo={index + 1} showMeta={false} parentOrderedCollapse /></div>)}
      </div>
      <div className="border-t p-2" style={{ borderColor: `${session.color}33` }}>
        <div className="relative"><textarea value={state.draft} onChange={(e) => { const value = e.target.value; setState((prev) => ({ ...prev, draft: value })); setMentionOpen(value.endsWith('@')) }} onPaste={onPaste} onKeyDown={async (e) => { if (e.key === 'ArrowUp' && !e.shiftKey && !e.currentTarget.value) { e.preventDefault(); try { const data: any = await api(`/api/sessions/${encodeURIComponent(session.id)}/inputs`); const items = Array.isArray(data) ? data : (data?.inputs || []); const text = items.map((item: any) => item?.input_text || item?.content || '').filter(Boolean)[0]; if (text) setState((prev) => ({ ...prev, draft: text })) } catch {} } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} placeholder="发送指令… @引用 · ↑回溯" className="min-h-[42px] w-full resize-none bg-transparent px-1 py-1 text-[12px] leading-5 outline-none placeholder:text-[var(--text-muted)]" style={{ color: 'var(--text-primary)' }} />{mentionOpen && <div className="absolute bottom-full left-0 right-0 mb-1 rounded-md border p-1 shadow-lg" style={{ borderColor: 'var(--border-color)', background: 'var(--modal-bg)' }}><button type="button" className="w-full rounded px-2 py-1 text-left text-[11px] hover:bg-[var(--bg-hover)]" onClick={() => { setState((prev) => ({ ...prev, draft: `${prev.draft.slice(0, -1)}@${session.title} ` })); setMentionOpen(false) }}>@{session.title}</button></div>}</div>
        <div className="flex items-center justify-between pt-1"><span className="truncate text-[10px]" style={{ color: state.error ? '#f87171' : 'var(--text-muted)' }}>{state.error || `${session.projectName} · 最近 ${state.entries.length} 条`}</span><div className="flex items-center gap-1"><label className="cursor-pointer rounded p-1.5 transition-colors hover:bg-white/10" title="粘贴或选择文件" style={{ color: 'var(--text-muted)' }}><Paperclip className="h-3.5 w-3.5" /><input type="file" multiple className="hidden" onChange={async (e) => { const files = Array.from(e.target.files || []); if (!files.length) return; try { const uploaded = await Promise.all(files.map((file) => uploadAttachmentFile(file, session.projectId))); setState((prev) => ({ ...prev, draft: `${prev.draft}${prev.draft ? '\n' : ''}${uploaded.map((item) => item.path).join('\n')}` })) } catch (err: any) { setState((prev) => ({ ...prev, error: err?.message || '文件上传失败' })) } e.currentTarget.value = '' }} /></label><button type="button" aria-label="发送指令" disabled={state.sending || !state.draft.trim()} onClick={send} className="rounded-md p-1.5 transition-colors disabled:opacity-40" style={{ color: session.color, background: `${session.color}18` }}><Send className="h-3.5 w-3.5" /></button></div></div>
      </div>
    </div>
  </>
}

export function AgentConversationOverlays({ sessions, enabled, modelRef, transformRef, onClose }: AgentConversationOverlaysProps) {
  const [pins, setPins] = useState<Set<string>>(readPins)
  const [states, setStates] = useState<Record<string, OverlayState>>({})
  const [positions, setPositions] = useState<Record<string, { left: number; top: number; targetX: number; targetY: number }>>({})
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
  useEffect(() => { let frame = 0; const tick = () => { const t = transformRef.current; const next: Record<string, { left: number; top: number; targetX: number; targetY: number }> = {}; openSessions.forEach((session, index) => { const node = modelRef.current.nodes.find((n: any) => n.id === session.id); const x = node ? node.x * t.zoom + t.offset.x : 120 + (index % 3) * 330; const y = node ? node.y * t.zoom + t.offset.y : 120 + Math.floor(index / 3) * 230; next[session.id] = { left: Math.max(8, Math.min(t.width - 320, x + 18)), top: Math.max(68, Math.min(t.height - 180, y - 30)), targetX: x, targetY: y } }); setPositions(next); frame = requestAnimationFrame(tick) }; frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame) }, [openSessions, modelRef, transformRef])
  if (!enabled) return null
  return <div className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">{openSessions.map((session) => <div key={session.id} className="pointer-events-auto"><SessionOverlay session={session} state={states[session.id] || { pinned: pins.has(session.id), entries: [], draft: '', sending: false }} setState={(updater) => { setSessionState(session.id, (prev) => { const next = updater(prev); if (next.pinned !== prev.pinned) { setPins((current) => { const copy = new Set(current); if (next.pinned) copy.add(session.id); else copy.delete(session.id); return copy }) } return next }) }} onClose={() => { if (pins.has(session.id)) setPins((current) => { const copy = new Set(current); copy.delete(session.id); return copy }); onClose(session.id) }} position={positions[session.id] || { left: 24, top: 84 }} /></div>)}</div>
}
