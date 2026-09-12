import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CheckCircle2, FlaskConical, LoaderCircle, Send, Sparkles } from 'lucide-react'
import { api, useStore } from '../../store'
import { timeAgo } from '../shell'
import { HomeModelHarnessSelect } from './home-model-harness-select'
import { HomeProjectSelect } from './home-project-select'
import { useComposerInputLayout, useComposerMobileLayout } from './useComposerInputLayout'
import { logUiEvent } from '../../services/easy-workbench/ui-observability'
import {
  easyResearchNavigation,
  navigateToWorkbenchObject,
  sessionNavigation,
} from '../../services/easy-workbench/workbench-navigation'

const LAST_RESEARCH_HOME_PROJECT_ID_KEY = 'mobius:ui:research-home:last-project-id'

function readLastResearchProjectId(): string {
  try { return localStorage.getItem(LAST_RESEARCH_HOME_PROJECT_ID_KEY)?.trim() || '' } catch { return '' }
}

function rememberLastResearchProjectId(projectId: string) {
  try { localStorage.setItem(LAST_RESEARCH_HOME_PROJECT_ID_KEY, String(projectId || '')) } catch {}
}

function conciseTitle(prompt: string) {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.trim() || '专项研究'
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}

function sortResearchProjects(items: any[]) {
  return [...items].sort((left, right) => {
    const leftActivity = Date.parse(left.last_session_activity_at || left.last_active || '') || 0
    const rightActivity = Date.parse(right.last_session_activity_at || right.last_active || '') || 0
    return rightActivity - leftActivity || String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN')
  })
}

function sortResearches(items: any[]) {
  return [...items].sort((left, right) => {
    const leftActivity = Date.parse(left.last_active || left.created_at || '') || 0
    const rightActivity = Date.parse(right.last_active || right.created_at || '') || 0
    return rightActivity - leftActivity
  })
}

