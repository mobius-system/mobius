import { Fragment, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, CircleDot, FlaskConical } from 'lucide-react'
import { RecentSessionGroupList } from './recent-session-group-list'
import type { RecentSessionTreeGroup, RecentSessionTreeSession } from '../services/recent-session-tree'

// 「项目 → 任务/研究 → 会话」树状分组渲染，供简易模式工作导航侧栏与 @ 目标
// 选择抽屉共享：分组数据由 buildRecentSessionTreeGroups 生成，会话行由调用方
// 通过 renderSession 注入（两侧行内信息不同），组头折叠/连接线在此统一。
type SessionGroupTreeProps<T extends RecentSessionTreeSession> = {
  groups: RecentSessionTreeGroup<T>[]
  renderSession: (session: T) => ReactNode
  currentSessionId?: string
  highlightCurrentGroup?: boolean
  collapsedKeys?: Set<string>
  onToggleGroup?: (key: string) => void
  testIdPrefix?: string
  domIdPrefix?: string
  className?: string
  style?: CSSProperties
  ariaLabel?: string
}

export function SessionGroupTree<T extends RecentSessionTreeSession>({
  groups,
  renderSession,
  currentSessionId = '',
  highlightCurrentGroup = false,
  collapsedKeys,
  onToggleGroup,
  testIdPrefix,
  domIdPrefix = 'session-group',
  className,
  style,
  ariaLabel,
}: SessionGroupTreeProps<T>) {
  const [internalCollapsed, setInternalCollapsed] = useState<Set<string>>(() => new Set())
  const collapsed = collapsedKeys ?? internalCollapsed

  const toggleGroup = (key: string) => {
    if (onToggleGroup) {
      onToggleGroup(key)
      return
    }
    setInternalCollapsed(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div
      className={className}
      style={style}
      aria-label={ariaLabel}
      data-testid={testIdPrefix ? `${testIdPrefix}-tree` : undefined}
    >
      {groups.map(group => {
        const isResearch = group.scopeType === 'research'
        const groupContainsCurrent = !!currentSessionId
          && group.sessions.some(session => session.session_id === currentSessionId)
          && highlightCurrentGroup
        const groupDomId = `${domIdPrefix}-${encodeURIComponent(group.key).replace(/%/g, '-')}`
        return (
          <section
            key={group.key}
            className="mb-1.5"
            data-testid={testIdPrefix ? `${testIdPrefix}-group` : undefined}
            data-project-id={group.projectId}
            data-subject-id={group.subjectId}
            data-scope-type={group.scopeType}
          >
            <button
              type="button"
              aria-expanded={!collapsed.has(group.key)}
              aria-controls={groupDomId}
              onClick={() => toggleGroup(group.key)}
              className="flex min-h-10 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-blue-500/50"
              style={{ background: groupContainsCurrent ? 'color-mix(in srgb, var(--bg-active) 58%, transparent)' : undefined }}
              title={`${group.projectName} / ${group.subjectTitle}`}
            >
              {collapsed.has(group.key)
                ? <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                : <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
              <span
                className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
                style={{
                  background: isResearch ? 'rgba(168,85,247,0.12)' : 'rgba(59,130,246,0.12)',
                  color: isResearch ? '#c084fc' : '#60a5fa',
                }}
              >
                {isResearch ? <FlaskConical className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>{group.projectName}</span>
                <span className="block truncate text-[12px] font-semibold leading-4" style={{ color: 'var(--text-primary)' }}>{group.subjectTitle}</span>
              </span>
              <span className="flex flex-shrink-0 flex-col items-end gap-0.5">
                <span className="text-[9px] font-medium" style={{ color: isResearch ? '#c084fc' : '#60a5fa' }}>{isResearch ? '研究' : '任务'}</span>
                <span className="text-[9px] tabular-nums" style={{ color: group.activeCount ? '#fbbf24' : 'var(--text-muted)' }}>
                  {group.activeCount ? `${group.activeCount} 活跃` : `${group.sessions.length} ${isResearch ? '智能体' : '会话'}`}
                </span>
              </span>
            </button>

            <RecentSessionGroupList
              id={groupDomId}
              hidden={collapsed.has(group.key)}
              className="relative ml-[22px] border-l pl-2"
              style={{ borderColor: groupContainsCurrent ? 'color-mix(in srgb, var(--accent-primary) 38%, var(--border-color))' : 'var(--border-color)' }}
              groupLabel={group.subjectTitle}
              itemLabel={isResearch ? '智能体' : '会话'}
            >
              {group.sessions.map(session => (
                <Fragment key={session.session_id}>{renderSession(session)}</Fragment>
              ))}
            </RecentSessionGroupList>
          </section>
        )
      })}
    </div>
  )
}
