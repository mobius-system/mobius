import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  FolderOpen,
  History,
  Loader2,
  MessageSquare,
  Plus,
  Search as SearchIcon,
  X,
} from 'lucide-react'
import { useStore, api } from '../store'
import { useLayoutMode, buildNormalModeTargetUrl } from '../services/layout-mode'
import { pollRecursive } from '../services/polling'
import { buildRecentSessionTreeGroups } from '../services/recent-session-tree'
import {
  EMPTY_PROJECT_HIERARCHY_SEARCH,
  hierarchyHitLabel,
  type ProjectHierarchyGroup,
  type ProjectHierarchyHit,
  type ProjectHierarchySearchResponse,
} from '../services/project-hierarchy-search'
import { ChatArea } from '../components/chat'
import { GlobalCreateRoot, type CreateKind } from '../components/global-create'
import { ResizablePanel } from '../components/resizable-panel'
import { SessionGroupTree } from '../components/session-group-tree'
import { Loading, TopNav, timeAgoPrecise } from '../components/shell'
import { ToastCard } from '../components/toast-card'

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

type ProjectOption = {
  id: string
  name: string
  count: number
  runningCount: number
  lastActive: number
}

type WorkView = 'recent' | 'running' | 'completed'

const RECENT_SESSION_LIMIT = 50
const CREATE_SUCCESS_TOAST_MS = 4000

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

function sessionStatus(session: RecentSession) {
  if (session.agent_status === 'running') return { label: '执行中', color: '#f59e0b', bg: 'rgba(245,158,11,.10)' }
  if (session.agent_status === 'pending') return { label: '启动中', color: '#fbbf24', bg: 'rgba(251,191,36,.10)' }
  if (session.agent_status === 'waiting') return { label: '待命', color: '#38bdf8', bg: 'rgba(56,189,248,.10)' }
  if (session.agent_status === 'completed' || session.status === 'completed') return { label: '已完成', color: '#34d399', bg: 'rgba(52,211,153,.10)' }
  return { label: '空闲', color: 'var(--text-muted)', bg: 'var(--bg-card)' }
}

