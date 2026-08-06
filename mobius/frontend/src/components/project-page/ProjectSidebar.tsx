import { Link } from 'react-router-dom'
import { LoaderCircle, MessageSquare, Search } from 'lucide-react'
import type { ProjectFilter, ProjectIssuePagination } from './types'
import { ListLoadingHint } from '../list-loading-hint'
import { SearchMatchText } from '../search-match-text'
import { textMatchesProjectSearch, type ProjectSessionMatchMap } from '../../services/project-session-search'

type ProjectSidebarProps = {
  userParam: string
  projectId: string
  issues: any[]
  search: string
  filter: ProjectFilter
  pagination: ProjectIssuePagination
  // 切换到未缓存项目时, 列表区域先显示 loading 而不是闪现上个项目的 issue 或"暂无 Issue".
  issuesLoading?: boolean
  sessionMatchesByIssue: ProjectSessionMatchMap
  sessionSearchLoading?: boolean
  sessionSearchError?: string
  sessionSearchTruncated?: boolean
  canCreateIssue?: boolean
  onSearchChange: (value: string) => void
  onFilterChange: (value: ProjectFilter) => void
  onCreateIssue: () => void
  onToggleStar: (issue: any) => void
}

export function ProjectSidebar({
  userParam,
  projectId,
  issues,
  search,
  filter,
  pagination,
  issuesLoading = false,
  sessionMatchesByIssue,
  sessionSearchLoading = false,
  sessionSearchError = '',
  sessionSearchTruncated = false,
  canCreateIssue = true,
  onSearchChange,
  onFilterChange,
  onCreateIssue,
  onToggleStar,
}: ProjectSidebarProps) {
  const showPagination = pagination.totalItems > pagination.pageSize
  const pageStart = pagination.totalItems === 0 ? 0 : (pagination.page - 1) * pagination.pageSize + 1
  const pageEnd = Math.min(pagination.page * pagination.pageSize, pagination.totalItems)
  const goToPage = (page: number) => pagination.onPageChange(Math.min(Math.max(page, 1), pagination.totalPages))

  return (
    <>
      {/* <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border-color)' }}>
        <span className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>任务</span>
        <button onClick={onCreateIssue} disabled={!canCreateIssue} title={canCreateIssue ? '新建任务' : '无权新建任务'} data-tour="project-sidebar-new-issue"
          className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-[var(--bg-hover)] text-blue-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
        </button>
      </div> */}
      <div className="px-3 py-2 space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-[9px] h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
          <input value={search} onChange={e => onSearchChange(e.target.value)}
            maxLength={200}
            data-project-hierarchy-search
            placeholder="搜索任务或会话..."
            className="w-full h-8 pl-8 pr-8 rounded-lg text-[12px] focus:outline-none focus:border-blue-500/30"
            style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
          {sessionSearchLoading && search.trim() && (
            <LoaderCircle className="pointer-events-none absolute right-2.5 top-[9px] h-3.5 w-3.5 animate-spin" style={{ color: 'var(--text-muted)' }} />
          )}
        </div>
        <div className="flex gap-1">
          {(['active', 'all', 'completed'] as const).map(f => (
            <button key={f} onClick={() => onFilterChange(f)}
              className={`flex-1 h-7 rounded text-[11px] transition-colors ${
                filter === f ? 'bg-blue-500/15 text-blue-400 border border-blue-500/20' : 'border border-transparent hover:bg-[var(--bg-card-hover)]'
              }`}
              style={filter !== f ? { color: 'var(--text-muted)' } : undefined}>
              {f === 'active' ? '进行中' : f === 'all' ? '全部' : '已完成'}
            </button>
          ))}
        </div>
        {search.trim() && (sessionSearchError || sessionSearchTruncated) && (
          <div className="px-0.5 text-[10px] leading-4" style={{ color: sessionSearchError ? '#f59e0b' : 'var(--text-muted)' }}>
            {sessionSearchError || '匹配较多，仅显示最近的 500 个会话'}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {(issuesLoading || (sessionSearchLoading && !!search.trim())) && issues.length === 0 ? (
          <ListLoadingHint />
        ) : issues.length === 0 ? (
          <div className="text-center py-8 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {search.trim() ? '未找到匹配的任务或会话' : '暂无任务'}
          </div>
        ) : issues.map((iss: any) => {
          const isCompleted = iss.status === 'completed'
          const sessionMatches = search.trim() ? (sessionMatchesByIssue[iss.id] || []) : []
          return (
            <div key={iss.id} className="mb-0.5">
              <Link to={`/u/${userParam}/p/${projectId}/i/${iss.id}`}
                className="group flex items-center gap-1.5 px-2 py-1 rounded-lg cursor-pointer transition-all hover:bg-[var(--bg-card-hover)]">
                <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleStar(iss) }}
                  title={iss.starred ? '取消收藏' : '收藏'}
                  className={`flex-shrink-0 -ml-1 p-1 bg-transparent border-none cursor-pointer rounded-md hover:bg-[var(--bg-hover)] ${iss.starred ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
                  <svg className="w-3.5 h-3.5" style={{ color: iss.starred ? '#f59e0b' : 'var(--text-muted)' }} fill={iss.starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
                </button>
                {!!iss.pinned && <svg className="w-2.5 h-2.5 flex-shrink-0" style={{ color: '#38bdf8' }} fill="currentColor" viewBox="0 0 24 24"><path d="M16 3l5 5-3 1-2 4-3 1-3-3-3 1-2-2 6-6-1-3 3-3-3-2 4-1z" /></svg>}
                <svg className="w-3.5 h-3.5 flex-shrink-0" style={{ color: isCompleted ? '#22c55e' : '#64748b' }} fill={isCompleted ? '#22c55e' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
                <span className={`text-[12px] font-medium truncate flex-1 ${isCompleted ? 'line-through' : ''}`}
                  style={{ color: isCompleted ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                  <SearchMatchText text={iss.title || ''} query={search} />
                </span>
                {iss.session_count > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)' }}>{iss.session_count}</span>
                )}
              </Link>
              {sessionMatches.slice(0, 3).map((session) => {
                const showDescription = textMatchesProjectSearch(session.description, search)
                return (
                  <Link key={session.session_id} to={`/u/${userParam}/p/${projectId}/i/${iss.id}?session=${session.session_id}`}
                    data-project-session-match={session.session_id}
                    className="ml-6 flex min-h-8 items-center gap-2 rounded-md border-l-2 border-blue-500/25 px-2 py-1 transition-colors hover:bg-[var(--bg-card-hover)]"
                    title={session.description || session.name}>
                    <MessageSquare className="h-3 w-3 flex-shrink-0 text-blue-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        <SearchMatchText text={session.name || '未命名会话'} query={search} />
                      </span>
                      {showDescription && (
                        <span className="block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          <SearchMatchText text={session.description || ''} query={search} />
                        </span>
                      )}
                    </span>
                  </Link>
                )
              })}
              {sessionMatches.length > 3 && (
                <div className="ml-8 px-2 py-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  另有 {sessionMatches.length - 3} 个匹配会话
                </div>
              )}
            </div>
          )
        })}
      </div>
      {showPagination && (
        <div className="px-3 py-2 border-t flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-color)' }}>
          <button
            type="button"
            onClick={() => goToPage(pagination.page - 1)}
            disabled={pagination.page <= 1}
            className="h-8 sm:h-7 px-2 rounded-md border text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
          >
            上一页
          </button>
          <span className="text-[11px] tabular-nums flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
            {pageStart}-{pageEnd} / {pagination.totalItems}
          </span>
          <button
            type="button"
            onClick={() => goToPage(pagination.page + 1)}
            disabled={pagination.page >= pagination.totalPages}
            className="h-8 sm:h-7 px-2 rounded-md border text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
          >
            下一页
          </button>
        </div>
      )}
    </>
  )
}
