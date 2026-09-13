/**
 * useChat — drives one Mobius chat session.
 *
 * Lifecycle (per the TUI spec):
 *   - lazily create a session (POST /api/issues/:issueId/sessions) on the first
 *     submitted message, using the saved preferences;
 *   - open the SSE stream (GET /api/sessions/:id/events?token=); on subscribe
 *     bootstrap the transcript via ① groups + ② tail-group entries, then apply
 *     live `entries` batches (watermark + uuid dedup) as they arrive;
 *   - reconnects re-run the same ① negotiation (stateless reconciliation):
 *     groups whose version changed are refetched whole, transcript rebuilt;
 *   - keep the agent's busy state synchronized with the runtime status API.
 * `/clear` remounts the hook (fresh session next time); `/resume` injects a
 * pre-existing sessionId.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { MobiusClient, ApiError } from '../api.js'
import { SseConnection } from '../sse.js'
import { updateIssuePreference } from '../config.js'
import { tuiAimuxIdentifier, probeAimuxBridgeConnection } from '../aimux.js'
import { viewsForEntry } from '../lib/entry-view.js'
import type { AnyEntry, HistoryPendingOpener } from '../types.js'
import type { ReadyState } from '../components/PrepScreen.js'

export interface ChatApi {
  client: MobiusClient
  ready: ReadyState
  resumeSessionId?: string | null
}

export interface ChatController {
  entries: AnyEntry[]
  pendingUser: string | null
  pending: HistoryPendingOpener[]
  typing: boolean
  sending: boolean
  error: string | null
  sessionId: string | null
  /** 智能体已离开本 TUI 设备、前往的新设备 ID; null = 未离开 (仍绑定本设备或非本设备会话). */
  switchedAway: string | null
  send: (text: string) => Promise<void>
  stop: () => Promise<void>
  pauseToDequeue: () => Promise<void>
}

let ID = 0
function nextId(): number { ID += 1; return ID }

/**
 * Does this entry represent the user's just-submitted message? Used to retire the
 * optimistic `pendingUser` placeholder once the real entry is observed — including
 * via a reconnect's history reconciliation (the live `entries` path already clears it).
 *
 * Mobius may prepend injected context (project/issue framing) to a user turn, so we
 * match the typed text as a suffix of the entry's normalized text rather than
 * requiring exact equality; a verbatim entry still matches because it ends with the
 * typed text.
 */
function entryMatchesPendingUser(entry: AnyEntry, pendingText: string): boolean {
  if (!pendingText) return false
  const want = pendingText.replace(/\s+/g, ' ').trim()
  if (!want) return false
  for (const view of viewsForEntry(entry)) {
    if (view.kind !== 'user') continue
    const got = view.text.replace(/\s+/g, ' ').trim()
    if (got === want || got.endsWith(want)) return true
  }
  return false
}

/** Stable identity for de-duplication. Every Mobius jsonl entry carries a uuid. */
function entryKey(entry: AnyEntry): string | null {
  return typeof entry?.uuid === 'string' ? entry.uuid : null
}

// 首次 bootstrap 拉取的末尾组数 (旧 SSE 尾部回放的等价物; 更早的组按需不拉,
// TUI 是平铺字幕, 没有轮次展开概念, 末尾几组已覆盖活跃对话).
const BOOTSTRAP_GROUP_COUNT = 3
// A fresh session can spend several seconds creating the worker and loading
// context before /status reports alive=true. Keep the first-turn indicator
// visible during that bootstrap window instead of letting the short generic
// hint expire and leaving the user with no feedback.
const FIRST_TURN_BOOTSTRAP_GRACE_MS = 30_000

/** Mini group store: 组序 + 水位线 (version) + 组内条目. */
interface GroupSlot {
  seq: number
  version: number
  entries: AnyEntry[]
}

// Retry transient gateway/transport errors so a brief 502/503/504 (a reverse-
// proxy blip, a backend worker recycling after a deploy, a transient upstream
// failure) doesn't immediately fail a message dispatch. 4xx errors are not
// retried — repeating them won't change the outcome. The caller passes one
// fixed reqId so the backend can de-duplicate across attempts.
async function sendWithRetry(fn: () => Promise<unknown>, maxAttempts = 3): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fn()
      return
    } catch (e: any) {
      const status = e?.status
      const transient =
        status === 502 || status === 503 || status === 504 ||
        status === 0 || e?.name === 'TypeError' // fetch-level network failure
      if (!transient || attempt >= maxAttempts - 1) throw e
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt))
    }
  }
}

