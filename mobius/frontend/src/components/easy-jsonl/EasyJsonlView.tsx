import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleEllipsis,
  FilePenLine,
  Image as ImageIcon,
  ListChecks,
  LoaderCircle,
  Search,
  Sparkles,
  TerminalSquare,
  UserRound,
  Wrench,
} from 'lucide-react'
import JsonlCompactMarkdown from '../jsonl-compact-markdown'
import { resolveMediaSrc } from '../jsonl-vscode-link'
import type { AnyEntry, JsonlViewItem } from '../viewer/types'
import { mergeBashToolResultItems } from '../viewer/entry-extract'
import { isHiddenJsonlNoiseEntry } from '../viewer/entry-classify'
import { buildRounds } from '../viewer/rounds'
import { buildEasyJsonlRounds, type EasyActivity, type EasyActivityKind } from './easy-jsonl-model'
import './easy-jsonl.css'

const EASY_INITIAL_WINDOW_SIZE = 200

export type EasyJsonlViewProps = {
  entries: AnyEntry[]
  emptyLoadingText?: string
  initialLoading?: boolean
  total?: number
  onLoadMore?: () => void
  loadingMore?: boolean
  working?: boolean
  liveText?: string
  scrollToEntryUuid?: string | null
  scrollToMatchTs?: string | null
  onScrollResolved?: () => void
  onScrollUnresolved?: () => void
}

function activityIcon(kind: EasyActivityKind) {
  if (kind === 'explore') return <Search />
  if (kind === 'command') return <TerminalSquare />
  if (kind === 'file-change') return <FilePenLine />
  if (kind === 'plan') return <ListChecks />
  if (kind === 'progress') return <CircleEllipsis />
  if (kind === 'error') return <AlertTriangle />
  if (kind === 'image') return <ImageIcon />
  return <Wrench />
}

