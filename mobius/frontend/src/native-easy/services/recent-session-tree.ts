export type RecentSessionTreeSession = {
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
  last_active?: string
}

export type RecentSessionTreeGroup<T extends RecentSessionTreeSession = RecentSessionTreeSession> = {
  key: string
  projectId: string
  projectName: string
  subjectId: string
  subjectTitle: string
  scopeType: 'issue' | 'research'
  sessions: T[]
  activeCount: number
}

export function recentSessionSubject(session: RecentSessionTreeSession) {
  return session.scope_type === 'research'
    ? (session.research_title || session.research_id || '研究')
    : (session.issue_title || session.issue_id || '任务')
}

function sessionActivityTime(session: RecentSessionTreeSession) {
  const parsed = Date.parse(String(session.last_active || ''))
  return Number.isFinite(parsed) ? parsed : -Infinity
}

export function isRecentSessionActive(session: RecentSessionTreeSession) {
  return session.agent_status === 'running'
    || session.agent_status === 'pending'
    || session.agent_status === 'waiting'
}

export function compareRecentSessionsByActivity(a: RecentSessionTreeSession, b: RecentSessionTreeSession) {
  const activeDiff = Number(isRecentSessionActive(b)) - Number(isRecentSessionActive(a))
  if (activeDiff !== 0) return activeDiff

  const timeDiff = sessionActivityTime(b) - sessionActivityTime(a)
  if (timeDiff !== 0) return timeDiff

  return String(a.name || a.session_id).localeCompare(String(b.name || b.session_id), 'zh-CN')
}

export function buildRecentSessionTreeGroups<T extends RecentSessionTreeSession>(sessions: T[]): RecentSessionTreeGroup<T>[] {
  const groups = new Map<string, RecentSessionTreeGroup<T>>()
  for (const session of sessions) {
    const scopeType = session.scope_type === 'research' ? 'research' : 'issue'
    const projectId = String(session.project_id || '')
    const projectName = String(session.project_name || session.project_id || '项目')
    const subjectId = String(scopeType === 'research' ? session.research_id || '' : session.issue_id || '')
    const subjectTitle = String(recentSessionSubject(session))
    // Missing parent ids must remain isolated instead of merging unrelated unnamed sessions.
    const parentKey = subjectId || `${subjectTitle}:${session.session_id}`
    const key = `${projectId}:${scopeType}:${parentKey}`
    const group = groups.get(key) || {
      key,
      projectId,
      projectName,
      subjectId,
      subjectTitle,
      scopeType,
      sessions: [],
      activeCount: 0,
    }
    group.sessions.push(session)
    if (isRecentSessionActive(session)) group.activeCount += 1
    groups.set(key, group)
  }

  return [...groups.values()]
    .map(group => ({ ...group, sessions: [...group.sessions].sort(compareRecentSessionsByActivity) }))
    .sort((a, b) => (
      compareRecentSessionsByActivity(a.sessions[0], b.sessions[0])
      || a.projectName.localeCompare(b.projectName, 'zh-CN')
      || a.subjectTitle.localeCompare(b.subjectTitle, 'zh-CN')
    ))
}
