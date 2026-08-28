export type GitDiffMode = 'unstaged' | 'staged'

export type SessionFileFeature = {
  path: string
  display_path: string
  original_paths?: string[]
  count: number
  first_timestamp?: string | null
  last_timestamp?: string | null
  outside_workspace?: boolean
}

export type SessionGitDiff = {
  path: string
  display_path: string
  mode: GitDiffMode
  diff: string | null
  fallback_content?: string | null
  fallback_error?: string | null
  ok: boolean
  error?: string | null
}

export type GitCommit = {
  hash: string
  short_hash: string
  author_name: string
  author_email: string
  date: string
  relative_date: string
  subject: string
  refs: string[]
}

export type GitHistoryResponse = {
  source: 'git'
  repo_path: string
  repo_name: string
  file: string | null
  limit: number
  cursor: string | null
  next_cursor: string | null
  has_more: boolean
  commits: GitCommit[]
}

export type GitCommitDiff = {
  source: 'git'
  sha: string
  short_sha: string
  file: string | null
  diff: string
}

export const GIT_DIFF_MODE_LABELS: Record<GitDiffMode, string> = {
  unstaged: '未暂存',
  staged: '已暂存',
}

export const SESSION_FEATURE_FILES_TIMEOUT_MS = 15_000

export function normalizedSessionFilePath(value: string) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

export function sessionFileMatches(file: SessionFileFeature, targetPath: string) {
  const target = normalizedSessionFilePath(targetPath)
  if (!target) return false
  return [file.path, file.display_path, ...(file.original_paths || [])]
    .some(candidate => normalizedSessionFilePath(candidate) === target)
}

export function formatSessionFeatureTime(value?: string | null) {
  if (!value) return '未知时间'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
