/**
 * viewer/RoundGroups.tsx — 对话轮次分组 / 上文续接分组的容器组件.
 *
 * 从 jsonl-view.tsx 拆出.
 *  - EntryCardWithImages: 在普通 entry 卡片后追加 display_images / 附件图片派生的图像卡片.
 *  - ContinuationGroup: "上文续接"折叠组 (尾部窗口截掉的头部条目); 只有一组时强制展开.
 *  - RoundGroup: 一个对话轮次 (1 条 user 问题 + N 条 agent 回复); 最新两轮默认展开,
 *    更早的轮在跌出最新两轮时自动折叠, 用户手动操作过的轮尊重用户.
 */
import { Fragment, memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import type { AnyEntry, BashToolResult, JsonlViewItem, Round, RoundItem } from './types'
import type { ToolStatus, ToolStatusMap } from './tool-status'
import { deriveToolCallStatus } from './tool-status'
import { groupExploreItems, type ExploreRenderItem } from './explore-group'
import { entryDisplayImages, entryReadImagePaths, entryUserAttachmentImages } from './entry-extract'
import { buildHeaderSummary } from './header-summary'
import { isEasyFlatEntry, isEasyMicroEntry, JsonEntryCard } from './EntryCard'
import { DisplayImagesCard } from './DisplayImages'
import type { TaskPlanByUuid } from './task-progress'
import type { RoundHeaderPalette } from './round-header-palette'
import { ASSISTANT_END_TURN_THEME } from './themes'
import { isRoundOpenerEntry } from './utils'

// 每卡工具状态 (组级 map 的预派生值): 按 (entry 身份, map 身份) 记忆.
// 传 primitive 给卡片 → SSE 新数据只换 map 身份, 内容未变的卡拿到同一字符串, memo 保持.
const statusCacheByEntry = new WeakMap<AnyEntry, { map: ToolStatusMap | null | undefined; status: ToolStatus | null }>()
function toolStatusOf(entry: AnyEntry, map: ToolStatusMap | null | undefined): ToolStatus | null {
  const hit = statusCacheByEntry.get(entry)
  if (hit && hit.map === map) return hit.status
  const status = deriveToolCallStatus(entry, map)
  statusCacheByEntry.set(entry, { map, status })
  return status
}

export function EntryCardWithImages({ entry, lineNo, bashResults = [], readResults = [], forceOpen = false, searchHighlighted = false, parentOrderedCollapse = false, showMeta = true, dense = false, easyMode = false, easyOpenerOverride = false, toolStatus, taskPlans }: {
  entry: AnyEntry
  lineNo: number
  bashResults?: BashToolResult[]
  readResults?: BashToolResult[]
  // forceOpen: 搜索命中该卡, 透传给 JsonEntryCard 强制展开.
  forceOpen?: boolean
  searchHighlighted?: boolean
  // parentOrderedCollapse: 上下文折叠规则命中的卡片, 透传给 JsonEntryCard 默认折叠 (用户仍可手动展开).
  parentOrderedCollapse?: boolean
  showMeta?: boolean
  dense?: boolean
  easyMode?: boolean
  easyOpenerOverride?: boolean
  // 已派生的每卡工具状态 ('running' | 'success' | 'error' | null), 见 toolStatusOf.
  toolStatus?: ToolStatus | null
  // 任务工具跨条目累积快照 (anchor uuid → PlanUpdate), 按卡片 uuid 取值透传给计划视图.
  taskPlans?: TaskPlanByUuid | null
}) {
  const displayImages = entryDisplayImages(entry)
  const readImages = entryReadImagePaths(entry)
  const attachmentImages = entryUserAttachmentImages(entry)
  const imgs = Array.from(new Set([...displayImages, ...readImages, ...attachmentImages]))
  const labels = [
    displayImages.length > 0 ? 'display_images' : '',
    readImages.length > 0 ? '读取图片' : '',
    attachmentImages.length > 0 ? '附件图片' : '',
  ].filter(Boolean)
  const sourceLabel = labels.join(' / ') || '图片'
  const uuid = typeof entry?.uuid === 'string' ? entry.uuid : null
  return (
    <>
      <JsonEntryCard entry={entry} lineNo={lineNo} forceOpen={forceOpen} searchHighlighted={searchHighlighted} parentOrderedCollapse={parentOrderedCollapse} showMeta={showMeta} dense={dense} easyMode={easyMode} easyOpenerOverride={easyOpenerOverride} bashResults={bashResults} readResults={readResults} toolStatus={toolStatus} taskPlan={(uuid && taskPlans) ? taskPlans.get(uuid) ?? null : null} />
      {imgs.length > 0 && <DisplayImagesCard images={imgs} lineNo={lineNo} sourceLabel={sourceLabel} easyMode={easyMode} />}
    </>
  )
}

// 探索类工具聚合容器: 把连续的只读/搜索调用折叠成 "已探索 N 个工具" 一行 (Cursor 式).
// 含失败调用时默认展开并标红, 摘要行带错误标记 (折叠也不能藏起错误); 展开后逐条渲染子卡片.
export function ExploreGroupCard({ items, hasError, showMeta = true, easyMode = false, toolStatusMap, collapseLineNos, focusLineNo, forceFocusOpen = false, taskPlans }: {
  items: RoundItem[]
  hasError: boolean
  showMeta?: boolean
  easyMode?: boolean
  toolStatusMap?: ToolStatusMap | null
  collapseLineNos?: Set<number>
  // 搜索命中卡可能被聚合在“探索”组内；组本身也必须打开，子卡才有机会展开/滚到。
  focusLineNo?: number | null
  forceFocusOpen?: boolean
  taskPlans?: TaskPlanByUuid | null
}) {
  const containsFocus = typeof focusLineNo === 'number' && items.some(item => item.lineNo === focusLineNo)
  const [open, setOpen] = useState(hasError || containsFocus)
  useEffect(() => { if (containsFocus) setOpen(true) }, [containsFocus])
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className={`jsonl-entry-card relative mb-2 rounded-lg border border-sky-500/20 bg-sky-500/[0.04] shadow-sm${easyMode ? ' easy-explore-group' : ''}`}
    >
      <summary className={`cursor-pointer px-3 pt-1.5 ${open ? 'pb-0.5' : 'pb-1.5'} flex items-center gap-2 text-[12px] select-text`}>
        <Search className={`h-3 w-3 flex-shrink-0 ${hasError ? 'text-red-400' : 'text-sky-400'}`} strokeWidth={2.2} aria-hidden="true" />
        <span className={`font-mono font-semibold flex-shrink-0 ${hasError ? 'text-red-300' : 'text-sky-300'}`}>探索</span>
        <span className="text-[11px] text-[var(--text-muted)] truncate flex-1">
          已聚合 {items.length} 个只读 / 搜索工具调用{hasError ? ' · 含失败' : ''}
        </span>
        <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 font-mono">{open ? '▲' : '▼'}</span>
      </summary>
      {open && (
        <div className="mt-1 flex flex-col gap-1 px-1 pb-1">
          {items.map((item) => (
            <EntryCardWithImages
              key={(item.entry?.uuid || '') + '#' + item.lineNo}
              entry={item.entry}
              lineNo={item.lineNo}
              bashResults={item.bashResults}
              readResults={item.readResults}
              showMeta={showMeta}
              easyMode={easyMode}
              toolStatus={toolStatusOf(item.entry, toolStatusMap)}
              forceOpen={forceFocusOpen && item.lineNo === focusLineNo}
              searchHighlighted={item.lineNo === focusLineNo}
              parentOrderedCollapse={collapseLineNos?.has(item.lineNo)}
              taskPlans={taskPlans}
            />
          ))}
        </div>
      )}
    </details>
  )
}

