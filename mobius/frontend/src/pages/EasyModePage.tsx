import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Check, ChevronDown, CircleDot, FlaskConical, FolderOpen, History, MessageSquare, Plus, Search as SearchIcon } from 'lucide-react'
import { useStore, api } from '../store'
import { useLayoutMode } from '../services/layout-mode'
import { ChatArea } from '../components/chat'
import { GlobalCreateRoot, type CreateKind } from '../components/global-create'
import { ResizablePanel } from '../components/resizable-panel'
import { Loading, TopNav, timeAgoPrecise } from '../components/shell'

type RecentSession = {
  session_id: string
  name?: string
  project_id?: string | null
  project_name?: string | null
  issue_id?: string | null
  issue_title?: string | null
  research_id?: string | null
  research_title?: string | null
  scope_type?: 'issue' | 'research'
  agent_status?: string
  message_count?: number
  last_active?: string
  status?: string
  [key: string]: unknown
}

const RECENT_SESSION_LIMIT = 50

function normalizeRecent(value: unknown): RecentSession[] {
  return (Array.isArray(value) ? value : [])
    .filter((session: any) => session?.session_id && session?.status !== 'archived')
    .sort((a: any, b: any) => (
      new Date(b.last_active || 0).getTime() - new Date(a.last_active || 0).getTime()
    ))
    .slice(0, RECENT_SESSION_LIMIT)
}

function projectChipStyle(active: boolean): CSSProperties {
  return active
    ? {
        background: 'color-mix(in srgb, var(--accent-primary) 16%, transparent)',
        color: 'var(--accent-primary)',
        border: '1px solid color-mix(in srgb, var(--accent-primary) 40%, var(--border-color))',
      }
    : {
        background: 'transparent',
        color: 'var(--text-secondary)',
        border: '1px solid var(--border-color)',
      }
}

