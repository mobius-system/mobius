import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { JsonlLiveTailCard, JsonlView } from './jsonl-view'
import { VSCodeOpenProvider } from './jsonl-vscode-link'
import type { SessionHistoryStore } from '../services/agent-history-store'
import { useHistorySnapshotOf } from '../services/agent-history-store'
import { scrollDebug } from './scroll-debug'

const EasyJsonlView = lazy(() => import('./easy-jsonl/EasyJsonlView'))

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
  chatContainerRef: RefObject<HTMLDivElement>
  endRef: RefObject<HTMLDivElement>
  // agent-history-store 实例 (快照订阅在本面板内部 — Chat 不随每条数据重渲染).
  historyStore: SessionHistoryStore | null
  // 空会话占位文案的状态输入 (文案规则见下, 由 Chat 的会话状态派生).
  derivedStatus: string
  showJsonlMeta: boolean
  backendAlive: boolean | null
  backendWorking: boolean | null
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
  onEasyRoundCountChange?: (count: number) => void
  easyExpandAllSignal?: number
  variant?: 'standard' | 'easy'
}

function SessionJsonlPanelInner({
  currentProjectId,
  chatContainerRef,
  endRef,
  historyStore,
  derivedStatus,
  showJsonlMeta,
  backendAlive,
  backendWorking,
  backendPid,
  realTimeInfo,
  hasNewMessages,
  onScrollPositionChange,
  onJumpToBottom,
  onPauseToDequeue,
  scrollToEntryUuid,
  scrollToMatchTs,
  onMatchScrollResolved,
  onEasyRoundCountChange,
  easyExpandAllSignal,
  variant = 'standard',
}: SessionJsonlPanelProps) {
  // 订阅下沉: 快照/摊平条目/派生值都在本组件内算, Chat 只递 store.
  const historySnapshot = useHistorySnapshotOf(historyStore)
  // URL 中的 match/ts 会在首次精确滚动完成后被上层清理，命中视觉反馈不能随之消失。
  // 面板本地保留本次目标，直到切换到另一份 historyStore（即离开当前会话）。
  const highlightTargetRef = useRef<{ uuid: string | null; ts: string | null } | null>(null)
  const previousStoreRef = useRef(historyStore)
  // Keep the target synchronously while rendering. The parent removes match/ts as soon as
  // scrolling completes; a passive effect here can lose a frame (and the highlight) when
  // that URL cleanup races the initial target capture.
  if (previousStoreRef.current !== historyStore) {
    // Do not discard a URL target during the normal null -> store initialization
    // transition; clear only after an already-bound session is replaced.
    if (previousStoreRef.current !== null) highlightTargetRef.current = null
    previousStoreRef.current = historyStore
  }
  if (scrollToEntryUuid || scrollToMatchTs) {
    highlightTargetRef.current = { uuid: scrollToEntryUuid || null, ts: scrollToMatchTs || null }
  }
  const effectiveScrollToEntryUuid = scrollToEntryUuid || highlightTargetRef.current?.uuid || null
  const effectiveScrollToMatchTs = scrollToMatchTs || highlightTargetRef.current?.ts || null
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
  // 上一帧 scrollTop, 用于"方向性"解除判定 (仅向上滚才算用户解除钉底).
  const lastScrollTopRef = useRef<number | null>(null)

  // 用户输入意图监听: wheel / touchmove / keydown 一旦表达"向上翻"意图, 立即把
  // userScrolledUp 置 true (终止 EntriesAutoScroll 的追底), 不再依赖 onScroll 里
  // "向上滚 > 2px"的方向推断 — 慢速小步上滚会被 lerp 追底拉回. 这些事件天然来自用户,
  // 绕开"程序滚动 vs 用户滚动"的来源识别; 恢复钉底仍由 onScroll 的 dist < 4 负责.
  // 不监听 pointerdown: 点按卡片/代码/选中文字等非滚动点击也会触发它, 会把 userScrolledUp
  // 误置 true 从而永久停掉追底 ("不追底"); 滚动条拖拽仍由 onScroll 的 movedUp 方向判定兜底.
  useEffect(() => {
    const el = chatContainerRef.current
    if (!el) return

    // wheel 上滚 (deltaY<0) 才算向上翻; 向下滚留 onScroll 贴底判定恢复钉底.
    const onWheel = (e: WheelEvent) => {
      scrollDebug('wheel event: deltaY=', e.deltaY, e.deltaY < 0 ? '(上滚→flag true)' : '(下滚, 交给 onScroll)')
      if (e.deltaY < 0) onScrollPositionChange(true)
    }
    // 手指下移 (clientY 增大) = 内容上滚 (向上翻); 反之回底部交给 onScroll 恢复.
    let lastTouchY: number | null = null
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!t) return
      if (lastTouchY !== null && t.clientY > lastTouchY) {
        scrollDebug('touchmove: 手指下移(内容上翻) → flag true')
        onScrollPositionChange(true)
      }
      lastTouchY = t.clientY
    }
    // 仅"向上翻"类按键视为接管; 输入区与滚动容器是兄弟节点, 输入框方向键不会冒泡到此.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') {
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
        <div className="px-5 py-5" style={variant === 'easy' ? { paddingBottom: 176 } : undefined}>
          <VSCodeOpenProvider projectId={currentProjectId}>
            {variant === 'easy' ? (
              <Suspense fallback={<div className="py-10 text-center text-[12px] text-[var(--text-muted)]">正在整理简易对话...</div>}>
                <EasyJsonlView
                  entries={visibleJsonl}
                  emptyLoadingText={jsonlEmptyLoadingText}
                  initialLoading={jsonlInitialLoading}
                  working={!!(backendAlive && backendWorking)}
                  liveText={realTimeInfo}
                  scrollToEntryUuid={effectiveScrollToEntryUuid}
                  scrollToMatchTs={effectiveScrollToMatchTs}
                  onScrollResolved={onMatchScrollResolved}
                  onRoundCountChange={onEasyRoundCountChange}
                  expandAllSignal={easyExpandAllSignal}
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
            {variant === 'standard' && backendAlive && backendWorking && (
              <JsonlLiveTailCard
                lastTimestamp={lastTimestamp}
                pid={backendPid}
                realTimeInfo={realTimeInfo}
              />
            )}
            <div ref={endRef} />
          </VSCodeOpenProvider>
        </div>
      </div>
      {hasNewMessages && (
        <div className="flex justify-center py-1 flex-shrink-0">
          <button onClick={onJumpToBottom} className="px-4 py-1.5 text-[12px] bg-blue-500/90 text-white rounded-full hover:bg-blue-500 transition-colors shadow-md flex items-center gap-1.5">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 14l-7 7m0 0l-7-7m7 7V3" /></svg>
            新消息
          </button>
        </div>
      )}
    </div>
  )
}

export const SessionJsonlPanel = memo(SessionJsonlPanelInner)
