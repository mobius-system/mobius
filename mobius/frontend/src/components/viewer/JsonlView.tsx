/**
 * viewer/JsonlView.tsx — jsonl 视图顶层组件.
 *
 * 从 jsonl-view.tsx 拆出. props.entries 是 jsonl 全部已读 entries; 这里负责:
 *  - 尾部窗口 (默认最近 JSONL_INITIAL_WINDOW_SIZE 条, 可"展开全部"/"加载全部"),
 *  - tool_result 合并回发起方 (mergeBashToolResultItems),
 *  - 对话轮次分组 (buildRounds),
 *  - 把 preItem / round / continuation 三类 block 喂给虚拟列表 (VirtualizedBlockList).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { VirtualizedBlockList } from '../jsonl-virtual-list'
import type { AnyEntry, JsonlViewItem, JsonlRenderBlock } from './types'
import { mergeBashToolResultItems } from './entry-extract'
import { buildRounds } from './rounds'
import { buildHeaderSummary } from './header-summary'
import { ContinuationGroup, RoundGroup, EntryCardWithImages } from './RoundGroups'
import { isHiddenJsonlNoiseEntry } from './entry-classify'

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

// 与 renderBlocks 里 round block 的 key 公式严格一致 (跳转按 data-block-key 查 DOM 必须同口径).
function roundKeyOf(round: any): string {
  const first = round?.items?.[0]
  return `round:${first?.entry?.uuid || first?.lineNo || round?.roundNum}`
}

// 给定搜索命中的 (uuid, timestamp), 在已渲染的 rounds 里定位它所属的那一轮.
// 1) uuid 精确: 跨所有 round 的所有 item 找 entry.uuid / entry.id (命中可能在轮中非首条).
// 2) timestamp 区间兜底: 命中条目可能被 hideMinor 过滤 (如 thinking), 此时取 opener.ts <= 命中 ts 的最后一轮.
// 找不到返回 null (调用方据此触发 "加载全部" 再试, 或放弃).
function findRoundForMatch(rounds: any[], uuid: string | null | undefined, ts: string | null | undefined): any | null {
  if (uuid) {
    for (const r of rounds) {
      for (const it of r?.items || []) {
        const e = it?.entry
        if (e?.uuid === uuid || e?.id === uuid) return r
      }
    }
  }
  if (ts) {
    const mt = Date.parse(ts)
    if (Number.isFinite(mt)) {
      let best: any = null
      for (const r of rounds) {
        const opener = r?.items?.[0]?.entry
        const ot = Date.parse(opener?.timestamp || opener?.created_at || '')
        if (Number.isFinite(ot) && ot <= mt) best = r
        else if (Number.isFinite(ot) && ot > mt) break // rounds 时序递增
      }
      return best
    }
  }
  return null
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
  scrollToEntryUuid,
  scrollToMatchTs,
  onScrollResolved,
  onScrollUnresolved,
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
  // 搜索结果跳转: 把命中条目的 uuid / timestamp 传进来, 解析到所属轮次后滚动到该轮卡片.
  // 命中条目可能不在当前尾部窗口 (旧消息) → onScrollUnresolved 触发上层 "加载全部" 后再解析.
  scrollToEntryUuid?: string | null
  scrollToMatchTs?: string | null
  onScrollResolved?: () => void
  onScrollUnresolved?: () => void
}) {
  const [showAll, setShowAll] = useState(false)
  // 点 "加载全部" 后置 true: 把所有轮次组 / 上文续接组强制展开 (尊重用户已手动折叠的组).
  // 同时把 showAll 一并打开, 让加载到的头部条目也进入视窗, 真正 "全部可见且展开".
  const [forceExpandAll, setForceExpandAll] = useState(false)
  const recent = useMemo(() => entries.slice(-(showAll ? entries.length : JSONL_INITIAL_WINDOW_SIZE)), [entries, showAll])
  const windowOffset = entries.length - recent.length
  const headerTitle = title === undefined ? 'JSONL' : title
  const visibleItems = useMemo(
    () => mergeBashToolResultItems(recent, windowOffset).filter(
      (item) => !isHiddenJsonlNoiseEntry(item.entry),
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

  // 点击 header "末轮" 摘要 -> 跳转到最后一个 RoundGroup. scrollToKey 必须与 renderBlocks 里
  // round block 的 key 公式完全一致, 列表才能按 data-block-key 查到目标.
  const headerRef = useRef<HTMLDivElement>(null)
  // 末轮按钮触发的跳转 (内部).
  const [internalTarget, setInternalTarget] = useState<{ key: string; offset: number } | null>(null)
  const jumpToLastRound = () => {
    if (rounds.length === 0) return
    const lastRound = rounds[rounds.length - 1]
    setInternalTarget({ key: roundKeyOf(lastRound), offset: headerRef.current?.offsetHeight ?? 0 })
  }

  // 搜索结果跳转 (外部): 把 scrollToEntryUuid/scrollToMatchTs 解析成具体 round 的 key.
  // 命中条目不在当前已渲染 rounds (旧消息被尾部窗口截断, 或被 hideMinor 过滤且无 ts 兜底) 时,
  // 若还有远端未加载条目 (hasRemoteMore), 调 onScrollUnresolved 让上层 "加载全部" 后再解析.
  const [extTarget, setExtTarget] = useState<{ key: string; offset: number } | null>(null)
  const extActive = !!(scrollToEntryUuid || scrollToMatchTs)
  const onResolvedRef = useRef(onScrollResolved)
  onResolvedRef.current = onScrollResolved
  const onUnresolvedRef = useRef(onScrollUnresolved)
  onUnresolvedRef.current = onScrollUnresolved
  const unresolvedFiredRef = useRef(false)
  useEffect(() => {
    if (!extActive) { setExtTarget(null); unresolvedFiredRef.current = false; return }
    const round = findRoundForMatch(rounds, scrollToEntryUuid ?? null, scrollToMatchTs ?? null)
    if (round) {
      setExtTarget({ key: roundKeyOf(round), offset: headerRef.current?.offsetHeight ?? 0 })
    } else {
      setExtTarget(null)
      if (hasRemoteMore && !unresolvedFiredRef.current) {
        // 命中条目不在已加载范围 → 触发 "加载全部" 再解析 (只触发一次).
        unresolvedFiredRef.current = true
        onUnresolvedRef.current?.()
      } else if (!hasRemoteMore) {
        // 已无远端可加载仍找不到 (uuid/ts 都对不上) → 放弃, 清掉 target 恢复默认行为.
        onResolvedRef.current?.()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extActive, scrollToEntryUuid, scrollToMatchTs, rounds, hasRemoteMore])

  // 外部跳转优先; 内部末轮跳转作 fallback. 两者都为 null 时不滚.
  const activeTarget = extTarget ?? internalTarget

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
      return <ContinuationGroup items={block.items} onlyGroup={onlyGroup} forceExpandAll={forceExpandAll} showMeta={showMeta} />
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
        forceExpandAll={forceExpandAll}
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
      <div ref={headerRef} className="flex items-center gap-2 px-1 py-1 sticky top-0 z-10 backdrop-blur-lg bg-[var(--bg-page)]/80">
        {headerTitle && <span className="min-w-0 truncate text-[var(--text-secondary)] font-semibold" title={headerTitle}>{headerTitle}</span>}
        {rounds.length > 0 && <span className="text-[var(--text-muted)] text-[11px]">{rounds.length} 轮</span>}
        {/* {hasOmittedHead && <span className="text-[var(--text-muted)] text-[11px]">· 已显示尾部</span>} */}
        {hasRemoteMore && !!onLoadMore && (
          <button
            onClick={() => {
              if (loadingMore) return
              onLoadMore()
              // 加载全部后: 打开整窗 (showAll 让头部条目进入视窗) + 强制展开所有组, 一步 "全部可见且展开".
              setShowAll(true)
              setForceExpandAll(true)
            }}
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
          <button
            type="button"
            onClick={jumpToLastRound}
            className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] bg-transparent border-0 p-0 cursor-pointer text-left transition-colors"
            title={`点击跳转到末轮：${lastRoundUserSummary}`}
          >
            <span className="opacity-60">末轮 ·</span> {lastRoundUserSummary}
          </button>
        )}
      </div>
      <VirtualizedBlockList
        blocks={renderBlocks}
        renderBlock={renderBlock}
        scrollToKey={activeTarget?.key ?? null}
        scrollOffset={activeTarget?.offset ?? 0}
        onScrollToKeyDone={() => {
          // 到位 (或超时兜底) 后清除当前活跃跳转. 外部跳转还要通知上层清 URL 参数.
          if (extTarget) onResolvedRef.current?.()
          setExtTarget(null)
          setInternalTarget(null)
        }}
      />
    </div>
  )
}