export default function EasyModePage() {
  const params = useParams()
  const [search, setSearch] = useSearchParams()
  const {
    projects,
    setProjects,
    currentSession,
    setCurrentProject,
    setCurrentIssue,
    setCurrentResearch,
    setCurrentSession,
    setCurrentTask,
  } = useStore()
  const [sessions, setSessions] = useState<RecentSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [projectFilterOpen, setProjectFilterOpen] = useState(false)
  const [projectFilterQuery, setProjectFilterQuery] = useState('')
  const [createKind, setCreateKind] = useState<CreateKind | null>(null)
  const navigate = useNavigate()
  const layoutMode = useLayoutMode()
  const sessionParam = search.get('session') || ''

  const projectOptions = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number; lastActive: number }>()
    for (const session of sessions) {
      if (!session.project_id) continue
      const lastActive = new Date(session.last_active || 0).getTime()
      const existing = map.get(session.project_id)
      if (existing) {
        existing.count += 1
        existing.lastActive = Math.max(existing.lastActive, lastActive)
      } else {
        map.set(session.project_id, {
          id: session.project_id,
          name: session.project_name || session.project_id,
          count: 1,
          lastActive,
        })
      }
    }
    return Array.from(map.values()).sort((a, b) => b.lastActive - a.lastActive)
  }, [sessions])

  const effectiveProject = selectedProject && projectOptions.some(project => project.id === selectedProject)
    ? selectedProject
    : null
  const selectedProjectOption = effectiveProject
    ? projectOptions.find(project => project.id === effectiveProject) || null
    : null
  const filteredProjectOptions = useMemo(() => {
    const q = projectFilterQuery.trim().toLowerCase()
    if (!q) return projectOptions
    return projectOptions.filter(project => (
      project.name.toLowerCase().includes(q) || project.id.toLowerCase().includes(q)
    ))
  }, [projectOptions, projectFilterQuery])
  const visibleSessions = effectiveProject
    ? sessions.filter(session => session.project_id === effectiveProject)
    : sessions
  const createDefaultProjectId = effectiveProject || (currentSession as RecentSession | null)?.project_id || undefined
  const createDefaultIssueId = (
    createDefaultProjectId &&
    (currentSession as RecentSession | null)?.project_id === createDefaultProjectId &&
    (currentSession as RecentSession | null)?.scope_type !== 'research'
  )
    ? (currentSession as RecentSession | null)?.issue_id || undefined
    : undefined

  useEffect(() => {
    if (!projectFilterOpen) return
    const close = () => setProjectFilterOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [projectFilterOpen])

  // 闭环修补：全局布局模式被切到非简易时（典型场景——另一个标签页切到了常规模式，
  // 或已选常规模式的用户直接落到 easy_mode 路径），本页不再适用，主动让位回用户主页，
  // 保持视图与全局模式一致。跨标签的 storage 事件只更新状态、不触发路由跳转，
  // 故必须由本页跟随离开，否则会停在「常规模式下显示简易页」的不一致态，刷新也不恢复。
  useEffect(() => {
    if (layoutMode && layoutMode !== 'easy_mode') {
      navigate(`/u/${params.user}`, { replace: true })
    }
  }, [layoutMode, params.user, navigate])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    Promise.all([
      api(`/api/tasks/recent?limit=${RECENT_SESSION_LIMIT}`),
      api('/api/projects?all=true'),
    ]).then(([recent, availableProjects]: any[]) => {
      if (cancelled) return
      setSessions(normalizeRecent(recent))
      if (Array.isArray(availableProjects)) setProjects(availableProjects)
    }).catch((err: any) => {
      if (cancelled) return
      setSessions([])
      setError(err?.message || '近期会话加载失败')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
    // 进入页面时只加载一次；projects 由并行请求补齐，不作为重新请求近期会话的触发条件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.user])

  // URL 中的 session 是简易模式唯一选择源。首次进入无参数时自动打开最近一条，
  // 从而保证 /easy_mode 本身就是一个可立即对话的主页。
  useEffect(() => {
    if (loading) return
    if (sessions.length === 0) {
      setCurrentSession(null)
      setCurrentTask(null)
      setCurrentProject(null)
      setCurrentIssue(null)
      setCurrentResearch(null)
      return
    }

    const selected = sessions.find(session => session.session_id === sessionParam) || sessions[0]
    if (!sessionParam || selected.session_id !== sessionParam) {
      const next = new URLSearchParams(search)
      next.set('session', selected.session_id)
      setSearch(next, { replace: true })
      return
    }

    if (currentSession?.session_id !== selected.session_id) {
      setCurrentSession(selected as any)
      setCurrentTask(selected as any)
    }
    const project = projects.find(item => item.id === selected.project_id)
    setCurrentProject(project || null)
    if (selected.scope_type === 'research' && selected.research_id) {
      setCurrentIssue(null)
      setCurrentResearch({
        id: selected.research_id,
        project_id: selected.project_id || '',
        title: selected.research_title || '研究',
      } as any)
    } else {
      setCurrentResearch(null)
      setCurrentIssue(selected.issue_id ? {
        id: selected.issue_id,
        project_id: selected.project_id || '',
        title: selected.issue_title || '任务',
      } as any : null)
    }
  }, [loading, sessions, sessionParam, projects, currentSession?.session_id, search, setSearch])

  const selectSession = (session: RecentSession) => {
    const next = new URLSearchParams(search)
    next.set('session', session.session_id)
    setSearch(next)
  }

  const selectProjectFilter = (projectId: string | null) => {
    setSelectedProject(projectId)
    setProjectFilterOpen(false)
    setProjectFilterQuery('')
  }

  return (
    <div className="flex h-screen flex-col" style={{ background: 'var(--bg-primary)' }} data-page="easy-mode">
      <TopNav />
      <div className="flex min-h-0 flex-1">
        <ResizablePanel
          storageKey="mobius:ui:sidebar:easy-mode-recent"
          defaultWidth={304}
          minWidth={232}
          maxWidth={460}
          side="left"
          className="flex flex-col border-r"
          style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}
        >
          <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border-color)' }}>
            <div className="flex items-center gap-2">
              <History className="h-4 w-4" style={{ color: 'var(--accent-primary)' }} />
              <h1 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>近期会话</h1>
              {!loading && (
                <span className="ml-auto rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
                  {sessions.length}
                </span>
              )}
            </div>

            <div className="mt-2 flex min-w-0 items-center gap-2">
              {projectOptions.length > 1 && (
                <div className="relative min-w-0 flex-1" data-testid="easy-project-filter">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      setProjectFilterOpen(value => !value)
                    }}
                    aria-haspopup="menu"
                    aria-expanded={projectFilterOpen}
                    className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md border px-2 text-left text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                    style={projectChipStyle(!!effectiveProject)}
                    title={selectedProjectOption?.name || '全部项目'}
                  >
                    <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{selectedProjectOption?.name || '全部项目'}</span>
                    <span className="flex-shrink-0 text-[10px] opacity-70">
                      {effectiveProject ? visibleSessions.length : `${projectOptions.length}项`}
                    </span>
                    <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${projectFilterOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {projectFilterOpen && (
                    <div
                      role="menu"
                      className="absolute left-0 right-0 top-9 z-50 rounded-lg p-1.5 shadow-xl"
                      style={{ background: 'var(--menu-bg)', border: '1px solid var(--border-color)' }}
                      onClick={event => event.stopPropagation()}
                    >
                      {projectOptions.length > 7 && (
                        <label className="mb-1 flex h-7 items-center gap-1.5 rounded-md border px-2" style={{ borderColor: 'var(--border-color)', background: 'var(--input-bg)' }}>
                          <SearchIcon className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                          <input
                            value={projectFilterQuery}
                            onChange={event => setProjectFilterQuery(event.target.value)}
                            placeholder="搜索项目"
                            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[11px] outline-none"
                            style={{ color: 'var(--text-primary)' }}
                            autoFocus
                          />
                        </label>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => selectProjectFilter(null)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                        style={{ color: 'var(--text-primary)', background: effectiveProject === null ? 'var(--bg-active)' : undefined }}
                      >
                        <span className="min-w-0 flex-1 truncate">全部项目</span>
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{sessions.length}</span>
                        {effectiveProject === null && <Check className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />}
                      </button>
                      <div className="mt-1 max-h-[232px] overflow-y-auto">
                        {filteredProjectOptions.length === 0 ? (
                          <div className="px-2 py-4 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>没有匹配项目</div>
                        ) : filteredProjectOptions.map(project => (
                          <button
                            key={project.id}
                            type="button"
                            role="menuitem"
                            onClick={() => selectProjectFilter(project.id)}
                            title={project.name}
                            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                            style={{ color: 'var(--text-primary)', background: effectiveProject === project.id ? 'var(--bg-active)' : undefined }}
                          >
                            <span className="min-w-0 flex-1 truncate">{project.name}</span>
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{project.count}</span>
                            {effectiveProject === project.id && <Check className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={() => setCreateKind('session')}
                data-testid="easy-new-session"
                className="inline-flex h-8 flex-shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold transition-colors hover:bg-[var(--bg-hover)]"
                style={{
                  borderColor: 'color-mix(in srgb, var(--accent-primary) 42%, var(--border-color))',
                  color: 'var(--accent-primary)',
                  background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                }}
                title="新建会话"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>新会话</span>
              </button>
            </div>

            <p className="mt-1.5 text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>
              {effectiveProject ? `仅显示 ${selectedProjectOption?.name || effectiveProject} 的近期会话` : '跨项目显示最近活跃的会话'}
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="easy-recent-sessions">
            {loading ? (
              <div className="px-3 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中...</div>
            ) : error ? (
              <div className="px-3 py-8 text-center text-[12px]" style={{ color: '#f87171' }}>{error}</div>
            ) : visibleSessions.length === 0 ? (
              <div className="px-3 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无近期会话</div>
            ) : visibleSessions.map(session => {
              const active = session.session_id === sessionParam
              const isResearch = session.scope_type === 'research'
              const subject = isResearch
                ? (session.research_title || session.research_id || '研究')
                : (session.issue_title || session.issue_id || '任务')
              return (
                <button
                  key={session.session_id}
                  type="button"
                  onClick={() => selectSession(session)}
                  className="mb-1 flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
                  style={{
                    borderColor: active ? 'color-mix(in srgb, var(--accent-primary) 42%, var(--border-color))' : 'transparent',
                    background: active ? 'var(--bg-active)' : undefined,
                  }}
                  data-session-id={session.session_id}
                  aria-current={active ? 'true' : undefined}
                >
                  <span
                    className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md"
                    style={{
                      background: isResearch ? 'rgba(168,85,247,0.14)' : 'rgba(59,130,246,0.14)',
                      color: isResearch ? '#c084fc' : '#60a5fa',
                    }}
                  >
                    {isResearch ? <FlaskConical className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-5" style={{ color: 'var(--text-primary)' }}>
                        {session.name || session.session_id}
                      </span>
                      <span
                        className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                        style={{ background: session.agent_status === 'running' ? '#f59e0b' : 'var(--text-muted)' }}
                      />
                    </span>
                    <span className="block truncate text-[10px] leading-4" style={{ color: 'var(--text-secondary)' }}>
                      {session.project_name || session.project_id || '项目'} / {subject}
                    </span>
                    <span className="mt-0.5 flex items-center gap-2 text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>
                      <span>{timeAgoPrecise(session.last_active || '')}</span>
                      <span className="inline-flex items-center gap-1"><MessageSquare className="h-3 w-3" />{session.message_count || 0}</span>
                    </span>
                  </span>
                  {active && <Check className="mt-1 h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />}
                </button>
              )
            })}
          </div>
        </ResizablePanel>

        {loading ? (
          <Loading text="正在加载近期会话..." />
        ) : currentSession ? (
          <ChatArea layout="easy" />
        ) : (
          <main className="flex min-w-0 flex-1 items-center justify-center" style={{ background: 'var(--bg-secondary)' }}>
            <div className="text-center">
              <History className="mx-auto mb-3 h-8 w-8" style={{ color: 'var(--text-muted)' }} />
              <div className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>暂无可打开的近期会话</div>
              <div className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>创建会话后会自动显示在这里</div>
            </div>
          </main>
        )}
      </div>
      {createKind && (
        <GlobalCreateRoot
          kind={createKind}
          ctx={{ projectId: createDefaultProjectId, issueId: createDefaultIssueId }}
          onClose={() => setCreateKind(null)}
          onNavigate={navigate}
        />
      )}
    </div>
  )
}
