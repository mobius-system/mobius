import { Children, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

export const RECENT_SESSION_GROUP_PREVIEW_LIMIT = 3

type RecentSessionGroupListProps = {
  children: ReactNode
  id: string
  hidden?: boolean
  className?: string
  style?: CSSProperties
  groupLabel: string
  itemLabel: string
}

export function RecentSessionGroupList({
  children,
  id,
  hidden,
  className,
  style,
  groupLabel,
  itemLabel,
}: RecentSessionGroupListProps) {
  const [expanded, setExpanded] = useState(false)
  const rows = Children.toArray(children)
  const hasMore = rows.length > RECENT_SESSION_GROUP_PREVIEW_LIMIT
  const remainingCount = Math.max(0, rows.length - RECENT_SESSION_GROUP_PREVIEW_LIMIT)
  const visibleRows = expanded ? rows : rows.slice(0, RECENT_SESSION_GROUP_PREVIEW_LIMIT)
  const rowsId = `${id}-sessions`

  return (
    <div id={id} hidden={hidden} className={className} style={style}>
      <div id={rowsId}>{visibleRows}</div>
      {hasMore && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={rowsId}
          aria-label={expanded ? `收起${groupLabel}的${itemLabel}` : `显示${groupLabel}的更多${itemLabel}，还有 ${remainingCount} 个`}
          onClick={() => setExpanded(value => !value)}
          className="group relative mt-1 flex min-h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 text-[10px] font-medium transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-blue-500/50"
          style={{ color: 'var(--text-secondary)' }}
          data-testid="recent-session-group-disclosure"
        >
          <span className="absolute -left-2 top-1/2 w-2 border-t" style={{ borderColor: 'var(--border-color)' }} aria-hidden="true" />
          {expanded ? <ChevronUp className="h-3 w-3" aria-hidden="true" /> : <ChevronDown className="h-3 w-3" aria-hidden="true" />}
          <span>{expanded ? '收起' : '显示更多'}</span>
          {!expanded && (
            <span
              className="inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[9px] tabular-nums"
              style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}
              aria-hidden="true"
            >
              {remainingCount}
            </span>
          )}
        </button>
      )}
    </div>
  )
}
