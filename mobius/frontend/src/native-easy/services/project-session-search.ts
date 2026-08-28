export type ProjectSessionMatch = {
  session_id: string
  issue_id: string | null
  research_id: string | null
  scope_type: 'issue' | 'research'
  research_role?: 'chief_researcher' | 'research_assistant' | null
  name: string
  description?: string | null
  status: string
  agent_status?: string
  created_at?: string
  completed_at?: string | null
  last_active: string
  message_count?: number
}

export type ProjectSessionMatchMap = Record<string, ProjectSessionMatch[]>

export type ProjectSessionSearchResponse = {
  query: string
  issues: ProjectSessionMatchMap
  researches: ProjectSessionMatchMap
  total: number
  truncated: boolean
}

export const EMPTY_PROJECT_SESSION_SEARCH: ProjectSessionSearchResponse = {
  query: '',
  issues: {},
  researches: {},
  total: 0,
  truncated: false,
}

export function textMatchesProjectSearch(value: unknown, rawQuery: string): boolean {
  const query = rawQuery.trim().toLocaleLowerCase()
  return !!query && String(value || '').toLocaleLowerCase().includes(query)
}
