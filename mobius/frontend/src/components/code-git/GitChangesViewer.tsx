import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import { FileDiff, GitCompare, GitCommitHorizontal, History, Loader2, RefreshCw } from 'lucide-react'
import { api } from '../../store'
import { CodeArtifactOpenProvider } from '../code-artifacts/CodeArtifactOpenContext'
import { FileReferenceLink } from '../code-artifacts/FileReferenceLink'
import { targetFromTrustedPath, type CodeArtifactOpenRequest } from '../code-artifacts/file-target'
import { safeToolPathLabel, sanitizeToolError } from '../session-tool-context'
import {
  DiffRows,
  parseUnifiedDiff,
  splitUnifiedDiffFiles,
  unifiedDiffNoHunkMessage,
  type UnifiedDiffFile,
  type UnifiedDiffModel,
} from './DiffRows'
import { GitHistoryList } from './GitHistoryList'
import {
  GIT_DIFF_MODE_LABELS,
  SESSION_FEATURE_FILES_TIMEOUT_MS,
  formatSessionFeatureTime,
  normalizedSessionFilePath,
  sessionFileMatches,
  type GitCommit,
  type GitCommitDiff,
  type GitDiffMode,
  type SessionFileFeature,
  type SessionGitDiff,
} from './types'
import { useGitHistory } from './useGitHistory'

type DiffSelection = { start: number; end: number }
type GitViewerTab = 'changes' | 'history'

function fileTarget(path: string, line?: number | null, endLine?: number | null) {
  const target = targetFromTrustedPath(path, { intent: 'preview', source: 'diff' })
  return target ? { ...target, line: line ?? null, endLine: endLine ?? null } : null
}

function DiffKindBadges({ model }: { model: UnifiedDiffModel }) {
  const labels = [
    model.renamed ? 'rename' : '',
    model.added ? 'new' : '',
    model.deleted ? 'delete' : '',
    model.binary ? 'binary' : '',
  ].filter(Boolean)
  if (!labels.length) return null
  return <>{labels.map(label => <span key={label} className="git-changes-viewer__badge">{label}</span>)}</>
}

function samePath(left: string, right: string) {
  return normalizedSessionFilePath(left) === normalizedSessionFilePath(right)
}

