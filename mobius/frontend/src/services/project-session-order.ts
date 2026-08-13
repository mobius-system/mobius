/**
 * Project cards show a small session preview. Keep the ordering policy in one
 * place so normal previews and search results tell the same story:
 * executing sessions first, then open sessions, then recently finished ones.
 */
export function projectSessionOrder(a: any, b: any): number {
  const rank = (session: any): number => {
    if (session?.agent_status === 'running') return 0
    if (session?.status === 'active') return 1
    return 2
  }

  const rankDiff = rank(a) - rank(b)
  if (rankDiff !== 0) return rankDiff

  const activityDate = (session: any): number => {
    const value = session?.status === 'completed'
      ? (session?.completed_at || session?.last_active)
      : session?.last_active
    const parsed = Date.parse(String(value || ''))
    return Number.isFinite(parsed) ? parsed : -Infinity
  }
  const dateDiff = activityDate(b) - activityDate(a)
  if (dateDiff !== 0) return dateDiff

  const createdDiff = Date.parse(String(b?.created_at || '')) - Date.parse(String(a?.created_at || ''))
  if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff
  return String(a?.session_id || '').localeCompare(String(b?.session_id || ''))
}

export function sortProjectSessions<T>(sessions: T[]): T[] {
  return [...(sessions || [])].sort(projectSessionOrder)
}

export function projectSessionPreview<T extends { agent_status?: string | null }>(
  sessions: T[],
  compact: boolean,
  showingSearchMatches = false,
): T[] {
  const ordered = sortProjectSessions(sessions)
  if (!compact) return ordered.slice(0, 3)
  if (showingSearchMatches) return ordered.slice(0, 2)
  const running = ordered.filter((session) => session?.agent_status === 'running')
  return running.length > 0 ? running.slice(0, 2) : ordered.slice(0, 1)
}

export function projectItemOrder(a: any, b: any): number {
  const runningDiff = Number(Number(b?.running_session_count || 0) > 0)
    - Number(Number(a?.running_session_count || 0) > 0)
  if (runningDiff !== 0) return runningDiff

  const activeSessionDiff = Number(Number(b?.active_session_count || 0) > 0)
    - Number(Number(a?.active_session_count || 0) > 0)
  if (activeSessionDiff !== 0) return activeSessionDiff

  const activeDiff = Number(b?.status !== 'completed') - Number(a?.status !== 'completed')
  if (activeDiff !== 0) return activeDiff

  const starredDiff = Number(!!b?.starred) - Number(!!a?.starred)
  if (starredDiff !== 0) return starredDiff
  const pinnedDiff = Number(!!b?.pinned) - Number(!!a?.pinned)
  if (pinnedDiff !== 0) return pinnedDiff

  const activity = (item: any): number => {
    const value = item?.status === 'completed'
      ? (item?.completed_at || item?.last_active)
      : item?.last_active
    const parsed = Date.parse(String(value || ''))
    return Number.isFinite(parsed) ? parsed : -Infinity
  }
  const activityDiff = activity(b) - activity(a)
  if (activityDiff !== 0) return activityDiff
  return String(a?.id || '').localeCompare(String(b?.id || ''))
}
