import { lazy, memo, Suspense, type RefObject } from 'react'
import { JsonlLiveTailCard, JsonlView } from './jsonl-view'
import { VSCodeOpenProvider } from './jsonl-vscode-link'

const EasyJsonlView = lazy(() => import('./easy-jsonl/EasyJsonlView'))

type SessionJsonlPanelProps = {
  currentProjectId: string
  chatContainerRef: RefObject<HTMLDivElement>
  endRef: RefObject<HTMLDivElement>
  visibleJsonl: any[]
  loadedJsonlCount: number
  jsonlTotal: number
  jsonlEmptyLoadingText: string
  jsonlInitialLoading: boolean
  jsonlLoadingMore: boolean
  showJsonlMeta: boolean
  cursorStyleTools: boolean
  backendAlive: boolean | null
  backendWorking: boolean | null
  backendPid: number | null
  realTimeInfo?: string
  lastTimestamp?: string | null
  hasNewMessages: boolean
  onLoadAllJsonl: () => void
  onScrollPositionChange: (userScrolledUp: boolean) => void
  onJumpToBottom: () => void
  // 搜索结果跳转: 命中条目 uuid / timestamp, JsonlView 解析到所属轮次卡片后滚动.
  scrollToEntryUuid?: string | null
  scrollToMatchTs?: string | null
  onMatchScrollResolved?: () => void
  onMatchScrollUnresolved?: () => void
  variant?: 'standard' | 'easy'
}

function SessionJsonlPanelInner({
  currentProjectId,
  chatContainerRef,
  endRef,
  visibleJsonl,
  loadedJsonlCount,
  jsonlTotal,
  jsonlEmptyLoadingText,
  jsonlInitialLoading,
  jsonlLoadingMore,
  showJsonlMeta,
  cursorStyleTools,
  backendAlive,
  backendWorking,
  backendPid,
  realTimeInfo,
  lastTimestamp,
  hasNewMessages,
  onLoadAllJsonl,
  onScrollPositionChange,
  onJumpToBottom,
  scrollToEntryUuid,
  scrollToMatchTs,
  onMatchScrollResolved,
  onMatchScrollUnresolved,
  variant = 'standard',
}: SessionJsonlPanelProps) {
  const effectiveTotal = jsonlTotal > loadedJsonlCount
    ? jsonlTotal - (loadedJsonlCount - visibleJsonl.length)
    : undefined

  return (
    <div data-tour="session-jsonl-view" className="mobius-chat-history flex flex-col min-w-0" style={{ width: '68%' }}>
      <div
        className="flex-1 overflow-y-auto relative"
        ref={chatContainerRef}
        onScroll={(e) => {
          const el = e.currentTarget
          const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
          onScrollPositionChange(distFromBottom > 200)
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
                  total={effectiveTotal}
                  onLoadMore={onLoadAllJsonl}
                  loadingMore={jsonlLoadingMore}
                  working={!!(backendAlive && backendWorking)}
                  liveText={realTimeInfo}
                  scrollToEntryUuid={scrollToEntryUuid}
                  scrollToMatchTs={scrollToMatchTs}
                  onScrollResolved={onMatchScrollResolved}
                  onScrollUnresolved={onMatchScrollUnresolved}
                />
              </Suspense>
            ) : (
              <JsonlView
                entries={visibleJsonl}
                title=""
                emptyLoadingText={jsonlEmptyLoadingText}
                initialLoading={jsonlInitialLoading}
                total={effectiveTotal}
                onLoadMore={onLoadAllJsonl}
                loadingMore={jsonlLoadingMore}
                showMeta={showJsonlMeta}
                cursorStyleTools={cursorStyleTools}
                scrollToEntryUuid={scrollToEntryUuid}
                scrollToMatchTs={scrollToMatchTs}
                onScrollResolved={onMatchScrollResolved}
                onScrollUnresolved={onMatchScrollUnresolved}
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
