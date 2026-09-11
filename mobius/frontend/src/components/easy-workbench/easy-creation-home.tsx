import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CheckCircle2, LoaderCircle, Puzzle, Send, Sparkles } from 'lucide-react'
import { api, useStore } from '../../store'
import { timeAgo } from '../shell'
import { HomeModelHarnessSelect } from './home-model-harness-select'
import { HomeProjectSelect } from './home-project-select'
import { openExtensionPanel } from './extension-panel'
import { useComposerInputLayout, useComposerMobileLayout } from './useComposerInputLayout'
import { logUiEvent } from '../../services/easy-workbench/ui-observability'
import {
  navigateToWorkbenchObject,
  sessionNavigation,
} from '../../services/easy-workbench/workbench-navigation'

const LAST_CREATION_HOME_PROJECT_ID_KEY = 'mobius:ui:creation-home:last-project-id'

function readLastCreationProjectId(): string {
  try { return localStorage.getItem(LAST_CREATION_HOME_PROJECT_ID_KEY)?.trim() || '' } catch { return '' }
}

function rememberLastCreationProjectId(projectId: string) {
  try { localStorage.setItem(LAST_CREATION_HOME_PROJECT_ID_KEY, String(projectId || '')) } catch {}
}

function conciseTitle(prompt: string) {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0]?.trim() || '拓展迭代'
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine
}

function sortCreationProjects(items: any[]) {
  return [...items].sort((left, right) => {
    const leftActivity = Date.parse(left.last_session_activity_at || left.last_active || '') || 0
    const rightActivity = Date.parse(right.last_session_activity_at || right.last_active || '') || 0
    return rightActivity - leftActivity || String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN')
  })
}

