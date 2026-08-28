import { MessageSquare } from 'lucide-react'
import { timeAgo, timeAgoPrecise } from './shell'
import type { RecentSession } from '../services/recent-sessions'

// 近期会话行 — Issue 侧栏「近期会话」与 @ 目标抽屉「近期会话」共享。
// 行为 (侧栏=跳转路由 / 抽屉=选为 @ 目标) 由 onClick 注入, 视觉与状态徽章保持一致。
export function recentSessionStatusPill(session: RecentSession): { label: string; color: string; bg: string } {
  if (session.agent_status === 'running') return { label: '执行中', color: '#f59e0b', bg: 'rgba(245,158,11,.10)' }
  if (session.agent_status === 'pending') return { label: '启动中', color: '#fbbf24', bg: 'rgba(251,191,36,.10)' }
  if (session.agent_status === 'waiting') return { label: '待命', color: '#38bdf8', bg: 'rgba(56,189,248,.10)' }
  if (session.agent_status === 'completed' || session.status === 'completed') return { label: '已完成', color: '#34d399', bg: 'rgba(52,211,153,.10)' }
  return { label: '空闲', color: 'var(--text-muted)', bg: 'var(--bg-card)' }
}

export function RecentSessionRow({
  session,
  active = false,
  disabled = false,
  onClick,
  title,
  variant = 'default',
}: {
  session: RecentSession
  active?: boolean
  disabled?: boolean
  onClick?: () => void
  title?: string
  variant?: 'default' | 'mention'
}) {
  const isResearch = session.scope_type === 'research'
  const status = recentSessionStatusPill(session)
  const relationLabel = isResearch ? 'Research 会话' : 'Issue 会话'
  if (variant === 'mention') {
    const active = session.agent_status === 'running'
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title ?? `${session.name || session.session_id} · ${session.session_id}`}
        className="relative mt-0.5 flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-card-hover)] focus-visible:ring-2 focus-visible:ring-blue-500/50 disabled:cursor-default disabled:opacity-50"
        style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}
        data-session-id={session.session_id}
      >
        <span className="absolute -left-2.5 top-1/2 w-2 border-t" style={{ borderColor: 'var(--border-color)' }} aria-hidden="true" />
        <span className={`h-2 w-2 flex-shrink-0 rounded-full ${active ? 'bg-emerald-400' : 'bg-slate-400'}`} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium leading-4" style={{ color: 'var(--text-primary)' }}>
              {session.name || session.session_id}
            </span>
            {session.last_active && <span className="flex-shrink-0 text-[9px] tabular-nums leading-3" style={{ color: 'var(--text-muted)' }}>{timeAgo(session.last_active)}</span>}
          </span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1 text-[9px] leading-3" style={{ color: 'var(--text-muted)' }}>
            <span className="max-w-[160px] truncate font-mono">{session.session_id}</span>
            <span className="rounded bg-[var(--bg-card-hover)] px-1.5 py-0.5">{relationLabel}</span>
            <span className="rounded bg-[var(--bg-card-hover)] px-1.5 py-0.5">近期</span>
          </span>
          {(session.project_name || session.issue_title || session.research_title) && (
            <span className="mt-1 line-clamp-1 block text-[10px] leading-4" style={{ color: 'var(--text-secondary)' }}>
              {[session.project_name, isResearch ? session.research_title : session.issue_title].filter(Boolean).join(' · ')}
            </span>
          )}
        </span>
        <span className="flex flex-shrink-0 flex-col items-end gap-0.5">
          <span className="rounded border px-1.5 py-0.5 text-[9px] leading-3" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
            选择模式
          </span>
        </span>
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? (session.name || session.session_id)}
      className="relative mt-0.5 flex min-h-9 w-full items-center gap-1.5 rounded-md border px-1.5 py-1 text-left transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-default disabled:opacity-50"
      style={{ borderColor: active ? 'color-mix(in srgb, var(--accent-primary) 42%, var(--border-color))' : 'transparent', background: active ? 'var(--bg-active)' : undefined }}
      data-session-id={session.session_id}
      aria-current={active ? 'true' : undefined}
    >
      <span className="absolute -left-2 top-1/2 w-1.5 border-t" style={{ borderColor: 'var(--border-color)' }} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1">
          <span className="flex-shrink-0 rounded px-1 py-0.5 text-[8px] font-medium leading-3" style={{ color: 'var(--text-secondary)', background: 'var(--bg-card)' }}>{isResearch ? '智能体' : '会话'}</span>
          <span className="min-w-0 flex-1 truncate text-[10px] font-medium leading-4" style={{ color: 'var(--text-primary)' }}>{session.name || session.session_id}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[8px] leading-3" style={{ color: 'var(--text-muted)' }}>
          <span>{timeAgoPrecise(session.last_active || '')}</span>
          <span className="inline-flex items-center gap-0.5"><MessageSquare className="h-2.5 w-2.5" />{session.message_count || 0}</span>
        </span>
      </span>
      <span className="flex-shrink-0 rounded-full px-1 py-0.5 text-[8px] font-medium leading-3" style={{ color: status.color, background: status.bg }}>{status.label}</span>
    </button>
  )
}
