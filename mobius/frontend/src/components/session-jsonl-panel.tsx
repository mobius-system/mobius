import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from 'react'
import { JsonlLiveTailCard, JsonlView } from './jsonl-view'
import { VSCodeOpenProvider } from './jsonl-vscode-link'
import { PendingQueueCard } from './viewer/PendingQueueCard'
import type { SessionHistoryStore } from '../services/agent-history-store'
import { useHistorySnapshotOf } from '../services/agent-history-store'
import { scrollDebug } from './scroll-debug'

const JsonlViewEasy = lazy(() => import('./viewer/JsonlViewEasy'))

// LIVE token output is deliberately paced instead of rendering every network chunk.
const LIVE_TOKEN_MAX_BUFFER_CHARS = 3200
const LIVE_TOKEN_MAX_CHARS_PER_SECOND = 60
const LIVE_TOKEN_TICK_MS = 50

// 显示 buffer 满了的缩容策略: 一次性删除前 2/3、保留后 1/3，腾出空间继续追加,
// 避免每次追加都 slice(-MAX) 做 O(n) 拷贝 (每 tick 反复触发).
function trimLiveBuffer(text: string): string {
  if (text.length <= LIVE_TOKEN_MAX_BUFFER_CHARS) return text
  return text.slice(Math.floor(text.length * 2 / 3))
}

// ── 最新可解析时间戳 (LIVE 卡锚点 / 诊断用). 从尾部向前找, 跳过无时间戳的元数据条目. ──
// 从 chat.tsx 迁入 (Chat 不再订阅快照, 摊平条目的派生消费集中到本面板).
function parseDebugTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const ms = new Date(value as string | number).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function findLatestEntryTimestamp(entries: any[]): {
  value: string | null
  index: number | null
  source: string | null
} {
  const candidates: Array<{ source: string; get: (entry: any) => unknown }> = [
    { source: 'timestamp', get: (entry) => entry?.timestamp },
    { source: 'created_at', get: (entry) => entry?.created_at },
    { source: 'payload.timestamp', get: (entry) => entry?.payload?.timestamp },
    { source: 'message.created_at', get: (entry) => entry?.message?.created_at },
  ]
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    for (const candidate of candidates) {
      const value = candidate.get(entry)
      if ((typeof value === 'string' || typeof value === 'number') && parseDebugTimestamp(value) !== null) {
        return { value: String(value), index, source: candidate.source }
      }
    }
  }
  return { value: null, index: null, source: null }
}

type SessionJsonlPanelProps = {
  currentProjectId: string
  // Stable identity for the currently displayed session. History-store
  // instances may be replaced while data is loading; search highlights must
  // survive that replacement but must be cleared when the user changes
  // sessions.
  sessionIdentity?: string
  chatContainerRef: RefObject<HTMLDivElement>
  endRef: RefObject<HTMLDivElement>
  // agent-history-store 实例 (快照订阅在本面板内部 — Chat 不随每条数据重渲染).
  historyStore: SessionHistoryStore | null
  // 空会话占位文案的状态输入 (文案规则见下, 由 Chat 的会话状态派生).
  derivedStatus: string
  showJsonlMeta: boolean
  backendAlive: boolean | null
  backendWorking: boolean | null
  // LIVE 卡乐观窗口 (见 chat.tsx LIVE_OPTIMISTIC_*_MS): 'on' = 提交后强制显示, 'off' = 终止后强制隐藏,
  // 'auto' = 面板按 alive && working 自己判.
  liveCardMode?: 'auto' | 'on' | 'off'
  backendPid: number | null
  realTimeInfo?: string
  hasNewMessages: boolean
  onScrollPositionChange: (userScrolledUp: boolean) => void
  onJumpToBottom: () => void
  // 排队卡片闪电按钮: 打断当前 turn 并出队下一条排队指令.
  onPauseToDequeue?: () => void
  // 搜索结果跳转: 命中条目 uuid / timestamp, JsonlView 解析到所属组后滚动.
  scrollToEntryUuid?: string | null
  scrollToMatchTs?: string | null
  onMatchScrollResolved?: () => void
  // 当前会话是否仍保留搜索命中红框。与 URL 中的 match/ts 独立，供 Chat 追底逻辑同步读取。
  searchHighlightActiveRef?: MutableRefObject<boolean>
  searchHighlightTargetRef?: MutableRefObject<{ uuid: string | null; ts: string | null } | null>
  searchHighlightClearSignal?: number
  searchHits?: Array<{ uuid?: string | null; timestamp?: string | null }>
  onSearchHitJump?: () => void
  onSearchHitPrevious?: () => void
  onSearchHitNext?: () => void
  onSearchHitClear?: () => void
  onEasyRoundCountChange?: (count: number) => void
  easyExpandAllSignal?: number
  variant?: 'standard' | 'easy'
  // Replaces the conversation contents while preserving the panel and scroll container.
  exclusiveContent?: ReactNode
}

