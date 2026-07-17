import { Link } from 'react-router-dom'
import { timeAgo } from '../shell'
import { AgentStatusDot } from '../AgentStatusDot'
import type { IssueConfirmAction } from './types'
import {
  LOGO_REVIEW_ISSUE_TITLE,
  LOGO_REVIEW_PROJECT_ID,
  LOGO_REVIEW_SESSION_NAME,
} from '../../services/logo-review-demo'

type IssueCardProps = {
  issue: any
  sessions: any[]
  userParam: string
  projectId: string
  onEdit: (issue: any) => void
  onConfirm: (action: IssueConfirmAction) => void
  onToggleStar: (issue: any) => void
}

export function IssueCard({
  issue,
  sessions,
  userParam,
  projectId,
  onEdit,
  onConfirm,
  onToggleStar,
}: IssueCardProps) {
  const isCompleted = issue.status === 'completed'
  const activeSessions = sessions.filter((s: any) => s.status === 'active')
  const sessionTotal = Number.isFinite(Number(issue.session_count)) ? Number(issue.session_count) : sessions.length
  const activeSessionTotal = Number.isFinite(Number(issue.session_count)) ? sessionTotal : activeSessions.length
  const isLogoReviewIssue = projectId === LOGO_REVIEW_PROJECT_ID
    && String(issue.title || '').includes(LOGO_REVIEW_ISSUE_TITLE)
  // v3 写权限: can_manage=false (非 owner, 不是允许名单, 项目不可写) 时隐藏所有管理按钮.
  // 后端 shapeProjectForUser 已经算好 can_manage; 这里在 issue 上也兼容读 issue.can_manage (个别路径会下发).
  const canManage = issue.can_manage !== false

  return (
    <div
      data-tour={isLogoReviewIssue ? 'logo-review-issue-card' : undefined}
      className="rounded-xl border overflow-hidden flex flex-col group transition-all hover:border-blue-500/30"
      style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}>
      <div className="px-4 py-3 border-b flex items-start gap-2" style={{ borderColor: 'var(--border-color)' }}>
        {!!issue.starred && <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: '#f59e0b' }} fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>}
        {!!issue.pinned && <svg className="w-3 h-3 mt-1 flex-shrink-0" style={{ color: '#38bdf8' }} fill="currentColor" viewBox="0 0 24 24"><path d="M16 3l5 5-3 1-2 4-3 1-3-3-3 1-2-2 6-6-1-3 3-3-3-2 4-1z" /></svg>}
        <svg className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: isCompleted ? '#22c55e' : '#60a5fa' }} fill={isCompleted ? '#22c55e' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
        <Link
          to={`/u/${userParam}/p/${projectId}/i/${issue.id}`}
          data-tour={isLogoReviewIssue ? 'logo-review-issue-link' : undefined}
          className={`text-[14px] font-semibold flex-1 hover:text-blue-400 transition-colors ${isCompleted ? 'line-through' : ''}`}
          style={{ color: isCompleted ? 'var(--text-muted)' : 'var(--text-primary)' }}>{issue.title}</Link>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button onClick={() => onToggleStar(issue)} className={`p-1 rounded hover:bg-white/10 transition-opacity ${issue.starred ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`} title={issue.starred ? '取消收藏' : '收藏'}>
            <svg className="w-3.5 h-3.5" style={{ color: issue.starred ? '#f59e0b' : 'var(--text-muted)' }} fill={issue.starred ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
          </button>
          {canManage && <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button onClick={() => onConfirm({ kind: isCompleted ? 'reopen' : 'complete', issue })} className="p-1 rounded hover:bg-white/10"
              title={isCompleted ? '重新打开' : '标记完成'}>
              <svg className="w-3.5 h-3.5" style={{ color: isCompleted ? '#f59e0b' : '#22c55e' }} fill={isCompleted ? '#f59e0b' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isCompleted ? 'M6 18L18 6M6 6l12 12' : 'M5 13l4 4L19 7'} /></svg>
            </button>
            <button onClick={() => onEdit(issue)} className="p-1 rounded hover:bg-white/10" title="修改">
              <svg className="w-3.5 h-3.5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
            </button>
            <button onClick={() => onConfirm({ kind: issue.pinned ? 'unpin' : 'pin', issue })} className="p-1 rounded hover:bg-white/10" title={issue.pinned ? '取消管理员置顶' : '管理员置顶 (项目级)'}>
              <svg className="w-3.5 h-3.5" style={{ color: issue.pinned ? '#38bdf8' : 'var(--text-muted)' }} fill={issue.pinned ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path d="M16 3l5 5-3 1-2 4-3 1-3-3-3 1-2-2 6-6-1-3 3-3-3-2 4-1z" /></svg>
            </button>
            <button onClick={() => onConfirm({ kind: 'delete', issue })} className="p-1 rounded hover:bg-red-500/10" title="删除">
              <svg className="w-3.5 h-3.5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          </div>}
        </div>
      </div>

      {issue.description && (
        <div className="px-4 py-2.5 text-[12px] leading-relaxed line-clamp-3" style={{ color: 'var(--text-secondary)' }}>
          {issue.description}
        </div>
      )}

      <div className="px-4 py-2 flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        <span>{activeSessionTotal} 活跃 · {sessionTotal} 总会话</span>
        <span className="ml-auto">活跃 {timeAgo(issue.last_active)}</span>
      </div>

      <div className="border-t px-4 py-2.5 flex-1" style={{ borderColor: 'var(--border-color)' }}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-muted)' }}>会话</span>
          <Link to={`/u/${userParam}/p/${projectId}/i/${issue.id}`}
            className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors">进入对话 →</Link>
        </div>
        {sessions.length === 0 ? (
          <div className="text-[11px] py-1" style={{ color: 'var(--text-muted)' }}>暂无会话</div>
        ) : (
          <div className="space-y-1">
            {sessions.slice(0, 4).map((s: any) => {
              const isLogoReviewSession = isLogoReviewIssue && String(s.name || '').includes(LOGO_REVIEW_SESSION_NAME)
              return (
              <Link key={s.session_id} to={`/u/${userParam}/p/${projectId}/i/${issue.id}?session=${s.session_id}`}
                data-tour={isLogoReviewSession ? 'logo-review-session-link' : undefined}
                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--bg-card-hover)] transition-colors">
                <AgentStatusDot agentStatus={s.agent_status} className="flex-shrink-0" />
                <span className="text-[12px] truncate flex-1" style={{ color: 'var(--text-primary)' }}>{s.name}</span>
                <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{s.message_count} · {timeAgo(s.last_active)}</span>
              </Link>
              )
            })}
            {sessionTotal > sessions.length && (
              <div className="text-[11px] py-1 px-2" style={{ color: 'var(--text-muted)' }}>
                还有 {sessionTotal - sessions.length} 个会话...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