export function GitChangesViewer({
  sessionId,
  projectId,
  initialView,
  initialPath,
  initialLine,
  endLine,
  trigger,
  sourceLabel,
  suspended = false,
  fallbackFocusRef,
  onReturnToPreview,
  onClose,
  onOpenArtifact,
}: {
  sessionId?: string | null
  projectId: string
  initialView?: GitViewerTab
  initialPath?: string | null
  initialLine?: number | null
  endLine?: number | null
  trigger?: HTMLElement | null
  sourceLabel?: string
  suspended?: boolean
  fallbackFocusRef?: RefObject<HTMLElement>
  onReturnToPreview?: () => void
  onClose: () => void
  onOpenArtifact?: (request: CodeArtifactOpenRequest) => void
}) {
  const [activeView, setActiveView] = useState<GitViewerTab>(initialView || (sessionId ? 'changes' : 'history'))
  const [files, setFiles] = useState<SessionFileFeature[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [focusIndex, setFocusIndex] = useState(0)
  const [mode, setMode] = useState<GitDiffMode>('unstaged')
  const [loading, setLoading] = useState(!!sessionId)
  const [error, setError] = useState('')
  const [workspaceError, setWorkspaceError] = useState('')
  const [diff, setDiff] = useState<SessionGitDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState('')
  const [diffReloadKey, setDiffReloadKey] = useState(0)
  const [initialPathMissing, setInitialPathMissing] = useState(false)
  const [selection, setSelection] = useState<DiffSelection | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [historyFile, setHistoryFile] = useState('')
  const [selectedCommitSha, setSelectedCommitSha] = useState('')
  const [commitFiles, setCommitFiles] = useState<UnifiedDiffFile[]>([])
  const [commitFilesSha, setCommitFilesSha] = useState('')
  const [selectedCommitPath, setSelectedCommitPath] = useState('')
  const [commitDiffLoading, setCommitDiffLoading] = useState(false)
  const [commitDiffError, setCommitDiffError] = useState('')
  const [commitDiffReloadKey, setCommitDiffReloadKey] = useState(0)
  const [commitFileDiff, setCommitFileDiff] = useState<GitCommitDiff | null>(null)
  const [commitFileDiffLoading, setCommitFileDiffLoading] = useState(false)
  const [commitFileDiffError, setCommitFileDiffError] = useState('')
  const [commitFileDiffReloadKey, setCommitFileDiffReloadKey] = useState(0)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const fileButtonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectionAnchorRef = useRef<number | null>(null)
  const initialSelectionAppliedRef = useRef(false)
  const lastInitialPathRef = useRef<string | null | undefined>(undefined)
  const commitRequestTokenRef = useRef(0)
  const commitFileRequestTokenRef = useRef(0)
  const filesRequestTokenRef = useRef(0)
  const filesAbortRef = useRef<AbortController | null>(null)

  const history = useGitHistory({
    projectId,
    file: historyFile || null,
    enabled: activeView === 'history',
  })

  const selectedCommit = useMemo(
    () => history.commits.find(commit => commit.hash === selectedCommitSha) || null,
    [history.commits, selectedCommitSha],
  )
  const selectedCommitFile = useMemo(
    () => commitFiles.find(file => samePath(file.path, selectedCommitPath)) || null,
    [commitFiles, selectedCommitPath],
  )

  const exit = useCallback(() => {
    if (onReturnToPreview) onReturnToPreview()
    else onClose()
    window.requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus()
      else fallbackFocusRef?.current?.focus()
    })
  }, [fallbackFocusRef, onClose, onReturnToPreview, trigger])

  useLayoutEffect(() => {
    if (!suspended) titleRef.current?.focus()
  }, [suspended])

  useEffect(() => {
    if (suspended) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (selection) {
        setSelection(null)
        selectionAnchorRef.current = null
        setAnnouncement('已清除 Diff 行选区')
        return
      }
      exit()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [exit, selection, suspended])

  const selectedFile = useMemo(
    () => files.find(file => sessionFileMatches(file, selectedPath)) || null,
    [files, selectedPath],
  )

  const loadFiles = useCallback(async () => {
    if (!sessionId) {
      setLoading(false)
      return
    }
    filesAbortRef.current?.abort()
    const controller = new AbortController()
    filesAbortRef.current = controller
    const token = ++filesRequestTokenRef.current
    const timeout = window.setTimeout(() => controller.abort(), SESSION_FEATURE_FILES_TIMEOUT_MS)
    setLoading(true)
    setError('')
    const applyInitialPath = lastInitialPathRef.current !== initialPath
    lastInitialPathRef.current = initialPath
    try {
      const data = await api(`/api/sessions/${sessionId}/features/files`, { signal: controller.signal })
      if (token !== filesRequestTokenRef.current) return
      const nextFiles: SessionFileFeature[] = Array.isArray(data?.files) ? data.files : []
      setFiles(nextFiles)
      setWorkspaceError(typeof data?.workspace_error === 'string'
        ? sanitizeToolError(data.workspace_error, '当前工作目录不可用')
        : '')
      setSelectedPath(previous => {
        let nextPath = ''
        if (initialPath && applyInitialPath) {
          const matched = nextFiles.find(file => sessionFileMatches(file, initialPath))
          setInitialPathMissing(!matched)
          nextPath = matched?.path || ''
        } else if (previous && nextFiles.some(file => sessionFileMatches(file, previous))) {
          setInitialPathMissing(false)
          nextPath = previous
        } else if (initialPath) {
          const matched = nextFiles.find(file => sessionFileMatches(file, initialPath))
          setInitialPathMissing(!matched)
          nextPath = matched?.path || ''
        } else {
          setInitialPathMissing(false)
          nextPath = nextFiles[0]?.path || ''
        }
        const nextIndex = Math.max(0, nextFiles.findIndex(file => sessionFileMatches(file, nextPath)))
        setFocusIndex(nextIndex)
        return nextPath
      })
    } catch (reason: any) {
      if (token !== filesRequestTokenRef.current) return
      setError(controller.signal.aborted
        ? '扫描超时，请稍后重试'
        : sanitizeToolError(reason, '读取文件修改清单失败'))
      setFiles([])
      setSelectedPath('')
      setInitialPathMissing(false)
    } finally {
      window.clearTimeout(timeout)
      if (token === filesRequestTokenRef.current) setLoading(false)
    }
  }, [initialPath, sessionId])

  useEffect(() => {
    void loadFiles()
    return () => {
      filesRequestTokenRef.current += 1
      filesAbortRef.current?.abort()
      filesAbortRef.current = null
    }
  }, [loadFiles])

  useEffect(() => {
    initialSelectionAppliedRef.current = false
  }, [endLine, initialLine, initialPath])

  useEffect(() => {
    if (activeView === 'changes' && !loading && initialPath && selectedFile) fileButtonRefs.current[focusIndex]?.focus()
  }, [activeView, focusIndex, initialPath, loading, selectedFile])

  useEffect(() => {
    setSelection(null)
    selectionAnchorRef.current = null
    if (!sessionId || !selectedPath) {
      setDiff(null)
      setDiffError('')
      setDiffLoading(false)
      return
    }
    const controller = new AbortController()
    setDiff(null)
    setDiffLoading(true)
    setDiffError('')
    const url = `/api/sessions/${sessionId}/features/git-diff?file=${encodeURIComponent(selectedPath)}&mode=${mode}`
    api(url, { signal: controller.signal })
      .then((data: any) => {
        if (controller.signal.aborted) return
        const first = Array.isArray(data?.diffs) ? data.diffs[0] : null
        setDiff(first || null)
        if (first && first.ok === false && first.fallback_content == null) {
          setDiffError(sanitizeToolError(first.error, '读取 diff 失败'))
        }
      })
      .catch((reason: any) => {
        if (controller.signal.aborted) return
        setDiff(null)
        setDiffError(sanitizeToolError(reason, '读取 diff 失败'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setDiffLoading(false)
      })
    return () => controller.abort()
  }, [diffReloadKey, mode, selectedPath, sessionId])

  const diffModel = useMemo(
    () => diff?.diff ? parseUnifiedDiff(diff.diff, selectedFile?.path || selectedPath) : null,
    [diff?.diff, selectedFile?.path, selectedPath],
  )

  useEffect(() => {
    if (initialSelectionAppliedRef.current || !initialLine || !diffModel || !selectedFile || !initialPath || !sessionFileMatches(selectedFile, initialPath)) return
    const rangeEnd = endLine || initialLine
    const matched = diffModel.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        const line = row.newLine ?? row.oldLine
        return line !== null && line >= initialLine && line <= rangeEnd
      })
    initialSelectionAppliedRef.current = true
    if (!matched.length) return
    const next = { start: matched[0].index, end: matched[matched.length - 1].index }
    selectionAnchorRef.current = next.start
    setSelection(next)
    setAnnouncement(`已定位 Diff 中的 L${initialLine}${rangeEnd !== initialLine ? `–L${rangeEnd}` : ''}`)
  }, [diffModel, endLine, initialLine, initialPath, selectedFile])

  useEffect(() => {
    if (activeView !== 'history' || history.loading) return
    setSelectedCommitSha(previous => {
      if (history.commits.some(commit => commit.hash === previous)) return previous
      return history.commits[0]?.hash || ''
    })
  }, [activeView, history.commits, history.loading])

  useEffect(() => {
    setSelection(null)
    selectionAnchorRef.current = null
    if (activeView !== 'history' || !selectedCommit || !projectId) {
      setCommitFiles([])
      setCommitFilesSha('')
      setSelectedCommitPath('')
      setCommitDiffError('')
      setCommitDiffLoading(false)
      return
    }
    const controller = new AbortController()
    const requestToken = ++commitRequestTokenRef.current
    setCommitFiles([])
    setCommitFilesSha('')
    setSelectedCommitPath('')
    setCommitDiffLoading(true)
    setCommitDiffError('')
    api(`/api/projects/${projectId}/git-history/${selectedCommit.hash}/diff`, { signal: controller.signal })
      .then((data: GitCommitDiff) => {
        if (controller.signal.aborted || requestToken !== commitRequestTokenRef.current) return
        const nextFiles = splitUnifiedDiffFiles(data?.diff || '')
        setCommitFiles(nextFiles)
        setCommitFilesSha(selectedCommit.hash)
        const preferred = historyFile ? nextFiles.find(file => samePath(file.path, historyFile)) : null
        setSelectedCommitPath(preferred?.path || nextFiles[0]?.path || '')
      })
      .catch((reason: any) => {
        if (controller.signal.aborted || requestToken !== commitRequestTokenRef.current) return
        setCommitDiffError(sanitizeToolError(reason, '读取 commit 文件列表失败'))
      })
      .finally(() => {
        if (!controller.signal.aborted && requestToken === commitRequestTokenRef.current) setCommitDiffLoading(false)
      })
    return () => controller.abort()
  }, [activeView, commitDiffReloadKey, historyFile, projectId, selectedCommit])

  useEffect(() => {
    if (activeView !== 'history' || !selectedCommit || !selectedCommitFile || commitFilesSha !== selectedCommit.hash) {
      setCommitFileDiff(null)
      setCommitFileDiffError('')
      setCommitFileDiffLoading(false)
      return
    }
    const controller = new AbortController()
    const requestToken = ++commitFileRequestTokenRef.current
    setCommitFileDiff(null)
    setCommitFileDiffLoading(true)
    setCommitFileDiffError('')
    const query = new URLSearchParams({ file: selectedCommitFile.path })
    api(`/api/projects/${projectId}/git-history/${selectedCommit.hash}/diff?${query.toString()}`, { signal: controller.signal })
      .then((data: GitCommitDiff) => {
        if (controller.signal.aborted || requestToken !== commitFileRequestTokenRef.current) return
        setCommitFileDiff(data)
      })
      .catch((reason: any) => {
        if (controller.signal.aborted || requestToken !== commitFileRequestTokenRef.current) return
        setCommitFileDiffError(sanitizeToolError(reason, '读取该文件 diff 失败'))
      })
      .finally(() => {
        if (!controller.signal.aborted && requestToken === commitFileRequestTokenRef.current) setCommitFileDiffLoading(false)
      })
    return () => controller.abort()
  }, [activeView, commitFileDiffReloadKey, commitFilesSha, projectId, selectedCommit, selectedCommitFile])

  const commitFileDiffModel = useMemo(
    () => commitFileDiff?.diff ? parseUnifiedDiff(commitFileDiff.diff, selectedCommitFile?.path || selectedCommitPath) : null,
    [commitFileDiff?.diff, selectedCommitFile?.path, selectedCommitPath],
  )

  const selectFile = useCallback((file: SessionFileFeature, index: number) => {
    setInitialPathMissing(false)
    setSelectedPath(file.path)
    setFocusIndex(index)
    setAnnouncement(`已选择 ${file.display_path}，来源 ${GIT_DIFF_MODE_LABELS[mode]}`)
  }, [mode])

  const moveFileFocus = useCallback((nextIndex: number) => {
    if (!files.length) return
    const clamped = Math.max(0, Math.min(files.length - 1, nextIndex))
    setFocusIndex(clamped)
    window.requestAnimationFrame(() => fileButtonRefs.current[clamped]?.focus())
  }, [files.length])

  const onFileKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, file: SessionFileFeature, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveFileFocus(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveFileFocus(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      moveFileFocus(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      moveFileFocus(files.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      selectFile(file, index)
    }
  }

  const selectDiffRow = (index: number, extend: boolean) => {
    const anchor = extend && selectionAnchorRef.current !== null ? selectionAnchorRef.current : index
    if (!extend || selectionAnchorRef.current === null) selectionAnchorRef.current = index
    const next = { start: Math.min(anchor, index), end: Math.max(anchor, index) }
    setSelection(next)
    setAnnouncement(next.start === next.end ? '已选择 1 行 Diff' : `已选择 ${next.end - next.start + 1} 行 Diff`)
  }

  const selectedTarget = selectedFile
    ? fileTarget(
      selectedFile.path,
      initialPath && sessionFileMatches(selectedFile, initialPath) ? initialLine : null,
      initialPath && sessionFileMatches(selectedFile, initialPath) ? endLine : null,
    )
    : null
  const commitFileTarget = selectedCommitFile ? fileTarget(selectedCommitFile.path) : null

  const selectCommit = (commit: GitCommit) => {
    setSelectedCommitSha(commit.hash)
    setAnnouncement(`已选择 commit ${commit.short_hash || commit.hash.slice(0, 7)}`)
  }

  const selectView = (view: GitViewerTab) => {
    if (view === 'changes' && !sessionId) return
    setActiveView(view)
    setSelection(null)
    selectionAnchorRef.current = null
    setAnnouncement(view === 'changes' ? '已切换到当前变更' : '已切换到提交历史')
  }

  const showFileHistory = () => {
    if (!selectedCommitFile) return
    setHistoryFile(selectedCommitFile.path)
    setSelectedCommitSha('')
    setAnnouncement(`已切换到 ${selectedCommitFile.path} 的文件历史`)
  }

  return (
    <CodeArtifactOpenProvider onOpenArtifact={onOpenArtifact}>
      <div
        className={`git-changes-viewer workbench-layer-modal fixed inset-0 flex items-center justify-center${suspended ? ' git-changes-viewer--suspended' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-hidden={suspended || undefined}
        aria-labelledby="git-changes-viewer-title"
        {...(suspended ? { inert: '' } : {}) as any}
      >
        <button type="button" className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={exit} aria-label={onReturnToPreview ? '返回文件预览' : '关闭 Git 只读查看'} />
        <div className="relative flex h-[82vh] w-[min(1180px,94vw)] flex-col overflow-hidden rounded-2xl shadow-2xl" style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
          <header className="flex flex-shrink-0 items-center gap-3 border-b px-5 py-3" style={{ borderColor: 'var(--border-color)' }}>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {activeView === 'changes' ? <FileDiff className="h-4 w-4 flex-shrink-0 text-blue-400" strokeWidth={1.8} /> : <History className="h-4 w-4 flex-shrink-0 text-amber-400" strokeWidth={1.8} />}
              <h2 id="git-changes-viewer-title" ref={titleRef} tabIndex={-1} className="truncate text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Git 只读查看</h2>
              <span className="flex-shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                · {activeView === 'changes' ? `${files.length} 个本会话文件` : `${history.commits.length} 条提交`}
              </span>
              {sourceLabel && <span className="git-changes-viewer__badge">{sourceLabel}</span>}
              {history.repoName && activeView === 'history' && <span className="git-changes-viewer__badge">{history.repoName}</span>}
              {initialLine && activeView === 'changes' && <span className="git-changes-viewer__badge">L{initialLine}{endLine && endLine !== initialLine ? `–L${endLine}` : ''}</span>}
            </div>
            <button
              type="button"
              onClick={() => {
                if (activeView === 'changes') void loadFiles()
                else {
                  history.reload()
                  setCommitDiffReloadKey(key => key + 1)
                }
              }}
              disabled={activeView === 'changes' ? loading : history.loading}
              className="workbench-control-md inline-flex items-center gap-1.5 border px-2.5 text-[11px] disabled:opacity-40"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}
            >
              {(activeView === 'changes' ? loading : history.loading) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新
            </button>
            <button type="button" onClick={exit} className="workbench-control-md border px-2.5 text-[11px]" style={{ borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }}>
              {onReturnToPreview ? '返回预览' : '关闭'}
            </button>
          </header>

          {activeView === 'changes' && (error || workspaceError) && (
            <div className="workbench-status-danger mx-5 mt-3 flex items-center gap-3 rounded-[var(--radius-control)] border px-3 py-2 text-[12px]" role="alert">
              <span className="min-w-0 flex-1">{error || workspaceError}</span>
              <button type="button" onClick={() => void loadFiles()} disabled={loading} className="workbench-control-md inline-flex flex-shrink-0 items-center gap-1.5 border px-3 text-[11px]" style={{ borderColor: 'var(--status-danger-border)' }}>
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />重试扫描
              </button>
            </div>
          )}

          <div className="flex min-h-0 flex-1">
            <aside className="flex w-[34%] min-w-[260px] flex-col border-r" style={{ borderColor: 'var(--border-color)' }} aria-label="Git 变更与历史">
              <div className="grid grid-cols-2 gap-1 border-b p-3" role="tablist" aria-label="Git 查看模式" style={{ borderColor: 'var(--border-color)' }}>
                {(['changes', 'history'] as GitViewerTab[]).map(view => (
                  <button
                    key={view}
                    type="button"
                    role="tab"
                    aria-selected={activeView === view}
                    disabled={view === 'changes' && !sessionId}
                    title={view === 'changes' && !sessionId ? '当前变更需要从会话打开' : undefined}
                    onClick={() => selectView(view)}
                    className={`git-changes-viewer__source-tab${activeView === view ? ' git-changes-viewer__source-tab--active' : ''}`}
                  >
                    {view === 'changes' ? '变更' : '历史'}
                  </button>
                ))}
              </div>

              {activeView === 'changes' ? (
                <>
                  <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border-color)' }}>
                    <div className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>本会话文件</div>
                    <p className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>/features/files · Session JSONL 文件特征</p>
                    <div className="mt-3 text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>当前 diff source</div>
                    <div className="mt-1.5 flex gap-1" role="tablist" aria-label="当前 Git diff source">
                      {(['unstaged', 'staged'] as GitDiffMode[]).map(item => (
                        <button
                          key={item}
                          type="button"
                          role="tab"
                          aria-selected={mode === item}
                          className={`git-changes-viewer__source-tab${mode === item ? ' git-changes-viewer__source-tab--active' : ''}`}
                          onClick={() => {
                            setMode(item)
                            setSelection(null)
                            selectionAnchorRef.current = null
                            setAnnouncement(`已切换到${GIT_DIFF_MODE_LABELS[item]}变更`)
                          }}
                        >
                          {GIT_DIFF_MODE_LABELS[item]}
                        </button>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>当前仓库状态 · {mode === 'unstaged' ? '工作树' : 'index'}</p>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto p-3" role="listbox" aria-label="本会话修改文件">
                    {loading && <div className="flex items-center justify-center gap-2 py-10 text-[13px]" style={{ color: 'var(--text-muted)' }}><Loader2 className="h-4 w-4 animate-spin" />扫描中…</div>}
                    {!loading && files.length === 0 && !error && (
                      <div className="flex flex-col items-center gap-3 py-10 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
                        <span>暂无本会话文件记录</span>
                        <button type="button" onClick={() => void loadFiles()} className="workbench-control-md inline-flex items-center gap-1.5 border px-3 text-[11px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
                          <RefreshCw className="h-3.5 w-3.5" />重试扫描
                        </button>
                      </div>
                    )}
                    {!loading && files.map((file, index) => {
                      const active = sessionFileMatches(file, selectedPath)
                      return (
                        <button
                          key={file.path}
                          ref={element => { fileButtonRefs.current[index] = element }}
                          type="button"
                          role="option"
                          aria-selected={active}
                          tabIndex={focusIndex === index ? 0 : -1}
                          onFocus={() => setFocusIndex(index)}
                          onKeyDown={event => onFileKeyDown(event, file, index)}
                          onClick={() => selectFile(file, index)}
                          className={`git-changes-viewer__file${active ? ' git-changes-viewer__file--active' : ''}`}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={file.display_path}>{file.display_path}</span>
                            <span className="git-changes-viewer__count">{file.count}</span>
                          </span>
                          <span className="mt-1 block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{formatSessionFeatureTime(file.last_timestamp)}</span>
                        </button>
                      )
                    })}
                  </div>
                </>
              ) : (
                <>
                  <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border-color)' }}>
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 text-[11px] font-semibold text-[var(--text-primary)]">{historyFile ? '该文件历史' : '全部提交'}</div>
                      {historyFile && <button type="button" onClick={() => { setHistoryFile(''); setSelectedCommitSha('') }} className="text-[10px] font-medium text-[var(--accent-primary)] hover:underline">全部历史</button>}
                    </div>
                    {historyFile && <code className="mt-1 block truncate text-[10px] text-[var(--text-muted)]" title={historyFile}>{historyFile}</code>}
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <GitHistoryList
                      commits={history.commits}
                      selectedSha={selectedCommitSha}
                      file={historyFile || null}
                      loading={history.loading}
                      loadingMore={history.loadingMore}
                      error={history.error}
                      hasMore={history.hasMore}
                      onSelect={selectCommit}
                      onRetry={history.reload}
                      onLoadMore={history.loadMore}
                      onShowAll={() => { setHistoryFile(''); setSelectedCommitSha('') }}
                    />
                  </div>
                </>
              )}
            </aside>

            <main className="flex min-w-0 flex-1 flex-col">
              {activeView === 'changes' ? (
                initialPathMissing && !loading ? (
                  <div className="mx-auto flex max-w-lg flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                    <FileDiff className="h-7 w-7 text-[var(--text-muted)]" />
                    <div className="text-[13px] font-medium text-[var(--text-primary)]">该文件不是本会话修改</div>
                    <code className="max-w-full break-all rounded bg-[var(--surface-control)] px-2 py-1 text-[11px] text-[var(--text-secondary)]">{safeToolPathLabel(initialPath || '')}</code>
                    <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">这里只允许 Session JSONL 文件特征清单中的路径；文件仍可回到预览层查看。</p>
                    {onReturnToPreview && <button type="button" className="workbench-control-md border px-3 text-[12px]" style={{ borderColor: 'var(--border-strong)' }} onClick={exit}>返回文件预览</button>}
                  </div>
                ) : !selectedFile && !loading ? (
                  <div className="flex flex-1 items-center justify-center text-[13px]" style={{ color: 'var(--text-muted)' }}>请选择一个本会话文件</div>
                ) : selectedFile ? (
                  <>
                    <div className="flex min-h-10 flex-shrink-0 items-center gap-2 border-b px-4 py-1.5" style={{ borderColor: 'var(--border-color)', background: 'var(--modal-bg)' }}>
                      <div className="min-w-0 flex-1">{selectedTarget && <FileReferenceLink target={selectedTarget} showParent />}</div>
                      <span className="git-changes-viewer__badge">{GIT_DIFF_MODE_LABELS[mode]}</span>
                      {diffModel && <DiffKindBadges model={diffModel} />}
                      {diffLoading && <Loader2 className="h-4 w-4 animate-spin text-blue-400" />}
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto">
                      {diffError && (
                        <div className="workbench-status-danger m-4 rounded-[var(--radius-control)] border p-3 text-[12px]" role="alert">
                          <pre className="whitespace-pre-wrap">{diffError}</pre>
                          <button type="button" onClick={() => setDiffReloadKey(key => key + 1)} className="workbench-control-md mt-3 inline-flex items-center gap-1.5 border px-3 text-[11px]" style={{ borderColor: 'var(--status-danger-border)' }}>
                            <RefreshCw className="h-3.5 w-3.5" />重试当前 Diff
                          </button>
                        </div>
                      )}
                      {!diffLoading && !diffError && diff?.diff && diffModel?.hasHunks && (
                        <DiffRows model={diffModel} fallbackPath={selectedFile.path} selection={selection} onSelectRow={selectDiffRow} />
                      )}
                      {!diffLoading && !diffError && diff?.diff && diffModel && !diffModel.hasHunks && (
                        <div className="p-5">
                          <div className="workbench-panel border p-4 text-[12px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
                            <p>{unifiedDiffNoHunkMessage(diffModel)}</p>
                            {(diffModel.renamed || diffModel.added || diffModel.deleted) && <p className="mt-2 font-mono text-[11px]">{diffModel.oldPath || '/dev/null'} → {diffModel.newPath || '/dev/null'}</p>}
                          </div>
                          <DiffRows model={diffModel} fallbackPath={selectedFile.path} selection={selection} onSelectRow={selectDiffRow} />
                        </div>
                      )}
                      {!diffLoading && !diffError && (!diff || !diff.diff) && (
                        <div className="p-5">
                          <div className="workbench-panel border p-4" style={{ borderColor: 'var(--border-default)' }}>
                            <div className="text-[13px] font-medium text-[var(--text-primary)]">本会话改过，但当前工作树无该 diff</div>
                            <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">当前来源为「{GIT_DIFF_MODE_LABELS[mode]}」。不会自动回退到最近 commit；可切换来源，或查看当前文件。</p>
                            <div className="mt-3">{selectedTarget && <FileReferenceLink target={selectedTarget} showParent />}</div>
                            <button type="button" onClick={() => setDiffReloadKey(key => key + 1)} className="workbench-control-md mt-3 inline-flex items-center gap-1.5 border px-3 text-[11px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
                              <RefreshCw className="h-3.5 w-3.5" />重试当前来源
                            </button>
                            {diff?.fallback_error && <p className="mt-3 text-[11px] text-[var(--status-danger)]">当前文件不可读：{diff.fallback_error}</p>}
                          </div>
                          {diff?.fallback_content != null && (
                            <div className="mt-4 overflow-auto rounded-[var(--radius-panel)] border" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-base)' }}>
                              <div className="sticky top-0 border-b px-3 py-2 text-[10px] text-[var(--text-muted)]" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-base)' }}>当前文件内容</div>
                              <pre className="min-w-max whitespace-pre p-4 font-mono text-[11px] leading-[1.5] text-[var(--text-secondary)]">{diff.fallback_content || ' '}</pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                ) : null
              ) : !selectedCommit && !history.loading ? (
                <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-[var(--text-muted)]">{history.error ? '提交历史加载失败，请在左侧重试' : '请选择一个 commit'}</div>
              ) : selectedCommit ? (
                <>
                  <div className="flex flex-shrink-0 items-start gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-color)' }}>
                    <GitCommitHorizontal className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
                    <div className="min-w-0 flex-1">
                      <div className="break-words text-[13px] font-medium text-[var(--text-primary)]">{selectedCommit.subject || '(无提交信息)'}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[var(--text-muted)]">
                        <code title={selectedCommit.hash}>{selectedCommit.short_hash || selectedCommit.hash.slice(0, 7)}</code>
                        <span>{selectedCommit.author_name || 'unknown'}</span>
                        <time dateTime={selectedCommit.date}>{selectedCommit.relative_date || selectedCommit.date}</time>
                      </div>
                    </div>
                    {commitDiffLoading && <Loader2 className="h-4 w-4 animate-spin text-amber-400" />}
                  </div>
                  {commitDiffError ? (
                    <div className="workbench-status-danger m-4 rounded-[var(--radius-control)] border p-3 text-[12px]" role="alert">
                      <div className="whitespace-pre-wrap">{commitDiffError}</div>
                      <button type="button" onClick={() => setCommitDiffReloadKey(key => key + 1)} className="workbench-control-md mt-3 inline-flex items-center gap-1.5 border px-3 text-[11px]" style={{ borderColor: 'var(--status-danger-border)' }}><RefreshCw className="h-3.5 w-3.5" />重试 commit diff</button>
                    </div>
                  ) : !commitDiffLoading && commitFiles.length === 0 ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-[13px] text-[var(--text-muted)]">
                      <FileDiff className="h-7 w-7" />
                      <span>该 commit 没有可显示的文件 diff</span>
                      <button type="button" onClick={() => setCommitDiffReloadKey(key => key + 1)} className="workbench-control-md inline-flex items-center gap-1.5 border px-3 text-[11px]" style={{ borderColor: 'var(--border-default)' }}><RefreshCw className="h-3.5 w-3.5" />重新加载</button>
                    </div>
                  ) : (
                    <div className="flex min-h-0 flex-1">
                      <div className="w-[31%] min-w-[180px] overflow-y-auto border-r p-2" role="listbox" aria-label="该 commit 的文件" style={{ borderColor: 'var(--border-color)' }}>
                        {commitFiles.map(file => (
                          <button
                            key={`${file.oldPath || ''}:${file.newPath || ''}`}
                            type="button"
                            role="option"
                            aria-selected={samePath(file.path, selectedCommitPath)}
                            onClick={() => { setSelectedCommitPath(file.path); setSelection(null); selectionAnchorRef.current = null }}
                            className={`git-changes-viewer__file${samePath(file.path, selectedCommitPath) ? ' git-changes-viewer__file--active' : ''}`}
                          >
                            <span className="block truncate font-mono text-[11px]" title={file.path}>{file.path}</span>
                            {(file.model.renamed || file.model.added || file.model.deleted || file.model.binary) && <span className="mt-1 flex flex-wrap gap-1"><DiffKindBadges model={file.model} /></span>}
                          </button>
                        ))}
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col">
                        {selectedCommitFile && (
                          <div className="flex min-h-10 flex-shrink-0 items-center gap-2 border-b px-3 py-1.5" style={{ borderColor: 'var(--border-color)' }}>
                            <div className="min-w-0 flex-1">{commitFileTarget && <FileReferenceLink target={commitFileTarget} showParent />}</div>
                            <button type="button" onClick={historyFile && samePath(historyFile, selectedCommitFile.path) ? () => { setHistoryFile(''); setSelectedCommitSha('') } : showFileHistory} className="workbench-control-md border px-2.5 text-[11px]" style={{ borderColor: 'var(--border-default)', color: 'var(--accent-primary)' }}>
                              {historyFile && samePath(historyFile, selectedCommitFile.path) ? '全部历史' : '该文件历史'}
                            </button>
                            {commitFileDiffLoading && <Loader2 className="h-4 w-4 animate-spin text-blue-400" />}
                          </div>
                        )}
                        <div className="min-h-0 flex-1 overflow-auto">
                          {commitFileDiffError && (
                            <div className="workbench-status-danger m-4 rounded-[var(--radius-control)] border p-3 text-[12px]" role="alert">
                              <div className="whitespace-pre-wrap">{commitFileDiffError}</div>
                              <button type="button" onClick={() => setCommitFileDiffReloadKey(key => key + 1)} className="workbench-control-md mt-3 inline-flex items-center gap-1.5 border px-3 text-[11px]" style={{ borderColor: 'var(--status-danger-border)' }}><RefreshCw className="h-3.5 w-3.5" />重试该文件 diff</button>
                            </div>
                          )}
                          {!commitFileDiffLoading && !commitFileDiffError && commitFileDiff?.diff && commitFileDiffModel?.hasHunks && (
                            <DiffRows model={commitFileDiffModel} fallbackPath={selectedCommitFile?.path || selectedCommitPath} selection={selection} onSelectRow={selectDiffRow} />
                          )}
                          {!commitFileDiffLoading && !commitFileDiffError && commitFileDiff?.diff && commitFileDiffModel && !commitFileDiffModel.hasHunks && (
                            <div className="p-5">
                              <div className="workbench-panel border p-4 text-[12px] text-[var(--text-secondary)]" style={{ borderColor: 'var(--border-default)' }}>{unifiedDiffNoHunkMessage(commitFileDiffModel)}</div>
                              <DiffRows model={commitFileDiffModel} fallbackPath={selectedCommitFile?.path || selectedCommitPath} selection={selection} onSelectRow={selectDiffRow} />
                            </div>
                          )}
                          {!commitFileDiffLoading && !commitFileDiffError && selectedCommitFile && (!commitFileDiff || !commitFileDiff.diff) && (
                            <div className="flex min-h-full flex-col items-center justify-center gap-3 p-5 text-center text-[12px] text-[var(--text-muted)]">
                              <span>该 commit 中没有这个文件的 diff</span>
                              <button type="button" onClick={() => setCommitFileDiffReloadKey(key => key + 1)} className="workbench-control-md inline-flex items-center gap-1.5 border px-3 text-[11px]" style={{ borderColor: 'var(--border-default)' }}><RefreshCw className="h-3.5 w-3.5" />重新加载</button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-[var(--text-muted)]"><Loader2 className="h-4 w-4 animate-spin" />加载提交历史…</div>
              )}
            </main>
          </div>
          <div className="sr-only" aria-live="polite">{announcement}</div>
        </div>
      </div>
    </CodeArtifactOpenProvider>
  )
}