function SessionJsonlPanelInner({
  currentProjectId,
  sessionIdentity = '',
  chatContainerRef,
  endRef,
  historyStore,
  derivedStatus,
  showJsonlMeta,
  backendAlive,
  backendWorking,
  liveCardMode = 'auto',
  backendPid,
  realTimeInfo,
  hasNewMessages,
  onScrollPositionChange,
  onJumpToBottom,
  onPauseToDequeue,
  scrollToEntryUuid,
  scrollToMatchTs,
  onMatchScrollResolved,
  searchHighlightActiveRef,
  searchHighlightTargetRef,
  searchHighlightClearSignal = 0,
  searchHits = [],
  onSearchHitJump,
  onSearchHitPrevious,
  onSearchHitNext,
  onSearchHitClear,
  onEasyRoundCountChange,
  easyExpandAllSignal,
  variant = 'standard',
  exclusiveContent,
}: SessionJsonlPanelProps) {
  // 订阅下沉: 快照/摊平条目/派生值都在本组件内算, Chat 只递 store.
  const historySnapshot = useHistorySnapshotOf(historyStore)
  // URL 中的 match/ts 会在首次精确滚动完成后被上层清理，命中视觉反馈不能随之消失。
  // 面板本地保留本次目标，直到切换到另一份 historyStore（即离开当前会话）。
  const highlightTargetRef = useRef<{ uuid: string | null; ts: string | null } | null>(null)
  const previousClearSignalRef = useRef(searchHighlightClearSignal)
  const previousSessionIdentityRef = useRef(sessionIdentity)
  // Keep the target synchronously while rendering. The parent removes match/ts as soon as
  // scrolling completes; a passive effect here can lose a frame (and the highlight) when
  // that URL cleanup races the initial target capture.
  if (previousSessionIdentityRef.current !== sessionIdentity) {
    highlightTargetRef.current = null
    previousSessionIdentityRef.current = sessionIdentity
  }
  if (scrollToEntryUuid || scrollToMatchTs) {
    highlightTargetRef.current = { uuid: scrollToEntryUuid || null, ts: scrollToMatchTs || null }
  }
  if (previousClearSignalRef.current !== searchHighlightClearSignal) {
    previousClearSignalRef.current = searchHighlightClearSignal
    highlightTargetRef.current = null
  }
  const effectiveScrollToEntryUuid = scrollToEntryUuid || highlightTargetRef.current?.uuid || null
  const effectiveScrollToMatchTs = scrollToMatchTs || highlightTargetRef.current?.ts || null
  if (searchHighlightActiveRef) {
    searchHighlightActiveRef.current = !!(effectiveScrollToEntryUuid || effectiveScrollToMatchTs)
  }
  if (searchHighlightTargetRef) {
    searchHighlightTargetRef.current = effectiveScrollToEntryUuid || effectiveScrollToMatchTs
      ? { uuid: effectiveScrollToEntryUuid, ts: effectiveScrollToMatchTs }
      : null
  }
  const visibleJsonl = useMemo(
    () => (historyStore ? historyStore.flattenEntries() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyStore, historySnapshot.rev],
  )
  const jsonlInitialLoading = !historySnapshot.negotiated && historySnapshot.groups.length === 0 && !historySnapshot.error
  // 空会话占位文案: pending(刚发消息等创建进程) / running(agent 在跑等首条输出) 时给 loading 文案,
  // 由 JsonlView 配 spinner 显示; idle/waiting(终态空, 不会有数据自动到来) 时留空.
  const jsonlEmptyLoadingText = visibleJsonl.length === 0
    ? (derivedStatus === 'pending'
        ? (backendAlive ? '智能体进程已创建，联络中' : '正在创建智能体进程，请稍等')
        : derivedStatus === 'running' ? '智能体工作中，等待输出…' : '')
    : ''
  const lastTimestamp = useMemo(() => findLatestEntryTimestamp(visibleJsonl).value, [visibleJsonl])
  const liveCardVisible = liveCardMode === 'on' ? true
    : liveCardMode === 'off' ? false
    : !!(backendAlive === true && backendWorking === true)
  // 强开窗 (提交乐观窗 / 发送阶段, 见 chat.tsx liveMode) 内不要求已有时间戳: 会话刚提交、首条
  // entry 还没落盘时, 卡片按"已提交 · 等待智能体响应…"渲染, 与左下角黄字提示同一时间段.
  const liveCardMounted = exclusiveContent == null && liveCardVisible
    && (!!lastTimestamp || liveCardMode === 'on')
  const [liveTokenText, setLiveTokenText] = useState('')
  const liveTokenBufferRef = useRef('')
  const liveTokenDisplayRef = useRef('')
  const liveTokenClearTimerRef = useRef<number | null>(null)

  // The LIVE card consumes only tokens produced after this subscription starts.
  // The proxy's only_latest mode suppresses its historical snapshot; snapshot
  // events are still ignored for compatibility with older proxy instances.
  useEffect(() => {
    if (!liveCardMounted || backendWorking !== true || !sessionIdentity) {
      liveTokenBufferRef.current = ''
      liveTokenDisplayRef.current = ''
      setLiveTokenText('')
      if (liveTokenClearTimerRef.current !== null) {
        window.clearTimeout(liveTokenClearTimerRef.current)
        liveTokenClearTimerRef.current = null
      }
      return
    }

    const source = new EventSource(`/api/token_stream?session=${encodeURIComponent(sessionIdentity)}&only_latest=1`)
    const handleToken = (event: MessageEvent<string>) => {
      let payload: { text?: unknown }
      try { payload = JSON.parse(event.data) } catch { return }
      const text = typeof payload.text === 'string' ? payload.text : ''
      const normalizedText = text.replace(/\r\n?|\n/g, ' ')
      if (!normalizedText) return

      // Keep deltas contiguous. If the producer outruns the typewriter, fast-forward
      // the complete visible tail instead of deleting the queue head repeatedly and
      // joining two non-adjacent fragments (which looks like reordered text).
      const combined = liveTokenBufferRef.current + normalizedText
      if (combined.length > LIVE_TOKEN_MAX_BUFFER_CHARS) {
        liveTokenDisplayRef.current = trimLiveBuffer(liveTokenDisplayRef.current + combined)
        liveTokenBufferRef.current = ''
        setLiveTokenText(liveTokenDisplayRef.current)
      } else {
        liveTokenBufferRef.current = combined
      }
      if (liveTokenClearTimerRef.current !== null) window.clearTimeout(liveTokenClearTimerRef.current)
      liveTokenClearTimerRef.current = window.setTimeout(() => {
        liveTokenBufferRef.current = ''
        liveTokenDisplayRef.current = ''
        liveTokenClearTimerRef.current = null
        setLiveTokenText('')
      }, 5000)
    }
    const handleSnapshot = () => {
      // only_latest should never send this; ignore it if an older proxy does.
    }
    source.addEventListener('token', handleToken as EventListener)
    source.addEventListener('snapshot', handleSnapshot as EventListener)
    const charsPerTick = Math.max(1, Math.round(LIVE_TOKEN_MAX_CHARS_PER_SECOND * LIVE_TOKEN_TICK_MS / 1000))
    const typewriterTimer = window.setInterval(() => {
      const pending = liveTokenBufferRef.current
      if (!pending) return
      const next = pending.slice(0, charsPerTick)
      liveTokenBufferRef.current = pending.slice(next.length)
      liveTokenDisplayRef.current = trimLiveBuffer(liveTokenDisplayRef.current + next)
      setLiveTokenText(liveTokenDisplayRef.current)
    }, LIVE_TOKEN_TICK_MS)

    return () => {
      source.removeEventListener('token', handleToken as EventListener)
      source.removeEventListener('snapshot', handleSnapshot as EventListener)
      source.close()
      window.clearInterval(typewriterTimer)
      liveTokenBufferRef.current = ''
      liveTokenDisplayRef.current = ''
      setLiveTokenText('')
      if (liveTokenClearTimerRef.current !== null) {
        window.clearTimeout(liveTokenClearTimerRef.current)
        liveTokenClearTimerRef.current = null
      }
    }
  }, [backendWorking, liveCardMounted, sessionIdentity])
  // 上一帧 scrollTop, 用于"方向性"解除判定 (仅向上滚才算用户解除钉底).
  const lastScrollTopRef = useRef<number | null>(null)
  // 内容是否真的撑满视口 (有可滚动余量). 对话没满时下方并没有被遮住的内容, "新消息"
  // 按钮纯属噪音 — 它此前会在空/短会话里亮着. 容器与内容根都盯: 容器管视口尺寸变化,
  // 内容根 (第一个子元素, 高度随内容走) 管新条目长高.
  const [hasScrollRoom, setHasScrollRoom] = useState(false)
  useEffect(() => {
    const el = chatContainerRef.current
    if (!el) return
    const measure = () => setHasScrollRoom(el.scrollHeight - el.clientHeight > 4)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild instanceof HTMLElement) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [chatContainerRef])

  // 用户输入意图监听: wheel / touchmove / keydown 一旦表达"向上翻"意图, 立即把
  // userScrolledUp 置 true (终止 EntriesAutoScroll 的追底), 不再依赖 onScroll 里
  // "向上滚 > 2px"的方向推断 — 慢速小步上滚会被 lerp 追底拉回. 这些事件天然来自用户,
  // 绕开"程序滚动 vs 用户滚动"的来源识别; 恢复钉底仍由 onScroll 的 dist < 4 负责.
  // 不监听 pointerdown: 点按卡片/代码/选中文字等非滚动点击也会触发它, 会把 userScrolledUp
  // 误置 true 从而永久停掉追底 ("不追底"); 滚动条拖拽仍由 onScroll 的 movedUp 方向判定兜底.
  useEffect(() => {
    const el = chatContainerRef.current
    if (!el) return

    // 内容没撑满视口时"上滚"不会产生任何位移, 不代表用户在看历史: 记成解除钉底会让
    // 追底永久停摆 (连新会话都不再自动滚), 还会在底部亮出无意义的"新消息"按钮.
    const roomToScroll = () => el.scrollHeight - el.clientHeight > 4
    // wheel 上滚 (deltaY<0) 才算向上翻; 向下滚留 onScroll 贴底判定恢复钉底.
    const onWheel = (e: WheelEvent) => {
      scrollDebug('wheel event: deltaY=', e.deltaY, e.deltaY < 0 ? '(上滚→flag true)' : '(下滚, 交给 onScroll)')
      if (e.deltaY < 0 && roomToScroll()) onScrollPositionChange(true)
    }
    // 手指下移 (clientY 增大) = 内容上滚 (向上翻); 反之回底部交给 onScroll 恢复.
    let lastTouchY: number | null = null
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      if (lastTouchY !== null && t.clientY > lastTouchY && roomToScroll()) {
        scrollDebug('touchmove: 手指下移(内容上翻) → flag true')
        onScrollPositionChange(true)
      }
      lastTouchY = t.clientY
    }
    // 仅"向上翻"类按键视为接管; 输入区与滚动容器是兄弟节点, 输入框方向键不会冒泡到此.
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') && roomToScroll()) {
        scrollDebug('keydown:', e.key, '→ flag true')
        onScrollPositionChange(true)
      }
    }

    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [chatContainerRef, onScrollPositionChange])

  return (
    <div data-tour="session-jsonl-view" className="mobius-chat-history flex min-w-0 flex-1 flex-col">
      <div
        className="flex-1 overflow-y-auto overflow-x-clip relative"
        ref={chatContainerRef}
        onScroll={(e) => {
          const el = e.currentTarget
          const dist = el.scrollHeight - el.scrollTop - el.clientHeight
          // 方向性解除判定 (调参台定稿, 配套 EntriesAutoScroll 的 lerp 追赶):
          // 只有"向上滚"才算用户解除钉底 — lerp 追赶与程序钉底全是向下的, 追高卡
          // 途中 dist 再大也不误判; 手动滚回贴底 (dist<4) 恢复钉底. 内容切换时
          // scrollTop 被 clamp 到边缘的跳变不算用户滚动.
          const prev = lastScrollTopRef.current
          lastScrollTopRef.current = el.scrollTop
          const clampedToEdge = el.scrollTop <= 0 || el.scrollTop >= el.scrollHeight - el.clientHeight - 0.5
          const movedUp = prev !== null && prev - el.scrollTop > 2 && !clampedToEdge
          if (movedUp && dist > 200) {
            scrollDebug('onScroll: movedUp=true, dist=', dist, '>200 → flag true')
            onScrollPositionChange(true)
          } else if (dist < 4) {
            scrollDebug('onScroll: dist=', dist.toFixed(1), '<4 → flag false (恢复钉底)')
            onScrollPositionChange(false)
          }
        }}
      >
        <div
          className={exclusiveContent == null ? 'px-5 py-5' : 'flex min-h-full items-center justify-center p-4'}
          style={undefined}
        >
          {exclusiveContent == null ? (
            <VSCodeOpenProvider projectId={currentProjectId}>
              {variant === 'easy' ? (
                <Suspense fallback={<div className="py-10 text-center text-[12px] text-[var(--text-muted)]">正在整理简易对话...</div>}>
                  <JsonlViewEasy
                    snapshot={historySnapshot}
                    store={historyStore}
                    title=""
                    emptyLoadingText={jsonlEmptyLoadingText}
                    initialLoading={jsonlInitialLoading}
                    showMeta={showJsonlMeta}
                    scrollToEntryUuid={effectiveScrollToEntryUuid}
                    scrollToMatchTs={effectiveScrollToMatchTs}
                    searchNavigationRequested={!!(scrollToEntryUuid || scrollToMatchTs)}
                    onScrollResolved={onMatchScrollResolved}
                    onPauseToDequeue={onPauseToDequeue}
                    // 简易模式队列卡不在视图内渲染, 改由本面板排在 LIVE 卡之下.
                    suppressPending
                  />
                </Suspense>
              ) : (
                <JsonlView
                  snapshot={historySnapshot}
                  store={historyStore}
                  title=""
                  emptyLoadingText={jsonlEmptyLoadingText}
                  initialLoading={jsonlInitialLoading}
                  showMeta={showJsonlMeta}
                  scrollToEntryUuid={effectiveScrollToEntryUuid}
                  scrollToMatchTs={effectiveScrollToMatchTs}
                  searchNavigationRequested={!!(scrollToEntryUuid || scrollToMatchTs)}
                  onScrollResolved={onMatchScrollResolved}
                  onPauseToDequeue={onPauseToDequeue}
                />
              )}
              {liveCardVisible && (
                <JsonlLiveTailCard
                  lastTimestamp={lastTimestamp}
                  pid={backendPid}
                  realTimeInfo={realTimeInfo}
                  liveTokenText={liveTokenText}
                  optimistic={liveCardMode === 'on'}
                  easyMode={variant === 'easy'}
                />
              )}
              {/* 简易模式: 排队卡排在 LIVE 卡之下 (标准模式仍在视图内, 位于列表末尾). */}
              {/* Easy mode: the queue card sits below the LIVE card. */}
              {variant === 'easy' && (
                <PendingQueueCard pending={historySnapshot.pending} onPauseToDequeue={onPauseToDequeue} easyMode />
              )}
              <div ref={endRef} />
            </VSCodeOpenProvider>
          ) : exclusiveContent}
        </div>
      </div>
      {exclusiveContent == null && hasNewMessages && hasScrollRoom && (
        <div className="flex justify-center py-1 flex-shrink-0">
          <button onClick={onJumpToBottom} className="px-4 py-1.5 text-[12px] bg-blue-500/90 text-white rounded-full hover:bg-blue-500 transition-colors shadow-md flex items-center gap-1.5">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 14l-7 7m0 0l-7-7m7 7V3" /></svg>
            新消息
          </button>
        </div>
      )}
      {exclusiveContent == null && searchHits.length > 0 && (searchHighlightActiveRef?.current || searchHighlightTargetRef?.current) && (
        <div className="flex justify-center py-1 flex-shrink-0">
          <div className="inline-flex items-center gap-1 rounded-full border border-red-500/50 bg-red-500/10 px-1.5 py-1 shadow-md" role="group" aria-label="搜索命中导航">
            <span className="px-2 text-[11px] font-semibold text-red-100">查看命中</span>
            <button type="button" onClick={onSearchHitJump} className="rounded-full px-2 py-1 text-[11px] font-medium text-red-200 hover:bg-red-500/20">跳转</button>
            <button type="button" onClick={onSearchHitPrevious} className="rounded-full px-2 py-1 text-[11px] text-red-200 hover:bg-red-500/20" aria-label="上一个命中">上一个命中</button>
            <button type="button" onClick={onSearchHitNext} className="rounded-full px-2 py-1 text-[11px] text-red-200 hover:bg-red-500/20" aria-label="下一个命中">下一个命中</button>
            <button type="button" onClick={onSearchHitClear} className="rounded-full px-2 py-1 text-[11px] text-red-200 hover:bg-red-500/20" aria-label="清除搜索结果">清除搜索结果</button>
          </div>
        </div>
      )}
    </div>
  )
}

export const SessionJsonlPanel = memo(SessionJsonlPanelInner)
