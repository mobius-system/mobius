import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { Copy, ExternalLink, FileDiff, FileQuestion, Loader2, Quote, RefreshCw, X } from 'lucide-react'
import { api } from '../../store'
import { buildVscodeUrl, fileIcon } from '../project-files'
import { useWorkbenchShellSlot } from '../workbench-shell'
import { codeLanguageFromPath, copyCodeText } from './CodeBlock'
import { highlightFileLines } from './highlight-file-lines'
import { safeToolPathLabel, sanitizeToolError } from '../session-tool-context'
import { FileWorkspaceTree } from './FileWorkspaceTree'
import {
  filePathSegments,
  formatFileTarget,
  resolveProjectRelativePath,
  withFileTargetRange,
  workspaceTabKey,
  type CodeArtifactOpenRequest,
  type CodeArtifactTarget,
} from './file-target'

type FilePreviewData = {
  path: string
  name: string
  abs_path?: string
  size: number
  content: string
  truncated: boolean
  binary: boolean
}

type FilePreviewMeta = {
  bindPath: string
  vscodeWorkspacePath: string
  vscodeWebUrl: string
}

type LineRange = { start: number; end: number }

type CachedPreview = {
  loading: boolean
  error: string
  data: FilePreviewData | null
  meta: FilePreviewMeta | null
  resolvedPath: string
  selectedRange: LineRange | null
  scrollTop: number
}

function restoreFocus(request: CodeArtifactOpenRequest, fallbackFocusRef?: RefObject<HTMLElement>) {
  window.requestAnimationFrame(() => {
    const trigger = request.trigger
    if (trigger?.isConnected) trigger.focus()
    else fallbackFocusRef?.current?.focus()
  })
}

function absoluteFilePath(meta: FilePreviewMeta | null, data: FilePreviewData | null, resolvedPath: string) {
  if (data?.abs_path) return data.abs_path
  if (!meta?.bindPath || !resolvedPath) return ''
  return `${meta.bindPath.replace(/[\\/]+$/, '')}/${resolvedPath.replace(/^[\\/]+/, '')}`
}

function lineRangeLabel(range: LineRange | null) {
  if (!range) return '全部行'
  return range.start === range.end ? `L${range.start}` : `L${range.start}–L${range.end}`
}

