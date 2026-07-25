/**
 * useChat — drives one Mobius chat session.
 *
 * Lifecycle (per the TUI spec):
 *   - lazily create a session (POST /api/issues/:issueId/sessions) on the first
 *     submitted message, using the saved preferences;
 *   - open the SSE stream (GET /api/sessions/:id/events?token=) and append
 *     `jsonl_entry` payloads to the transcript as they arrive;
 *   - mirror the agent's busy state from the `typing` event.
 * `/clear` remounts the hook (fresh session next time); `/resume` injects a
 * pre-existing sessionId so the stream replays its history.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MobiusClient, ApiError } from '../api.js'
import { SseConnection } from '../sse.js'
import { updateIssuePreference } from '../config.js'
import type { AnyEntry } from '../types.js'
import type { ReadyState } from '../components/PrepScreen.js'

export interface ChatApi {
  client: MobiusClient
  ready: ReadyState
  resumeSessionId?: string | null
}

export interface ChatController {
  entries: AnyEntry[]
  pendingUser: string | null
  typing: boolean
  sending: boolean
  error: string | null
  sessionId: string | null
  send: (text: string) => Promise<void>
  stop: () => Promise<void>
}

let ID = 0
function nextId(): number { ID += 1; return ID }

export function useChat({ client, ready, resumeSessionId }: ChatApi): ChatController {
  const [sessionId, setSessionId] = useState<string | null>(resumeSessionId ?? null)
  const [entries, setEntries] = useState<AnyEntry[]>([])
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sseRef = useRef<SseConnection | null>(null)
  const idCounter = useRef(0)

  const appendEntries = useCallback((newOnes: AnyEntry[]) => {
    if (!newOnes.length) return
    setEntries(prev => {
      const stamped = newOnes.map(e => ({ ...e, __id: e.__id ?? nextId() }))
      return [...prev, ...stamped]
    })
  }, [])

  const setHistory = useCallback((list: AnyEntry[]) => {
    setEntries(list.map(e => ({ ...e, __id: e.__id ?? nextId() })))
  }, [])

  // ── SSE connection ────────────────────────────────────────────────────────
  const connect = useCallback((sid: string) => {
    if (process.env.MOBIUS_TUI_DEBUG) console.error('[connect]', sid)
    sseRef.current?.close()
    const url = `${client.server}/api/sessions/${encodeURIComponent(sid)}/events?token=${encodeURIComponent(client.token)}`
    const conn = new SseConnection(url, {
      onHistoryEntries: (es, _done) => {
        if (es.length) setHistory(es)
      },
      onEntry: (entry) => {
        if (process.env.MOBIUS_TUI_DEBUG) console.error('[onEntry]', entry?.type, (entry?.message?.content?.[0]?.text ?? '').slice(0, 40))
        appendEntries([entry])
        setPendingUser(null)
      },
      onTyping: (active) => setTyping(active),
      onError: (msg) => setError(msg),
    })
    sseRef.current = conn
    conn.start()
  }, [client.server, client.token, appendEntries, setHistory])

  // Connect immediately when a resume session is provided, or after we create one.
  useEffect(() => {
    if (sessionId && !sseRef.current) connect(sessionId)
    return () => { /* keep connection across re-renders; closed on unmount */ }
  }, [sessionId, connect])

  useEffect(() => () => { sseRef.current?.close() }, [])

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionId) return sessionId
    const { project, issue, prefs } = ready
    const name = `TUI ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`
    const s = await client.createSession(issue.id, {
      name,
      model: prefs.model,
      language: prefs.language,
      excluded_skill_ids: prefs.excluded_skill_ids,
      excluded_memory_ids: prefs.excluded_memory_ids,
    })
    const sid = s.session_id
    setSessionId(sid)
    // persist the chosen model/language onto this issue for next time
    await updateIssuePreference(process.cwd(), issue.id, { model: prefs.model, language: prefs.language })
    return sid
  }, [sessionId, ready, client])

  const send = useCallback(async (text: string) => {
    const body = text.trim()
    if (!body || sending) return
    setError(null)
    setPendingUser(body)
    setSending(true)
    try {
      const sid = await ensureSession()
      // SSE may not be connected yet for a freshly created session; give it a tick.
      if (!sseRef.current) await new Promise(r => setTimeout(r, 200))
      if (process.env.MOBIUS_TUI_DEBUG) console.error('[send-post]', sid, 'sse=', !!sseRef.current, 'closed=', sseRef.current?.isClosed())
      const reqId = `tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      await client.sendMessage(sid, body, reqId)
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : `发送失败: ${e?.message ?? e}`
      setError(msg)
      setPendingUser(null)
    } finally {
      setSending(false)
    }
  }, [sending, ensureSession, client])

  const stop = useCallback(async () => {
    if (!sessionId) return
    try { await client.stopSession(sessionId) } catch { /* ignore */ }
    setTyping(false)
  }, [sessionId, client])

  return { entries, pendingUser, typing, sending, error, sessionId, send, stop }
}
