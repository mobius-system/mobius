import { memo, type RefObject } from 'react'
import { JsonlLiveTailCard, JsonlView } from './jsonl-view'
import { VSCodeOpenProvider } from './jsonl-vscode-link'

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
  backendAlive: boolean | null
  backendWorking: boolean | null
  backendPid: number | null
  realTimeInfo?: string
  lastTimestamp?: string | null
  hasNewMessages: boolean
  onLoadAllJsonl: () => void
  onScrollPositionChange: (userScrolledUp: boolean) => void
  onJumpToBottom: () => void
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
  backendAlive,
  backendWorking,
  backendPid,
  realTimeInfo,
  lastTimestamp,
  hasNewMessages,
  onLoadAllJsonl,
  onScrollPositionChange,
  onJumpToBottom,
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
        <div className="px-5 py-5">
          <VSCodeOpenProvider projectId={currentProjectId}>
            <JsonlView
              entries={visibleJsonl}
              title=""
              emptyLoadingText={jsonlEmptyLoadingText}
              initialLoading={jsonlInitialLoading}
              total={effectiveTotal}
              onLoadMore={onLoadAllJsonl}
              loadingMore={jsonlLoadingMore}
              showMeta={showJsonlMeta}
            />
            {backendAlive && backendWorking && (
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
