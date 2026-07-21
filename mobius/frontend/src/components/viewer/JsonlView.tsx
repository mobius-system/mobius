/**
 * viewer/JsonlView.tsx — jsonl 视图顶层组件.
 *
 * 从 jsonl-view.tsx 拆出. props.entries 是 jsonl 全部已读 entries; 这里负责:
 *  - 尾部窗口 (默认最近 JSONL_INITIAL_WINDOW_SIZE 条, 可"展开全部"/"加载全部"),
 *  - tool_result 合并回发起方 (mergeBashToolResultItems),
 *  - 对话轮次分组 (buildRounds),
 *  - 把 preItem / round / continuation 三类 block 喂给虚拟列表 (VirtualizedBlockList).
 */
import { useMemo, useState } from 'react'
import { VirtualizedBlockList } from '../jsonl-virtual-list'
import type { AnyEntry, JsonlViewItem, JsonlRenderBlock } from './types'
import { mergeBashToolResultItems } from './entry-extract'
import { buildRounds } from './rounds'
import { buildHeaderSummary } from './header-summary'
import { ContinuationGroup, RoundGroup, EntryCardWithImages } from './RoundGroups'
import { isTokenCountEvent, isEnvironmentContextEntry } from './entry-classify'

const JSONL_INITIAL_WINDOW_SIZE = 200

