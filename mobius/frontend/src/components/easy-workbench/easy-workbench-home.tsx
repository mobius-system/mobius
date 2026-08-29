import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Folder,
  LoaderCircle,
  Mic,
  Paperclip,
  Plus,
  Search,
  Send,
  Square,
  X,
} from 'lucide-react'
import { api, useStore } from '../../store'
import { timeAgo } from '../shell'
import { NewProjectModal } from '../modals'
import { HomeComposerAttachments, useHomeComposerAttachments } from './home-composer-attachments'
import { HomeModelHarnessSelect } from './home-model-harness-select'
import { useComposerInputLayout, useComposerMobileLayout } from './useComposerInputLayout'
import { useHomeVoiceInput } from './useHomeVoiceInput'
import { formatVoiceSeconds } from '../../services/assistant-voice'
import {
  ConversationCreationError,
  createDefaultConversation,
  type ConversationCreationCheckpoint,
} from '../../services/easy-workbench/create-conversation'
import {
  readLastHomeModel,
  readLastHomeProjectId,
  rememberLastHomeModel,
  rememberLastHomeProjectId,
} from '../../services/easy-workbench/home-composer-preferences'
import { logUiEvent } from '../../services/easy-workbench/ui-observability'
import {
  navigateToWorkbenchObject,
  prepareWorkbenchObjectNavigation,
  sessionNavigation,
} from '../../services/easy-workbench/workbench-navigation'

function sortProjects(items: any[]) {
  return [...items].sort((left, right) => {
    const leftActivity = Date.parse(left.last_session_activity_at || left.last_active || '') || 0
    const rightActivity = Date.parse(right.last_session_activity_at || right.last_active || '') || 0
    return rightActivity - leftActivity || String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN')
  })
}

