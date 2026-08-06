import { Link } from 'react-router-dom'
import { timeAgo } from '../shell'
import { SearchMatchText } from '../search-match-text'
import { textMatchesProjectSearch, type ProjectSessionMatch } from '../../services/project-session-search'
import { projectSessionPreview, sortProjectSessions } from '../../services/project-session-order'

type ResearchCardProps = {
  research: any
  sessions: any[]
  searchMatches: ProjectSessionMatch[]
  searchQuery: string
  userParam: string
  projectId: string
  compact?: boolean
  onEdit: (research: any) => void
  onToggleStatus: (research: any, status: 'active' | 'completed') => void
}

export function ResearchCard({
  research,
  sessions,
  searchMatches,
  searchQuery,
  userParam,
  projectId,
  compact = false,
  onEdit,
  onToggleStatus,
}: ResearchCardProps) {
  const isCompleted = research.status === 'completed'
  const activeSessions = sessions.filter((s: any) => s.agent_status === 'running')
  const sessionTotal = Number.isFinite(Number(research.session_count)) ? Number(research.session_count) : sessions.length
  const activeSessionTotal = Number.isFinite(Number(research.running_session_count)) ? Number(research.running_session_count) : activeSessions.length
  const showingSessionMatches = !!searchQuery.trim() && searchMatches.length > 0
  const displayedSessions = sortProjectSessions(showingSessionMatches ? searchMatches : sessions)
  const previewSessions = projectSessionPreview(displayedSessions, compact, showingSessionMatches)
  const hiddenSessionCount = Math.max(0, (showingSessionMatches ? searchMatches.length : sessionTotal) - previewSessions.length)
  const chief = sessions.find((s: any) => s.research_role === 'chief_researcher')
  const hasChief = !!chief || Number(research.chief_count || 0) > 0

  return (
    <div className="rounded-lg border overflow-hidden flex flex-col group transition-all hover:border-emerald-500/30"
      style={{
        background: 'var(--bg-primary)',
        borderColor: 'var(--border-color)',
        borderLeftColor: activeSessionTotal > 0 ? '#22c55e' : 'var(--border-color)',
        borderLeftWidth: activeSessionTotal > 0 ? 2 : 1,
      }}>
      <div className={`${compact ? 'px-3 py-2.5' : 'px-4 py-3'} border-b flex items-start gap-2`} style={{ borderColor: 'var(--border-color)' }}>
        <svg className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: isCompleted ? '#22c55e' : '#34d399' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a8 8 0 10-13.856 0M12 6v6l4 2" />
        </svg>
        <Link to={`/u/${userParam}/p/${projectId}/r/${research.id}`}
          className={`${compact ? 'text-[13px]' : 'text-[14px]'} font-semibold flex-1 min-w-0 truncate hover:text-emerald-400 transition-colors ${isCompleted ? 'line-through' : ''}`}
          style={{ color: isCompleted ? 'var(--text-muted)' : 'var(--text-primary)' }}>{research.title}</Link>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          <button onClick={() => onToggleStatus(research, isCompleted ? 'active' : 'completed')}
            className="p-1 rounded hover:bg-white/10" title={isCompleted ? '重新打开' : '标记完成'}>
            <svg className="w-3.5 h-3.5" style={{ color: isCompleted ? '#f59e0b' : '#22c55e' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isCompleted ? 'M6 18L18 6M6 6l12 12' : 'M5 13l4 4L19 7'} /></svg>
          </button>
          <button onClick={() => onEdit(research)} className="p-1 rounded hover:bg-white/10" title="修改">
            <svg className="w-3.5 h-3.5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
          </button>
        </div>
      </div>

      {research.description && (
        <div className={`${compact ? 'px-3 py-2 line-clamp-1' : 'px-4 py-2.5 line-clamp-3'} text-[12px] leading-relaxed`} style={{ color: 'var(--text-secondary)' }}>
          {research.description}
        </div>
      )}

      <div className={`${compact ? 'px-3 py-1.5' : 'px-4 py-2'} flex items-center gap-3 text-[11px]`} style={{ color: 'var(--text-muted)' }}>
        <span>{activeSessionTotal} 执行中 · {sessionTotal} 个研究智能体</span>
        <span>{hasChief ? '已有 chief' : '未创建 chief'}</span>
        <span className="ml-auto">活跃 {timeAgo(research.last_active)}</span>
      </div>

      <div className={`${compact ? 'px-3 py-2' : 'px-4 py-2.5'} border-t flex-1`} style={{ borderColor: 'var(--border-color)' }}>
        <div className={`flex items-center justify-between ${compact ? 'mb-1' : 'mb-2'}`}>
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-muted)' }}>
            {showingSessionMatches ? `匹配智能体 ${searchMatches.length}` : '研究智能体'}
          </span>
          <Link to={`/u/${userParam}/p/${projectId}/r/${research.id}`}
            className="text-[11px] text-emerald-400 hover:text-emerald-300 transition-colors">进入研究 →</Link>
        </div>
        {displayedSessions.length === 0 ? (
          <div className="text-[11px] py-1" style={{ color: 'var(--text-muted)' }}>暂无研究智能体</div>
        ) : (
          <div className="space-y-1">
            {previewSessions.map((s: any) => (
              <Link key={s.session_id} to={`/u/${userParam}/p/${projectId}/r/${research.id}?session=${s.session_id}`}
                data-project-card-session-match={showingSessionMatches ? s.session_id : undefined}
                className={`flex items-center gap-2 px-2 ${compact ? 'py-1' : 'py-1.5'} rounded hover:bg-[var(--bg-card-hover)] transition-colors`}>
                {s.agent_status === 'running' ? <div className="pulse-green" /> : <div className="w-1.5 h-1.5 rounded-full bg-emerald-400/70 flex-shrink-0" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px]" style={{ color: 'var(--text-primary)' }}>
                    <SearchMatchText text={s.name || '未命名智能体'} query={showingSessionMatches ? searchQuery : ''} />
                  </span>
                  {showingSessionMatches && textMatchesProjectSearch(s.description, searchQuery) && (
                    <span className="block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      <SearchMatchText text={s.description || ''} query={searchQuery} />
                    </span>
                  )}
                </span>
                <span className="text-[10px] flex-shrink-0" style={{ color: s.research_role === 'chief_researcher' ? '#34d399' : 'var(--text-muted)' }}>
                  {s.research_role === 'chief_researcher' ? 'chief' : 'assistant'}
                </span>
              </Link>
            ))}
            {hiddenSessionCount > 0 && (
              <div className="text-[11px] py-1 px-2" style={{ color: 'var(--text-muted)' }}>
                还有 {hiddenSessionCount} 个{showingSessionMatches ? '匹配' : ''}研究智能体...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