// 巨轮窗口跳过中段条目时的提示卡: 不说明白的话, 用户会以为这一轮内容就这么多.
// 非可展开卡, 配色对齐"结束"卡的金色系统主题 (amber), 在长列表里同样一眼可扫.
export function HiddenGapCard({ count }: { count: number }) {
  return (
    <div className={`jsonl-entry-card relative mb-2 rounded-lg border shadow-sm px-3 py-1.5 flex items-center gap-2 ${ASSISTANT_END_TURN_THEME.border} ${ASSISTANT_END_TURN_THEME.bg}`}>
      <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
        <span className={`h-1.5 w-1.5 rounded-full ${ASSISTANT_END_TURN_THEME.dot}`}></span>
      </span>
      <span className={`font-mono font-semibold flex-shrink-0 ${ASSISTANT_END_TURN_THEME.text}`}>隐藏</span>
      <span className="text-[11px] text-[var(--text-secondary)] truncate flex-1 min-w-0">本轮过长，此处隐藏了一些对话内容</span>
      <span className="text-[10px] font-mono text-[var(--text-muted)] flex-shrink-0">{count} 条</span>
    </div>
  )
}

// 一条提示行 (左侧与普通卡片一致的行号槽 + 卡片本体), 与 RoundGroup 的其它行同构.
function HiddenGapRow({ count }: { count: number }) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="font-mono text-[9px] text-[var(--text-dimmed)] flex-shrink-0 mt-2.5 w-5 text-right leading-none select-none">⋯</span>
      <div className="flex-1 min-w-0">
        <HiddenGapCard count={count} />
      </div>
    </div>
  )
}

