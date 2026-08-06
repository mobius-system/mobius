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