export function EasyWorkbenchHome() {
  const params = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    user,
    projects,
    setProjects,
    currentProject,
    setCurrentProject,
    setCurrentIssue,
    setCurrentResearch,
    setCurrentSession,
    setCurrentTask,
  } = useStore()
  const userId = params.user || user?.id || ''
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [lastProjectId, setLastProjectId] = useState(readLastHomeProjectId)
  const [lastModel, setLastModel] = useState(readLastHomeModel)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [projectQuery, setProjectQuery] = useState('')
  const [showNewProject, setShowNewProject] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [submissionQueued, setSubmissionQueued] = useState(false)
  const [sendError, setSendError] = useState('')
  const [checkpoint, setCheckpoint] = useState<ConversationCreationCheckpoint | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const projectMenuRef = useRef<HTMLDivElement | null>(null)
  const projectMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const projectSearchRef = useRef<HTMLInputElement | null>(null)

  const invalidateCheckpoint = useCallback(() => {
    setSendError('')
    setCheckpoint(null)
  }, [])
  const {
    attachments,
    readyAttachments,
    anyUploading,
    isDraggingFiles,
    fileInputRef,
    openFilePicker,
    handleFileInputChange,
    handlePaste,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    retryAttachment,
    removeAttachment,
    clearAttachments,
  } = useHomeComposerAttachments({
    projectId: selectedProjectId,
    onAttachmentsChanged: invalidateCheckpoint,
  })
  const isMobile = useComposerMobileLayout()
  const composerLayout = useComposerInputLayout({
    textareaRef: composerRef,
    value: prompt,
    expanded: false,
    isMobile,
  })
  const appendVoiceTranscript = useCallback((text: string) => {
    setPrompt(current => current
      ? `${current}${/\s$/.test(current) ? '' : ' '}${text}`
      : text)
    invalidateCheckpoint()
    window.requestAnimationFrame(() => composerRef.current?.focus())
  }, [invalidateCheckpoint])
  const {
    state: voiceState,
    recordingSeconds,
    toggle: toggleVoiceRecording,
    cancel: cancelVoiceInput,
  } = useHomeVoiceInput({
    disabled: sending,
    onError: setSendError,
    onTranscript: appendVoiceTranscript,
  })
  const voiceBusy = voiceState === 'recording' || voiceState === 'transcribing'

  useEffect(() => {
    logUiEvent('home_arrived', { user_id: userId })
    setCurrentIssue(null)
    setCurrentResearch(null)
    setCurrentSession(null)
    setCurrentTask(null)
  }, [setCurrentIssue, setCurrentResearch, setCurrentSession, setCurrentTask, userId])

  const resetComposer = useCallback(() => {
    cancelVoiceInput()
    setPrompt('')
    setSendError('')
    setCheckpoint(null)
    setSubmissionQueued(false)
    clearAttachments()
    window.setTimeout(() => composerRef.current?.focus(), 0)
  }, [cancelVoiceInput, clearAttachments])

  useEffect(() => {
    window.addEventListener('mobius:new-conversation', resetComposer)
    return () => window.removeEventListener('mobius:new-conversation', resetComposer)
  }, [resetComposer])

  useEffect(() => {
    let cancelled = false
    setLoadingProjects(true)
    api('/api/projects?all=true')
      .then((result: any) => {
        if (cancelled) return
        setProjects(sortProjects(Array.isArray(result) ? result : (result?.projects || [])))
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingProjects(false) })
    return () => { cancelled = true }
  }, [setProjects])

  useEffect(() => {
    if (!projectMenuOpen) return
    const onOutsidePointer = (event: PointerEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node)) setProjectMenuOpen(false)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setProjectMenuOpen(false)
      setProjectQuery('')
      projectMenuButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onOutsidePointer)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', onOutsidePointer)
      document.removeEventListener('keydown', onEscape)
    }
  }, [projectMenuOpen])

  useEffect(() => {
    if (projectMenuOpen) window.requestAnimationFrame(() => projectSearchRef.current?.focus())
    else setProjectQuery('')
  }, [projectMenuOpen])

  const usableProjects = useMemo(
    () => projects.filter((project: any) => project.kind !== 'extension' && !project.hidden && !project.disabled),
    [projects],
  )
  const filteredProjects = useMemo(() => {
    const query = projectQuery.trim().toLowerCase()
    if (!query) return usableProjects
    return usableProjects.filter((project: any) => [project.name, project.description, project.id]
      .some(value => String(value || '').toLowerCase().includes(query)))
  }, [projectQuery, usableProjects])
  const selectedProject = useMemo(
    () => usableProjects.find((project: any) => project.id === selectedProjectId) || null,
    [selectedProjectId, usableProjects],
  )

  useEffect(() => {
    const requested = searchParams.get('project') || ''
    const next = requested && usableProjects.some((project: any) => project.id === requested)
      ? requested
      : lastProjectId && usableProjects.some((project: any) => project.id === lastProjectId)
        ? lastProjectId
        : currentProject && usableProjects.some((project: any) => project.id === currentProject.id)
          ? currentProject.id
          : usableProjects[0]?.id || ''
    if (next !== selectedProjectId) setSelectedProjectId(next)
  }, [currentProject, lastProjectId, searchParams, selectedProjectId, usableProjects])

  useEffect(() => setCurrentProject(selectedProject), [selectedProject, setCurrentProject])

  const selectProject = (projectId: string) => {
    prepareWorkbenchObjectNavigation()
    cancelVoiceInput()
    setProjectMenuOpen(false)
    setSelectedProjectId(projectId)
    setLastProjectId(projectId)
    rememberLastHomeProjectId(projectId)
    setSearchParams(projectId ? { project: projectId } : {}, { replace: true })
    clearAttachments()
    setCheckpoint(null)
    setSendError('')
    window.requestAnimationFrame(() => composerRef.current?.focus())
  }

  const onProjectCreated = (project: any) => {
    setShowNewProject(false)
    setProjects(sortProjects([project, ...projects.filter((item: any) => item.id !== project.id)]))
    setCurrentProject(project)
    selectProject(project.id)
  }

  const selectModel = useCallback((model: string) => {
    setSelectedModel(model)
    setLastModel(model)
    rememberLastHomeModel(model)
  }, [])

  const send = async () => {
    if (!selectedProjectId || sending) return
    if (voiceBusy) {
      setSendError(voiceState === 'recording' ? '请先停止录音并等待转写完成。' : '语音正在转写，请稍候。')
      return
    }
    if (anyUploading) {
      setSendError('附件仍在上传，请稍候…')
      return
    }
    if (!prompt.trim() && readyAttachments.length === 0) return
    if (!selectedModel) {
      setSendError('模型与 Harness 组合仍在加载或暂无可用组合')
      return
    }
    const submittedPrompt = prompt
    setSending(true)
    setSubmissionQueued(true)
    setSendError('')
    setPrompt('')
    try {
      const created = await createDefaultConversation({
        projectId: selectedProjectId,
        prompt: submittedPrompt,
        attachments: readyAttachments.map(attachment => ({
          kind: attachment.kind,
          path: attachment.remotePath || '',
        })),
        model: selectedModel,
        checkpoint,
      })
      logUiEvent('first_message_submitted', {
        project_id: selectedProjectId,
        issue_id: created.issueId,
        session_id: created.sessionId,
        model: selectedModel,
      })
      window.dispatchEvent(new CustomEvent('mobius:refresh-conversation-rail'))
      navigateToWorkbenchObject(navigate, sessionNavigation(userId, created.sessionId))
    } catch (reason) {
      setPrompt(previous => previous || submittedPrompt)
      setSubmissionQueued(false)
      if (reason instanceof ConversationCreationError) {
        setCheckpoint(reason.checkpoint)
        setSendError(reason.message)
      } else {
        setSendError(reason instanceof Error ? reason.message : '创建会话失败')
      }
    } finally {
      setSending(false)
    }
  }

  const hasSendableContent = !!prompt.trim() || readyAttachments.length > 0
  const canRequestSend = hasSendableContent && !anyUploading && !voiceBusy
  const voiceTip = voiceState === 'recording'
    ? `停止录音 ${formatVoiceSeconds(recordingSeconds)}`
    : voiceState === 'transcribing'
      ? '正在转写语音'
      : voiceState === 'error'
        ? '重新录制语音'
        : '语音输入'

  if (loadingProjects) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2" style={{ color: 'var(--text-muted)', background: 'var(--surface-messages)' }}>
        <LoaderCircle className="h-4 w-4 animate-spin" /> 加载项目…
      </div>
    )
  }

  if (usableProjects.length === 0) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center p-6" style={{ background: 'var(--surface-messages)' }}>
        <div className="workbench-panel w-full max-w-md border p-6 text-center" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}>
          <Folder className="mx-auto h-7 w-7" style={{ color: 'var(--text-muted)' }} />
          <h1 className="mt-4 text-[18px] font-semibold" style={{ color: 'var(--text-strong)' }}>创建第一个项目</h1>
          <p className="mt-2 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>创建或连接项目后，就可以直接告诉 Mobius 你想完成什么。</p>
          <button type="button" onClick={() => setShowNewProject(true)} className="workbench-control-md btn-primary mt-5 px-4 text-[12px] font-medium">新建项目</button>
        </div>
        {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} onCreated={onProjectCreated} />}
      </div>
    )
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-5 sm:p-8" style={{ background: 'var(--surface-messages)' }}>
      <div className="mx-auto flex min-h-full w-full max-w-[880px] flex-col justify-center py-8">
        <div className="mb-6 text-center">
          <h1 data-workbench-main-heading tabIndex={-1} className="text-[20px] font-semibold tracking-tight outline-none" style={{ color: 'var(--text-strong)' }}>想让 Mobius 做什么？</h1>
          <p className="mt-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>描述目标即可，任务详情和会话会自动创建。</p>
        </div>

        <div className="workbench-composer relative px-3 py-2.5" onPaste={handlePaste} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
          {isDraggingFiles && (
            <div className="pointer-events-none absolute inset-0 z-20 rounded-[var(--radius-composer,22px)] p-1" style={{ background: 'var(--surface-composer)' }}>
              <div className="flex h-full items-center justify-center rounded-[var(--radius-control)] border border-dashed" style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-strong)', background: 'var(--surface-active)' }}>
                <span className="text-[12px] font-medium">松开以添加附件</span>
              </div>
            </div>
          )}
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInputChange} />
          <HomeComposerAttachments attachments={attachments} onRemove={removeAttachment} onRetry={retryAttachment} />
          <textarea
            ref={composerRef}
            data-workbench-composer
            autoFocus
            value={prompt}
            disabled={sending}
            onChange={event => { setPrompt(event.target.value); invalidateCheckpoint() }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder="描述你的任务…"
            className="w-full resize-none bg-transparent px-2 py-1 text-[14px] leading-[1.5] outline-none"
            style={{
              height: composerLayout.height,
              minHeight: composerLayout.minHeight,
              maxHeight: composerLayout.maxHeight,
              overflowY: composerLayout.overflowY,
              color: 'var(--text-primary)',
            }}
          />
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 border-t pt-2" style={{ borderColor: 'color-mix(in srgb, var(--border-default) 72%, transparent)' }}>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <div ref={projectMenuRef} className="relative min-w-0">
                <button ref={projectMenuButtonRef} type="button" onClick={() => setProjectMenuOpen(open => !open)} aria-haspopup="menu" aria-expanded={projectMenuOpen}
                  className="home-composer-project-select workbench-control-md flex min-w-0 max-w-[260px] items-center gap-2 px-2.5 text-[12px] transition-colors hover:bg-[var(--surface-control-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  style={{ color: 'var(--text-secondary)', background: 'var(--surface-control)' }} title={selectedProject?.name || '选择项目'}>
                  <Folder className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{selectedProject?.name || '选择项目'}</span>
                  <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${projectMenuOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>
                {projectMenuOpen && (
                  <div role="menu" aria-label="选择项目" className="workbench-popover absolute left-0 top-[calc(100%+8px)] z-40 w-[300px] max-w-[calc(100vw-48px)] overflow-hidden p-2" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)' }}>
                    <div role="search" className="flex h-9 items-center gap-2 rounded-[var(--radius-control)] px-3" style={{ background: 'var(--input-bg)', color: 'var(--text-secondary)' }}>
                      <Search className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.8} aria-hidden="true" />
                      <input
                        ref={projectSearchRef}
                        value={projectQuery}
                        onChange={event => setProjectQuery(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            setProjectMenuOpen(false)
                            setProjectQuery('')
                            projectMenuButtonRef.current?.focus()
                          }
                        }}
                        placeholder="搜索项目名称、描述或 ID"
                        aria-label="搜索项目"
                        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] outline-none placeholder:text-[var(--text-muted)]"
                        style={{ color: 'var(--text-primary)' }}
                      />
                      {projectQuery && (
                        <button
                          type="button"
                          onClick={() => {
                            setProjectQuery('')
                            projectSearchRef.current?.focus()
                          }}
                          className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[var(--radius-control)] hover:bg-[var(--surface-control-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                          aria-label="清空项目搜索"
                          title="清空搜索"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <div className="mt-2 max-h-[240px] overflow-y-auto">
                      {filteredProjects.length === 0 ? (
                        <div className="px-3 py-7 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>没有匹配的项目</div>
                      ) : filteredProjects.map((project: any) => {
                        const active = project.id === selectedProjectId
                        return (
                          <button key={project.id} type="button" role="menuitemradio" aria-checked={active} data-active={active ? 'true' : 'false'} onClick={() => selectProject(project.id)} className="workbench-project-option flex min-h-9 w-full items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-left transition-colors hover:bg-[var(--surface-control-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]" title={project.name}>
                            <Folder className="h-3.5 w-3.5 flex-shrink-0" />
                            <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{project.name}</span>
                            {active && <Check className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} aria-hidden="true" />}
                          </button>
                        )
                      })}
                    </div>
                    <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-default)' }}>
                      <button type="button" role="menuitem" onClick={() => { setProjectMenuOpen(false); setProjectQuery(''); setShowNewProject(true) }} className="flex min-h-9 w-full items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-left text-[12px] font-semibold transition-colors hover:bg-[var(--surface-control-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]" style={{ color: 'var(--text-primary)' }}>
                        <Plus className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} aria-hidden="true" /> 新建项目
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <HomeModelHarnessSelect projectId={selectedProjectId} userId={user?.id || userId} lastRememberedModel={lastModel} projectDefaultModel={selectedProject?.default_model} value={selectedModel} onChange={selectModel} disabled={sending || !!checkpoint?.sessionId} />
            </div>
            <div className="flex items-center gap-2">
              <button type="button" data-home-composer-attachment-button onClick={openFilePicker} disabled={sending} className="composer-icon-btn inline-flex h-8 w-8 flex-shrink-0 items-center justify-center disabled:opacity-40" aria-label="选择附件" title="添加附件"><Paperclip className="h-4 w-4" strokeWidth={1.8} /></button>
              <button
                type="button"
                data-home-composer-voice-button
                onClick={toggleVoiceRecording}
                disabled={sending || voiceState === 'transcribing'}
                className={`composer-icon-btn home-composer-voice home-composer-voice--${voiceState} inline-flex h-8 w-8 flex-shrink-0 items-center justify-center disabled:opacity-40`}
                aria-label={voiceTip}
                aria-pressed={voiceState === 'recording'}
                title={voiceTip}
              >
                {voiceState === 'recording'
                  ? <Square className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true" />
                  : voiceState === 'transcribing'
                    ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                    : <Mic className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />}
              </button>
              <button type="button" onClick={() => void send()} disabled={!canRequestSend || !selectedModel || sending}
                aria-label={sending ? '正在开始会话' : anyUploading ? '附件仍在上传' : '发送'}
                title={sending ? '正在开始会话' : anyUploading ? '附件仍在上传，请稍候' : '发送'}
                className="home-composer-send inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border-0 p-0 disabled:opacity-40">
                {submissionQueued ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          <span className="sr-only" role="status" aria-live="polite">{voiceState === 'recording' ? `正在录音 ${formatVoiceSeconds(recordingSeconds)}` : voiceState === 'transcribing' ? '正在转写语音' : ''}</span>
        </div>

        {submissionQueued && <div className="mt-2 flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }} role="status" aria-live="polite"><span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: 'var(--status-running)' }} aria-hidden="true" />已提交，正在打开会话…</div>}
        {sendError && <div className="workbench-status-danger mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-control)] border px-3 py-2 text-[12px]"><span>{sendError}</span>{checkpoint && <button type="button" onClick={() => void send()} disabled={sending} className="flex-shrink-0 underline disabled:opacity-50">重试当前阶段</button>}</div>}

        <section className="mt-10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold" style={{ color: 'var(--text-secondary)' }}>最近项目</h2>
            <button type="button" onClick={() => navigate(`/u/${userId}`)} className="text-[11px] hover:underline" style={{ color: 'var(--text-muted)' }}>全部项目 →</button>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {usableProjects.slice(0, 3).map((project: any) => (
              <button key={project.id} type="button" onClick={() => selectProject(project.id)} className="home-recent-project workbench-panel min-w-0 border px-3 py-3 text-left transition-colors hover:bg-[var(--surface-control-hover)]" style={{ borderColor: project.id === selectedProjectId ? 'var(--border-strong)' : 'var(--border-default)', background: project.id === selectedProjectId ? 'var(--surface-active)' : 'var(--surface-card)' }}>
                <span className="block truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{project.name}</span>
                <span className="mt-1 block text-[10px]" style={{ color: 'var(--text-muted)' }}>最近活跃 {timeAgo(project.last_session_activity_at || project.last_active)}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
      {showNewProject && <NewProjectModal onClose={() => setShowNewProject(false)} onCreated={onProjectCreated} />}
    </div>
  )
}