function EasyActivityItem({ activity }: { activity: EasyActivity }) {
  const [expanded, setExpanded] = useState(!!activity.defaultExpanded)
  const canExpand = activity.details.length > 0 || !!activity.imageUrls?.length
  return (
    <div className={`easy-jsonl-activity easy-jsonl-activity--${activity.kind}${expanded ? ' is-expanded' : ''}`} data-easy-activity={activity.kind}>
      <span className="easy-jsonl-activity__node" aria-hidden="true">
        {activity.state === 'error' ? <AlertTriangle /> : activityIcon(activity.kind)}
      </span>
      <button
        type="button"
        className="easy-jsonl-activity__summary"
        onClick={() => canExpand && setExpanded(value => !value)}
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
      >
        <span className="easy-jsonl-activity__copy">
          <strong>{activity.title}</strong>
          {!expanded && activity.summary && <small>{activity.summary}</small>}
        </span>
        {canExpand && <ChevronDown className="easy-jsonl-activity__chevron" />}
      </button>
      {expanded && (
        <div className="easy-jsonl-activity__detail">
          {activity.details.length > 0 && (
            <ul>
              {activity.details.map((detail, index) => <li key={`${activity.id}:${index}`}>{detail}</li>)}
            </ul>
          )}
          {!!activity.imageUrls?.length && (
            <div className="easy-jsonl-gallery">
              {activity.imageUrls.map((url) => (
                <a key={url} href={resolveMediaSrc(url)} target="_blank" rel="noreferrer">
                  <img src={resolveMediaSrc(url)} alt="智能体生成的图片" loading="lazy" />
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function formatRoundTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function EasySkeleton() {
  return (
    <div className="easy-jsonl-skeleton" role="status" aria-label="正在加载简易对话">
      <span><LoaderCircle className="animate-spin" /> 正在整理对话...</span>
      <i /><i /><i />
    </div>
  )
}

function findMatchLine(items: JsonlViewItem[], uuid?: string | null, ts?: string | null): number | null {
  if (uuid) {
    const match = items.find(item => item.entry?.uuid === uuid || item.entry?.id === uuid)
    if (match) return match.lineNo
  }
  if (ts) {
    const target = Date.parse(ts)
    const exact = items.find(item => {
      const value = item.entry?.timestamp || item.entry?.created_at
      return value === ts || (Number.isFinite(target) && Date.parse(value || '') === target)
    })
    if (exact) return exact.lineNo
  }
  return null
}

export default function EasyJsonlView({
  entries,
  emptyLoadingText,
  initialLoading,
  total,
  onLoadMore,
  loadingMore,
  working = false,
  liveText,
  scrollToEntryUuid,
  scrollToMatchTs,
  onScrollResolved,
  onScrollUnresolved,
}: EasyJsonlViewProps) {
  const [showAll, setShowAll] = useState(false)
  const recent = useMemo(() => entries.slice(-(showAll ? entries.length : EASY_INITIAL_WINDOW_SIZE)), [entries, showAll])
  const windowOffset = entries.length - recent.length
  const visibleItems = useMemo(() => mergeBashToolResultItems(recent, windowOffset).filter(item => !isHiddenJsonlNoiseEntry(item.entry)), [recent, windowOffset])
  const { rounds } = useMemo(() => buildRounds(visibleItems), [visibleItems])
  const easyRounds = useMemo(() => buildEasyJsonlRounds(rounds), [rounds])
  const displayTotal = typeof total === 'number' && total > entries.length ? total : entries.length
  const hasRemoteMore = typeof total === 'number' && total > entries.length
  const targetHandledRef = useRef('')

  useEffect(() => {
    const targetKey = `${scrollToEntryUuid || ''}:${scrollToMatchTs || ''}`
    if (!scrollToEntryUuid && !scrollToMatchTs) { targetHandledRef.current = ''; return }
    if (targetHandledRef.current === targetKey || initialLoading || entries.length === 0) return
    const lineNo = findMatchLine(visibleItems, scrollToEntryUuid, scrollToMatchTs)
    if (lineNo == null) {
      if (!showAll) setShowAll(true)
      if (hasRemoteMore) onScrollUnresolved?.()
      else onScrollResolved?.()
      return
    }
    const round = easyRounds.find(item => item.lineNos.includes(lineNo))
    if (!round) { onScrollResolved?.(); return }
    requestAnimationFrame(() => {
      const element = document.querySelector(`[data-easy-round-id="${CSS.escape(round.id)}"]`)
      element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      targetHandledRef.current = targetKey
      onScrollResolved?.()
    })
  }, [scrollToEntryUuid, scrollToMatchTs, visibleItems, easyRounds, initialLoading, entries.length, showAll, hasRemoteMore, onScrollResolved, onScrollUnresolved])

  if (entries.length === 0) {
    if (initialLoading) return <EasySkeleton />
    return (
      <div className="easy-jsonl-empty" role="status">
        {emptyLoadingText ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
        <span>{emptyLoadingText || '还没有对话内容'}</span>
      </div>
    )
  }

  return (
    <div className="easy-jsonl-view" data-testid="easy-jsonl-view">
      <div className="easy-jsonl-toolbar">
        <span><Sparkles /> 简易对话</span>
        <small>{easyRounds.length} 轮</small>
        {hasRemoteMore && onLoadMore && (
          <button type="button" disabled={!!loadingMore} onClick={() => { setShowAll(true); onLoadMore() }}>
            {loadingMore ? '加载中…' : `加载全部 · ${displayTotal}`}
          </button>
        )}
        {!hasRemoteMore && entries.length > EASY_INITIAL_WINDOW_SIZE && !showAll && (
          <button type="button" onClick={() => setShowAll(true)}>展开全部 · {entries.length}</button>
        )}
      </div>

      <div className="easy-jsonl-rounds">
        {easyRounds.map((round, index) => {
          const isLast = index === easyRounds.length - 1
          const roundWorking = isLast && working
          return (
            <section
              key={round.id}
              className={`easy-jsonl-round${roundWorking ? ' is-working' : ''}${round.hasError ? ' has-error' : ''}`}
              data-easy-round-id={round.id}
              data-testid="easy-jsonl-round"
            >
              <header className="easy-jsonl-prompt">
                <span className="easy-jsonl-prompt__avatar"><UserRound /></span>
                <div>
                  <div className="easy-jsonl-prompt__meta">
                    <strong>你的任务</strong>
                    <time>{formatRoundTime(round.startedAt)}</time>
                  </div>
                  <p>{round.userPrompt || '继续处理当前任务'}</p>
                </div>
              </header>

              {(round.activities.length > 0 || roundWorking) && (
                <div className="easy-jsonl-rail" aria-label="执行过程">
                  {round.activities.map(activity => <EasyActivityItem key={activity.id} activity={activity} />)}
                  {roundWorking && (
                    <div className="easy-jsonl-live" role="status">
                      <span><LoaderCircle className="animate-spin" /></span>
                      <div><strong>正在继续处理</strong><small>{liveText || '智能体正在执行当前任务…'}</small></div>
                    </div>
                  )}
                </div>
              )}

              {round.assistantResponse && (
                <article className="easy-jsonl-response">
                  <div className="easy-jsonl-response__heading">
                    <span><Bot /></span>
                    <strong>回复</strong>
                    {!roundWorking && <CheckCircle2 />}
                  </div>
                  <JsonlCompactMarkdown text={round.assistantResponse} />
                </article>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