export function ContinuationGroup({ items, onlyGroup, forceExpandAll = false, showMeta = true, easyMode = false, toolStatusMap, collapseLineNos, focusLineNo, taskPlans }: { items: JsonlViewItem[]; onlyGroup: boolean; forceExpandAll?: boolean; showMeta?: boolean; easyMode?: boolean; toolStatusMap?: ToolStatusMap | null; collapseLineNos?: Set<number>; focusLineNo?: number | null; taskPlans?: TaskPlanByUuid | null }) {
  // 只有一组时强制展开, 禁止折叠; forceExpandAll (点 "加载全部") 时也展开; 其它场景保留原默认折叠行为
  const containsFocus = typeof focusLineNo === 'number' && items.some(item => item.lineNo === focusLineNo)
  const [open, setOpen] = useState(onlyGroup || forceExpandAll || containsFocus)
  useEffect(() => { if (onlyGroup || forceExpandAll || containsFocus) setOpen(true) }, [onlyGroup, forceExpandAll, containsFocus])
  const firstSummary = items[0] ? buildHeaderSummary(items[0].entry).short : ''

  return (
    <div className={`mb-1${easyMode ? ' easy-round-group' : ''}`}>
      <button
        type="button"
        onClick={onlyGroup ? undefined : () => setOpen(o => !o)}
        disabled={onlyGroup}
        aria-expanded={open}
        className={`${easyMode ? 'easy-round-group-trigger' : 'w-full flex items-center gap-2 px-2 py-1.5 rounded-xl border border-amber-500/15 transition-colors'} text-left group ${onlyGroup ? 'cursor-default' : 'hover:bg-[var(--bg-card-hover)] hover:border-amber-500/30'}`}
      >
        {easyMode ? (
          <>
            <span className="easy-round-group-trigger__label">{open ? '点击收起上文' : '点击展开上文'}</span>
            <ChevronDown className="easy-round-group-trigger__icon" size={14} strokeWidth={2.2} aria-hidden="true" />
          </>
        ) : (
          <>
            <span className="font-mono text-[10px] font-bold text-amber-400/75 flex-shrink-0 w-8">...</span>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />
            <span className="text-[11px] text-[var(--text-secondary)] truncate flex-1 min-w-0">上文续接{firstSummary ? ` · ${firstSummary}` : ''}</span>
            <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 font-mono">+{items.length}</span>
            {!onlyGroup && <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 opacity-50 group-hover:opacity-100 transition-opacity">{open ? '▲' : '▼'}</span>}
          </>
        )}
      </button>

      {open && (
        <div className="mt-2">
          {items.map(({ entry, lineNo, bashResults, readResults }) => (
            <div key={(entry?.uuid || entry?.id || entry?.timestamp || '') + '#' + lineNo} className={`flex items-start gap-1.5${easyMode ? ' easy-round-entry-row' : ''}`}>
              {!easyMode && <span className="font-mono text-[9px] text-[var(--text-dimmed)] flex-shrink-0 mt-2.5 w-7 text-right leading-none select-none">...</span>}
              <div className="flex-1 min-w-0">
                <EntryCardWithImages entry={entry} lineNo={lineNo} bashResults={bashResults} readResults={readResults} showMeta={showMeta} easyMode={easyMode} toolStatus={toolStatusOf(entry, toolStatusMap)} forceOpen={lineNo === focusLineNo} parentOrderedCollapse={collapseLineNos?.has(lineNo)} taskPlans={taskPlans} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/*
 * Render a consecutive easy-mode micro-step run with an animated disclosure row.
 */
function EasyMicroStepGroup({ items, showMeta, toolStatusMap, collapseLineNos, focusLineNo, forceFocusOpen, taskPlans }: {
  items: RoundItem[]
  showMeta: boolean
  toolStatusMap?: ToolStatusMap | null
  collapseLineNos?: Set<number>
  focusLineNo?: number | null
  forceFocusOpen?: boolean
  taskPlans?: TaskPlanByUuid | null
}) {
  const containsFocus = !!forceFocusOpen && typeof focusLineNo === 'number' && items.some((item) => item.lineNo === focusLineNo)
  const [expanded, setExpanded] = useState(containsFocus)
  useEffect(() => { if (containsFocus) setExpanded(true) }, [containsFocus])
  const count = items.length
  return (
    <div className={`easy-step-group${expanded ? ' is-expanded' : ''}`}>
      <button
        type="button"
        className="easy-step-group__trigger"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="easy-step-group__label">
          {expanded ? `收起${count}个步骤` : `完成了${count}个步骤，点击查看`}
        </span>
        <ChevronDown className="easy-step-group__icon" size={14} strokeWidth={2.2} aria-hidden="true" />
      </button>
      <div className="easy-step-group__collapse" aria-hidden={!expanded}>
        <div className="easy-step-group__content">
          {items.map((item) => (
            <div key={(item.entry?.uuid || item.entry?.id || '') + '#' + item.lineNo} className="easy-round-entry-row">
              <div className="flex-1 min-w-0">
                <EntryCardWithImages
                  entry={item.entry}
                  lineNo={item.lineNo}
                  bashResults={item.bashResults}
                  readResults={item.readResults}
                  showMeta={showMeta}
                  easyMode
                  toolStatus={toolStatusOf(item.entry, toolStatusMap)}
                  forceOpen={!!forceFocusOpen && item.lineNo === focusLineNo}
                  searchHighlighted={item.lineNo === focusLineNo}
                  parentOrderedCollapse={collapseLineNos?.has(item.lineNo)}
                  taskPlans={taskPlans}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// 受控组件: 开合状态来自 store 的组状态机 (closed/open-*), 本组件只发转移意图.
// 自动规则: 用户没插手过 (sticky=false) 时跟随"末两轮展开"自动开合;
// 用户点过一次后 sticky=true, 自动规则永不再接管. 展开即加载由 store 状态机保证.
// memo: 未收数据的组全部 prop 身份稳定 (round 缓存 + 回调缓存 + map 缓存), 整组跳过重渲染.
function RoundGroupInner({ round, isLast, isSecondLast, onlyGroup, open, sticky = false, loading = false, failed = false, resident = false, onUserToggle, onAutoOpen, onAutoClose, onRetry, forceOpen = false, searchActive = false, searchHighlighted = false, showMeta = true, easyMode = false, toolStatusMap, collapseLineNos, focusLineNo, headerPalette, taskPlans, headerTitle, headerSummary }: { round: Round; isLast: boolean; isSecondLast: boolean; onlyGroup: boolean; open: boolean; sticky?: boolean; loading?: boolean; failed?: boolean; resident?: boolean; onUserToggle: () => void; onAutoOpen: () => void; onAutoClose: () => void; onRetry: () => void; forceOpen?: boolean; searchActive?: boolean; searchHighlighted?: boolean; showMeta?: boolean; easyMode?: boolean; toolStatusMap?: ToolStatusMap | null; collapseLineNos?: Set<number>; focusLineNo?: number | null; headerPalette: RoundHeaderPalette; taskPlans?: TaskPlanByUuid | null; headerTitle?: string; headerSummary?: string }) {
  const autoOpen = isLast || isSecondLast
  // 自动开合同步: store 状态落后于期望态时推一把 (首次挂载/轮次升跌时).
  useEffect(() => {
    // 搜索命中是显式导航，必须压过此前把该轮锁定为 sticky/closed 的状态。
    if (forceOpen) { if (!open) onAutoOpen(); return }
    // 自动定位结束后只保留红色标记与当前开合状态；用户可以自行折叠，
    // 也不会被“旧轮次自动关闭”规则立刻收回去。
    if (searchActive) return
    if (sticky) return
    if (onlyGroup || autoOpen) { if (!open) onAutoOpen(); return }
    if (open) onAutoClose()
  }, [sticky, autoOpen, onlyGroup, forceOpen, searchActive, open, onAutoOpen, onAutoClose])
  // 首帧防闪: store 还没来得及转移时, 按"应展开"先行绘制 (视觉态), effect 随后对齐真实态.
  const openVisual = open || forceOpen || (!sticky && (onlyGroup || autoOpen))

  const toggle = () => onUserToggle()

  const openerItem = easyMode ? round.items.find((item) => isRoundOpenerEntry(item.entry)) : undefined
  const userItem = openerItem || round.items[0]
  const essentialOpener = easyMode ? round.essential_dict?.opener || null : null
  const essentialFinal = easyMode ? round.essential_dict?.final || null : null
  const agentCount = round.items.length - 1
  const easyCollapsed = easyMode && !openVisual
  // 条目未加载时 (折叠轮零条目驻留), 用调用方给的元数据摘要当轮次标识.
  const userSummary = userItem ? buildHeaderSummary(userItem.entry).short : (headerSummary || '')
  // 探索类聚合: 连续只读/搜索调用合并为 "已探索 N 个工具".
  const renderSeq: ExploreRenderItem[] = groupExploreItems(round.items, toolStatusMap)
  // 简易模式只折叠“连续微缩卡 → 紧邻平铺文本卡”的步骤串，避免把没有结论的尾部过程藏起来。
  // Easy mode collapses only a consecutive micro-card run immediately followed by flat text.
  const easyStepRuns = new Map<number, RoundItem[]>()
  const easyStepHidden = new Set<number>()
  if (easyMode) {
    for (let index = 0; index < renderSeq.length; index += 1) {
      const current = renderSeq[index]
      if (current.kind !== 'single' || !isEasyMicroEntry(current.item.entry)) continue
      const run: RoundItem[] = [current.item]
      let end = index + 1
      while (end < renderSeq.length) {
        const next = renderSeq[end]
        if (next.kind !== 'single' || !isEasyMicroEntry(next.item.entry)) break
        run.push(next.item)
        end += 1
      }
      const following = renderSeq[end]
      if (run.length > 0 && following?.kind === 'single' && isEasyFlatEntry(following.item.entry)) {
        easyStepRuns.set(index, run)
        for (let hidden = index + 1; hidden < end; hidden += 1) easyStepHidden.add(hidden)
        index = end - 1
      }
    }
  }
  // 巨轮被窗口跳过的中段: 在对应位置插提示行 (游标按 renderSeq 顺序推进, 与 items 下标单调对应).
  const hiddenGaps = round.hiddenGaps || []
  let gapCursor = 0
  const gapsBefore = (relIdx: number) => {
    const rows: ReactNode[] = []
    while (gapCursor < hiddenGaps.length && hiddenGaps[gapCursor].at <= relIdx) {
      const gap = hiddenGaps[gapCursor]
      gapCursor += 1
      rows.push(<HiddenGapRow key={`hidden-gap-${gapCursor}-${gap.at}`} count={gap.count} />)
    }
    return rows
  }

  // 折叠态和展开态必须复用同一张 opener 卡片；不能用摘要 div 替换它，否则内容截断和高度都会漂移。
  // The opener must use one card in both states; swapping in a summary div changes truncation and height.
  const openerEntry = userItem?.entry || essentialOpener
  const openerLineNo = userItem?.lineNo ?? 0
  const collapsedOpener = easyMode && openerEntry ? (
    <div className="easy-collapsed-opener">
      <div className="easy-round-opener-row">
        <span aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <EntryCardWithImages
            entry={openerEntry}
            lineNo={openerLineNo}
            bashResults={userItem?.bashResults}
            readResults={userItem?.readResults}
            showMeta={showMeta}
            easyMode
            easyOpenerOverride={true}
            toolStatus={toolStatusOf(openerEntry, toolStatusMap)}
            forceOpen={forceOpen && openerLineNo === focusLineNo}
            searchHighlighted={openerLineNo === focusLineNo}
            parentOrderedCollapse={collapseLineNos?.has(openerLineNo)}
            taskPlans={taskPlans}
          />
        </div>
      </div>
    </div>
  ) : null
  const collapsedSummaryOpener = easyCollapsed && !userItem && (headerSummary || userSummary) ? (
    <div className="easy-user-bubble">{headerSummary || userSummary}</div>
  ) : null
  const collapsedFinal = easyMode && easyCollapsed && essentialFinal ? (
    <div className="easy-essential-final" data-essential="final">
      <EntryCardWithImages
        entry={essentialFinal}
        lineNo={0}
        showMeta={false}
        easyMode
        forceOpen
      />
    </div>
  ) : null

  return (
    <div className={`mb-1${easyMode ? ' easy-round-group' : ''}`}>
      {collapsedOpener}
      {collapsedSummaryOpener}
      <button
        type="button"
        onClick={onlyGroup ? undefined : toggle}
        disabled={onlyGroup}
        data-round-header-palette={headerPalette.id}
        aria-expanded={openVisual}
        aria-keyshortcuts="Control+Shift+K"
        title={`轮次背景：${headerPalette.name} · Ctrl+Shift+K 切换`}
        data-search-hit-group={searchHighlighted ? 'true' : undefined}
        className={`${easyMode ? 'easy-round-group-trigger' : 'round-group-trigger w-full h-8 min-h-8 flex items-center gap-2 px-2 py-0 rounded-lg border'} text-left group ${onlyGroup ? 'cursor-default' : 'cursor-pointer'} ${searchHighlighted ? 'ring-2 ring-red-500/95 border-red-500/95 bg-red-500/15 shadow-[0_0_0_3px_rgba(239,68,68,0.24),0_0_22px_rgba(239,68,68,0.3)]' : ''}`}
        style={{
          '--round-header-background': headerPalette.background,
          '--round-header-background-size': headerPalette.backgroundSize,
          // round-group-trigger 的基础 CSS 会从这些变量写入 border-color；命中态
          // 用变量覆盖而不是只依赖 Tailwind border 类，确保不会被基础样式盖掉。
          '--round-header-border': searchHighlighted ? 'rgba(239,68,68,0.95)' : headerPalette.border,
          '--round-header-border-hover': searchHighlighted ? 'rgba(248,113,113,1)' : headerPalette.borderHover,
          '--round-header-accent': searchHighlighted ? 'rgba(239,68,68,1)' : headerPalette.accent,
          boxShadow: searchHighlighted
            ? 'inset 3px 0 0 rgba(239,68,68,1), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 3px rgba(239,68,68,0.24), 0 0 22px rgba(239,68,68,0.3)'
            : undefined,
        } as CSSProperties}
      >
        {easyMode ? (
          <>
            <span className="easy-round-group-trigger__label">{openVisual ? '点击收起' : '点击展开'}</span>
            <ChevronDown className="easy-round-group-trigger__icon" size={14} strokeWidth={2.2} aria-hidden="true" />
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-[var(--round-header-accent)]" />
            <span className="font-mono text-[10px] font-bold text-[var(--text-secondary)] flex-shrink-0 w-12" title={`第 ${round.roundNum} 轮`}>
              {headerTitle ?? `第 ${round.roundNum} 轮`}
            </span>
            <span className="text-[11px] text-[var(--text-secondary)] truncate flex-1 min-w-0">
              {/* 展开后用户问题由下方编号为 roundNum 的卡片完整呈现, header 不再重复摘要 (仅折叠态显示作轮次标识) */}
              {openVisual ? '' : (userSummary || '(空)')}
            </span>
            {searchHighlighted && (
              <span className="inline-flex items-center gap-1 rounded-full border border-red-400/80 bg-red-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-red-100 flex-shrink-0" title="搜索命中所在轮次">
                <Search className="h-3 w-3" strokeWidth={2.4} aria-hidden="true" />
                搜索命中
              </span>
            )}
            {!openVisual && agentCount > 0 && (
              <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 font-mono">
                +{agentCount}
              </span>
            )}
            {!onlyGroup && (
              <span className="text-[10px] text-[var(--text-muted)] flex-shrink-0 opacity-50 group-hover:opacity-100 transition-opacity">
                {openVisual ? '▲' : '▼'}
              </span>
            )}
          </>
        )}
      </button>

      {collapsedFinal}

      {openVisual && (
        <div className="mt-2 jsonl-thread">
          {!resident && (
            <div className="mb-1 flex justify-center">
              {failed ? (
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={loading}
                  className="text-[10px] px-2 py-0.5 rounded border border-dashed text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-60"
                >
                  {loading ? '正在重试…' : '明细加载失败 · 点击重试'}
                </button>
              ) : (
                <span className="text-[10px] px-2 py-0.5 text-[var(--text-muted)]">
                  正在加载本轮明细…
                </span>
              )}
            </div>
          )}
          {/* 已加载但渲染为空 (条目全被噪声过滤 / 数据本就为空) → 显式提醒, 不留空白. */}
          {resident && renderSeq.length === 0 && (
            <div className="mb-1 flex justify-center">
              <span className="text-[10px] px-2 py-0.5 rounded border border-dashed text-[var(--text-muted)]">
                本轮为空 · 没有可显示的条目
              </span>
            </div>
          )}
          {renderSeq.map((ri, idx) => {
            const easyStepRun = easyStepRuns.get(idx)
            if (easyStepRun) {
              return (
                <Fragment key={`easy-steps-${easyStepRun[0]?.lineNo ?? idx}`}>
                  {gapsBefore(easyStepRun[0]?.relIdx ?? 0)}
                  <EasyMicroStepGroup
                    items={easyStepRun}
                    showMeta={showMeta}
                    toolStatusMap={toolStatusMap}
                    collapseLineNos={collapseLineNos}
                    focusLineNo={focusLineNo}
                    forceFocusOpen={forceOpen}
                    taskPlans={taskPlans}
                  />
                </Fragment>
              )
            }
            if (easyStepHidden.has(idx)) return null
            if (ri.kind === 'explore') {
              return (
                <Fragment key={`explore-${idx}-${ri.items[0]?.lineNo ?? ''}`}>
                  {gapsBefore(ri.items[0]?.relIdx ?? 0)}
                  <div className={`flex items-start gap-1.5${easyMode ? ' easy-round-entry-row' : ''}`}>
                    <span className="font-mono text-[9px] text-[var(--text-dimmed)] flex-shrink-0 mt-2.5 w-5 text-right leading-none select-none">·</span>
                    <div className="flex-1 min-w-0">
                      <ExploreGroupCard items={ri.items} hasError={ri.hasError} showMeta={showMeta} easyMode={easyMode} toolStatusMap={toolStatusMap} collapseLineNos={collapseLineNos} focusLineNo={focusLineNo} forceFocusOpen={forceOpen} taskPlans={taskPlans} />
                    </div>
                  </div>
                </Fragment>
              )
            }
            const item = ri.item
            const isUserItem = easyMode ? (isRoundOpenerEntry(item.entry) || item.relIdx === 0) : item.relIdx === 0
            // 简易模式把 opener 提到 group 操作行之前，避免“点击收起”跑到用户气泡上方。
            // Easy mode renders the opener before the group control so “collapse” stays below the bubble.
            if (easyMode && openVisual && userItem && item.lineNo === userItem.lineNo) return null
            return (
              <Fragment key={(item.entry?.uuid || '') + '#' + item.lineNo}>
                {gapsBefore(item.relIdx)}
                <div className={`flex items-start gap-1.5${easyMode ? ' easy-round-entry-row' : ''}${easyMode && isUserItem ? ' easy-round-opener-row' : ''}`}>
                  <span className="font-mono text-[9px] text-[var(--text-dimmed)] flex-shrink-0 mt-2.5 w-5 text-right leading-none select-none">
                    {/* 编号: 用户问题=轮次号(如 3), AI 回复=轮次号.子序号(如 3.1/3.2) */}
                    {isUserItem ? 'u' : `${item.relIdx}`}
                    {/* {isUserItem ? `${round.roundNum}` : `${round.roundNum}.${item.relIdx}`} */}
                  </span>
                  <div className="flex-1 min-w-0">
                    <EntryCardWithImages
                      entry={item.entry}
                      lineNo={item.lineNo}
                      bashResults={item.bashResults}
                      readResults={item.readResults}
                      showMeta={showMeta}
                      easyMode={easyMode}
                      easyOpenerOverride={easyMode && isUserItem}
                      toolStatus={toolStatusOf(item.entry, toolStatusMap)}
                      forceOpen={forceOpen && item.lineNo === focusLineNo}
                      searchHighlighted={item.lineNo === focusLineNo}
                      parentOrderedCollapse={collapseLineNos?.has(item.lineNo)}
                      taskPlans={taskPlans}
                    />
                  </div>
                </div>
              </Fragment>
            )
          })}
          {/* 跳过段落在可见序列末尾 (at === items.length) 时, 提示行走在最后一行之后. */}
          {hiddenGaps.slice(gapCursor).map((gap, index) => (
            <HiddenGapRow key={`hidden-gap-tail-${index}-${gap.at}`} count={gap.count} />
          ))}
        </div>
      )}
    </div>
  )
}

export const RoundGroup = memo(RoundGroupInner)
