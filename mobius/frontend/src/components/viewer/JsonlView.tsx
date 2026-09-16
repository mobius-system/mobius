/**
 * viewer/JsonlView.tsx — jsonl 视图顶层组件 (group 驱动).
 *
 * 数据源是 agent-history-store 的快照 (协议 ① 的组元数据 + ② 的按需组条目):
 *  - 每个组渲染一个 RoundGroup; 未加载的组零条目驻留, 只显示元数据摘要头;
 *    展开 (或搜索命中) 时通过 onEnsureGroupEntries 走 ② 整组拉取.
 *  - 组内条目走与旧版相同的流水线: mergeBashToolResultItems → 噪声过滤 → 任务计划,
 *    每组独立跑 (快照与锚点同组).
 *  - 前端不再分组: buildRounds 退役, 组结构完全来自后端.
 *  - lineNo 是跨组唯一的全局序号 (组基址 + 组内序), 搜索跳转/强制展开靠它精确定位.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { VirtualizedBlockList } from '../jsonl-virtual-list'
import type { AnyEntry, JsonlViewItem, JsonlRenderBlock, Round, RoundHiddenGap } from './types'
import { mergeBashToolResultItems } from './entry-extract'
import { collectResolvedCallIds } from './tool-status'
import { RoundGroup } from './RoundGroups'
import { isHiddenJsonlNoiseEntry } from './entry-classify'
import { extractInitialContext } from './initial-context'
import { filterDisplayDuplicates } from './display-dedup'
import { computeCollapsedByForgottenFlag } from './fold-rules'
import { hideRepeatedEncryptedReasoning } from './visibility-rules'
import { buildTaskPlans } from './task-progress'
import type { HistorySnapshot, SessionHistoryStore } from '../../services/agent-history-store'

// 逐组状态机转移回调 (身份稳定, 供 RoundGroup memo 判等).
interface GroupCallbacks {
  toggle: () => void
  open: () => void
  close: () => void
  retry: () => void
}
import {
  ROUND_HEADER_PALETTES,
  ROUND_HEADER_PALETTE_STORAGE_KEY,
  normalizeRoundHeaderPaletteIndex,
  readRoundHeaderPaletteIndex,
  saveRoundHeaderPaletteIndex,
} from './round-header-palette'

// 单组条目渲染窗口上限: 巨轮只渲染"开轮条目 + 尾部窗口" (虚拟列表保证视口流畅,
// 这里限制的是首次进组的流水线成本).
const GROUP_ENTRY_WINDOW = 256
// 巨轮额外保留的组头条目数: 开轮的用户问题卡 (边车原文卡 + 原生 user 卡) 必须留在
// 窗口里, 否则尾部窗口会把"这一轮在问什么"整段切掉 —— 用户只能看到半截回复.
// 留 8 条: 覆盖两张开轮卡 + 紧随其后的首条回复, 成本可忽略.
const GROUP_ENTRY_HEAD = 8

function JsonlInitialSkeleton() {
  return (
    <div className="jsonl-initial-skeleton" aria-live="polite" role="status">
      <div className="mb-3 flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        <span className="relative inline-flex h-3.5 w-3.5 flex-shrink-0">
          <span className="absolute inset-0 rounded-full border-2 border-[var(--text-muted)] opacity-20" />
          <span className="absolute inset-0 rounded-full border-2 border-transparent border-t-[var(--text-muted)] animate-spin" />
        </span>
        <span className="mobius-status-marquee">正在加载会话数据...</span>
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
function roundKeyOf(groupId: string): string {
  return `round:${groupId}`
}

// 搜索命中的 (uuid, ts) 在已渲染的组条目里定位条目; 找不到返回 null.
function findItemInRounds(rounds: Round[], uuid: string | null | undefined, ts: string | null | undefined): JsonlViewItem | null {
  const matches = (entry: AnyEntry | undefined): boolean => {
    if (!entry) return false
    if (uuid && (entry.uuid === uuid || entry.id === uuid)) return true
    if (!ts) return false
    const value = entryTimestamp(entry)
    if (value === ts) return true
    const targetMs = Date.parse(ts)
    return Number.isFinite(targetMs) && Date.parse(value) === targetMs
  }
  const itemMatches = (it: JsonlViewItem): boolean => {
    if (matches(it?.entry)) return true
    // tool_result 条目在展示流水线中会合并并隐藏，搜索命中仍应回到承载结果的
    // tool_use 卡片，而不是只滚到轮次标题。
    return [...(it?.bashResults || []), ...(it?.readResults || [])].some((result: any) => matches(result?.entry))
  }
  if (uuid) {
    for (const r of rounds) {
      for (const it of r?.items || []) {
        if (itemMatches(it)) return it
      }
    }
  }
  if (ts) {
    for (const r of rounds) {
      for (const it of r?.items || []) {
        if (itemMatches(it)) return it
      }
    }
  }
  return null
}

// 组条目 → 渲染流水线 (与旧版整列表流水线相同, 逐组独立跑; lineNo = 组基址 + 组内序).
function entryTimestamp(entry: AnyEntry): string {
  return String(entry?.timestamp || entry?.created_at || entry?.message?.created_at || entry?.payload?.timestamp || '')
}

function targetIndexOf(entries: AnyEntry[], uuid?: string | null, ts?: string | null): number {
  if (uuid) {
    const index = entries.findIndex((entry) => entry?.uuid === uuid || entry?.id === uuid)
    if (index >= 0) return index
  }
  if (ts) {
    const exact = entries.findIndex((entry) => entryTimestamp(entry) === ts)
    if (exact >= 0) return exact
    const targetMs = Date.parse(ts)
    if (Number.isFinite(targetMs)) {
      return entries.findIndex((entry) => Date.parse(entryTimestamp(entry)) === targetMs)
    }
  }
  return -1
}

// 巨轮窗口跳过中段条目时插进流水线的占位条目: 跟着普通条目一起穿过去重/合并/过滤,
// 渲染前被回收成 round.hiddenGaps (位置 = 它在可见序列里的下标), 不会进入 round.items.
// 必须用白名单内的 type (否则会被 isHiddenJsonlNoiseEntry 当噪声丢掉) 且不命中任何特例谓词.
const HIDDEN_GAP_MARK = 'mobius-hidden-gap'
function hiddenGapEntry(count: number): AnyEntry {
  return { type: 'system', subtype: HIDDEN_GAP_MARK, hiddenCount: count }
}

function buildRoundFromEntries(entries: AnyEntry[], roundNum: number, baseLineNo: number, targetUuid?: string | null, targetTs?: string | null): Round {
  let windowStart = Math.max(0, entries.length - GROUP_ENTRY_WINDOW)
  // 搜索命中可能在很早的条目里。保留命中条目周围的窗口，既不把整轮全部挂载，
  // 又保证 UUID/时间戳定位能找到真实卡片而不是只落到轮次标题。
  const targetIndex = targetIndexOf(entries, targetUuid, targetTs)
  if (targetIndex >= 0 && entries.length > GROUP_ENTRY_WINDOW) {
    windowStart = Math.max(0, Math.min(targetIndex - Math.floor(GROUP_ENTRY_WINDOW / 2), entries.length - GROUP_ENTRY_WINDOW))
  }
  // 渲染窗口 = 开轮条目段 (组头, 保住用户问题卡) + 主窗口段 (尾部窗口 / 搜索命中窗口).
  // 两段之间的中段被跳过, 跳过处插占位条目 -> 渲染成"本轮过长"提示卡.
  const spans = entries.length > GROUP_ENTRY_WINDOW
    ? [
        { start: 0, end: Math.min(GROUP_ENTRY_HEAD, windowStart) },
        { start: windowStart, end: Math.min(windowStart + GROUP_ENTRY_WINDOW, entries.length) },
      ]
    : [{ start: 0, end: entries.length }]
  // 两段重叠/相接时合并 (搜索命中窗口落到组头段内的情形), 避免凭空多出一段"隐藏".
  const pieces: { start: number; end: number }[] = []
  for (const span of spans) {
    if (span.end <= span.start) continue
    const last = pieces[pieces.length - 1]
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else pieces.push({ ...span })
  }
  const windowed: AnyEntry[] = []
  pieces.forEach((piece, index) => {
    const hiddenStart = index === 0 ? 0 : pieces[index - 1].end
    if (piece.start > hiddenStart) {
      // 只数"本来会显示成卡片"的条目: 被跳过的原始条目里混着 last-prompt / 快照等噪声,
      // 直接报原始条数会让提示卡的数字虚高.
      const hiddenCount = entries.slice(hiddenStart, piece.start).filter((entry) => !isHiddenJsonlNoiseEntry(entry)).length
      // 跳过的全是噪声 → 用户本来就看不到差别, 不插提示.
      if (hiddenCount > 0) windowed.push(hiddenGapEntry(hiddenCount))
    }
    windowed.push(...entries.slice(piece.start, piece.end))
  })
  // 窗口是分段拼接时组内行号不再连续, 按条目的组内原始序号重编, 让编号同样留出空档.
  const groupIndexOf = new Map<AnyEntry, number>()
  if (pieces.length > 1) entries.forEach((entry, index) => { if (entry && typeof entry === 'object') groupIndexOf.set(entry, index) })
  const deduped = filterDisplayDuplicates(windowed)
  const merged = mergeBashToolResultItems(deduped, baseLineNo + windowStart)
  if (groupIndexOf.size > 0) {
    for (const item of merged) {
      const original = groupIndexOf.get(item.entry)
      if (original !== undefined) item.lineNo = baseLineNo + original + 1
      // 合并进本卡的 tool_result 也按原始序号重编, 否则它们会沿用连续性假设下的错号.
      for (const result of [...(item.bashResults || []), ...(item.readResults || [])]) {
        const resultIndex = groupIndexOf.get(result.entry)
        if (resultIndex !== undefined) result.lineNo = baseLineNo + resultIndex + 1
      }
    }
  }
  let visible = hideRepeatedEncryptedReasoning(
    merged.filter((item) => !isHiddenJsonlNoiseEntry(item.entry)),
  )
  // 特殊规则 (仅第一轮 / group 1): 一旦出现"初始模式"卡片 (extractInitialContext 命中),
  // 隐藏它之前的所有卡片 —— 初始上下文之前的 setup 噪声 / 边车原文卡不再展示.
  if (roundNum === 1) {
    const initialIndex = visible.findIndex((item) => extractInitialContext(item.entry) !== null)
    if (initialIndex > 0) visible = visible.slice(initialIndex)
  }
  // 回收占位条目: at = 提示行要插在 items 中的下标.
  const items: JsonlViewItem[] = []
  const hiddenGaps: RoundHiddenGap[] = []
  for (const item of visible) {
    if (item.entry?.subtype === HIDDEN_GAP_MARK) {
      hiddenGaps.push({ at: items.length, count: Number(item.entry.hiddenCount) || 0 })
      continue
    }
    items.push(item)
  }
  return {
    roundNum,
    items: items.map((item, index) => ({ ...item, relIdx: index })),
    hiddenGaps: hiddenGaps.length > 0 ? hiddenGaps : undefined,
  }
}

// 每组渲染结果按 entries 数组身份记忆 (SSE 只让收数据的组换数组身份):
// 快照每变一次, 只有真正收到新数据的组重跑流水线, 其余组直接复用上一代的 Round —
// 连带 toolStatusMap/taskPlans 等下游 WeakMap 缓存与卡片 memo 的 prop 身份全部保持稳定.
interface CachedRound { seq: number; base: number; targetKey: string; round: Round }
const roundByEntries = new WeakMap<AnyEntry[], CachedRound>()
const EMPTY_GROUP_ENTRIES: AnyEntry[] = []

// ── 逐组派生数据的 WeakMap 缓存 (items 数组在快照 rev 不变时引用稳定) ─────────

const toolStatusCache = new WeakMap<AnyEntry[], ReturnType<typeof collectResolvedCallIds> | null>()
// 状态集合必须扫"与渲染相同的窗口切片"的原始条目:
//  1. 收集器吃 AnyEntry (在元素顶层找 tool_result 字段), 末端 JsonlViewItem 形状不对;
//  2. merge/过滤会吞掉纯 tool_result 条目, 末端列表里已没有结果载体.
// 扫原始窗口 (含被 merge/过滤隐藏的条目) 才能配出 tool_use → result 的完成态.
function toolStatusMapFor(entries: AnyEntry[]) {
  const hit = toolStatusCache.get(entries)
  if (hit !== undefined) return hit
  const windowed = entries.length > GROUP_ENTRY_WINDOW ? entries.slice(-GROUP_ENTRY_WINDOW) : entries
  const value = collectResolvedCallIds(windowed)
  toolStatusCache.set(entries, value)
  return value
}

const collapsedCache = new WeakMap<AnyEntry[], Set<number>>()
function collapsedLineNosFor(entries: AnyEntry[], items: JsonlViewItem[]) {
  const hit = collapsedCache.get(entries)
  if (hit) return hit
  const next = computeCollapsedByForgottenFlag(items)
  collapsedCache.set(entries, next)
  return next
}

const plansCache = new WeakMap<AnyEntry[], ReturnType<typeof buildTaskPlans>['plans']>()
function taskPlansFor(entries: AnyEntry[], items: JsonlViewItem[]) {
  const hit = plansCache.get(entries)
  if (hit) return hit
  const { plans } = buildTaskPlans(items)
  plansCache.set(entries, plans)
  return plans
}

export function JsonlView({
  snapshot,
  store,
  title,
  emptyLoadingText,
  initialLoading,
  showMeta = true,
  scrollToEntryUuid,
  scrollToMatchTs,
  searchNavigationRequested = false,
  onScrollResolved,
  onPauseToDequeue,
}: {
  // agent-history-store 的快照 (rev 驱动重渲染).
  snapshot: HistorySnapshot
  // store 实例: 视图只发状态机转移意图 (开/合/重试), 不直接碰数据.
  store: SessionHistoryStore | null
  title?: string
  emptyLoadingText?: string
  initialLoading?: boolean
  // false 时 jsonl 卡片标题里不再显示 "#序号" 和 "MM-DD HH:MM:SS" 时间戳前缀.
  showMeta?: boolean
  // 搜索结果跳转: 命中条目 uuid / timestamp; 未加载的组先 ② 再定位.
  scrollToEntryUuid?: string | null
  scrollToMatchTs?: string | null
  // URL 里仍有本次搜索参数时为 true。命中目标会长期保留用于红色高亮，
  // 但自动滚动只在这个请求开始时启动，完成或用户操作后立即解锁视野。
  searchNavigationRequested?: boolean
  onScrollResolved?: () => void
  // 排队卡片闪电按钮: 打断当前 turn 并出队下一条排队指令.
  onPauseToDequeue?: () => void
}) {
  const groups = snapshot.groups
  const [roundHeaderPaletteIndex, setRoundHeaderPaletteIndex] = useState(readRoundHeaderPaletteIndex)
  const [roundHeaderPaletteAnnouncement, setRoundHeaderPaletteAnnouncement] = useState('')
  const roundHeaderPalette = ROUND_HEADER_PALETTES[roundHeaderPaletteIndex]

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.metaKey || !event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      const next = (roundHeaderPaletteIndex + 1) % ROUND_HEADER_PALETTES.length
      saveRoundHeaderPaletteIndex(next)
      setRoundHeaderPaletteAnnouncement(`轮次背景已切换为${ROUND_HEADER_PALETTES[next].name}，第 ${next + 1} 种，共 ${ROUND_HEADER_PALETTES.length} 种`)
      setRoundHeaderPaletteIndex(next)
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== ROUND_HEADER_PALETTE_STORAGE_KEY) return
      setRoundHeaderPaletteIndex(normalizeRoundHeaderPaletteIndex(event.newValue))
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('storage', onStorage)
    }
  }, [roundHeaderPaletteIndex])

  // 组 → Round: 条目已加载才建 items; 未加载 = 零条目驻留, 只渲染元数据头.
  // lineNo 组基址累加, 保证跨组唯一 (搜索跳转按 data-jsonl-line-no 全局查询).
  // 逐组缓存 (roundByEntries): 命中条件 = 同一 entries 数组 + 同 seq + 同基址
  // (前面某组条数变了会推 base, 后续组 lineNo 失效 → 自动重建).
  const rounds = useMemo(() => {
    const targetKey = `${scrollToEntryUuid || ''}:${scrollToMatchTs || ''}`
    let baseLineNo = 0
    return groups.map((meta) => {
      const entries = snapshot.entriesByGroup.get(meta.id) || EMPTY_GROUP_ENTRIES
      const state = (snapshot.groupRuntime.get(meta.id)?.state) || 'closed'
      let round: Round
      if (entries.length === 0) {
        round = { roundNum: meta.seq, items: [] as any[] }
      } else {
        const hit = roundByEntries.get(entries)
        if (hit && hit.seq === meta.seq && hit.base === baseLineNo && hit.targetKey === targetKey) {
          round = hit.round
        } else {
          round = buildRoundFromEntries(entries, meta.seq, baseLineNo, scrollToEntryUuid, scrollToMatchTs)
          roundByEntries.set(entries, { seq: meta.seq, base: baseLineNo, targetKey, round })
        }
      }
      baseLineNo += entries.length
      return { meta, round, state, entries }
    })
  }, [snapshot, scrollToEntryUuid, scrollToMatchTs])

  const headerTitle = title === undefined ? 'JSONL' : title
  const loadedGroups = rounds.filter((r) => r.entries.length > 0).length
  const totalEntryCount = groups.reduce((sum, g) => sum + (g.entry_count || 0), 0)
  // 末轮摘要: 直接用组元数据 (不再从条目派生).
  const lastRoundUserSummary = groups.length > 0 ? (groups[groups.length - 1].user_summary || '') : ''
  const onlyGroup = groups.length === 1

  // 点击 header "末轮" 摘要 -> 跳转到最后一个组.
  const headerRef = useRef<HTMLDivElement>(null)
  const [internalTarget, setInternalTarget] = useState<{ key: string; offset: number } | null>(null)
  const jumpToLastRound = () => {
    if (groups.length === 0) return
    setInternalTarget({ key: roundKeyOf(groups[groups.length - 1].id), offset: headerRef.current?.offsetHeight ?? 0 })
  }

  // 搜索结果跳转: 已加载 → 定位; 未加载 → 按 opener_ts 区间找所属组先 ②
  // (快照 rev 变化后本 effect 重跑, 条目到位再精确定位).
  const [extTarget, setExtTarget] = useState<{ key: string; offset: number } | null>(null)
  const [extFocusLineNo, setExtFocusLineNo] = useState<number | null>(null)
  const [searchNavigationActive, setSearchNavigationActive] = useState(searchNavigationRequested)
  const extActive = !!(scrollToEntryUuid || scrollToMatchTs)
  const onResolvedRef = useRef(onScrollResolved)
  onResolvedRef.current = onScrollResolved
  const storeRef = useRef(store)
  storeRef.current = store
  useEffect(() => {
    if (searchNavigationRequested) setSearchNavigationActive(true)
  }, [searchNavigationRequested])

  const finishSearchNavigation = () => {
    setSearchNavigationActive(false)
    onResolvedRef.current?.()
  }

  useEffect(() => {
    if (!extActive) { setExtTarget(null); setExtFocusLineNo(null); return }
    if (initialLoading) { setExtTarget(null); return }
    const matchItem = findItemInRounds(rounds.map((r) => r.round), scrollToEntryUuid ?? null, scrollToMatchTs ?? null)
    if (matchItem) {
      const owner = rounds.find((r) => r.round.items.some((it) => it.lineNo === matchItem.lineNo))
      setExtFocusLineNo(matchItem.lineNo)
      setExtTarget({ key: owner ? roundKeyOf(owner.meta.id) : roundKeyOf(groups[0]?.id || ''), offset: headerRef.current?.offsetHeight ?? 0 })
      return
    }
    // 未命中: 时间戳区间定位所属组 (元数据里有每组的 opener_ts), 触发该组加载.
    const ts = scrollToMatchTs ?? null
    const targetMs = ts ? Date.parse(ts) : NaN
    if (!Number.isFinite(targetMs)) {
      // 只有 uuid 没有时间兜底: 从最后一组往前逐组补载直到找到 (有界, 一般一两轮就命中).
      const firstUnloaded = [...rounds].reverse().find((r) => r.entries.length === 0)
      if (firstUnloaded) { storeRef.current?.ensureGroupEntries(firstUnloaded.meta.id); return }
      onResolvedRef.current?.()
      return
    }
    let owner: (typeof rounds)[number] | undefined
    for (const r of rounds) {
      const openerMs = Date.parse(r.meta.opener_ts || '')
      if (Number.isFinite(openerMs) && openerMs <= targetMs) owner = r
      else if (Number.isFinite(openerMs) && openerMs > targetMs) break
    }
    if (!owner) owner = rounds[0]
    if (!owner) { onResolvedRef.current?.(); return }
    if (owner.entries.length === 0) { storeRef.current?.ensureGroupEntries(owner.meta.id); return }
    // 组已加载但条目里没有 (被噪声过滤/窗口截掉): 至少滚到所属组.
    setExtFocusLineNo(null)
    setExtTarget({ key: roundKeyOf(owner.meta.id), offset: headerRef.current?.offsetHeight ?? 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extActive, scrollToEntryUuid, scrollToMatchTs, initialLoading, snapshot.rev])

  const activeTarget = (searchNavigationActive ? extTarget : null) ?? internalTarget

  const renderBlocks = useMemo<JsonlRenderBlock[]>(() => {
    const blocks: JsonlRenderBlock[] = rounds.map((r, index) => ({
      key: roundKeyOf(r.meta.id),
      kind: 'round' as const,
      round: r.round,
      index,
    }))
    // 挂起的开轮卡 → 渲染成「特殊的最后一个组」(排队中, 尚未开轮).
    if (snapshot.pending.length > 0) {
      blocks.push({
        key: 'pending',
        kind: 'pending',
        pending: snapshot.pending.map((p) => ({ id: p.id, user_summary: p.user_summary })),
      })
    }
    return blocks
  }, [rounds, snapshot.pending])

  // 逐组回调缓存: 身份跨渲染稳定, 是 RoundGroup memo 生效的前提 (store 换实例时整体作废).
  const groupCbRef = useRef<{ store: SessionHistoryStore | null; map: Map<string, GroupCallbacks> }>({ store: null, map: new Map() })
  if (groupCbRef.current.store !== store) groupCbRef.current = { store, map: new Map() }
  const groupCallbacksOf = (gid: string): GroupCallbacks => {
    let c = groupCbRef.current.map.get(gid)
    if (!c) {
      c = {
        toggle: () => { store?.toggleGroup(gid) },
        open: () => { store?.openGroup(gid, 'auto') },
        close: () => { store?.closeGroup(gid, 'auto') },
        retry: () => { store?.retryGroup(gid) },
      }
      groupCbRef.current.map.set(gid, c)
    }
    return c
  }

  const renderBlock = (block: JsonlRenderBlock) => {
    if (block.kind === 'pending') {
      // 与 LIVE 卡保持同一形态 (rounded-lg + 呼吸点 + mono 标签 + 单行截断 + 流光),
      // 只显示最后一条待处理消息并给出总数 (等 N 条指令), 不再整卡铺开全部 pending 列表.
      const last = block.pending[block.pending.length - 1]
      const count = block.pending.length
      return (
        <div
          className="mb-2 rounded-lg border card-enter jsonl-live-sweep border-amber-500/15 bg-amber-500/[0.05] px-3 py-2 flex items-center gap-2 text-[12px]"
          style={{ ['--live-accent' as string]: '#fbbf24' } as CSSProperties}>
          <span className="relative inline-flex w-2 h-2 flex-shrink-0">
            <span className="absolute inset-0 rounded-full bg-amber-400 animate-ping opacity-75" />
            <span className="relative inline-flex rounded-full w-2 h-2 bg-amber-400" />
          </span>
          <span className="font-mono font-semibold text-amber-300 flex-shrink-0">排队</span>
          <span className="flex-1 text-[11px] truncate" style={{ color: 'var(--text-muted)' }} title={last?.user_summary || undefined}>
            {last?.user_summary || '(无内容)'}
          </span>
          <span className="text-[10px] text-amber-300/80 font-mono flex-shrink-0">等 {count} 条指令</span>
          {onPauseToDequeue && (
            <button
              type="button"
              onClick={onPauseToDequeue}
              title="打断当前并出队下一条指令"
              aria-label="打断当前并出队下一条指令"
              className="flex-shrink-0 p-0.5 rounded text-amber-300 hover:bg-amber-500/20 hover:text-amber-200 transition-colors"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </button>
          )}
        </div>
      )
    }
    if (block.kind !== 'round') return null
    const r = rounds[block.index]
    if (!r) return null
    const entries = r.entries.length > 0 ? r.entries : null
    const rt = snapshot.groupRuntime.get(r.meta.id)
    const cb = groupCallbacksOf(r.meta.id)
    return (
      <RoundGroup
        round={r.round}
        isLast={block.index === rounds.length - 1}
        isSecondLast={block.index === rounds.length - 2}
        onlyGroup={onlyGroup}
        open={r.state !== 'closed'}
        sticky={!!rt?.sticky}
        loading={r.state === 'open-loading'}
        failed={!!rt?.lastError}
        // resident = ② 已到货 (数据驻留), 与条目数无关: 加载出的空组走"空提醒"而非永转加载.
        resident={snapshot.entriesByGroup.has(r.meta.id)}
        onUserToggle={cb.toggle}
        onAutoOpen={cb.open}
        onAutoClose={cb.close}
        onRetry={cb.retry}
        // Keep the owning group highlighted even when the exact card is still loading
        // (or the target only resolved to group metadata). The card itself is marked once
        // extFocusLineNo is known.
        forceOpen={searchNavigationActive && block.key === extTarget?.key}
        searchHighlighted={block.key === extTarget?.key}
        showMeta={showMeta}
        toolStatusMap={entries ? toolStatusMapFor(entries) : null}
        collapseLineNos={entries ? collapsedLineNosFor(entries, r.round.items) : undefined}
        focusLineNo={extFocusLineNo}
        // 未加载组零条目驻留: 折叠头摘要用组元数据 (loaded 后 items[0] 摘要优先).
        headerSummary={r.meta.user_summary}
        headerPalette={roundHeaderPalette}
        taskPlans={entries ? taskPlansFor(entries, r.round.items) : null}
      />
    )
  }

  // 空 (有 pending 时也非空 — 排队中的伪组仍需渲染).
  if (groups.length === 0 && snapshot.pending.length === 0) {
    if (initialLoading) return <JsonlInitialSkeleton />
    if (emptyLoadingText) {
      return (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.05] px-4 py-4 text-[12px] text-amber-200 card-enter" aria-live="polite">
          <div className="flex items-center gap-3">
            <span className="relative inline-flex w-4 h-4 flex-shrink-0">
              <span className="absolute inset-0 rounded-full border-2 border-amber-300/20" />
              <span className="absolute inset-0 rounded-full border-2 border-transparent border-t-amber-300 animate-spin" />
            </span>
            <span className="font-medium mobius-status-marquee">{emptyLoadingText}</span>
          </div>
        </div>
      )
    }
    return (
      <div className="text-[12px] text-center py-8 text-[var(--text-muted)]" aria-live="polite" role="status">
        暂无对话内容
      </div>
    )
  }

  // 非空
  return (
    <div className="text-[12px]">
      <span className="sr-only" aria-live="polite" aria-atomic="true">{roundHeaderPaletteAnnouncement}</span>
      <div ref={headerRef} className="flex items-center gap-2 px-1 py-1 sticky top-0 z-10 backdrop-blur-lg bg-[var(--bg-page)]/80">
        {headerTitle && <span className="min-w-0 truncate text-[var(--text-secondary)] font-semibold" title={headerTitle}>{headerTitle}</span>}
        {groups.length > 0 && <span className="text-[var(--text-muted)] text-[11px]">{groups.length} 轮</span>}
        {loadedGroups < groups.length && (
          <span className="text-[var(--text-muted)] text-[11px]" title="展开对应轮次时按需加载明细">已载 {loadedGroups}/{groups.length} 轮 · 共 {totalEntryCount} 条</span>
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
        scrollToEntryLineNo={searchNavigationActive ? extFocusLineNo : null}
        scrollOffset={activeTarget?.offset ?? 0}
        onScrollToKeyDone={() => {
          if (searchNavigationActive && extTarget && extFocusLineNo !== null) return
          if (searchNavigationActive && extTarget) {
            // URL cleanup must not clear the visual target: SessionJsonlPanel retains it
            // for the lifetime of this history store, so loading/reflow cannot make the
            // red group/card treatment disappear.
            finishSearchNavigation()
            return
          }
          setInternalTarget(null)
        }}
        onScrollToEntryDone={() => {
          if (!searchNavigationActive || !extTarget || extFocusLineNo === null) return
          finishSearchNavigation()
          setInternalTarget(null)
        }}
        onNavigationCancel={() => {
          if (searchNavigationActive) finishSearchNavigation()
        }}
      />
    </div>
  )
}
