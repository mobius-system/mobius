import { Link } from 'react-router-dom'
import { timeAgo } from '../shell'
import { AgentStatusDot } from '../AgentStatusDot'
import { ListLoadingHint } from '../list-loading-hint'

export type ProjectSessionRow = {
  session_id: string
  name?: string
  scope_type?: 'issue' | 'research'
  issue_id?: string | null
  research_id?: string | null
  status?: string
  agent_status?: string | null
  last_active?: string | null
  message_count?: number
  user_display_name?: string
  parent_title?: string
  parent_status?: string | null
}

type ProjectSessionListProps = {
  sessions: ProjectSessionRow[]
  loading?: boolean
  truncated?: boolean
  userParam: string
  projectId: string
}

/**
 * 项目页「列表」密度: 直接展示项目内的会话活动流 (按活跃顺序), 而不是父级任务卡片。
 * Project page list density: a session activity feed (ordered by activity) instead of parent issue cards.
 */
export function ProjectSessionList({
  sessions,
  loading = false,
  truncated = false,
  userParam,
  projectId,
}: ProjectSessionListProps) {
  if (sessions.length === 0) {
    // 首次拉取时先显示 loading, 不要闪「暂无会话」空态。
    // Show a loading hint on first fetch instead of flashing the empty state.
    if (loading) {
      return (
        <div className="rounded-2xl border-dashed border-2 p-10 text-center" style={{ borderColor: 'var(--border-color)' }}>
          <ListLoadingHint />
        </div>
      )
    }
    return (
      <div className="text-center text-[length:var(--fs-md)]" role="status" style={{ color: 'var(--text-muted)' }}>
        暂无会话
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {sessions.map((session) => {
        const parentId = session.scope_type === 'research' ? session.research_id : session.issue_id
        const parentKind = session.scope_type === 'research' ? 'r' : 'i'
        const target = `/u/${encodeURIComponent(userParam)}/p/${encodeURIComponent(projectId)}/${parentKind}/${encodeURIComponent(String(parentId || ''))}?session=${encodeURIComponent(session.session_id)}`
        const running = session.agent_status === 'running'
        const finished = session.status === 'completed'
        return (
          <Link
            key={session.session_id}
            to={target}
            data-project-session-row={session.session_id}
            title={session.parent_title ? `所属任务: ${session.parent_title}` : undefined}
            className="group flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors hover:border-blue-500/30"
            style={{
              background: 'var(--bg-primary)',
              borderColor: 'var(--border-color)',
              borderLeftColor: running ? '#22c55e' : 'var(--border-color)',
              borderLeftWidth: running ? 2 : 1,
            }}>
            <AgentStatusDot agentStatus={session.agent_status} className="flex-shrink-0" />
            <span
              className="min-w-0 flex-1 truncate text-[length:var(--fs-lg)] font-medium transition-colors group-hover:text-blue-400"
              style={{ color: finished ? 'var(--text-muted)' : 'var(--text-primary)' }}>
              {session.name || '未命名会话'}
            </span>
            {!!session.parent_title && (
              <span
                className="hidden max-w-[30%] flex-shrink-0 truncate text-[length:var(--fs-sm)] sm:block"
                style={{ color: 'var(--text-secondary)' }}>
                {session.parent_title}
              </span>
            )}
            <span className="flex-shrink-0 text-[length:var(--fs-sm)] tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {Number(session.message_count || 0)} 条 · {timeAgo(session.last_active || '')}
            </span>
          </Link>
        )
      })}
      {truncated && (
        <div className="text-center text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>
          仅显示最近 500 个会话
        </div>
      )}
    </div>
  )
}

export default ProjectSessionList