export function formatCodeReference(path: string, language: string, lines: string[], range: LineRange) {
  const snippet = lines.slice(range.start - 1, range.end).join('\n')
  const longestFence = Math.max(2, ...Array.from(snippet.matchAll(/`{3,}/g), match => match[0].length))
  const fence = '`'.repeat(longestFence + 1)
  return `${path}#L${range.start}-L${range.end}\n${fence}${language}\n${snippet}\n${fence}`
}

export function FilePreviewLayer({
  projectId,
  request,
  suspended = false,
  fallbackFocusRef,
  onClose,
  onViewDiff,
  onOpenEditor,
  onInsertReference,
}: {
  projectId: string
  request: CodeArtifactOpenRequest
  suspended?: boolean
  fallbackFocusRef?: RefObject<HTMLElement>
  onClose: () => void
  onViewDiff: (target: CodeArtifactTarget, trigger: HTMLElement | null) => void
  /** 仅在宿主启用了可定位的内部 CodeConversation 时提供。 */
  onOpenEditor?: (target: CodeArtifactTarget) => void
  onInsertReference: (reference: string) => void
}) {
  const [reloadKey, setReloadKey] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<FilePreviewData | null>(null)
  const [meta, setMeta] = useState<FilePreviewMeta | null>(null)
  const [resolvedPath, setResolvedPath] = useState('')
  const [copied, setCopied] = useState(false)
  const [selectedRange, setSelectedRange] = useState<LineRange | null>(null)
  const [tabs, setTabs] = useState<CodeArtifactOpenRequest[]>([request])
  const [activeKey, setActiveKey] = useState(() => workspaceTabKey(request.target))
  const [revealDir, setRevealDir] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const targetLineRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const selectionAnchorRef = useRef<number | null>(null)
  const draggingRef = useRef(false)
  const cacheRef = useRef(new Map<string, CachedPreview>())
  const fetchedKeysRef = useRef(new Set<string>())
  const prevActiveKeyRef = useRef(activeKey)
  const pendingLocateRef = useRef<{ key: string; start: number; end: number } | null>(
    request.target.line !== null
      ? { key: workspaceTabKey(request.target), start: request.target.line, end: request.target.endLine ?? request.target.line }
      : null,
  )
  const shouldScrollToTargetRef = useRef(request.target.line !== null)
  const previewSlot = useWorkbenchShellSlot('preview')
  const activeRequest = tabs.find(tab => workspaceTabKey(tab.target) === activeKey) || request
  const formatted = formatFileTarget(activeRequest.target)

  const rememberTab = useCallback((key: string, next: Partial<CachedPreview> = {}) => {
    const previous = cacheRef.current.get(key)
    cacheRef.current.set(key, {
      loading: next.loading ?? loading,
      error: next.error ?? error,
      data: next.data ?? data,
      meta: next.meta ?? meta,
      resolvedPath: next.resolvedPath ?? resolvedPath,
      selectedRange: next.selectedRange ?? selectedRange,
      scrollTop: next.scrollTop ?? bodyRef.current?.scrollTop ?? previous?.scrollTop ?? 0,
    })
  }, [data, error, loading, meta, resolvedPath, selectedRange])

  const openTab = useCallback((next: CodeArtifactOpenRequest) => {
    const key = workspaceTabKey(next.target)
    setTabs(previous => {
      const index = previous.findIndex(tab => workspaceTabKey(tab.target) === key)
      if (index < 0) return [...previous, next]
      const copy = [...previous]
      copy[index] = next
      return copy
    })
    if (next.target.line !== null) {
      pendingLocateRef.current = {
        key,
        start: next.target.line,
        end: next.target.endLine ?? next.target.line,
      }
      shouldScrollToTargetRef.current = true
    }
    setActiveKey(key)
  }, [])

  useEffect(() => {
    openTab(request)
  }, [openTab, request])

  const closeWorkspace = useCallback(() => {
    onClose()
    restoreFocus(activeRequest, fallbackFocusRef)
  }, [activeRequest, fallbackFocusRef, onClose])

  const closeTab = useCallback((key: string) => {
    setTabs(previous => {
      const index = previous.findIndex(tab => workspaceTabKey(tab.target) === key)
      if (index < 0) return previous
      const next = previous.filter((_, itemIndex) => itemIndex !== index)
      if (!next.length) {
        onClose()
        restoreFocus(activeRequest, fallbackFocusRef)
        return previous
      }
      if (key === activeKey) {
        const neighbor = next[index] || next[index - 1]
        setActiveKey(workspaceTabKey(neighbor.target))
      }
      return next
    })
  }, [activeKey, activeRequest, fallbackFocusRef, onClose])

  useLayoutEffect(() => {
    if (!suspended) headingRef.current?.focus()
  }, [suspended])

  useEffect(() => {
    if (prevActiveKeyRef.current === activeKey) return
    rememberTab(prevActiveKeyRef.current, { scrollTop: bodyRef.current?.scrollTop ?? 0 })
    prevActiveKeyRef.current = activeKey
  }, [activeKey, rememberTab])

  useEffect(() => {
    if (suspended) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeWorkspace()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [closeWorkspace, suspended])

  useEffect(() => {
    const stopDragging = () => { draggingRef.current = false }
    document.addEventListener('pointerup', stopDragging, true)
    document.addEventListener('pointercancel', stopDragging, true)
    return () => {
      document.removeEventListener('pointerup', stopDragging, true)
      document.removeEventListener('pointercancel', stopDragging, true)
    }
  }, [])

  useEffect(() => {
    const tabKey = workspaceTabKey(activeRequest.target)
    const cached = cacheRef.current.get(tabKey)
    if (cached && fetchedKeysRef.current.has(tabKey)) {
      setLoading(false)
      setError(cached.error)
      setData(cached.data)
      setMeta(cached.meta)
      setResolvedPath(cached.resolvedPath)
      setSelectedRange(cached.selectedRange)
      selectionAnchorRef.current = cached.selectedRange?.start ?? null
      window.requestAnimationFrame(() => {
        if (bodyRef.current && !pendingLocateRef.current) bodyRef.current.scrollTop = cached.scrollTop
      })
      return
    }

    const controller = new AbortController()
    setLoading(true)
    setError('')
    setData(null)
    setMeta(null)
    setResolvedPath('')
    setSelectedRange(null)
    selectionAnchorRef.current = null

    void (async () => {
      let readingFile = false
      try {
        const projectMeta = await api(`/api/projects/${encodeURIComponent(projectId)}/files?path=/`, { signal: controller.signal })
        const nextMeta = {
          bindPath: String(projectMeta?.bind_path || ''),
          vscodeWorkspacePath: String(projectMeta?.vscode_workspace_path || projectMeta?.bind_path || ''),
          vscodeWebUrl: String(projectMeta?.vscode_web_url || ''),
        }
        setMeta(nextMeta)
        const resolved = resolveProjectRelativePath(activeRequest.target, {
          bindPath: projectMeta?.bind_path,
          vscodeWorkspacePath: projectMeta?.vscode_workspace_path,
        })
        if (!resolved.ok) throw new Error(resolved.error)
        setResolvedPath(resolved.path)
        readingFile = true
        const file = await api(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(resolved.path)}`, { signal: controller.signal })
        const nextData = {
          path: String(file?.path || resolved.path),
          name: String(file?.name || formatted.basename),
          abs_path: typeof file?.abs_path === 'string' ? file.abs_path : undefined,
          size: Number(file?.size || 0),
          content: typeof file?.content === 'string' ? file.content : '',
          truncated: !!file?.truncated,
          binary: !!file?.binary,
        }
        setData(nextData)
        fetchedKeysRef.current.add(tabKey)
        cacheRef.current.set(tabKey, {
          loading: false,
          error: '',
          data: nextData,
          meta: nextMeta,
          resolvedPath: resolved.path,
          selectedRange: cacheRef.current.get(tabKey)?.selectedRange ?? null,
          scrollTop: cacheRef.current.get(tabKey)?.scrollTop ?? 0,
        })
      } catch (nextError: any) {
        if (controller.signal.aborted) return
        const message = sanitizeToolError(nextError, '读取文件失败')
        const nextErrorText = readingFile && /^(?:not found|http 404)$/i.test(message.trim())
          ? '项目里找不到这个文件'
          : message
        setError(nextErrorText)
        fetchedKeysRef.current.add(tabKey)
        cacheRef.current.set(tabKey, {
          loading: false,
          error: nextErrorText,
          data: null,
          meta: null,
          resolvedPath: '',
          selectedRange: null,
          scrollTop: 0,
        })
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [activeKey, activeRequest.target, formatted.basename, projectId, reloadKey])

  const lines = useMemo(() => data && !data.binary ? data.content.split('\n') : [], [data])
  const targetRange = useMemo(() => {
    if (!lines.length || activeRequest.target.line === null) return null
    const requestedStart = activeRequest.target.line
    const requestedEnd = activeRequest.target.endLine ?? requestedStart
    const start = Math.max(1, Math.min(lines.length, requestedStart))
    const end = Math.max(start, Math.min(lines.length, requestedEnd))
    return { requestedStart, requestedEnd, start, end, clamped: start !== requestedStart || end !== requestedEnd }
  }, [activeRequest.target.endLine, activeRequest.target.line, lines.length])

  useEffect(() => {
    const pending = pendingLocateRef.current
    if (pending && pending.key === activeKey && lines.length) {
      const start = Math.max(1, Math.min(lines.length, pending.start))
      const end = Math.max(start, Math.min(lines.length, pending.end))
      const nextRange = { start, end }
      setSelectedRange(nextRange)
      selectionAnchorRef.current = start
      pendingLocateRef.current = null
      shouldScrollToTargetRef.current = true
      rememberTab(activeKey, { selectedRange: nextRange })
      return
    }
    if (!targetRange || cacheRef.current.get(activeKey)?.selectedRange) return
    const initial = { start: targetRange.start, end: targetRange.end }
    setSelectedRange(initial)
    selectionAnchorRef.current = initial.start
    shouldScrollToTargetRef.current = true
  }, [activeKey, lines.length, rememberTab, targetRange])

  useLayoutEffect(() => {
    if (loading || suspended || !shouldScrollToTargetRef.current) return
    if (error) {
      errorRef.current?.focus()
      shouldScrollToTargetRef.current = false
      return
    }
    if (targetLineRef.current) {
      targetLineRef.current.scrollIntoView({ block: 'center', inline: 'nearest' })
      shouldScrollToTargetRef.current = false
    }
  }, [error, loading, selectedRange, suspended, targetRange])

  const language = codeLanguageFromPath(data?.path || resolvedPath || activeRequest.target.path)
  const highlightedLines = useMemo(
    () => data && !data.binary ? highlightFileLines(data.content, language) : [],
    [data, language],
  )
  const currentPath = data?.path || resolvedPath || safeToolPathLabel(activeRequest.target.path)
  const crumbs = filePathSegments(currentPath)
  const editorFilePath = absoluteFilePath(meta, data, resolvedPath)
  const editorUrl = meta?.vscodeWebUrl && meta.vscodeWorkspacePath && editorFilePath
    ? buildVscodeUrl(meta.vscodeWebUrl, meta.vscodeWorkspacePath, editorFilePath)
    : null

  const handleCopyPath = async () => {
    // 未经项目 API 解析的绝对路径不回显也不复制；成功解析后复制项目相对路径。
    const copyPath = resolvedPath || safeToolPathLabel(activeRequest.target.path)
    if (!await copyCodeText(copyPath)) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  const handleCopyContent = async () => {
    if (!data?.content || data.binary) return
    if (!await copyCodeText(data.content)) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  const viewDiff = (event: React.MouseEvent<HTMLButtonElement>) => {
    onViewDiff({ ...activeRequest.target, path: currentPath, intent: 'diff' }, event.currentTarget)
  }

  const selectLine = (lineNumber: number, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const anchor = event.shiftKey && selectionAnchorRef.current !== null
      ? selectionAnchorRef.current
      : lineNumber
    if (!event.shiftKey || selectionAnchorRef.current === null) selectionAnchorRef.current = lineNumber
    draggingRef.current = true
    setSelectedRange({ start: Math.min(anchor, lineNumber), end: Math.max(anchor, lineNumber) })
  }

  const extendSelection = (lineNumber: number, event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || (event.buttons & 1) !== 1 || selectionAnchorRef.current === null) return
    event.preventDefault()
    setSelectedRange({
      start: Math.min(selectionAnchorRef.current, lineNumber),
      end: Math.max(selectionAnchorRef.current, lineNumber),
    })
  }

  const insertReference = () => {
    if (!selectedRange || !lines.length) return
    onInsertReference(formatCodeReference(currentPath, language, lines, selectedRange))
  }

  const openEditor = () => {
    if (onOpenEditor) {
      const baseTarget = { ...activeRequest.target, path: currentPath }
      onOpenEditor(selectedRange
        ? withFileTargetRange(baseTarget, selectedRange.start, selectedRange.end)
        : baseTarget)
      return
    }
    if (!editorUrl) return
    window.open(editorUrl, '_blank', 'noopener,noreferrer')
  }

  const editorAvailable = !loading && !error && !!data && (!!onOpenEditor || !!editorUrl)
  const fileMissing = !loading && error === '项目里找不到这个文件'
  const editorTitle = loading
    ? '文件解析完成后可在编辑器打开'
    : error || !data
      ? '当前文件尚不可打开'
      : onOpenEditor
        ? `在内部编辑器打开${selectedRange ? ` ${lineRangeLabel(selectedRange)}` : '文件'}`
        : editorUrl
          ? '在 VSCode Web 打开文件'
          : '未启用内部编辑器，且未配置可用的 VSCode Web'

  const panel = (
      <section
        className={`code-artifact-preview${suspended ? ' code-artifact-preview--suspended' : ''}`}
        data-code-artifact-preview
        data-code-artifact-workspace
        role="dialog"
        aria-modal="false"
        aria-hidden={suspended || undefined}
        aria-labelledby="code-artifact-preview-title"
      >
        <div className="code-artifact-preview__chrome">
          <div className="code-artifact-preview__tabs" role="tablist" aria-label="已打开文件">
            {tabs.map(tab => {
              const key = workspaceTabKey(tab.target)
              const label = formatFileTarget(tab.target)
              const selected = key === activeKey
              return (
                <div key={key} className={`code-artifact-preview__tab${selected ? ' is-active' : ''}`}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className="code-artifact-preview__tab-button"
                    title={label.title}
                    onClick={() => setActiveKey(key)}
                  >
                    <span aria-hidden="true">{fileIcon(label.basename, 'file')}</span>
                    {label.basename}
                  </button>
                  <button
                    type="button"
                    className="code-artifact-preview__tab-close"
                    aria-label={`关闭 ${label.basename}`}
                    onClick={() => closeTab(key)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              )
            })}
            <div className="code-artifact-preview__tab-actions">
              <button type="button" className="code-artifact-preview__icon-button" onClick={() => void handleCopyContent()} disabled={loading || !!error || !!data?.binary} title={copied ? '已复制' : '复制文件内容'} aria-label={copied ? '已复制' : '复制文件内容'}>
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button type="button" className="code-artifact-preview__icon-button" onClick={insertReference} disabled={loading || !!error || !!data?.binary || !selectedRange} title={selectedRange ? `引用 ${lineRangeLabel(selectedRange)} 到 Composer` : '先选代码行再引用到 Composer'} aria-label="引用到 Composer">
                <Quote className="h-3.5 w-3.5" />
              </button>
              <button type="button" className="code-artifact-preview__icon-button" onClick={viewDiff} disabled={loading || !!error} title="查看本会话修改" aria-label="查看本会话修改">
                <FileDiff className="h-3.5 w-3.5" />
              </button>
              <button type="button" className="code-artifact-preview__icon-button" onClick={openEditor} disabled={!editorAvailable} title={editorTitle} aria-label="在编辑器打开">
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
              <button type="button" className="code-artifact-preview__icon-button" onClick={closeWorkspace} title="关闭文件工作台" aria-label="关闭文件工作台">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <header className="code-artifact-preview__header">
            <h2 id="code-artifact-preview-title" ref={headingRef} tabIndex={-1} className="sr-only">
              {currentPath}
            </h2>
            <nav className="code-artifact-preview__crumb" aria-label="文件路径">
              {crumbs.map((crumb, index) => (
                <span key={crumb.path} className="code-artifact-preview__crumb-item">
                  {index > 0 && <span aria-hidden="true">›</span>}
                  {crumb.isFile ? (
                    <span className="is-file" title={crumb.path}>{crumb.name}</span>
                  ) : (
                    <button type="button" title={crumb.path} onClick={() => setRevealDir(crumb.path)}>
                      {crumb.name}
                    </button>
                  )}
                </span>
              ))}
            </nav>
            <span className="sr-only" aria-live="polite">
              {!loading && !error && !data?.binary
                ? selectedRange ? `已选 ${lineRangeLabel(selectedRange)}` : '点击、Shift+点击或拖选代码行'
                : ''}
            </span>
          </header>
        </div>

        {data?.truncated && (
          <div className="code-artifact-preview__notice">文件超过 1.5MB，当前仅显示服务端返回的前部内容。</div>
        )}
        {targetRange?.clamped && (
          <div className="code-artifact-preview__notice">
            请求 L{targetRange.requestedStart}{targetRange.requestedEnd !== targetRange.requestedStart ? `–L${targetRange.requestedEnd}` : ''}，当前可用内容仅 {lines.length} 行；已定位到最近可用行。
          </div>
        )}

        <div className="code-artifact-preview__workspace">
        <div
          ref={bodyRef}
          className="code-artifact-preview__body"
          onScroll={event => rememberTab(activeKey, { scrollTop: event.currentTarget.scrollTop })}
        >
          {loading && (
            <div className="code-artifact-preview__state"><Loader2 className="h-5 w-5 animate-spin" />正在读取文件…</div>
          )}
          {!loading && error && (
            <div ref={errorRef} tabIndex={-1} className={`code-artifact-preview__error${fileMissing ? ' is-missing' : ''}`} role="alert">
              <div className="code-artifact-preview__error-heading">
                <FileQuestion className="h-5 w-5" aria-hidden="true" />
                <strong>{fileMissing ? '未找到文件' : '无法预览文件'}</strong>
              </div>
              <span>{fileMissing ? '该引用不是当前项目中的文件，可能是命令、旧路径，或文件已被移动。可从右侧项目文件中选择正确文件。' : error}</span>
              <code>{safeToolPathLabel(activeRequest.target.path)}</code>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="code-artifact-preview__action" onClick={() => {
                  fetchedKeysRef.current.delete(activeKey)
                  cacheRef.current.delete(activeKey)
                  setReloadKey(value => value + 1)
                }}>
                  <RefreshCw className="h-3.5 w-3.5" />重新读取
                </button>
                <button type="button" className="code-artifact-preview__action" onClick={() => void handleCopyPath()}>
                  <Copy className="h-3.5 w-3.5" />{copied ? '已复制' : '复制路径'}
                </button>
                <button type="button" className="code-artifact-preview__action" onClick={closeWorkspace}>
                  <X className="h-3.5 w-3.5" />关闭预览
                </button>
              </div>
            </div>
          )}
          {!loading && !error && data?.binary && (
            <div className="code-artifact-preview__state">这是二进制文件，内部预览不显示其内容。</div>
          )}
          {!loading && !error && data && !data.binary && (
            <div className="code-artifact-preview__lines" data-code-artifact-highlighted role="listbox" aria-label={`${data.name} 文件内容`} aria-multiselectable="true">
              {lines.map((_line, index) => {
                const lineNumber = index + 1
                const targeted = !!targetRange && lineNumber >= targetRange.start && lineNumber <= targetRange.end
                const selected = !!selectedRange && lineNumber >= selectedRange.start && lineNumber <= selectedRange.end
                const start = targetRange?.start === lineNumber
                return (
                  <div
                    key={lineNumber}
                    ref={start ? targetLineRef : undefined}
                    tabIndex={start ? -1 : undefined}
                    role="option"
                    aria-current={start ? 'location' : undefined}
                    aria-selected={selected}
                    className={`code-artifact-preview__line${targeted ? ' code-artifact-preview__line--target' : ''}${selected ? ' code-artifact-preview__line--selected' : ''}`}
                    onPointerDown={event => selectLine(lineNumber, event)}
                    onPointerEnter={event => extendSelection(lineNumber, event)}
                  >
                    <span className="code-artifact-preview__line-number" aria-hidden="true">{lineNumber}</span>
                    <code dangerouslySetInnerHTML={{ __html: highlightedLines[index] || ' ' }} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <FileWorkspaceTree
          projectId={projectId}
          activePath={currentPath}
          activeAbsPath={data?.abs_path}
          revealDir={revealDir}
          onOpenRequest={openTab}
        />
        </div>
      </section>
  )

  if (previewSlot) return createPortal(panel, previewSlot)

  return (
    <div className={`code-artifact-layer code-artifact-layer--docked workbench-layer-drawer${suspended ? ' code-artifact-layer--suspended' : ''}`}>
      {panel}
    </div>
  )
}