// 极简模式「我的创作」专属欢迎页 (项目欢迎页的同构变体, 项目默认就是拓展项目)。
// 输入内容都围绕所选拓展展开: 一句话即在该拓展项目下建 issue + 会话并发出首消息,
// 进入会话后右侧浏览器自动打开该拓展的预览页, 修改结果实时可见。
export function EasyCreationHome() {
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
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [submissionQueued, setSubmissionQueued] = useState(false)
  const [sendError, setSendError] = useState('')
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  const draftKey = `mobius:easy-creation-home-draft:${userId}`
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
    logUiEvent('creation_home_arrived', { user_id: userId })
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
        // 只看拓展项目: 我的创作的一切输入都围绕拓展本身展开。
        const extensionProjects = all.filter((project: any) => project?.kind === 'extension' && project?.id && !project.hidden && !project.disabled)
        setProjects(sortCreationProjects(extensionProjects))
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingProjects(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!projects.length) return
    const requested = searchParams.get('project') || ''
    const remembered = readLastCreationProjectId()
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

  // 拓展项目 id 即 ext_<name>, 预览面板直接按注册表名字开 (与左栏点拓展条目同链路)。
  const extensionName = selectedProject?.extension_name
    || String(selectedProject?.id || '').replace(/^ext_/, '')

  const selectProject = useCallback((projectId: string) => {
    setSelectedProjectId(projectId)
    rememberLastCreationProjectId(projectId)
    setSearchParams(projectId ? { view: 'creation', project: projectId } : { view: 'creation' }, { replace: true })
    setSendError('')
    window.requestAnimationFrame(() => composerRef.current?.focus())
  }, [setSearchParams])

  const selectModel = useCallback((model: string) => {
    setSelectedModel(model)
  }, [])

  const send = async () => {
    if (!selectedProjectId || sending) return
    if (!prompt.trim()) return
    if (!selectedModel) {
      setSendError('模型与 Harness 组合仍在加载或暂无可用组合')
      return
    }
    const goal = prompt
    const title = conciseTitle(goal)
    const extLabel = selectedProject?.name || extensionName
    setSending(true)
    setSubmissionQueued(true)
    setSendError('')
    setPrompt('')
    try {
      const issue: any = await api(`/api/projects/${encodeURIComponent(selectedProjectId)}/issues`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          description: `维护和迭代拓展 ${extLabel}: ${goal}`,
        }),
      })
      if (!issue?.id) throw new Error(issue?.error || '创建拓展任务失败')
      const session: any = await api(`/api/issues/${encodeURIComponent(issue.id)}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
          name: title,
          description: goal,
          model: selectedModel,
          language: 'zh',
          initial_message: {
            content: goal,
            request_id: `creation-home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            mentions: [],
          },
        }),
      })
      if (!session?.session_id) throw new Error(session?.error || '创建会话失败')
      logUiEvent('creation_first_message_submitted', {
        project_id: selectedProjectId,
        issue_id: issue.id,
        session_id: session.session_id,
        model: selectedModel,
      })
      window.dispatchEvent(new CustomEvent('mobius:refresh-conversation-rail'))
      // 进会话 + 右侧浏览器自动打开该拓展预览 (与左栏点拓展条目同体验)。
      // 会话页挂载需要时间, 事件早于监听器注册会被丢掉 → 短间隔重试派发,
      // 直至右栏真正展开 (openRightExtension 幂等, 重复派发无副作用)。
      navigateToWorkbenchObject(navigate, sessionNavigation(userId, session.session_id))
      const panelPayload = {
        name: extensionName,
        displayName: extLabel,
        url: `/extension/${encodeURIComponent(extensionName)}/`,
      }
      let attempts = 0
      const openPanelWhenReady = () => {
        openExtensionPanel(panelPayload)
        attempts += 1
        const opened = document.querySelector('[data-extension-panel][data-open="true"]')
        if (!opened && attempts < 20) window.setTimeout(openPanelWhenReady, 300)
      }
      window.setTimeout(openPanelWhenReady, 250)
    } catch (reason) {
      setPrompt(previous => previous || goal)
      setSubmissionQueued(false)
      setSendError(reason instanceof Error ? reason.message : '创建拓展会话失败')
    } finally {
      setSending(false)
    }
  }

  if (loadingProjects) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2" style={{ color: 'var(--text-muted)', background: 'var(--surface-messages)' }}>
        <LoaderCircle className="h-4 w-4 animate-spin" /> 加载拓展项目…
      </div>
    )
  }

  if (projects.length === 0) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center p-6" style={{ background: 'var(--surface-messages)' }}>
        <div className="workbench-panel w-full max-w-md border p-6 text-center" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}>
          <Puzzle className="mx-auto h-7 w-7" style={{ color: 'var(--text-muted)' }} />
          <h1 className="mt-4 text-[18px] font-semibold" style={{ color: 'var(--text-strong)' }}>还没有拓展项目</h1>
          <p className="mt-2 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>新建一个拓展项目后，就能在这里一句话让 Mobius 迭代它，右侧实时预览修改结果。</p>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('mobius:open-create', { detail: { kind: 'project', projectKind: 'extension' } }))}
            className="workbench-control-md btn-primary mt-5 px-4 text-[12px] font-medium"
          >
            新建拓展项目
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-5 sm:p-8" style={{ background: 'var(--surface-messages)' }}>
      <div className="mx-auto flex min-h-full w-full max-w-[880px] flex-col justify-center py-8">
        <div className="mb-6 text-center">
          <h1 data-workbench-main-heading tabIndex={-1} className="text-[20px] font-semibold tracking-tight outline-none" style={{ color: 'var(--text-strong)' }}>继续打磨你的创作</h1>
          <p className="mt-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>每一件创作都留在这里。一句话说出想改的，右侧实时看它成形。</p>
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
            placeholder={`描述要对「${selectedProject?.name || '拓展'}」做的修改…`}
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
                menuLabel="选择拓展项目"
                searchPlaceholder="搜索拓展项目名称、描述或 ID"
                newLabel="新建拓展项目"
                onNewProject={() => window.dispatchEvent(new CustomEvent('mobius:open-create', { detail: { kind: 'project', projectKind: 'extension' } }))}
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
              aria-label={sending ? '正在创建拓展会话' : '发送'}
              title={sending ? '正在创建拓展会话' : '发送'}
              className="home-composer-send inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border-0 p-0 disabled:opacity-40"
            >
              {submissionQueued ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {submissionQueued && <div className="mt-2 flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }} role="status" aria-live="polite"><span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: 'var(--status-running)' }} aria-hidden="true" />已提交，正在打开拓展会话…</div>}
        {sendError && <div className="workbench-status-danger mt-3 rounded-[var(--radius-control)] border px-3 py-2 text-[12px]"><span>{sendError}</span></div>}

        <section className="mt-10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold" style={{ color: 'var(--text-secondary)' }}>最近拓展</h2>
            {projects.length > 0 && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{selectedProject?.name || ''}</span>}
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {projects.slice(0, 3).map((project: any) => (
              <button
                key={project.id}
                type="button"
                onClick={() => selectProject(project.id)}
                className="workbench-panel min-w-0 border px-3 py-3 text-left transition-colors hover:bg-[var(--surface-control-hover)]"
                style={{ borderColor: project.id === selectedProjectId ? 'var(--border-strong)' : 'var(--border-default)', background: project.id === selectedProjectId ? 'var(--surface-active)' : 'var(--surface-card)' }}
              >
                <span className="block truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{project.name}</span>
                <span className="mt-1 block text-[10px]" style={{ color: 'var(--text-muted)' }}>最近活跃 {timeAgo(project.last_session_activity_at || project.last_active)}</span>
              </button>
            ))}
          </div>
          {projects.length === 0 && (
            <div className="workbench-panel border border-dashed px-4 py-6 text-center text-[12px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
              <Sparkles className="mx-auto mb-2 h-4 w-4" style={{ color: 'var(--text-muted)' }} />
              还没有拓展项目，从上面新建第一个。
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
