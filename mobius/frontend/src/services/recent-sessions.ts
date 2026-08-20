// 近期活跃会话数据层 — @ 目标选择抽屉与 Issue 侧栏「近期会话」共享。
// 数据源 /api/tasks/recent (登录用户自己的近期会话, 含跨项目), 归一化 +
// 树状分组复用 recent-session-tree 的 buildRecentSessionTreeGroups。
import { buildRecentSessionTreeGroups, type RecentSessionTreeGroup } from './recent-session-tree'

export const RECENT_SESSION_LIMIT = 50

export type RecentSession = {
  session_id: string
  name?: string
  project_id?: string | null
  project_name?: string | null
  issue_id?: string | null
  issue_title?: string | null
  research_id?: string | null
  research_title?: string | null
  scope_type?: 'issue' | 'research'
  agent_status?: string
  message_count?: number
  last_active?: string
  status?: string
}

export function normalizeRecentSessions(value: unknown): RecentSession[] {
  return (Array.isArray(value) ? value : [])
    .filter((session: any) => session?.session_id && session?.status !== 'archived')
    .sort((a: any, b: any) => (
      new Date(b.last_active || 0).getTime() - new Date(a.last_active || 0).getTime()
    ))
    .slice(0, RECENT_SESSION_LIMIT)
}

export function recentSessionGroupsOf(sessions: RecentSession[]): RecentSessionTreeGroup<RecentSession>[] {
  return buildRecentSessionTreeGroups(sessions)
}

// 跳转到该会话所在路由 (与 IssuePage 侧栏近期会话一致: 有 issue/research 归属才可跳转)。
export function recentSessionTarget(user: string, session: RecentSession) {
  if (!user || !session.project_id || !session.session_id) return ''
  const base = `/u/${encodeURIComponent(user)}/p/${encodeURIComponent(session.project_id)}`
  const query = `?session=${encodeURIComponent(session.session_id)}`
  if (session.scope_type === 'research' && session.research_id) {
    return `${base}/r/${encodeURIComponent(session.research_id)}${query}`
  }
  if (session.issue_id) return `${base}/i/${encodeURIComponent(session.issue_id)}${query}`
  return ''
}