function JsonlInitialSkeleton() {
  return (
    <div className="jsonl-initial-skeleton" aria-live="polite" role="status">
      <div className="mb-3 flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        <span className="relative inline-flex h-3.5 w-3.5 flex-shrink-0">
          <span className="absolute inset-0 rounded-full border-2 border-[var(--text-muted)] opacity-20" />
          <span className="absolute inset-0 rounded-full border-2 border-transparent border-t-[var(--text-muted)] animate-spin" />
        </span>
        <span>正在加载会话数据...</span>
      </div>
      <div className="space-y-2" aria-hidden="true">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="jsonl-initial-skeleton__card">
            <div className="jsonl-initial-skeleton__line w-1/3" />
            <div className="jsonl-initial-skeleton__line w-5/6" />
            <div className="jsonl-initial-skeleton__line w-2/3" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function JsonlView({
  entries,
  title,
  emptyLoadingText,
  initialLoading,
  total,
  onLoadMore,
  loadingMore,
  showMeta = true,
}: {
  entries: AnyEntry[]
  title?: string
  emptyLoadingText?: string
  initialLoading?: boolean
  // count-then-tail: 后端先发 cheap total (jsonl_meta), 然后只回灌末尾 JSONL_INITIAL_WINDOW_SIZE 条.
  // 没传 total 时回退到 entries.length 旧行为, 老页面不破.
  total?: number
  // 点 "加载全部" 时调用; 上层负责 REST 拉剩余条目并 set entries.
  onLoadMore?: () => void
  loadingMore?: boolean
  // false 时 jsonl 卡片标题里不再显示 "#序号" 和 "MM-DD HH:MM:SS" 时间戳前缀.
  showMeta?: boolean
}) {
  const [showAll, setShowAll] = useState(false)
  const recent = useMemo(() => entries.slice(-(showAll ? entries.length : JSONL_INITIAL_WINDOW_SIZE)), [entries, showAll])
  const windowOffset = entries.length - recent.length
  const headerTitle = title === undefined ? 'JSONL' : title
  const visibleItems = useMemo(
    () => mergeBashToolResultItems(recent, windowOffset).filter(
      (item) => !isTokenCountEvent(item.entry) && !isEnvironmentContextEntry(item.entry),
    ),
    [recent, windowOffset],
  )
  const { preItems, rounds } = useMemo(() => buildRounds(visibleItems), [visibleItems])
  // 总数显示: 优先用后端给的 total (服务器侧 count, 比前端 entries.length 准)
  const displayTotal = typeof total === 'number' && total > entries.length ? total : entries.length
  const hasRemoteMore = typeof total === 'number' && total > entries.length
  const hasOmittedHead = hasRemoteMore || windowOffset > 0
  // 当整个 JSONL 视图处于"少组"场景时, 强制展开唯一的组且禁止折叠.
  // 涵盖:
  //   - 0 RoundGroup + 1 ContinuationGroup (无新轮, 只有上文接续, totalGroups=1)
  //   - 1 RoundGroup + 0 ContinuationGroup (1 轮对话, totalGroups=1)
  //   - 1 RoundGroup + 1 ContinuationGroup (1 轮对话 + 上下文接续, totalGroups=2 但 rounds=1)
  // 0 轮且无截断, 或 2+ 轮时, 沿用原"上文折叠 / 最新轮展开"默认行为.
  const hasContinuationGroup = preItems.length > 0 && hasOmittedHead
  const totalGroups = rounds.length + (hasContinuationGroup ? 1 : 0)
  const onlyGroup = totalGroups === 1 || rounds.length === 1
  // 末轮用户摘要: 最后一组 RoundGroup 的用户问题一句话, 展示在 header 右侧, 让用户在
  // "只显示尾部 / 加载全部" 时无需展开就能知道当前最末一轮在问什么. 与 RoundGroup 内
  // buildHeaderSummary(userItem.entry).short 同源, 视觉一致.
  const lastRoundUserSummary = useMemo(() => {
    if (rounds.length === 0) return ''
    const userItem = rounds[rounds.length - 1].items[0]
    return userItem ? buildHeaderSummary(userItem.entry).shortTail : ''
  }, [rounds])

  const renderBlocks = useMemo<JsonlRenderBlock[]>(() => {
    const blocks: JsonlRenderBlock[] = []
    if (preItems.length > 0 && hasOmittedHead) {
      blocks.push({ key: 'continuation', kind: 'continuation', items: preItems })
    } else {
      preItems.forEach((item) => {
        blocks.push({
          key: `pre:${item.entry?.uuid || item.entry?.id || item.entry?.timestamp || item.lineNo}`,
          kind: 'preItem',
          item,
        })
      })
    }
    rounds.forEach((round, index) => {
      blocks.push({
        key: `round:${round.items[0]?.entry?.uuid || round.items[0]?.lineNo || round.roundNum}`,
        kind: 'round',
        round,
        index,
      })
    })
    return blocks
  }, [hasOmittedHead, preItems, rounds])

  const renderBlock = (block: JsonlRenderBlock) => {
    if (block.kind === 'continuation') {
      return <ContinuationGroup items={block.items} onlyGroup={onlyGroup} showMeta={showMeta} />
    }
    if (block.kind === 'preItem') {
      const { entry, lineNo, bashResults, readResults } = block.item
      return (
        <EntryCardWithImages
          entry={entry}
          lineNo={lineNo}
          bashResults={bashResults}
          readResults={readResults}
          showMeta={showMeta}
        />
      )
    }
    return (
      <RoundGroup
        round={block.round}
        isLast={block.index === rounds.length - 1}
        isSecondLast={block.index === rounds.length - 2}
        onlyGroup={onlyGroup}
        showMeta={showMeta}
      />
    )
  }

  if (entries.length === 0) {
    if (initialLoading) return <JsonlInitialSkeleton />
    if (emptyLoadingText) {
      return (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.05] px-4 py-4 text-[12px] text-amber-200 card-enter" aria-live="polite">
          <div className="flex items-center gap-3">
            <span className="relative inline-flex w-4 h-4 flex-shrink-0">
              <span className="absolute inset-0 rounded-full border-2 border-amber-300/20" />
              <span className="absolute inset-0 rounded-full border-2 border-transparent border-t-amber-300 animate-spin" />
            </span>
            <span className="font-medium">{emptyLoadingText}</span>
          </div>
        </div>
      )
    }
    return (
      <div className="flex items-center gap-2 text-[12px] text-[var(--text-muted)] italic px-3 py-4" aria-live="polite" role="status">
        <span className="relative inline-flex h-3.5 w-3.5 flex-shrink-0 not-italic" aria-hidden="true">
          <span className="absolute inset-0 rounded-full border-2 border-[var(--text-muted)] opacity-20" />
          <span className="absolute inset-0 rounded-full border-2 border-transparent border-t-[var(--text-muted)] animate-spin" />
        </span>
        <span>暂无数据，请稍等</span>
      </div>
    )
  }

  return (
    <div className="text-[12px]">
      <div className="flex items-center gap-2 px-1 py-1 sticky top-0 z-10 backdrop-blur-lg bg-[var(--bg-page)]/80">
        {headerTitle && <span className="min-w-0 truncate text-[var(--text-secondary)] font-semibold" title={headerTitle}>{headerTitle}</span>}
        {rounds.length > 0 && <span className="text-[var(--text-muted)] text-[11px]">{rounds.length} 轮</span>}
        {/* {hasOmittedHead && <span className="text-[var(--text-muted)] text-[11px]">· 已显示尾部</span>} */}
        {hasRemoteMore && !!onLoadMore && (
          <button
            onClick={() => { if (!loadingMore) onLoadMore() }}
            disabled={!!loadingMore}
            className="text-[11px] px-2 py-0.5 rounded border border-[var(--border-color)] hover:bg-[var(--bg-hover)] text-[var(--text-muted)] disabled:opacity-50"
          >
            {loadingMore ? '加载中…' : `加载全部 (共 ${displayTotal} 条)`}
          </button>
        )}
        {!hasRemoteMore && entries.length > JSONL_INITIAL_WINDOW_SIZE && !showAll && (
          <button onClick={() => setShowAll(true)} className="text-[11px] px-2 py-0.5 rounded border border-[var(--border-color)] hover:bg-[var(--bg-hover)] text-[var(--text-muted)]">
            展开全部 ({entries.length})
          </button>
        )}
        {lastRoundUserSummary && (
          <span
            className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]"
            title={lastRoundUserSummary}
          >
            <span className="opacity-60">末轮 ·</span> {lastRoundUserSummary}
          </span>
        )}
      </div>
      <VirtualizedBlockList blocks={renderBlocks} renderBlock={renderBlock} />
    </div>
  )
}
