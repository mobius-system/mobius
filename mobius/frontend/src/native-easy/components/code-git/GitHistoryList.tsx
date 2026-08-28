import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { GitCommitHorizontal, Loader2, RefreshCw } from 'lucide-react'
import type { GitCommit } from './types'

function commitTime(commit: GitCommit) {
  const date = new Date(commit.date)
  const absolute = Number.isNaN(date.getTime()) ? commit.date : date.toLocaleString('zh-CN')
  return { absolute, visible: commit.relative_date || absolute || '未知时间' }
}

export function GitHistoryList({
  commits,
  selectedSha,
  file,
  loading,
  loadingMore,
  error,
  hasMore,
  onSelect,
  onRetry,
  onLoadMore,
  onShowAll,
}: {
  commits: GitCommit[]
  selectedSha: string
  file?: string | null
  loading: boolean
  loadingMore: boolean
  error: string
  hasMore: boolean
  onSelect: (commit: GitCommit) => void
  onRetry: () => void
  onLoadMore: () => void
  onShowAll: () => void
}) {
  const selectedIndex = Math.max(0, commits.findIndex(commit => commit.hash === selectedSha))
  const [focusIndex, setFocusIndex] = useState(selectedIndex)
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    setFocusIndex(selectedIndex)
  }, [selectedIndex])

  const moveFocus = (index: number) => {
    if (!commits.length) return
    const next = Math.max(0, Math.min(commits.length - 1, index))
    setFocusIndex(next)
    window.requestAnimationFrame(() => refs.current[next]?.focus())
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, commit: GitCommit, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveFocus(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      moveFocus(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      moveFocus(commits.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(commit)
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />加载提交历史…</div>
  }

  if (error && commits.length === 0) {
    return (
      <div className="workbench-status-danger m-3 rounded-[var(--radius-control)] border p-3 text-[12px]" role="alert">
        <div className="whitespace-pre-wrap">{error}</div>
        <button type="button" onClick={onRetry} className="workbench-control-md mt-3 inline-flex items-center gap-1.5 border px-3 text-[11px]" style={{ borderColor: 'var(--status-danger-border)' }}>
          <RefreshCw className="h-3.5 w-3.5" />重试历史
        </button>
      </div>
    )
  }

  if (commits.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center text-[12px] text-[var(--text-muted)]">
        <GitCommitHorizontal className="h-6 w-6" />
        <span>{file ? '该文件还没有提交历史' : '当前仓库还没有提交记录'}</span>
        {file && <button type="button" onClick={onShowAll} className="workbench-control-md border px-3 text-[11px]" style={{ borderColor: 'var(--border-default)' }}>返回全部历史</button>}
        <button type="button" onClick={onRetry} className="workbench-control-md inline-flex items-center gap-1.5 border px-3 text-[11px]" style={{ borderColor: 'var(--border-default)' }}><RefreshCw className="h-3.5 w-3.5" />重新加载</button>
      </div>
    )
  }

  return (
    <div className="p-3" role="listbox" aria-label={file ? `文件 ${file} 的提交历史` : '提交历史'}>
      {commits.map((commit, index) => {
        const active = commit.hash === selectedSha
        const time = commitTime(commit)
        return (
          <button
            key={commit.hash}
            ref={element => { refs.current[index] = element }}
            type="button"
            role="option"
            aria-selected={active}
            tabIndex={focusIndex === index ? 0 : -1}
            onFocus={() => setFocusIndex(index)}
            onKeyDown={event => onKeyDown(event, commit, index)}
            onClick={() => onSelect(commit)}
            className={`git-history-list__commit${active ? ' git-history-list__commit--active' : ''}`}
          >
            <span className="block break-words text-[12px] font-medium leading-5 text-[var(--text-primary)]">{commit.subject || '(无提交信息)'}</span>
            <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] text-[var(--text-muted)]">
              <code className="git-changes-viewer__badge" title={commit.hash}>{commit.short_hash || commit.hash.slice(0, 7)}</code>
              <span className="max-w-[9rem] truncate" title={commit.author_email}>{commit.author_name || 'unknown'}</span>
              <span aria-hidden>·</span>
              <time dateTime={commit.date} title={time.absolute}>{time.visible}</time>
            </span>
            {!!commit.refs?.length && (
              <span className="mt-1.5 flex flex-wrap gap-1">
                {commit.refs.map(ref => <span key={ref} className="git-history-list__ref">{ref}</span>)}
              </span>
            )}
          </button>
        )
      })}
      {error && <div className="workbench-status-danger mt-2 rounded-[var(--radius-control)] border p-2 text-[11px]" role="alert">{error}</div>}
      {hasMore && (
        <button type="button" onClick={onLoadMore} disabled={loadingMore} className="workbench-control-md mt-2 inline-flex w-full items-center justify-center gap-1.5 border text-[11px] disabled:opacity-50" style={{ borderColor: 'var(--border-default)' }}>
          {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{loadingMore ? '加载中…' : '加载更多'}
        </button>
      )}
    </div>
  )
}