function sessionMatchesView(session: RecentSession, view: WorkView) {
  if (view === 'running') return session.agent_status === 'running'
  if (view === 'completed') return session.agent_status === 'completed' || session.status === 'completed'
  return true
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
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [projectFilterOpen, setProjectFilterOpen] = useState(false)
  const [projectFilterQuery, setProjectFilterQuery] = useState('')
  const [sessionQuery, setSessionQuery] = useState('')
  const [hierarchySearch, setHierarchySearch] = useState<ProjectHierarchySearchResponse>(EMPTY_PROJECT_HIERARCHY_SEARCH)
  const [hierarchySearchLoading, setHierarchySearchLoading] = useState(false)
  const [hierarchySearchError, setHierarchySearchError] = useState('')
  const [openingSearchResult, setOpeningSearchResult] = useState('')
  const [lookupFailedSessionId, setLookupFailedSessionId] = useState('')
  const [createKind, setCreateKind] = useState<CreateKind | null>(null)
  const [createIssueOverride, setCreateIssueOverride] = useState('')
  const [createSuccessToast, setCreateSuccessToast] = useState<{ name: string } | null>(null)
  const [projectSuccessToast, setProjectSuccessToast] = useState<{ name: string } | null>(null)
  const [collapsedSessionGroups, setCollapsedSessionGroups] = useState<Set<string>>(() => new Set())
  const projectFilterButtonRef = useRef<HTMLButtonElement | null>(null)
  const navigate = useNavigate()
  const layoutMode = useLayoutMode()
  const sessionParam = search.get('session') || ''
  const projectParam = search.get('project') || ''
  const workView = (['recent', 'running', 'completed'].includes(search.get('view') || '')
    ? search.get('view')
    : 'recent') as WorkView

  const projectOptions = useMemo<ProjectOption[]>(() => {
    const activity = new Map<string, { count: number; runningCount: number; lastActive: number }>()
    for (const session of sessions) {
      if (!session.project_id) continue
      const current = activity.get(session.project_id) || { count: 0, runningCount: 0, lastActive: 0 }
      current.count += 1
      if (session.agent_status === 'running') current.runningCount += 1
      current.lastActive = Math.max(current.lastActive, new Date(session.last_active || 0).getTime())
      activity.set(session.project_id, current)
    }
    return projects
      .filter((project: any) => project?.id)
      .map((project: any) => {
        const recent = activity.get(project.id) || { count: 0, runningCount: 0, lastActive: 0 }
        return { id: project.id, name: project.name || project.id, ...recent }
      })
      .sort((a, b) => b.lastActive - a.lastActive || a.name.localeCompare(b.name, 'zh-CN'))
  }, [projects, sessions])

  const effectiveProject = projectParam && projectOptions.some(project => project.id === projectParam)
    ? projectParam
    : ''
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

  const projectSessions = effectiveProject
    ? sessions.filter(session => session.project_id === effectiveProject)
    : sessions
  const visibleSessions = useMemo(() => (
    projectSessions.filter(session => sessionMatchesView(session, workView))
  ), [projectSessions, workView])
  const visibleSessionGroups = useMemo(() => buildRecentSessionTreeGroups(visibleSessions), [visibleSessions])
  const normalizedSessionQuery = sessionQuery.trim().slice(0, 200)
  const activeHierarchySearch = hierarchySearch.query === normalizedSessionQuery
    ? hierarchySearch
    : { ...EMPTY_PROJECT_HIERARCHY_SEARCH, query: normalizedSessionQuery }

  const selectedSession = sessions.find(session => session.session_id === sessionParam) || null
  const contextMatchesProject = !!selectedSession && (!effectiveProject || selectedSession.project_id === effectiveProject)
  const createDefaultProjectId = effectiveProject || (currentSession as RecentSession | null)?.project_id || undefined
  const createDefaultIssueId = createIssueOverride || ((
    createDefaultProjectId &&
    (currentSession as RecentSession | null)?.project_id === createDefaultProjectId &&
    (currentSession as RecentSession | null)?.scope_type !== 'research'
  )
    ? (currentSession as RecentSession | null)?.issue_id || undefined
    : undefined)

  useEffect(() => {
    if (!projectFilterOpen) return
    const close = () => setProjectFilterOpen(false)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setProjectFilterOpen(false)
      projectFilterButtonRef.current?.focus()
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [projectFilterOpen])

  useEffect(() => {
    if (!normalizedSessionQuery) {
      setHierarchySearch(EMPTY_PROJECT_HIERARCHY_SEARCH)
      setHierarchySearchLoading(false)
      setHierarchySearchError('')
      return
    }
    const controller = new AbortController()
    setHierarchySearchLoading(true)
    setHierarchySearchError('')
    const timer = window.setTimeout(() => {
      api(`/api/projects/hierarchy-search?q=${encodeURIComponent(normalizedSessionQuery)}`, { signal: controller.signal })
        .then((result: ProjectHierarchySearchResponse) => setHierarchySearch(result))
        .catch((err: any) => {
          if (err?.name === 'AbortError') return
          setHierarchySearchError('全部工作搜索暂时不可用，请稍后重试')
        })
        .finally(() => {
          if (!controller.signal.aborted) setHierarchySearchLoading(false)
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [normalizedSessionQuery])

  useEffect(() => {
    if (!layoutMode || layoutMode === 'easy_mode') return
    if (loading) return
    const ctx = currentSession
      || (sessionParam ? sessions.find(session => session.session_id === sessionParam) : null)
      || sessions[0]
      || null
    navigate(
      buildNormalModeTargetUrl({
        user: params.user,
        projectId: ctx?.project_id,
        issueId: ctx?.issue_id,
        researchId: ctx?.research_id,
        scopeType: ctx?.scope_type ?? null,
        sessionId: ctx?.session_id || sessionParam || undefined,
      }),
      { replace: true },
    )
  }, [layoutMode, params.user, navigate, currentSession, sessions, sessionParam, loading])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    Promise.all([
      api(`/api/tasks/recent?limit=${RECENT_SESSION_LIMIT}`, { signal: controller.signal }),
      api('/api/projects?all=true', { signal: controller.signal }),
    ]).then(([recent, availableProjects]: any[]) => {
      setSessions(normalizeRecent(recent))
      if (Array.isArray(availableProjects)) setProjects(availableProjects)
    }).catch((err: any) => {
      if (err?.name === 'AbortError') return
      setSessions([])
      setError(err?.message || '工作导航加载失败，请稍后重试')
    }).finally(() => setLoading(false))
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.user])

  useEffect(() => pollRecursive(async (signal) => {
    if (document.visibilityState !== 'visible') return
    setRefreshing(true)
    try {
      const recent = await api(`/api/tasks/recent?limit=${RECENT_SESSION_LIMIT}`, { signal })
      setSessions((current) => {
        const next = normalizeRecent(recent)
        const selected = current.find(session => session.session_id === sessionParam)
        return selected && !next.some(session => session.session_id === selected.session_id)
          ? [selected, ...next]
          : next
      })
    } finally {
      setRefreshing(false)
    }
  }, 10_000, 10_000, { startImmediately: false }), [params.user, sessionParam])

  useEffect(() => {
    if (!createSuccessToast) return
    const timer = window.setTimeout(() => setCreateSuccessToast(null), CREATE_SUCCESS_TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [createSuccessToast])

  useEffect(() => {
    if (!projectSuccessToast) return
    const timer = window.setTimeout(() => setProjectSuccessToast(null), CREATE_SUCCESS_TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [projectSuccessToast])

  const handleSessionCreated = (session: RecentSession) => {
    setCreateSuccessToast({ name: session?.name || '新会话' })
    // 创建接口返回的对象可能不含项目/任务展示字段，立即重拉近期列表，避免用户等待
    // 下一轮 10 秒轮询才能在左栏看到新会话。
    api(`/api/tasks/recent?limit=${RECENT_SESSION_LIMIT}`)
      .then(recent => setSessions(current => {
        const next = normalizeRecent(recent)
        if (!session?.session_id || next.some(item => item.session_id === session.session_id)) return next
        return [session, ...next.filter(item => item.session_id !== session.session_id)].slice(0, RECENT_SESSION_LIMIT)
      }))
      .catch(() => {
        if (session?.session_id) {
          setSessions(current => [session, ...current.filter(item => item.session_id !== session.session_id)].slice(0, RECENT_SESSION_LIMIT))
        }
      })
  }

  // 全局搜索可以打开不在“最近 50 个”中的历史会话；刷新深链时也补拉该会话，
  // 避免 URL 中的有效 session 因近期列表未包含而被错误清除。
  useEffect(() => {
    if (loading || !sessionParam || sessions.some(session => session.session_id === sessionParam)) return
    if (lookupFailedSessionId === sessionParam) return
    const controller = new AbortController()
    api(`/api/tasks/${encodeURIComponent(sessionParam)}`, { signal: controller.signal })
      .then((session: RecentSession) => {
        if (!session?.session_id || session.status === 'archived') throw new Error('未找到可打开的会话')
        setSessions(current => [session, ...current.filter(item => item.session_id !== session.session_id)])
        setLookupFailedSessionId('')
      })
      .catch((err: any) => {
        if (err?.name !== 'AbortError') setLookupFailedSessionId(sessionParam)
      })
    return () => controller.abort()
  }, [loading, sessionParam, sessions, lookupFailedSessionId])

  // project + session 是简易模式的权威上下文。项目切换后，只能打开该项目的会话；
  // 若该项目在近期列表中没有会话，清空右侧并给出创建入口，绝不保留另一项目的上下文。
  useEffect(() => {
    if (loading) return
    if (sessionParam && !selectedSession && lookupFailedSessionId !== sessionParam) return
    if (projectParam && projectOptions.length > 0 && !effectiveProject) {
      const next = new URLSearchParams(search)
      next.delete('project')
      setSearch(next, { replace: true })
      return
    }

    const projectCandidates = effectiveProject
      ? sessions.filter(session => session.project_id === effectiveProject)
      : sessions
    const candidates = projectCandidates.filter(session => sessionMatchesView(session, workView))
    const orderedCandidates = buildRecentSessionTreeGroups(candidates).flatMap(group => group.sessions)
    const selected = orderedCandidates.find(session => session.session_id === sessionParam) || orderedCandidates[0] || null
    if (!selected) {
      if (sessionParam) {
        const next = new URLSearchParams(search)
        next.delete('session')
        setSearch(next, { replace: true })
      }
      setCurrentSession(null)
      setCurrentTask(null)
      setCurrentProject(effectiveProject ? projects.find(item => item.id === effectiveProject) || null : null)
      setCurrentIssue(null)
      setCurrentResearch(null)
      return
    }

    if (selected.session_id !== sessionParam || (!effectiveProject && selected.project_id && projectParam)) {
      const next = new URLSearchParams(search)
      next.set('session', selected.session_id)
      if (effectiveProject) next.set('project', effectiveProject)
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
  }, [loading, sessions, sessionParam, selectedSession, lookupFailedSessionId, projectParam, effectiveProject, projectOptions.length, projects, currentSession?.session_id, search, setSearch, workView])

  const selectSession = (session: RecentSession) => {
    const next = new URLSearchParams(search)
    next.set('session', session.session_id)
    if (effectiveProject && session.project_id) next.set('project', session.project_id)
    else next.delete('project')
    setSearch(next)
  }

  const selectProjectFilter = (projectId: string | null) => {
    const next = new URLSearchParams(search)
    if (projectId) next.set('project', projectId)
    else next.delete('project')
    const matchingSessions = sessions.filter(session => (
      (!projectId || session.project_id === projectId) && sessionMatchesView(session, workView)
    ))
    const first = buildRecentSessionTreeGroups(matchingSessions)[0]?.sessions[0]
    if (first) next.set('session', first.session_id)
    else next.delete('session')
    setSearch(next)
    setProjectFilterOpen(false)
    setProjectFilterQuery('')
    setSessionQuery('')
  }

  const toggleSessionGroup = (groupKey: string) => {
    setCollapsedSessionGroups(current => {
      const next = new Set(current)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }

  const openCreateSession = (issueId = '') => {
    setCreateIssueOverride(issueId)
    setCreateKind('session')
  }

  const openSearchSession = async (group: ProjectHierarchyGroup, hit: ProjectHierarchyHit) => {
    const resultKey = `${hit.kind}:${hit.id}`
    setOpeningSearchResult(resultKey)
    setHierarchySearchError('')
    try {
      let session: RecentSession | null = null
      if (hit.kind === 'session' || hit.kind === 'research_agent') {
        session = await api(`/api/tasks/${encodeURIComponent(hit.id)}`)
      } else {
        const endpoint = hit.kind === 'research'
          ? `/api/researches/${encodeURIComponent(hit.id)}/sessions`
          : `/api/issues/${encodeURIComponent(hit.id)}/sessions`
        const list = await api(endpoint)
        session = Array.isArray(list) && list.length > 0 ? list[0] : null
        if (!session) {
          if (hit.kind === 'issue') {
            setSessionQuery('')
            selectProjectFilter(String(group.project.id))
            openCreateSession(hit.id)
            return
          }
          throw new Error('这个研究还没有可继续的智能体')
        }
      }
      if (!session) throw new Error('没有可打开的会话')
      const decorated: RecentSession = {
        ...session,
        session_id: session.session_id,
        project_id: session.project_id || String(group.project.id),
        project_name: session.project_name || group.project.name,
        issue_id: session.issue_id || (hit.parent_kind === 'issue' ? hit.parent_id : hit.kind === 'issue' ? hit.id : null),
        issue_title: session.issue_title || (hit.parent_kind === 'issue' ? hit.parent_title : hit.kind === 'issue' ? hit.title : null),
        research_id: session.research_id || (hit.parent_kind === 'research' ? hit.parent_id : hit.kind === 'research' ? hit.id : null),
        research_title: session.research_title || (hit.parent_kind === 'research' ? hit.parent_title : hit.kind === 'research' ? hit.title : null),
        scope_type: session.scope_type || (hit.kind === 'research' || hit.kind === 'research_agent' ? 'research' : 'issue'),
      }
      setSessions(current => [decorated, ...current.filter(item => item.session_id !== decorated.session_id)])
      const next = new URLSearchParams(search)
      next.set('project', String(group.project.id))
      next.set('session', decorated.session_id)
      next.delete('view')
      setSearch(next)
      setSessionQuery('')
    } catch (err: any) {
      setHierarchySearchError(err?.message || '无法打开这项工作')
    } finally {
      setOpeningSearchResult('')
    }
  }

  return (
    <div className="flex h-screen flex-col" style={{ background: 'var(--bg-primary)' }} data-page="easy-mode">
      <TopNav />
      <div className="flex min-h-0 flex-1">
        <ResizablePanel
          storageKey="mobius:ui:sidebar:easy-mode-recent"
          defaultWidth={304}
          minWidth={248}
          maxWidth={460}
          side="left"
          className="flex flex-col border-r"
          style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}
        >
          <div className="border-b px-3 py-3" style={{ borderColor: 'var(--border-color)' }}>
            <div className="flex items-center gap-2 px-1">
              <History className="h-4 w-4" style={{ color: 'var(--accent-primary)' }} />
              <h1 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>工作导航</h1>
              {refreshing && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin" style={{ color: 'var(--text-muted)' }} aria-label="正在刷新工作状态" />}
              {!loading && !refreshing && (
                <span className="ml-auto rounded-full px-2 py-0.5 text-[10px]" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
                  最近 {sessions.length}
                </span>
              )}
            </div>

            <label className="mt-2.5 flex h-9 items-center gap-2 rounded-lg border px-2.5 focus-within:ring-2 focus-within:ring-blue-500/20" style={{ borderColor: 'var(--border-color)', background: 'var(--input-bg)' }}>
              <SearchIcon className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
              <input
                value={sessionQuery}
                onChange={event => setSessionQuery(event.target.value)}
                maxLength={200}
                placeholder="搜索全部项目、任务或会话"
                aria-label="搜索全部项目、任务或会话"
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] outline-none"
                style={{ color: 'var(--text-primary)' }}
              />
              {hierarchySearchLoading ? (
                <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" style={{ color: 'var(--accent-primary)' }} aria-label="正在搜索全部工作" />
              ) : sessionQuery && (
                <button type="button" onClick={() => setSessionQuery('')} aria-label="清空搜索" className="rounded p-0.5 hover:bg-[var(--bg-hover)]">
                  <X className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                </button>
              )}
            </label>

            {!normalizedSessionQuery && <div className="mt-2 flex min-w-0 items-center gap-2">
              <div className="relative min-w-0 flex-1" data-testid="easy-project-filter">
                <button
                  ref={projectFilterButtonRef}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    setProjectFilterOpen(value => !value)
                  }}
                  aria-haspopup="menu"
                  aria-expanded={projectFilterOpen}
                  className="flex h-9 w-full min-w-0 items-center gap-1.5 rounded-lg border px-2.5 text-left text-[12px] transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-blue-500/50"
                  style={projectChipStyle(!!effectiveProject)}
                  title={selectedProjectOption?.name || '所有近期工作'}
                >
                  <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{selectedProjectOption?.name || '所有近期工作'}</span>
                  <span className="flex-shrink-0 text-[10px] opacity-70">
                    {effectiveProject ? `${projectSessions.length} 会话` : `${projectOptions.length} 项目`}
                  </span>
                  <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${projectFilterOpen ? 'rotate-180' : ''}`} />
                </button>
                {projectFilterOpen && (
                  <div
                    role="menu"
                    className="absolute left-0 right-0 top-10 z-50 rounded-lg p-1.5 shadow-xl"
                    style={{ background: 'var(--menu-bg)', border: '1px solid var(--border-color)' }}
                    onClick={event => event.stopPropagation()}
                  >
                    <label className="mb-1 flex h-8 items-center gap-1.5 rounded-md border px-2" style={{ borderColor: 'var(--border-color)', background: 'var(--input-bg)' }}>
                      <SearchIcon className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                      <input
                        value={projectFilterQuery}
                        onChange={event => setProjectFilterQuery(event.target.value)}
                        placeholder={`搜索全部 ${projectOptions.length} 个项目`}
                        aria-label="搜索全部项目"
                        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[11px] outline-none"
                        style={{ color: 'var(--text-primary)' }}
                        autoFocus
                      />
                    </label>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => selectProjectFilter(null)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                      style={{ color: 'var(--text-primary)', background: effectiveProject === '' ? 'var(--bg-active)' : undefined }}
                    >
                      <span className="min-w-0 flex-1 truncate">所有近期工作</span>
                      <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{sessions.length}</span>
                      {effectiveProject === '' && <Check className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />}
                    </button>
                    <div className="mt-1 max-h-[280px] overflow-y-auto">
                      {filteredProjectOptions.length === 0 ? (
                        <div className="px-2 py-5 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>没有匹配项目，请尝试简称或项目 ID</div>
                      ) : filteredProjectOptions.map(project => (
                        <button
                          key={project.id}
                          type="button"
                          role="menuitem"
                          onClick={() => selectProjectFilter(project.id)}
                          title={project.name}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                          style={{ color: 'var(--text-primary)', background: effectiveProject === project.id ? 'var(--bg-active)' : undefined }}
                        >
                          <span className="min-w-0 flex-1 truncate">{project.name}</span>
                          {project.runningCount > 0 && <span className="text-[10px] text-amber-400">运行 {project.runningCount}</span>}
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{project.count ? `近期 ${project.count}` : '暂无近期会话'}</span>
                          {effectiveProject === project.id && <Check className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => openCreateSession()}
                data-testid="easy-new-session"
                className="inline-flex h-9 flex-shrink-0 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-semibold transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-blue-500/50"
                style={{
                  borderColor: 'color-mix(in srgb, var(--accent-primary) 42%, var(--border-color))',
                  color: 'var(--accent-primary)',
                  background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                }}
                title={selectedProjectOption ? `在 ${selectedProjectOption.name} 新建会话` : '新建会话'}
              >
                <Plus className="h-3.5 w-3.5" />
                <span>新会话</span>
              </button>
            </div>}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="easy-recent-sessions">
            {normalizedSessionQuery ? (
              <div data-testid="easy-global-search-results">
                <div className="flex min-h-8 items-center justify-between px-2 py-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  <span>{hierarchySearchLoading ? '正在搜索全部工作…' : `全部工作 · ${activeHierarchySearch.match_count} 条匹配`}</span>
                  {activeHierarchySearch.truncated && <span>仅显示最相关结果</span>}
                </div>
                {hierarchySearchError ? (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-5 text-center text-[11px] text-red-300">{hierarchySearchError}</div>
                ) : !hierarchySearchLoading && activeHierarchySearch.projects.length === 0 ? (
                  <div className="px-3 py-10 text-center">
                    <SearchIcon className="mx-auto h-7 w-7" style={{ color: 'var(--text-muted)' }} />
                    <div className="mt-3 text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>没有找到相关工作</div>
                    <div className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>尝试项目简称、任务标题或会话名称</div>
                  </div>
                ) : activeHierarchySearch.projects.map(group => (
                  <section key={group.project.id} className="mb-2 overflow-hidden rounded-lg border" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-card)' }}>
                    <button
                      type="button"
                      onClick={() => {
                        setSessionQuery('')
                        selectProjectFilter(String(group.project.id))
                      }}
                      className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-blue-500/50"
                      title={`切换到项目：${group.project.name || group.project.id}`}
                    >
                      <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
                      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>{group.project.name || group.project.id}</span>
                      <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{group.project_match ? '项目匹配' : `${group.total_matches} 项`}</span>
                    </button>
                    {group.matches.length > 0 && (
                      <div className="border-t px-1 py-1" style={{ borderColor: 'var(--border-color)' }}>
                        {group.matches.map(hit => {
                          const key = `${hit.kind}:${hit.id}`
                          return (
                            <button
                              key={key}
                              type="button"
                              data-search-kind={hit.kind}
                              data-search-id={hit.id}
                              onClick={() => void openSearchSession(group, hit)}
                              disabled={!!openingSearchResult}
                              className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-blue-500/50 disabled:opacity-60"
                            >
                              <span className="mt-0.5 flex-shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium" style={{ background: 'var(--bg-active)', color: 'var(--text-secondary)' }}>{hierarchyHitLabel(hit.kind)}</span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>{hit.title || hit.id}</span>
                                <span className="mt-0.5 block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                  {hit.parent_title || (hit.kind === 'issue' ? '打开最近会话；没有会话则新建' : hit.kind === 'research' ? '打开研究智能体' : '直接继续会话')}
                                </span>
                              </span>
                              {openingSearchResult === key && <Loader2 className="mt-1 h-3.5 w-3.5 flex-shrink-0 animate-spin" style={{ color: 'var(--accent-primary)' }} />}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </section>
                ))}
              </div>
            ) : loading ? (
              <div className="px-3 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>正在加载工作导航...</div>
            ) : error ? (
              <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-5 text-center text-[12px] text-red-300">{error}</div>
            ) : visibleSessions.length === 0 ? (
              <div className="px-3 py-10 text-center">
                <FolderOpen className="mx-auto h-7 w-7" style={{ color: 'var(--text-muted)' }} />
                <div className="mt-3 text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {workView !== 'recent' ? `当前没有${workView === 'running' ? '执行中' : '已完成'}的会话` : '这个项目没有近期会话'}
                </div>
                <div className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>
                  {selectedProjectOption ? '可以在当前项目中创建一个新会话' : '创建会话后会显示在这里'}
                </div>
                {selectedProjectOption && workView === 'recent' && (
                  <button type="button" onClick={() => openCreateSession()} className="mt-3 rounded-lg border px-3 py-2 text-[11px] font-medium text-blue-400 hover:bg-blue-500/10" style={{ borderColor: 'rgba(59,130,246,.28)' }}>
                    在当前项目新建会话
                  </button>
                )}
              </div>
            ) : (
              <SessionGroupTree
                ariaLabel="按项目与任务分组的近期工作"
                groups={visibleSessionGroups}
                currentSessionId={sessionParam}
                highlightCurrentGroup={contextMatchesProject}
                collapsedKeys={collapsedSessionGroups}
                onToggleGroup={toggleSessionGroup}
                testIdPrefix="easy-session"
                domIdPrefix="easy-session-group"
                renderSession={session => {
                  const isResearch = session.scope_type === 'research'
                  const active = session.session_id === sessionParam && contextMatchesProject
                  const status = sessionStatus(session)
                  return (
                    <button
                      type="button"
                      onClick={() => selectSession(session)}
                      className="relative mt-0.5 flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-blue-500/50"
                      style={{
                        borderColor: active ? 'color-mix(in srgb, var(--accent-primary) 42%, var(--border-color))' : 'transparent',
                        background: active ? 'var(--bg-active)' : undefined,
                      }}
                      data-session-id={session.session_id}
                      aria-current={active ? 'true' : undefined}
                      title={session.name || session.session_id}
                    >
                      <span className="absolute -left-2.5 top-1/2 w-2 border-t" style={{ borderColor: 'var(--border-color)' }} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-medium leading-3" style={{ color: 'var(--text-secondary)', background: 'var(--bg-card)' }}>
                            {isResearch ? '智能体' : '会话'}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[11px] font-medium leading-4" style={{ color: 'var(--text-primary)' }}>
                            {session.name || session.session_id}
                          </span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 text-[9px] leading-3" style={{ color: 'var(--text-muted)' }}>
                          <span>{timeAgoPrecise(session.last_active || '')}</span>
                          <span className="inline-flex items-center gap-1"><MessageSquare className="h-2.5 w-2.5" />{session.message_count || 0}</span>
                        </span>
                      </span>
                      <span className="flex-shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium" style={{ color: status.color, background: status.bg }}>
                        {status.label}
                      </span>
                      {active && <Check className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />}
                    </button>
                  )
                }}
              />
            )}
          </div>
        </ResizablePanel>

        {loading ? (
          <Loading text="正在加载工作导航..." />
        ) : currentSession && contextMatchesProject ? (
          <ChatArea
            layout="easy"
            easyProjectControl={{
              selectedProjectId: effectiveProject || selectedSession?.project_id || undefined,
              selectedProjectName: selectedProjectOption?.name || selectedSession?.project_name || projects.find((project: any) => project.id === selectedSession?.project_id)?.name,
              projects: projectOptions,
              onSelectProject: selectProjectFilter,
              onCreateProject: () => setCreateKind('project'),
            }}
          />
        ) : (
          <main className="flex min-w-0 flex-1 items-center justify-center px-6" style={{ background: 'var(--bg-secondary)' }} data-testid="easy-project-empty">
            <div className="max-w-sm text-center">
              <FolderOpen className="mx-auto mb-3 h-9 w-9" style={{ color: 'var(--text-muted)' }} />
              <div className="text-[15px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {workView !== 'recent' ? `当前没有${workView === 'running' ? '执行中' : '已完成'}的会话` : selectedProjectOption ? selectedProjectOption.name : '暂无可打开的近期会话'}
              </div>
              <div className="mt-1.5 text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>
                {workView !== 'recent' ? '切换到“最近”查看其他工作，或创建一个新会话。' : selectedProjectOption ? '这个项目不在最近 50 个会话中。新建会话后可以直接从这里继续工作。' : '选择一个项目或创建会话后开始工作。'}
              </div>
              {selectedProjectOption && workView === 'recent' && (
                <button type="button" onClick={() => openCreateSession()} className="mt-4 rounded-lg bg-blue-500 px-4 py-2 text-[12px] font-medium text-white hover:bg-blue-600">
                  在当前项目新建会话
                </button>
              )}
            </div>
          </main>
        )}
      </div>
      {createKind && (
        <GlobalCreateRoot
          kind={createKind}
          ctx={{ projectId: createDefaultProjectId, issueId: createDefaultIssueId }}
          sessionSuccessMode="toast"
          entitySuccessMode={createKind === 'project' ? 'external' : 'dialog'}
          onSessionCreated={handleSessionCreated}
          onEntityCreated={(kind, entity) => {
            if (kind !== 'project' || !entity?.id) return
            setProjects([...projects.filter((project: any) => project.id !== entity.id), entity])
            setProjectSuccessToast({ name: entity.name || entity.id })
            selectProjectFilter(entity.id)
          }}
          onClose={() => {
            setCreateKind(null)
            setCreateIssueOverride('')
          }}
          onNavigate={navigate}
        />
      )}
      {createSuccessToast && (
        <ToastCard
          tone="success"
          icon={<CheckCircle2 className="h-4 w-4" strokeWidth={2} />}
          title="会话已创建并开始执行"
          subtitle={createSuccessToast.name}
          onClose={() => setCreateSuccessToast(null)}
        />
      )}
      {projectSuccessToast && (
        <ToastCard
          tone="success"
          icon={<CheckCircle2 className="h-4 w-4" strokeWidth={2} />}
          title="项目已创建并切换"
          subtitle={projectSuccessToast.name}
          onClose={() => setProjectSuccessToast(null)}
        />
      )}
    </div>
  )
}
