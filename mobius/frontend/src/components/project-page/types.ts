export type ProjectFilter = 'all' | 'active' | 'completed'
export type ProjectListSection = 'issues' | 'researches'
export type ProjectCardDensity = 'compact' | 'detailed'

export type ProjectIssuePagination = {
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  onPageChange: (page: number) => void
}

export type GitRepoDraft = {
  url: string
  name?: string
}

export type IssueConfirmAction = {
  kind: 'complete' | 'reopen' | 'pin' | 'unpin' | 'delete'
  issue: any
}