// 极简模式「专项团队」专属欢迎页 (项目欢迎页的同构变体)。
// 用户在这里只需写一句话: 创建一个 chief_led 团队并自动启动 Leader,
// 然后直接进入与 Leader 的会话; 后续招兵买马 / 完成任务由 Leader 自主推进。
export function EasyResearchHome() {
  const params = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    user,
    setCurrentProject,
    setCurrentIssue,
    setCurrentResearch,
    setCurrentSession,
    setCurrentTask,
  } = useStore()
  const userId = params.user || user?.id || ''

  const [loadingProjects, setLoadingProjects] = useState(true)
  const [projects, setProjects] = useState<any[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [recentResearches, setRecentResearches] = useState<any[]>([])
  const [loadingResearches, setLoadingResearches] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [submissionQueued, setSubmissionQueued] = useState(false)
  const [sendError, setSendError] = useState('')
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  const draftKey = `mobius:easy-research-home-draft:${userId}`
  const draftHydratedRef = useRef('')
  useEffect(() => {
    try { const saved = localStorage.getItem(draftKey); if (saved) setPrompt(saved) } catch {}
    draftHydratedRef.current = draftKey
  }, [draftKey])
  useEffect(() => {
    if (draftHydratedRef.current !== draftKey) return
    try { if (prompt.trim()) localStorage.setItem(draftKey, prompt); else localStorage.removeItem(draftKey) } catch {}
  }, [draftKey, prompt])

  const isMobile = useComposerMobileLayout()
  const composerLayout = useComposerInputLayout({
    textareaRef: composerRef,
    value: prompt,
    expanded: false,
    isMobile,
  })

  useEffect(() => {
    logUiEvent('research_home_arrived', { user_id: userId })
    setCurrentIssue(null)
    setCurrentResearch(null)
    setCurrentSession(null)
    setCurrentTask(null)
  }, [setCurrentIssue, setCurrentResearch, setCurrentSession, setCurrentTask, userId])

  useEffect(() => {
    let cancelled = false
    setLoadingProjects(true)
    api('/api/projects?all=true')
      .then((result: any) => {
        if (cancelled) return
        const all = Array.isArray(result) ? result : (result?.projects || [])
        const researchProjects = all.filter((project: any) => project?.research_enabled && project?.id)
        setProjects(sortResearchProjects(researchProjects))
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingProjects(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!projects.length) return
    const requested = searchParams.get('project') || ''
    const remembered = readLastResearchProjectId()
    const next = requested && projects.some((project: any) => project.id === requested)
      ? requested
      : remembered && projects.some((project: any) => project.id === remembered)
        ? remembered
        : projects[0].id
    if (next !== selectedProjectId) setSelectedProjectId(next)
  }, [projects, searchParams, selectedProjectId])

  const selectedProject = useMemo(
    () => projects.find(project => project.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  )

  useEffect(() => setCurrentProject(selectedProject), [selectedProject, setCurrentProject])

  const selectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId)
    rememberLastResearchProjectId(projectId)
    setSearchParams(projectId ? { view: 'research', project: projectId } : { view: 'research' }, { replace: true })
    setSendError('')
    window.requestAnimationFrame(() => composerRef.current?.focus())
  }, [setSearchParams])

  const selectModel = useCallback((model: string) => {
    setSelectedModel(model)
  }, [])

  useEffect(() => {
    if (!selectedProjectId) return
    let cancelled = false
    setLoadingResearches(true)
    api(`/api/projects/${encodeURIComponent(selectedProjectId)}/researches`)
      .then((rows: any) => {
        if (!cancelled) setRecentResearches(sortResearches(Array.isArray(rows) ? rows : []).slice(0, 3))
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingResearches(false) })
    return () => { cancelled = true }
  }, [selectedProjectId])

  const openResearch = useCallback((research: any) => {
    navigateToWorkbenchObject(navigate, easyResearchNavigation(userId, research.id, { projectId: research.project_id }))
  }, [navigate, userId])

  const send = async () => {
    if (!selectedProjectId || sending) return
    if (!prompt.trim()) return
    if (!selectedModel) {
      setSendError('模型与 Harness 组合仍在加载或暂无可用组合')
      return
    }
    const goal = prompt
    const title = conciseTitle(goal)
    setSending(true)
    setSubmissionQueued(true)
    setSendError('')
    setPrompt('')
    try {
      const research: any = await api(`/api/projects/${encodeURIComponent(selectedProjectId)}/researches`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          description: goal,
          mode: 'chief_led',
          assistant_limit: 3,
          chief: {
            name: `${title} Leader`,
            purpose: goal,
            initial_prompt: goal,
            model: selectedModel,
            language: 'zh',
            skill_ids: ['research-chief-agent'],
            memory_ids: [],
            memory_selection_confirmed: true,
          },
        }),
      })
      if (research?.error) throw new Error(research.error)
      const sessionId = research?.chief_session?.session_id
      if (!sessionId) throw new Error('团队已创建，但未能启动 Leader')
      logUiEvent('research_first_message_submitted', {
        project_id: selectedProjectId,
        research_id: research.id,
        session_id: sessionId,
        model: selectedModel,
      })
      window.dispatchEvent(new CustomEvent('mobius:refresh-conversation-rail'))
      navigateToWorkbenchObject(navigate, sessionNavigation(userId, sessionId, { sourceSurface: 'research' }))
    } catch (reason) {
      setPrompt(previous => previous || goal)
      setSubmissionQueued(false)
      setSendError(reason instanceof Error ? reason.message : '创建专项团队失败')
    } finally {
      setSending(false)
    }
  }

  if (loadingProjects) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2" style={{ color: 'var(--text-muted)', background: 'var(--surface-messages)' }}>
        <LoaderCircle className="h-4 w-4 animate-spin" /> 加载专项团队…
      </div>
    )
  }

  if (projects.length === 0) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center p-6" style={{ background: 'var(--surface-messages)' }}>
        <div className="workbench-panel w-full max-w-md border p-6 text-center" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}>
          <FlaskConical className="mx-auto h-7 w-7" style={{ color: 'var(--text-muted)' }} />
          <h1 className="mt-4 text-[18px] font-semibold" style={{ color: 'var(--text-strong)' }}>还没有研究项目</h1>
          <p className="mt-2 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>先新建一个启用研究系统的项目，之后就能直接和 Leader 对话，让它自动组队推进研究。</p>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('mobius:open-create', { detail: { kind: 'project', projectKind: 'research' } }))}
            className="workbench-control-md btn-primary mt-5 px-4 text-[12px] font-medium"
          >
            新建研究项目
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-5 sm:p-8" style={{ background: 'var(--surface-messages)' }}>
      <div className="mx-auto flex min-h-full w-full max-w-[880px] flex-col justify-center py-8">
        <div className="mb-6 text-center">
          <h1 data-workbench-main-heading tabIndex={-1} className="text-[20px] font-semibold tracking-tight outline-none" style={{ color: 'var(--text-strong)' }}>想让这个团队研究什么？</h1>
          <p className="mt-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>只需和 Leader 说清楚目标，它会自动招兵买马并推进任务。</p>
        </div>

        <div className="workbench-composer relative px-3 py-2.5">
          <textarea
            ref={composerRef}
            data-workbench-composer
            autoFocus
            value={prompt}
            disabled={sending}
            onChange={event => { setPrompt(event.target.value); setSendError('') }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder="描述这个团队要完成的研究…"
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
              <HomeProjectSelect
                projects={projects}
                selectedProjectId={selectedProjectId}
                onSelect={selectProject}
                menuLabel="选择研究项目"
                searchPlaceholder="搜索研究项目名称、描述或 ID"
                newLabel="新建研究项目"
                onNewProject={() => window.dispatchEvent(new CustomEvent('mobius:open-create', { detail: { kind: 'project', projectKind: 'research' } }))}
                disabled={sending}
              />
              <HomeModelHarnessSelect
                projectId={selectedProjectId}
                userId={user?.id || userId}
                lastRememberedModel=""
                projectDefaultModel={selectedProject?.default_model}
                value={selectedModel}
                onChange={selectModel}
                disabled={sending}
              />
            </div>
            <button
              type="button"
              onClick={() => void send()}
              disabled={!prompt.trim() || !selectedModel || sending}
              aria-label={sending ? '正在创建团队' : '交给 Leader'}
              title={sending ? '正在创建团队' : '交给 Leader'}
              className="home-composer-send inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border-0 p-0 disabled:opacity-40"
            >
              {submissionQueued ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {submissionQueued && <div className="mt-2 flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }} role="status" aria-live="polite"><span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: 'var(--status-running)' }} aria-hidden="true" />已提交，正在组建团队…</div>}
        {sendError && <div className="workbench-status-danger mt-3 rounded-[var(--radius-control)] border px-3 py-2 text-[12px]"><span>{sendError}</span></div>}

        <section className="mt-10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold" style={{ color: 'var(--text-secondary)' }}>最近专项团队</h2>
            {recentResearches.length > 0 && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{selectedProject?.name || ''}</span>}
          </div>
          {loadingResearches ? (
            <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}><LoaderCircle className="h-3.5 w-3.5 animate-spin" /> 加载团队…</div>
          ) : recentResearches.length === 0 ? (
            <div className="workbench-panel border border-dashed px-4 py-6 text-center text-[12px]" style={{ borderColor: 'var(--border-default)' }}>
              <Sparkles className="mx-auto mb-2 h-4 w-4" style={{ color: 'var(--text-muted)' }} />
              还没有专项团队，从上面创建第一个。
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-3">
              {recentResearches.map(research => (
                <button
                  key={research.id}
                  type="button"
                  onClick={() => openResearch(research)}
                  className="workbench-panel min-w-0 border px-3 py-3 text-left transition-colors hover:bg-[var(--surface-control-hover)]"
                  style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}
                >
                  <span className="block truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{research.title || research.id}</span>
                  <span className="mt-1 block text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {(research.session_count || 0) > 0 ? `${research.session_count} 个会话 · ` : ''}最近活跃 {timeAgo(research.last_active || research.created_at)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
