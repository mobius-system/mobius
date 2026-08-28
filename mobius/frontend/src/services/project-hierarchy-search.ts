import { issuePath, researchPath, sessionPath } from './workbench-navigation'

export type ProjectHierarchyHitKind = 'issue' | 'research' | 'session' | 'research_agent'

export type ProjectHierarchyHit = {
  kind: ProjectHierarchyHitKind
  id: string
  title: string
  description: string
  status: string
  last_active: string | null
  parent_kind: 'issue' | 'research' | null
  parent_id: string | null
  parent_title: string | null
  matched_fields: string[]
  score: number
}

export type ProjectHierarchyGroup = {
  project: any
  project_match: boolean
  project_matched_fields: string[]
  matches: ProjectHierarchyHit[]
  total_matches: number
  score: number
}

export type ProjectHierarchySearchResponse = {
  query: string
  project_count: number
  match_count: number
  projects: ProjectHierarchyGroup[]
  truncated: boolean
}

export const EMPTY_PROJECT_HIERARCHY_SEARCH: ProjectHierarchySearchResponse = {
  query: '',
  project_count: 0,
  match_count: 0,
  projects: [],
  truncated: false,
}

export function textMatchesHierarchySearch(value: unknown, rawQuery: string): boolean {
  const query = rawQuery.trim().toLocaleLowerCase()
  return !!query && String(value || '').toLocaleLowerCase().includes(query)
}

export function hierarchyHitLabel(kind: ProjectHierarchyHitKind): string {
  if (kind === 'issue') return '任务'
  if (kind === 'research') return '研究'
  if (kind === 'research_agent') return '智能体'
  return '会话'
}

export function hierarchyHitUrl(project: any, hit: ProjectHierarchyHit, options: { returnTo?: string } = {}): string {
  const userId = String(project.created_by || '')
  const projectId = String(project.id || '')
  if (hit.kind === 'issue') return issuePath(userId, projectId, hit.id, options)
  if (hit.kind === 'research') return researchPath(userId, projectId, hit.id, options)
  return sessionPath(userId, hit.id)
}