export function useChat({ client, ready, resumeSessionId }: ChatApi): ChatController {
  const [sessionId, setSessionId] = useState<string | null>(resumeSessionId ?? null)
  const [entries, setEntries] = useState<AnyEntry[]>([])
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  const [pending, setPending] = useState<HistoryPendingOpener[]>([])
  const [typing, setTyping] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [switchedAway, setSwitchedAway] = useState<string | null>(null)
  const sseRef = useRef<SseConnection | null>(null)
  // agent-history mini group store (协议 ①②③ 的 TUI 侧消费形态).
  const groupSlotsRef = useRef<Map<string, GroupSlot>>(new Map())
  const pollNowRef = useRef<(() => void) | null>(null)
  const typingRef = useRef(false)
  const sendingRef = useRef(false)
  const workingHintUntilRef = useRef(0)
  const statusEpochRef = useRef(0)
  // SSE auto-reconnect state. A reverse proxy's idle timeout (or a server
  // restart) drops the stream mid-session; without reconnect the TUI stops
  // receiving new jsonl entries even though the web client keeps updating.
  // On reconnect the stateless ①② reconciliation refills any missed entries.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptRef = useRef(0)
  const aliveRef = useRef(true)
  const stoppedRef = useRef(false)
  const doConnectRef = useRef<(sid: string) => void>(() => {})
  const connectionGenerationRef = useRef(0)

  const updateTyping = useCallback((active: boolean) => {
    typingRef.current = active
    setTyping(active)
  }, [])

  const appendEntries = useCallback((newOnes: AnyEntry[]) => {
    if (!newOnes.length) return
    setEntries(prev => {
      // De-duplicate by uuid so a live `entries` batch that also appears in a
      // reconnect's history replay is never shown twice.
      const seen = new Set<string>()
      for (const e of prev) { const k = entryKey(e); if (k) seen.add(k) }
      const stamped: AnyEntry[] = []
      for (const e of newOnes) {
        const k = entryKey(e)
        if (k && seen.has(k)) continue
        if (k) seen.add(k)
        stamped.push({ ...e, __id: e.__id ?? nextId() })
      }
      return stamped.length ? [...prev, ...stamped] : prev
    })
  }, [])

  const setHistory = useCallback((list: AnyEntry[]) => {
    const seen = new Set<string>()
    const out: AnyEntry[] = []
    for (const e of list) {
      const k = entryKey(e)
      if (k) { if (seen.has(k)) continue; seen.add(k) }
      out.push({ ...e, __id: e.__id ?? nextId() })
    }
    setEntries(out)
  }, [])

  // ── agent-history (协议 ①②③): bootstrap / 重连对账 ──────────────────────

  /** 按组序摊平重建 transcript (uuid 去重由 setHistory 兜底). */
  const rebuildEntriesFromGroups = useCallback(() => {
    const slots = [...groupSlotsRef.current.values()].sort((a, b) => a.seq - b.seq)
    const flat: AnyEntry[] = []
    for (const s of slots) flat.push(...s.entries)
    setHistory(flat)
  }, [setHistory])

  /**
   * Stateless 对账 (订阅时/重连时同一条路径):
   *   ① 拿全部组元数据 → 本地没有的或 version 变了的组 ② 整组重拉 → 重建 transcript.
   * 首次 (本地空) 只拉末尾 BOOTSTRAP_GROUP_COUNT 组; 之后每次只补差额, 常态零请求.
   */
  const reconcileHistory = useCallback(async (sid: string) => {
    try {
      const data = await client.listHistoryGroups(sid)
      const groups: any[] = Array.isArray(data?.groups) ? data.groups : []
      // 挂起中的开轮卡 (排队指令): /groups 是权威快照, 覆盖本地增量.
      setPending(Array.isArray(data?.pending) ? data.pending : [])
      const local = groupSlotsRef.current
      const targets = local.size === 0 ? groups.slice(-BOOTSTRAP_GROUP_COUNT) : groups
      let changed = false
      for (const g of targets) {
        const gid = String(g?.id ?? '')
        if (!gid) continue
        const ver = Number(g?.version) || 0
        const cur = local.get(gid)
        if (cur && cur.version >= ver) continue
        try {
          const r = await client.listHistoryGroupEntries(sid, gid)
          local.set(gid, {
            seq: Number(g?.seq) || (local.size + 1),
            version: Number(r?.version) || 0,
            entries: Array.isArray(r?.entries) ? r.entries : [],
          })
          changed = true
        } catch { /* 单组失败不阻塞其余组 */ }
      }
      // 服务端已不存在的组 → 丢弃 (会话被删/重建的防御).
      const alive = new Set(groups.map((g: any) => String(g?.id ?? '')))
      for (const gid of [...local.keys()]) {
        if (!alive.has(gid)) { local.delete(gid); changed = true }
      }
      if (changed) rebuildEntriesFromGroups()
      // 对账补齐后, 若乐观占位已被真实条目覆盖 → 退掉 (断线期间整轮完成的场景).
      setPendingUser(prev => {
        if (prev === null) return prev
        const slots = [...local.values()].sort((a, b) => a.seq - b.seq)
        const flat: AnyEntry[] = []
        for (const s of slots) flat.push(...s.entries)
        return flat.some(e => entryMatchesPendingUser(e, prev)) ? null : prev
      })
    } catch (e) {
      if (process.env.MOBIUS_TUI_DEBUG) console.error('[history-reconcile]', (e as Error)?.message ?? e)
    }
  }, [client, rebuildEntriesFromGroups])

  // ── SSE connection ────────────────────────────────────────────────────────
  const connect = useCallback((sid: string) => {
    if (process.env.MOBIUS_TUI_DEBUG) console.error('[connect]', sid)
    const generation = ++connectionGenerationRef.current
    sseRef.current?.close()
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
    const url = `${client.server}/api/sessions/${encodeURIComponent(sid)}/events?token=${encodeURIComponent(client.token)}`
    const conn = new SseConnection(url, {
      onGroupCreated: (group) => {
        if (!group || typeof group !== 'object') return
        const gid = String(group.id ?? '')
        if (!gid || groupSlotsRef.current.has(gid)) return  // 元数据不可变, 已知即忽略
        groupSlotsRef.current.set(gid, {
          seq: Number(group.seq) || (groupSlotsRef.current.size + 1),
          version: Number(group.version) || 1,
          entries: [],
        })
        // 新组开轮 = 后端已把挂起的 pending_round_openers 一次性出队 (flushPendingOpenersToSink).
        // 排队行随之清空; 随后 entries 事件会把这一整组内容补齐.
        setPending([])
      },
      onEntries: ({ group_id, group_id_version, entries }) => {
        if (process.env.MOBIUS_TUI_DEBUG) console.error('[onEntries]', group_id, group_id_version, entries.length)
        const gid = String(group_id ?? '')
        if (!gid) return
        let slot = groupSlotsRef.current.get(gid)
        if (!slot) {
          // 事件早到且本地无该组 (错过 group_created): 建槽后按水位线对账.
          slot = { seq: groupSlotsRef.current.size + 1, version: 0, entries: [] }
          groupSlotsRef.current.set(gid, slot)
        }
        const version = Number(group_id_version) || 0
        if (slot.entries.length > 0 && version <= slot.version) return  // 水位线: ≤ 本地即丢弃
        // uuid 去重保险丝: 与整组重拉/对账重叠的条目只留一份.
        const known = new Set<string>()
        for (const e of slot.entries) { const k = entryKey(e); if (k) known.add(k) }
        const fresh = entries.filter(e => {
          const k = entryKey(e)
          if (k && known.has(k)) return false
          if (k) known.add(k)
          return true
        })
        slot.entries = slot.entries.concat(fresh)
        slot.version = Math.max(slot.version, version)
        if (fresh.length > 0) {
          appendEntries(fresh)
          setPendingUser(null)
        }
      },
      onPendingOpener: (opener) => {
        // 忙时提交的新指令被挂起: 追加到排队行 (uuid 去重), 乐观占位随之退役.
        if (!opener || typeof opener !== 'object') return
        const id = String(opener.id ?? '')
        setPending(prev => {
          if (id && prev.some(p => p.id === id)) return prev
          return [...prev, { id, opener_ts: opener.opener_ts ?? null, user_summary: opener.user_summary ?? '' }]
        })
        setPendingUser(null)
      },
      onSubscribed: () => {
        reconnectAttemptRef.current = 0
        // 订阅即对账 (首开 = bootstrap 拉末尾几组; 重连 = stateless 补差额).
        void reconcileHistory(sid)
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
          // A fresh turn uses a longer bootstrap grace period.  Some agents
          // emit an early typing=false edge before their worker is observable;
          // do not let that transient edge erase the first-turn indicator.
          const remaining = workingHintUntilRef.current - Date.now()
          if (remaining < 5_000) workingHintUntilRef.current = 0
        }
        pollNowRef.current?.()
      },
      onError: (msg) => setError(msg),
      onClose: () => {
        // `connect()` closes the previous stream before installing its
        // replacement. Ignore that superseded stream's eventual close callback,
        // otherwise it can schedule a timer that tears down the fresh stream.
        if (generation !== connectionGenerationRef.current) return
        // Reconnect with exponential backoff as long as the session is still
        // alive; stop once it ends (alive=false) or after a few failed tries.
        if (stoppedRef.current || !aliveRef.current) return
        const attempt = reconnectAttemptRef.current
        if (attempt >= 6) return
        const delay = Math.min(15_000, 500 * 2 ** attempt)
        reconnectAttemptRef.current = attempt + 1
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null
          if (!stoppedRef.current) doConnectRef.current(sid)
        }, delay)
      },
    })
    sseRef.current = conn
    conn.start()
  }, [client.server, client.token, appendEntries, setHistory, updateTyping, reconcileHistory])
  doConnectRef.current = connect

  const ensureSseForSend = useCallback((sid: string): boolean => {
    // A completed worker reports alive=false. If its SSE stream is later closed
    // by an idle proxy, onClose deliberately stops reconnecting. Sending a new
    // turn revives the same session, so reopen the stream before dispatching the
    // message; otherwise the backend and web UI advance while this TUI remains
    // attached to a permanently closed connection.
    aliveRef.current = true
    reconnectAttemptRef.current = 0
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (!sseRef.current || sseRef.current.isClosed()) {
      connect(sid)
      return true
    }
    return false
  }, [connect])

  // Connect immediately when a resume session is provided, or after we create one.
  useEffect(() => {
    if (sessionId && !sseRef.current) connect(sessionId)
    return () => { /* keep connection across re-renders; closed on unmount */ }
  }, [sessionId, connect])

  useEffect(() => () => {
    stoppedRef.current = true
    sseRef.current?.close()
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
  }, [])

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
        aliveRef.current = !!status.alive

        // 设备切换检测: 本会话最初绑定本 TUI 设备 (initial_aimux_id == myId) 但当前已指向
        // 别处 (aimux_id != myId) → 智能体"已离开本设备前往新设备". 用于渲染显眼提示 (仅 TUI 端).
        const myId = tuiAimuxIdentifier()
        const left = status.initial_aimux_id === myId && status.aimux_id && status.aimux_id !== myId
          ? status.aimux_id
          : null
        setSwitchedAway(left)

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
    // 创建会话前确认 aimux reverse connect 已注册到服务器 bridge, 否则 codex 启动时
    // 注入的 MCP server (aimux mcp serve --remote <id>) 会因 remote 不存在而退出.
    // 不阻塞创建: 超时则继续 (aimux mcp serve 自身会兜底校验并报错给 codex).
    const aimuxId = tuiAimuxIdentifier()
    const probeDeadline = Date.now() + 8000
    while (Date.now() < probeDeadline) {
      try { if (await probeAimuxBridgeConnection(client.server, client.token, aimuxId)) break } catch {}
      await new Promise(r => setTimeout(r, 500))
    }
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
        add_remote_aimux_mcp: true,
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
    // Guard on the ref (synchronous truth) as well as the state so a stale
    // closure can't dispatch the same message twice (two distinct reqIds → two
    // user entries on the server).
    if (!body || sending || sendingRef.current) return
    setError(null)
    setPendingUser(body)
    statusEpochRef.current += 1
    const firstTurn = !sessionId && entries.length === 0
    workingHintUntilRef.current = Date.now() + (firstTurn ? FIRST_TURN_BOOTSTRAP_GRACE_MS : 2_000)
    sendingRef.current = true
    updateTyping(true)
    setSending(true)
    try {
      const sid = await ensureSession()
      // Fresh sessions connect via the sessionId effect. Resumed sessions may
      // have a permanently closed idle stream after their worker exited; revive
      // that stream explicitly before POSTing so this turn cannot be missed.
      const reopenedSse = ensureSseForSend(sid)
      if (reopenedSse || !sseRef.current) await new Promise(r => setTimeout(r, 200))
      if (process.env.MOBIUS_TUI_DEBUG) console.error('[send-post]', sid, 'sse=', !!sseRef.current, 'closed=', sseRef.current?.isClosed())
      const reqId = `tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      await sendWithRetry(() => client.sendMessage(sid, body, reqId))
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
  }, [sending, sessionId, entries.length, ensureSession, ensureSseForSend, client, updateTyping])

  const stop = useCallback(async () => {
    if (!sessionId) return
    statusEpochRef.current += 1
    workingHintUntilRef.current = 0
    sendingRef.current = false
    updateTyping(false)
    try { await client.stopSession(sessionId) } catch { /* ignore */ }
    pollNowRef.current?.()
  }, [sessionId, client, updateTyping])

  // 打断当前 turn 并出队下一条排队指令 (空输入回车 / 插队). 不追加新 prompt,
  // 后端对 claude-code/codex 发一次 C-c, deepseek harness 是空实现. 排队行会在
  // 新组开轮 (group_created) 时被清空, 这里只需触发并刷新状态轮询.
  const pauseToDequeue = useCallback(async () => {
    if (!sessionId) return
    statusEpochRef.current += 1
    try { await client.pauseToDequeue(sessionId) } catch (e: any) {
      const msg = e instanceof ApiError ? e.message : `插队失败: ${e?.message ?? e}`
      setError(msg)
    }
    pollNowRef.current?.()
  }, [sessionId, client])

  return { entries, pendingUser, pending, typing, sending, error, sessionId, switchedAway, send, stop, pauseToDequeue }
}
