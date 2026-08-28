import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, Code2, Loader2, X } from 'lucide-react'
import { api, useStore } from '../store'
import { ChatArea } from '../components/chat'
import { Loading } from '../components/shell'
import { useEditorAvailability } from '../components/workspace/use-editor-availability'
import {
  focusWorkbenchTarget,
  homePath,
  readWorkbenchFocusTarget,
  readWorkbenchSourceSurface,
} from '../services/workbench-navigation'

const EditorPane = lazy(() => import('../components/workspace/editor-pane').then(module => ({ default: module.EditorPane })))

export default function WorkPage() {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const {
    projects, setProjects, currentProject, currentSession, setCurrentProject, setCurrentIssue,
    setCurrentResearch, setCurrentSession, setCurrentTask,
  } = useStore()
  const userId = params.user || ''
  const sessionId = params.session || ''
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState(0)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorMounted, setEditorMounted] = useState(false)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    setError('')
    api(`/api/tasks/${encodeURIComponent(sessionId)}`)
      .then(async (session: any) => {
        if (cancelled) return
        if (!session?.session_id) throw new Error('无法打开这个会话')
        const projectId = String(session.project_id || '')
        const researchId = String(session.research_id || '')
        const issueId = String(session.issue_id || '')
        const scopeType: 'issue' | 'research' = session.scope_type === 'research' || !!researchId ? 'research' : 'issue'
        setCurrentSession(session)
        setCurrentTask(session)
        let projectList = projects
        if (!projectList.length || !projectList.some((project: any) => project.id === projectId)) {
          try {
            const value = await api('/api/projects')
            projectList = Array.isArray(value) ? value : (value?.projects || [])
            if (!cancelled) setProjects(projectList)
          } catch {}
        }
        if (cancelled) return
        setCurrentProject(projectList.find((project: any) => project.id === projectId) || null)

        if (scopeType === 'research' && researchId) {
          setCurrentIssue(null)
          api(`/api/researches/${researchId}`).then((research: any) => {
            if (!cancelled && !research?.error) setCurrentResearch(research)
          }).catch(() => {})
        } else if (issueId) {
          setCurrentResearch(null)
          api(`/api/issues/${issueId}`).then((issue: any) => {
            if (!cancelled && !issue?.error) setCurrentIssue(issue)
          }).catch(() => {})
        }
      })
      .catch((reason: any) => {
        if (!cancelled) setError(reason?.message || '无法打开这个会话')
      })
    return () => { cancelled = true }
  }, [retryKey, sessionId])

  const activeSessionLoaded = currentSession?.session_id === sessionId
  const editorProjectId = activeSessionLoaded ? String((currentSession as any)?.project_id || '') : ''
  const editorProject = currentProject?.id === editorProjectId
    ? currentProject
    : projects.find((project: any) => project.id === editorProjectId)
  const editorAvailability = useEditorAvailability(editorProjectId, activeSessionLoaded && !!editorProjectId)
  const sessionToolOrigin = readWorkbenchSourceSurface(location.state) || 'session'
  const editorAvailable = !!editorProjectId && !!editorAvailability.bindPath && !!editorAvailability.vscodeWebUrl
  const editorUnavailableReason = editorAvailability.loading
    ? '正在检查项目路径与 Web 编辑器配置…'
    : !editorProjectId
      ? '当前 Session 没有关联项目，无法打开编辑器'
      : !editorAvailability.bindPath
        ? '需要先为项目绑定工作路径（bind path）'
        : !editorAvailability.vscodeWebUrl
          ? '需要后端配置并启动 code-server（VSCODE_WEB_URL）'
          : ''

  const openEditor = useCallback(() => {
    if (!editorAvailable) return
    setEditorMounted(true)
    setEditorOpen(true)
  }, [editorAvailable])

  const closeEditor = useCallback(() => {
    setEditorOpen(false)
    window.requestAnimationFrame(() => focusWorkbenchTarget('composer'))
  }, [])

  // 编辑器只在当前项目内保活。换项目时销毁旧 iframe，避免把上一项目的 tab
  // 带入新项目；同一 Session 内开关只 hidden，不卸载编辑器或 Chat。
  useEffect(() => {
    setEditorOpen(false)
    setEditorMounted(false)
  }, [editorProjectId])

  useEffect(() => {
    if (!editorOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[role="dialog"], [role="menu"], .workbench-popover, .workbench-layer-modal')) return
      event.preventDefault()
      closeEditor()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeEditor, editorOpen])

  useEffect(() => {
    if (!activeSessionLoaded) return
    const requestedFocus = readWorkbenchFocusTarget(location.state) || 'composer'
    const frame = window.requestAnimationFrame(() => focusWorkbenchTarget(requestedFocus))
    return () => window.cancelAnimationFrame(frame)
  }, [activeSessionLoaded, location.key, sessionId])

  return (
    <div
      className="workbench-session-split relative flex min-h-0 min-w-0 flex-1"
      data-workbench-chat-host
      data-editor-open={editorOpen ? 'true' : 'false'}
    >
      {/* 该宿主从 WorkPage 首次渲染起就固定在 Chat 前面。首次打开才挂载 iframe；
          关闭只 hidden + inert，因而 code-server 的文件选择和 tab 不会被重置。 */}
      <section
        hidden={!editorOpen}
        aria-hidden={!editorOpen}
        {...(!editorOpen ? { inert: '' } : {}) as any}
        className="workbench-session-editor min-h-0 min-w-0"
        data-workbench-editor-host
        data-open={editorOpen ? 'true' : 'false'}
        aria-label="项目编辑器"
      >
        <header className="workbench-session-editor__header flex flex-shrink-0 items-center gap-2 border-b px-3" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-base)' }}>
          <Code2 className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
          <div className="min-w-0 flex-1">
            <strong className="block truncate text-[12px]" style={{ color: 'var(--text-primary)' }}>编辑器</strong>
            <span className="block truncate text-[9px]" style={{ color: 'var(--text-muted)' }} title={editorProject?.name || editorProjectId}>
              {editorProject?.name || editorProjectId}
            </span>
          </div>
          <button
            type="button"
            onClick={closeEditor}
            className="workbench-control-md inline-flex w-8 flex-shrink-0 items-center justify-center hover:bg-[var(--surface-control-hover)]"
            style={{ color: 'var(--text-secondary)' }}
            aria-label="关闭编辑器，返回当前会话"
            title="关闭编辑器"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1" data-workbench-editor-kernel>
          {editorMounted && editorAvailable && (
            <Suspense fallback={(
              <div className="flex h-full items-center justify-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)', background: 'var(--surface-base)' }}>
                <Loader2 className="h-4 w-4 animate-spin" /> 正在加载编辑器…
              </div>
            )}>
              <EditorPane
                projectName={editorProject?.name || editorProjectId}
                bindPath={editorAvailability.bindPath}
                vscodeWebUrl={editorAvailability.vscodeWebUrl}
              />
            </Suspense>
          )}
        </div>
      </section>

      {/* 唯一 Chat 槽位始终存在且位置稳定；编辑器开关只改变相邻宿主的可见性。 */}
      <div className="workbench-session-chat min-h-0 min-w-0 flex-1" data-workbench-chat-instance="primary">
        <div
          hidden={!activeSessionLoaded}
          aria-hidden={!activeSessionLoaded}
          {...(!activeSessionLoaded ? { inert: '' } : {}) as any}
          className="workbench-session-chat__surface flex min-h-0 min-w-0 flex-1"
        >
          <ChatArea
            layout="easy"
            chrome="shell"
            toolOrigin={sessionToolOrigin}
            shellChromeActive={activeSessionLoaded}
            workspaceEditor={{
              available: editorAvailable,
              loading: editorAvailability.loading,
              open: editorOpen,
              unavailableReason: editorUnavailableReason,
              onOpen: openEditor,
            }}
          />
        </div>
        {!activeSessionLoaded && (error ? (
          <div className="flex min-w-0 flex-1 items-center justify-center p-6" style={{ background: 'var(--surface-raised)' }}>
            <div className="max-w-md text-center">
              <AlertTriangle className="mx-auto h-6 w-6" style={{ color: 'var(--status-danger)' }} />
              <div className="mt-3 text-[13px]" style={{ color: 'var(--text-primary)' }}>{error}</div>
              <div className="mt-4 flex justify-center gap-2">
                <button type="button" onClick={() => setRetryKey(key => key + 1)} className="workbench-control-md border px-4 text-[12px] hover:bg-[var(--surface-control-hover)]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}>重试加载</button>
                <button type="button" onClick={() => navigate(homePath(userId))} className="workbench-control-md border px-4 text-[12px] hover:bg-[var(--surface-control-hover)]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>回到主页</button>
              </div>
            </div>
          </div>
        ) : (
          <Loading text="正在还原会话上下文..." />
        ))}
      </div>
    </div>
  )
}
