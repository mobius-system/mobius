/**
 * useChat — drives one Mobius chat session.
 *
 * Lifecycle (per the TUI spec):
 *   - lazily create a session (POST /api/issues/:issueId/sessions) on the first
 *     submitted message, using the saved preferences;
 *   - open the SSE stream (GET /api/sessions/:id/events?token=) and append
 *     `jsonl_entry` payloads to the transcript as they arrive;
 *   - keep the agent's busy state synchronized with the runtime status API.
 * `/clear` remounts the hook (fresh session next time); `/resume` injects a
 * pre-existing sessionId so the stream replays its history.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MobiusClient, ApiError } from '../api.js'
import { SseConnection } from '../sse.js'
import { updateIssuePreference } from '../config.js'
import { tuiAimuxIdentifier } from '../aimux.js'
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
  const pollNowRef = useRef<(() => void) | null>(null)
  const typingRef = useRef(false)
  const sendingRef = useRef(false)
  const workingHintUntilRef = useRef(0)
  const statusEpochRef = useRef(0)

  const updateTyping = useCallback((active: boolean) => {
    typingRef.current = active
    setTyping(active)
  }, [])

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
      onTyping: (active) => {
        // SSE is a low-latency hint, not the source of truth. A `true` event
        // lights the indicator immediately; either edge requests a fresh
        // runtime status so missed/replayed events cannot leave stale UI.
        statusEpochRef.current += 1
        if (active) {
          workingHintUntilRef.current = Date.now() + 1_500
          updateTyping(true)
        } else {
          workingHintUntilRef.current = 0
        }
        pollNowRef.current?.()
      },
      onError: (msg) => setError(msg),
    })
    sseRef.current = conn
    conn.start()
  }, [client.server, client.token, appendEntries, setHistory, updateTyping])

  // Connect immediately when a resume session is provided, or after we create one.
  useEffect(() => {
    if (sessionId && !sseRef.current) connect(sessionId)
    return () => { /* keep connection across re-renders; closed on unmount */ }
  }, [sessionId, connect])

  useEffect(() => () => { sseRef.current?.close() }, [])

  // ── Runtime status synchronization ──────────────────────────────────────
  // GET /api/sessions/:id/status is the only authoritative execution state.
  // Poll recursively after each request completes so a slow network cannot
  // accumulate overlapping requests. SSE merely asks this loop to run sooner.
  useEffect(() => {
    if (!sessionId) return

    let stopped = false
    let inFlight = false
    let rerunImmediately = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let controller: AbortController | null = null
    let poll: () => Promise<void>

    const schedule = (delayMs: number) => {
      if (stopped) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void poll() }, delayMs)
    }

    const requestNow = () => {
      if (stopped) return
      if (inFlight) {
        rerunImmediately = true
        return
      }
      schedule(0)
    }

    poll = async () => {
      if (stopped || inFlight) return
      inFlight = true
      timer = null
      const epoch = statusEpochRef.current
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(), 10_000)
      let nextDelay = 5_000

      try {
        const status = await client.sessionStatus(sessionId, controller.signal)
        if (stopped || epoch !== statusEpochRef.current) return

        if (status.alive && status.working) {
          workingHintUntilRef.current = 0
          updateTyping(true)
          nextDelay = 2_000
        } else {
          const hintRemaining = workingHintUntilRef.current - Date.now()
          if (hintRemaining > 0 || sendingRef.current) {
            // Session creation and message dispatch can briefly precede the
            // worker becoming observable. Preserve instant feedback while
            // retrying quickly, with a bounded grace period.
            updateTyping(true)
            nextDelay = Math.max(100, Math.min(500, hintRemaining || 500))
          } else {
            updateTyping(false)
            nextDelay = status.alive ? 5_000 : 15_000
          }
        }
      } catch (e: any) {
        // A status timeout or transient transport error must not disturb the
        // transcript or make Working flicker. The next recursive poll retries.
        if (process.env.MOBIUS_TUI_DEBUG && e?.name !== 'AbortError') {
          console.error('[status-poll]', e?.message ?? e)
        }
        nextDelay = typingRef.current ? 2_000 : 5_000
      } finally {
        clearTimeout(timeout)
        controller = null
        inFlight = false
        if (!stopped) {
          if (rerunImmediately) {
            rerunImmediately = false
            schedule(0)
          } else {
            schedule(nextDelay)
          }
        }
      }
    }

    pollNowRef.current = requestNow
    requestNow()

    return () => {
      stopped = true
      pollNowRef.current = null
      if (timer) clearTimeout(timer)
      controller?.abort()
    }
  }, [client, sessionId, updateTyping])

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
      pc_client_metadata: {
        work_mode: 'pc',
        aimux_id: tuiAimuxIdentifier(),
        local_path: process.cwd(),
        is_tui: true,
      },
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
    statusEpochRef.current += 1
    workingHintUntilRef.current = Date.now() + 2_000
    sendingRef.current = true
    updateTyping(true)
    setSending(true)
    try {
      const sid = await ensureSession()
      // SSE may not be connected yet for a freshly created session; give it a tick.
      if (!sseRef.current) await new Promise(r => setTimeout(r, 200))
      if (process.env.MOBIUS_TUI_DEBUG) console.error('[send-post]', sid, 'sse=', !!sseRef.current, 'closed=', sseRef.current?.isClosed())
      const reqId = `tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      await client.sendMessage(sid, body, reqId)
      pollNowRef.current?.()
    } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : `发送失败: ${e?.message ?? e}`
      setError(msg)
      setPendingUser(null)
      workingHintUntilRef.current = 0
      updateTyping(false)
    } finally {
      sendingRef.current = false
      setSending(false)
      pollNowRef.current?.()
    }
  }, [sending, ensureSession, client, updateTyping])

  const stop = useCallback(async () => {
    if (!sessionId) return
    statusEpochRef.current += 1
    workingHintUntilRef.current = 0
    sendingRef.current = false
    updateTyping(false)
    try { await client.stopSession(sessionId) } catch { /* ignore */ }
    pollNowRef.current?.()
  }, [sessionId, client, updateTyping])

  return { entries, pendingUser, typing, sending, error, sessionId, send, stop }
}
