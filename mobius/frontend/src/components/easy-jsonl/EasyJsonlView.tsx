import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  CircleEllipsis,
  FilePenLine,
  Image as ImageIcon,
  ListChecks,
  LoaderCircle,
  Search,
  Sparkles,
  TerminalSquare,
  Wrench,
} from 'lucide-react'
import JsonlCompactMarkdown from '../jsonl-compact-markdown'
import { resolveMediaSrc } from '../jsonl-vscode-link'
import type { AnyEntry, JsonlViewItem } from '../viewer/types'
import { mergeBashToolResultItems } from '../viewer/entry-extract'
import { isHiddenJsonlNoiseEntry } from '../viewer/entry-classify'
import { buildRounds } from '../viewer/rounds'
import {
  buildEasyJsonlRounds,
  splitEasyUserPrompt,
  stripEasyUserImageAttachmentBlocks,
  type EasyActivity,
  type EasyActivityKind,
  type EasyJsonlRound,
  type EasyTimelineBurst,
} from './easy-jsonl-model'
import { DisplayImagePreviewModal } from '../viewer/DisplayImages'
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
  onRoundCountChange?: (count: number) => void
  expandAllSignal?: number
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

function EasyActivityItem({ activity, forceExpanded = false }: { activity: EasyActivity; forceExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(!!activity.defaultExpanded)
  const userToggledRef = useRef(false)
  const planOutputSeenRef = useRef(false)
  const isQuiet = activity.kind === 'command' || activity.kind === 'explore' || activity.kind === 'tool'
  const canExpand = activity.details.length > 0 || !!activity.imageUrls?.length || !!activity.outputTail
  const showOutput = !!activity.outputTail && expanded

  useEffect(() => {
    if (forceExpanded || activity.defaultExpanded) setExpanded(true)
  }, [forceExpanded, activity.defaultExpanded])

  useEffect(() => {
    if (activity.kind !== 'plan' || !activity.outputTail || planOutputSeenRef.current) return
    planOutputSeenRef.current = true
    if (!userToggledRef.current) setExpanded(true)
  }, [activity.kind, activity.outputTail])

  return (
    <div
      className={`easy-jsonl-activity easy-jsonl-activity--${activity.kind}${expanded ? ' is-expanded' : ''}${forceExpanded ? ' is-search-match' : ''}`}
      data-easy-activity={activity.kind}
      data-easy-target-id={activity.id}
    >
      <span className="easy-jsonl-activity__node" aria-hidden="true">
        {activity.state === 'error' ? <AlertTriangle /> : activityIcon(activity.kind)}
      </span>
      <button
        type="button"
        className="easy-jsonl-activity__summary"
        onClick={() => {
          if (!canExpand || forceExpanded) return
          userToggledRef.current = true
          setExpanded(value => !value)
        }}
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
      >
        <span className="easy-jsonl-activity__copy">
          {isQuiet ? (
            <strong className="easy-jsonl-activity__command">
              <span className="easy-jsonl-activity__command-text">{activity.title}</span>
            </strong>
          ) : (
            <>
              <strong>{activity.title}</strong>
              {!expanded && activity.summary && <small>{activity.summary}</small>}
            </>
          )}
        </span>
        {canExpand && <ChevronDown className="easy-jsonl-activity__chevron" />}
      </button>
      {expanded && (activity.details.length > 0 || !!activity.imageUrls?.length) && (
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
      {showOutput && (
        <pre
          className="easy-jsonl-activity__output-tail"
          aria-label="工具输出，可滚动查看"
          tabIndex={0}
        >
          {activity.outputTail}
        </pre>
      )}
    </div>
  )
}

function EasyBurstItem({ burst, focusedLineNo }: { burst: EasyTimelineBurst; focusedLineNo: number | null }) {
  const forceExpanded = focusedLineNo != null && burst.items.some(activity => activity.lineNos.includes(focusedLineNo))
  const [expanded, setExpanded] = useState(burst.defaultExpanded)
  const lockedOpen = burst.hasError || forceExpanded

  useEffect(() => {
    if (lockedOpen || burst.defaultExpanded) setExpanded(true)
  }, [lockedOpen, burst.defaultExpanded])

  return (
    <section
      className={`easy-jsonl-burst${expanded ? ' is-expanded' : ''}${burst.hasError ? ' has-error' : ''}${forceExpanded ? ' is-search-match' : ''}`}
      data-easy-target-id={burst.id}
    >
      <button
        type="button"
        className="easy-jsonl-burst__summary"
        aria-expanded={expanded}
        onClick={() => !lockedOpen && setExpanded(value => !value)}
      >
        <strong>{burst.title}</strong>
        <ChevronDown className="easy-jsonl-burst__chevron" aria-hidden="true" />
      </button>
      {expanded && (
        <div className="easy-jsonl-burst__items">
          {burst.items.map(activity => (
            <EasyActivityItem
              key={activity.id}
              activity={activity}
              forceExpanded={focusedLineNo != null && activity.lineNos.includes(focusedLineNo)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function targetIdForLine(round: EasyJsonlRound, lineNo: number): string {
  for (const segment of round.timeline) {
    if (segment.type === 'message' && segment.lineNos.includes(lineNo)) return segment.id
    if (segment.type === 'row' && segment.activity.lineNos.includes(lineNo)) return segment.activity.id
    if (segment.type === 'burst') {
      const activity = segment.items.find(item => item.lineNos.includes(lineNo))
      if (activity) return activity.id
    }
  }
  return round.id
}

function attachmentImageLabel(src: string): string {
  const normalized = src.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || '附件图片'
}

function EasyUserAttachmentThumbnail({ src, onOpen }: { src: string; onOpen: (src: string) => void }) {
  const [failed, setFailed] = useState(false)
  const label = attachmentImageLabel(src)
  return (
    <button
      type="button"
      className={`easy-jsonl-prompt__attachment${failed ? ' is-failed' : ''}`}
      onClick={() => !failed && onOpen(src)}
      title={failed ? `${label} · 图片无法显示` : `${label} · 点击放大`}
      aria-label={failed ? `附件图片 ${label} 无法显示` : `预览附件图片 ${label}`}
      disabled={failed}
    >
      {failed ? (
        <span>图片无法显示</span>
      ) : (
        <img src={resolveMediaSrc(src)} alt={label} loading="lazy" onError={() => setFailed(true)} />
      )}
    </button>
  )
}

function EasyUserPrompt({ text, images }: { text: string; images: string[] }) {
  const parts = useMemo(() => splitEasyUserPrompt(text), [text])
  const [contextOpen, setContextOpen] = useState(false)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const visible = useMemo(() => stripEasyUserImageAttachmentBlocks(parts.visible), [parts.visible])
  const hidden = parts.hidden
  const systemOnly = !visible && !!hidden
  const showBubble = !!visible || !!hidden || images.length === 0

  return (
    <>
      <article
        className={`easy-jsonl-prompt${systemOnly ? ' easy-jsonl-prompt--system-only' : ''}${systemOnly && contextOpen ? ' is-expanded' : ''}`}
        aria-label="用户任务"
      >
        {images.length > 0 && (
          <div className="easy-jsonl-prompt__attachments" aria-label={`图片附件 ${images.length} 张`}>
            {images.map(src => <EasyUserAttachmentThumbnail key={src} src={src} onOpen={setPreviewSrc} />)}
          </div>
        )}
        {showBubble && (
          <div className="easy-jsonl-prompt__bubble">
            {visible ? <JsonlCompactMarkdown text={visible} /> : null}
            {!visible && !hidden && images.length === 0 ? <JsonlCompactMarkdown text="继续处理当前任务" /> : null}
            {hidden ? (
              <div className="easy-jsonl-prompt__context">
                <button
                  type="button"
                  className="easy-jsonl-prompt__context-toggle"
                  aria-expanded={contextOpen}
                  aria-label={contextOpen ? '收起系统上下文' : '展开系统上下文'}
                  onClick={() => setContextOpen(value => !value)}
                >
                  <span>系统上下文</span>
                  <ChevronDown className="easy-jsonl-prompt__context-chevron" />
                </button>
                {contextOpen ? <JsonlCompactMarkdown text={hidden} /> : null}
              </div>
            ) : null}
          </div>
        )}
      </article>
      {previewSrc && <DisplayImagePreviewModal src={previewSrc} onClose={() => setPreviewSrc(null)} />}
    </>
  )
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
  onRoundCountChange,
  expandAllSignal = 0,
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
  const [focusedLineNo, setFocusedLineNo] = useState<number | null>(null)

  useEffect(() => {
    onRoundCountChange?.(easyRounds.length)
  }, [easyRounds.length, onRoundCountChange])

  useEffect(() => {
    if (expandAllSignal > 0) setShowAll(true)
  }, [expandAllSignal])

  useEffect(() => {
    const targetKey = `${scrollToEntryUuid || ''}:${scrollToMatchTs || ''}`
    if (!scrollToEntryUuid && !scrollToMatchTs) {
      targetHandledRef.current = ''
      setFocusedLineNo(null)
      return
    }
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
    const targetId = targetIdForLine(round, lineNo)
    setFocusedLineNo(lineNo)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const target = document.querySelector(`[data-easy-target-id="${CSS.escape(targetId)}"]`)
        const roundElement = document.querySelector(`[data-easy-round-id="${CSS.escape(round.id)}"]`)
        ;(target || roundElement)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        targetHandledRef.current = targetKey
        onScrollResolved?.()
      })
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
              <EasyUserPrompt text={round.userPrompt} images={round.userAttachmentImages} />

              {round.timeline.length > 0 && (
                <div className="easy-jsonl-rail" aria-label="执行过程">
                  {round.timeline.map(segment => {
                    if (segment.type === 'burst') return <EasyBurstItem key={segment.id} burst={segment} focusedLineNo={focusedLineNo} />
                    if (segment.type === 'row') {
                      return (
                        <EasyActivityItem
                          key={segment.id}
                          activity={segment.activity}
                          forceExpanded={focusedLineNo != null && segment.activity.lineNos.includes(focusedLineNo)}
                        />
                      )
                    }
                    return (
                      <article
                        key={segment.id}
                        className={`easy-jsonl-message${focusedLineNo != null && segment.lineNos.includes(focusedLineNo) ? ' is-search-match' : ''}`}
                        data-easy-target-id={segment.id}
                        aria-label="助手过程消息"
                      >
                        <JsonlCompactMarkdown text={segment.text} />
                      </article>
                    )
                  })}
                </div>
              )}

              {round.assistantResponse && (
                <article className="easy-jsonl-response" aria-label="助手回复">
                  <JsonlCompactMarkdown text={round.assistantResponse} />
                </article>
              )}

              {roundWorking && (
                <div className="easy-jsonl-live" role="status">
                  <span><LoaderCircle className="animate-spin" /></span>
                  <div>
                    <strong>{round.workingLabel || '正在处理'}</strong>
                    <small>{liveText || '智能体正在执行当前任务…'}</small>
                  </div>
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
