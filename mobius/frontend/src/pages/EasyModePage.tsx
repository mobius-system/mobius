import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Bot,
  Boxes,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Cpu,
  FolderKanban,
  FolderOpen,
  History,
  LayoutList,
  Loader2,
  MessageSquare,
  MonitorSmartphone,
  Network,
  PanelLeft,
  Plus,
  Pencil,
  Puzzle,
  Search as SearchIcon,
  Settings,
  Sparkles,
  Trash2,
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
import { lazyWithRetry } from '../services/handle-stale-chunk'
import { EasySessionChatInput } from '../components/easy-session-chat-input'
import {
  EasySessionConfigBar,
  EasySessionModeTabs,
  EMPTY_EASY_SESSION_SELECTION,
  type EasySessionSelection,
} from '../components/easy-session-config-bar'
import { randomProjectBindPath, formatDefaultSessionName } from '../services/session-naming'
import type { CreateKind } from '../components/global-create'
import { ResizablePanel } from '../components/resizable-panel'
import { Loading, TopNav, timeAgoPrecise } from '../components/shell'
import { ToastCard } from '../components/toast-card'
import { MobiusLogo } from '../components/mobius-logo'

const EmbeddedOverviewCluster = lazy(() => import('./MobiusOverviewClusterPage'))

// 会话区按需加载: 简易模式首屏是"欢迎 + 输入框", 没选中会话时不渲染 ChatArea, 而 chat.tsx
// 会连带拖来 markdown 渲染栈(react-markdown/rehype-highlight/katex)与输入缓存等一大串依赖,
// 静态 import 等于每次打开简易模式都先付这笔钱.
// The conversation pane loads on demand: the easy-mode landing screen shows only the
// welcome composer, while chat.tsx drags in the whole markdown stack and session input
// cache, so a static import makes every easy-mode visit pay for it up front.
const ChatArea = lazyWithRetry(() => import('../components/chat').then(module => ({ default: module.ChatArea })))

// 首屏只出现"欢迎 + 输入框", 下面这些弹窗/管理面板都要用户点开才可见, 一律按需下载 —
// 它们所在的模块同时也是全局共用弹窗模块, 静态 import 会让打开简易模式先付整包体积.
// The landing screen only shows the welcome composer, so every dialog and manager panel
// below is user-triggered and loads on demand instead of riding along with first paint.
const ConfirmModal = lazyWithRetry(() => import('../components/modals').then(module => ({ default: module.ConfirmModal })))
const RenameSessionModal = lazyWithRetry(() => import('../components/modals').then(module => ({ default: module.RenameSessionModal })))
const GlobalCreateRoot = lazyWithRetry(() => import('../components/global-create').then(module => ({ default: module.GlobalCreateRoot })))
const MemoriesManager = lazyWithRetry(() => import('../components/memories').then(module => ({ default: module.MemoriesManager })))
const SkillsManager = lazyWithRetry(() => import('../components/skills').then(module => ({ default: module.SkillsManager })))

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
type EasyPanel = 'sessions' | 'overview' | 'extensions' | 'devices' | 'context'
type SessionListMode = 'grouped' | 'flat'

const RECENT_SESSION_LIMIT = 50
// 提交问题后延迟这么久补拉一次近期会话: 会话启动/状态翻转要立刻反映到左栏,
// 不必等下一轮 10s 轮询 (也不能立即拉, 后端此刻往往还没把状态刷成执行中)。
const MESSAGE_SENT_REFRESH_DELAY_MS = 1000
const CREATE_SUCCESS_TOAST_MS = 4000
const EASY_LIST_MODE_KEY = 'mobius:easy-mode:session-list-mode'
// 与 Electron 欢迎页“导入一些零散文件，随便聊聊”共用同一兜底容器：
// 用户没有显式选择项目/任务时，复用 let-us-chat / a random chat，缺失则按需创建。
const EASY_DEFAULT_PROJECT_NAME = 'let-us-chat'
const EASY_DEFAULT_ISSUE_TITLE = 'a random chat'
const EASY_NEW_PROJECT_ISSUE_TITLE = 'demo issue'
const EASY_DEFAULT_DESCRIPTION = 'no description'
const EASY_LAST_SELECTION_KEY = 'mobius:easy-mode:last-session-selection'

async function ensureEasyIssue(projectId: string, title: string): Promise<{ id: string; title: string }> {
  const response = await api(`/api/projects/${projectId}/issues?status=active`)
  const issues: any[] = Array.isArray(response) ? response : (response?.issues || [])
  const existing = issues.find(issue => String(issue?.title || '') === title)
  if (existing?.id) return { id: String(existing.id), title: String(existing.title || title) }

  const created = await api(`/api/projects/${projectId}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title,
      description: EASY_DEFAULT_DESCRIPTION,
      use_worktree: false,
      worktree_branch: '',
      visibility: 'private',
      is_planning: false,
    }),
  })
  if (!created?.id) throw new Error('默认任务创建失败')
  return { id: String(created.id), title: String(created.title || title) }
}

function readListMode(): SessionListMode {
  try {
    return localStorage.getItem(EASY_LIST_MODE_KEY) === 'flat' ? 'flat' : 'grouped'
  } catch {
    return 'grouped'
  }
}

function normalizeRecent(value: unknown): RecentSession[] {
  return (Array.isArray(value) ? value : [])
    .filter((session: any) => session?.session_id && session?.status !== 'archived')
    .sort((a: any, b: any) => (
      new Date(b.last_active || 0).getTime() - new Date(a.last_active || 0).getTime()
    ))
    .slice(0, RECENT_SESSION_LIMIT)
}

function sessionStatus(session: RecentSession) {
  if (session.agent_status === 'running') return { label: '执行中', color: '#f59e0b', bg: 'rgba(245,158,11,.10)' }
  if (session.agent_status === 'pending') return { label: '启动中', color: '#fbbf24', bg: 'rgba(251,191,36,.10)' }
  if (session.agent_status === 'waiting') return { label: '待命中', color: '#38bdf8', bg: 'rgba(56,189,248,.10)' }
  if (session.agent_status === 'completed' || session.status === 'completed') return { label: '完成', color: 'var(--text-muted)', bg: 'var(--bg-card)' }
  return { label: '空闲', color: 'var(--text-muted)', bg: 'var(--bg-card)' }
}

function sessionMatchesView(session: RecentSession, view: WorkView) {
  if (view === 'running') return session.agent_status === 'running'
  if (view === 'completed') return session.agent_status === 'completed' || session.status === 'completed'
  return true
}

function timeGreeting(displayName?: string) {
  const name = displayName || '朋友'
  const hour = new Date().getHours()
  if (hour < 5) return `夜深了，${name}`
  if (hour < 11) return `早上好，${name}`
  if (hour < 14) return `中午好，${name}`
  if (hour < 18) return `下午好，${name}`
  if (hour < 24) return `晚上好，${name}`
  return `晚上好，${name}`
}

function readEasyLastSelection(): Pick<EasySessionSelection, 'projectId' | 'issueId' | 'issueTitle'> {
  try {
    const raw = localStorage.getItem(EASY_LAST_SELECTION_KEY)
    if (!raw) return { projectId: '', issueId: '', issueTitle: '' }
    const parsed = JSON.parse(raw)
    return {
      projectId: typeof parsed?.projectId === 'string' ? parsed.projectId : '',
      issueId: typeof parsed?.issueId === 'string' ? parsed.issueId : '',
      issueTitle: typeof parsed?.issueTitle === 'string' ? parsed.issueTitle : '',
    }
  } catch {
    return { projectId: '', issueId: '', issueTitle: '' }
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
    setAssistantBubbleEnabled,
    theme,
    user,
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
  // 首屏由 URL 决定: 带 ?session= 直接落到对应会话, 不带才停在「新任务」欢迎页。
  // 不能写死 true —— 下面的上下文同步 effect 在 showWelcome 时会提前 return, 那样刷新
  // /easy_mode?session=<id> 会被欢迎页永久挡在前面, 会话怎么都打不开。
  const [showWelcome, setShowWelcome] = useState(() => !search.get('session'))
  const [welcomePrompt, setWelcomePrompt] = useState('')
  // 欢迎页输入框下方的项目/任务/模型/语言/记忆和技能选择, 提交时一次性带给创建接口
  const [welcomeSelection, setWelcomeSelection] = useState<EasySessionSelection>(() => ({
    ...EMPTY_EASY_SESSION_SELECTION,
    ...readEasyLastSelection(),
  }))
  const [welcomeCreating, setWelcomeCreating] = useState(false)
  const [sessionTransitioning, setSessionTransitioning] = useState(false)
  const [welcomeSelectionNotice, setWelcomeSelectionNotice] = useState(false)
  const [editingSession, setEditingSession] = useState<RecentSession | null>(null)
  const [deletingSession, setDeletingSession] = useState<RecentSession | null>(null)
  const [createErrorToast, setCreateErrorToast] = useState<{ message: string } | null>(null)
  const [createIssueOverride, setCreateIssueOverride] = useState('')
  const [createSuccessToast, setCreateSuccessToast] = useState<{ name: string } | null>(null)
  const [projectSuccessToast, setProjectSuccessToast] = useState<{ name: string } | null>(null)
  const [collapsedSessionGroups, setCollapsedSessionGroups] = useState<Set<string>>(() => new Set())
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false)
  const [sessionListMode, setSessionListMode] = useState<SessionListMode>(readListMode)
  const [contextTab, setContextTab] = useState<'skills' | 'memories'>('skills')
  const [remotes, setRemotes] = useState<any[]>([])
  const [remotesLoading, setRemotesLoading] = useState(false)
  const [remotesError, setRemotesError] = useState('')
  const projectFilterButtonRef = useRef<HTMLButtonElement | null>(null)
  const messageSentRefreshTimerRef = useRef<number | null>(null)
  const welcomeSelectionNoticeTimerRef = useRef<number | null>(null)
  const navigate = useNavigate()
  const layoutMode = useLayoutMode()
  const sessionParam = search.get('session') || ''
  const projectParam = search.get('project') || ''
  const workView = (['recent', 'running', 'completed'].includes(search.get('view') || '')
    ? search.get('view')
    : 'recent') as WorkView
  const requestedPanel = search.get('panel')
  const activePanel: EasyPanel = requestedPanel === 'overview'
    || requestedPanel === 'extensions'
    || requestedPanel === 'devices'
    || requestedPanel === 'context'
    ? requestedPanel
    : 'sessions'
  // 侧栏主导航是单选: 面板 (?panel=) 优先, 没有面板时才轮到「新任务」欢迎页。
  // 面板渲染顺序与这里一致, 所以高亮项恒等于右侧实际内容。
  const activePrimaryNav: EasyPanel | 'welcome' = activePanel !== 'sessions'
    ? activePanel
    : showWelcome ? 'welcome' : 'sessions'

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
      // 全局纵观的批量快照已包含完整项目列表；避免首屏再并发一份相同查询。
      activePanel === 'overview'
        ? Promise.resolve(null)
        : api('/api/projects?all=true', { signal: controller.signal }),
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

  // 拉一次 /api/tasks/recent 覆盖左栏列表; 当前会话若掉出近 50 条也要保留在列表里。
  const refreshRecentSessions = useCallback(async (signal?: AbortSignal) => {
    const recent = await api(`/api/tasks/recent?limit=${RECENT_SESSION_LIMIT}`, { signal })
    setSessions((current) => {
      const next = normalizeRecent(recent)
      const selected = current.find(session => session.session_id === sessionParam)
      return selected && !next.some(session => session.session_id === selected.session_id)
        ? [selected, ...next]
        : next
    })
  }, [sessionParam])

  // 提交问题后的补拉: 连续发送只保留最后一次定时器, 不重复叠加请求。
  const scheduleRefreshAfterSend = useCallback(() => {
    if (messageSentRefreshTimerRef.current !== null) window.clearTimeout(messageSentRefreshTimerRef.current)
    messageSentRefreshTimerRef.current = window.setTimeout(() => {
      messageSentRefreshTimerRef.current = null
      refreshRecentSessions().catch(() => {}) // 轮询仍在兜底, 单次失败静默
    }, MESSAGE_SENT_REFRESH_DELAY_MS)
  }, [refreshRecentSessions])

  useEffect(() => () => {
    if (messageSentRefreshTimerRef.current !== null) window.clearTimeout(messageSentRefreshTimerRef.current)
  }, [])

  useEffect(() => pollRecursive(async (signal) => {
    if (document.visibilityState !== 'visible') return
    setRefreshing(true)
    try {
      await refreshRecentSessions(signal)
    } finally {
      setRefreshing(false)
    }
  }, 10_000, 10_000, { startImmediately: false }), [params.user, sessionParam, refreshRecentSessions])

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

  useEffect(() => {
    if (!createErrorToast) return
    const timer = window.setTimeout(() => setCreateErrorToast(null), CREATE_SUCCESS_TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [createErrorToast])

  const loadRemotes = useCallback((signal?: AbortSignal) => {
    setRemotesLoading(true)
    setRemotesError('')
    return api('/aimux_bridge/api/remotes', { signal })
      .then((data: any) => setRemotes(Array.isArray(data?.remotes) ? data.remotes : []))
      .catch((err: any) => {
        if (err?.name === 'AbortError') return
        setRemotes([])
        setRemotesError(err?.message || '跨设备连接信息暂时不可用')
      })
      .finally(() => {
        if (!signal?.aborted) setRemotesLoading(false)
      })
  }, [])

  useEffect(() => {
    if (activePanel !== 'devices') return
    return pollRecursive((signal) => loadRemotes(signal), 10_000, 10_000)
  }, [activePanel, loadRemotes])

  const handleSessionCreated = (session: RecentSession) => {
    setCreateSuccessToast({ name: session?.name || '新会话' })
    // 从「+ 新任务」提交后立即进入新项目中的会话，不再停留在欢迎页。
    if (session?.session_id) {
      setSessionTransitioning(true)
      setShowWelcome(false)
      const next = new URLSearchParams(search)
      next.set('session', session.session_id)
      next.delete('project')
      next.delete('panel')
      setSearch(next)
    }
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

  useEffect(() => {
    if (!sessionTransitioning || !sessionParam || selectedSession?.session_id !== sessionParam) return
    setSessionTransitioning(false)
  }, [sessionTransitioning, sessionParam, selectedSession?.session_id])

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
    if (showWelcome) return
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
  }, [loading, showWelcome, sessions, sessionParam, selectedSession, lookupFailedSessionId, projectParam, effectiveProject, projectOptions.length, projects, currentSession?.session_id, search, setSearch, workView])

  const selectSession = (session: RecentSession) => {
    setShowWelcome(false)
    const next = new URLSearchParams(search)
    next.set('session', session.session_id)
    next.delete('panel')
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

  const openWelcome = () => {
    setShowWelcome(true)
    setWelcomePrompt('')
    setWelcomeSelection(current => ({ ...current, ...readEasyLastSelection(), createProject: false }))
    setWelcomeSelectionNotice(true)
    setCurrentSession(null)
    setCurrentTask(null)
    setCurrentIssue(null)
    setCurrentResearch(null)
    const next = new URLSearchParams(search)
    next.delete('session')
    next.delete('project')
    next.delete('panel')
    setSearch(next)
  }

  const showWelcomeSelectionNotice = () => {
    setWelcomeSelectionNotice(true)
    if (welcomeSelectionNoticeTimerRef.current) window.clearTimeout(welcomeSelectionNoticeTimerRef.current)
    welcomeSelectionNoticeTimerRef.current = window.setTimeout(() => setWelcomeSelectionNotice(false), 5000)
  }

  useEffect(() => {
    try {
      localStorage.setItem(EASY_LAST_SELECTION_KEY, JSON.stringify({
        projectId: welcomeSelection.projectId,
        issueId: welcomeSelection.issueId,
        issueTitle: welcomeSelection.issueTitle,
      }))
    } catch {}
  }, [welcomeSelection.projectId, welcomeSelection.issueId, welcomeSelection.issueTitle])

  useEffect(() => {
    if (!showWelcome) return
    showWelcomeSelectionNotice()
    return () => {
      if (welcomeSelectionNoticeTimerRef.current) window.clearTimeout(welcomeSelectionNoticeTimerRef.current)
    }
  }, [showWelcome])

  // 欢迎页提交: 输入框内容 + 下方选择直接创建并启动会话, 不再二次跳配置弹窗.
  // 请求体与「新建快捷会话」完全同源 (POST /api/issues/:id/sessions + 首条消息启动).
  const submitWelcomePrompt = async () => {
    const prompt = welcomePrompt.trim()
    if (!prompt || welcomeCreating) return
    const {
      createProject,
      projectId,
      issueId,
      issueTitle,
      model,
      language,
      excludedSkills,
      excludedMemories,
      projectPath,
      projectName,
    } = welcomeSelection
    if (createProject && !projectName.trim()) {
      setCreateErrorToast({ message: '请填写项目名' })
      return
    }
    setWelcomeCreating(true)
    try {
      let targetProject: any = null
      let targetIssue: { id: string; title: string } | null = null

      if (createProject) {
        const bindPath = projectPath.trim() || randomProjectBindPath(user?.work_dir)
        if (!bindPath) throw new Error('当前用户尚未配置工作目录，请选择中枢路径')
        targetProject = await api('/api/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: projectName.trim(),
            description: prompt,
            bindPath,
            bindPathManual: !!projectPath.trim() && !!welcomeSelection.projectPathManual,
            defaultUseWorktree: false,
            researchEnabled: false,
            visibility: 'private',
            can_post_issue: false,
            can_run_session: false,
          }),
        })
        if (!targetProject?.id) throw new Error('项目创建失败')
        setProjects([...projects.filter((project: any) => project.id !== targetProject.id), targetProject])
        targetIssue = await ensureEasyIssue(String(targetProject.id), EASY_NEW_PROJECT_ISSUE_TITLE)
      } else if (projectId) {
        targetProject = projects.find((project: any) => String(project.id) === projectId) || { id: projectId }
        targetIssue = issueId
          ? { id: issueId, title: issueTitle || EASY_DEFAULT_ISSUE_TITLE }
          : await ensureEasyIssue(projectId, EASY_DEFAULT_ISSUE_TITLE)
      } else {
        targetProject = projects.find((project: any) => (
          String(project?.created_by || '') === String(user?.id || '')
          && String(project?.name || '').toLowerCase() === EASY_DEFAULT_PROJECT_NAME
        ))
        if (!targetProject) {
          const workDir = String(user?.work_dir || '').trim().replace(/\/+$/, '')
          if (!workDir) throw new Error('当前用户尚未配置工作目录，无法创建默认项目')
          targetProject = await api('/api/projects', {
            method: 'POST',
            body: JSON.stringify({
              name: EASY_DEFAULT_PROJECT_NAME,
              description: '用于未指定项目时创建简易会话',
              bindPath: `${workDir}/${EASY_DEFAULT_PROJECT_NAME}`,
              bindPathManual: false,
              defaultUseWorktree: false,
              researchEnabled: false,
              visibility: 'private',
              can_post_issue: false,
              can_run_session: false,
            }),
          })
          if (!targetProject?.id) throw new Error('默认项目创建失败')
          setProjects([...projects.filter((project: any) => project.id !== targetProject.id), targetProject])
        }
        targetIssue = await ensureEasyIssue(String(targetProject.id), EASY_DEFAULT_ISSUE_TITLE)
      }

      if (!targetProject?.id || !targetIssue?.id) throw new Error('无法确定会话所属的项目与任务')
      const name = formatDefaultSessionName(targetIssue.title)
      const keepsSelectedContext = createProject || targetIssue.id === issueId
      const session = await api(`/api/issues/${targetIssue.id}/sessions`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: prompt,
          model,
          language,
          excluded_skill_ids: keepsSelectedContext ? excludedSkills : [],
          excluded_memory_ids: keepsSelectedContext ? excludedMemories : [],
          name_touched: false,
        }),
      })
      if (session?.error) throw new Error(session.error)
      if (session?.session_id) {
        const requestId = `easy-welcome-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        api(`/api/sessions/${session.session_id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: [name, prompt].filter(Boolean).join('\n\n'), request_id: requestId }),
        }).catch(() => {})
      }
      // 新建会话同样是「提交问题」: 1s 后再拉一次, 让左栏立刻显示该会话已在执行。
      scheduleRefreshAfterSend()
      handleSessionCreated({
        ...session,
        project_id: session?.project_id || String(targetProject.id),
        project_name: session?.project_name || targetProject.name,
        issue_id: session?.issue_id || targetIssue.id,
        issue_title: session?.issue_title || targetIssue.title,
      })
      setWelcomePrompt('')
    } catch (err: any) {
      setCreateErrorToast({ message: err?.message || '会话创建失败，请稍后重试' })
    } finally {
      setWelcomeCreating(false)
    }
  }

  const selectPanel = (panel: EasyPanel) => {
    const next = new URLSearchParams(search)
    if (panel === 'sessions') next.delete('panel')
    else next.set('panel', panel)
    setSearch(next)
  }

  const toggleListMode = () => {
    setSessionListMode(current => {
      const next = current === 'grouped' ? 'flat' : 'grouped'
      try { localStorage.setItem(EASY_LIST_MODE_KEY, next) } catch {}
      return next
    })
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

  const handleDeleteSession = async () => {
    if (!deletingSession) return
    const deletedSessionId = deletingSession.session_id
    const response = await api(`/api/sessions/${deletedSessionId}`, { method: 'DELETE' })
    setSessions(current => current.filter(session => session.session_id !== deletedSessionId))
    if (sessionParam === deletedSessionId) {
      setCurrentSession(null)
      setCurrentTask(null)
      const next = new URLSearchParams(search)
      next.delete('session')
      setSearch(next, { replace: true })
    }
    setDeletingSession(null)
    if (response?.message) alert(response.message)
  }

  const extensionProjects = projects.filter((project: any) => project?.kind === 'extension')
  const renderSessionRow = (session: RecentSession, nested = false) => {
    const active = session.session_id === sessionParam && contextMatchesProject && activePanel === 'sessions'
    const status = sessionStatus(session)
    return (
      <div key={session.session_id} className={`easy-sidebar-session-row ${nested ? 'easy-sidebar-session-row--nested' : ''}`}>
        <button
          type="button"
          onClick={() => selectSession(session)}
          className={`easy-sidebar-session ${active ? 'easy-sidebar-session--active' : ''} ${nested ? 'easy-sidebar-session--nested' : ''}`}
          data-session-id={session.session_id}
          aria-current={active ? 'true' : undefined}
          title={session.name || session.session_id}
        >
          <span className="easy-sidebar-session__state" data-status={session.agent_status || session.status || 'idle'} />
          <span className="min-w-0 flex-1 truncate">{session.name || session.session_id}</span>
          {session.agent_status === 'running' || session.agent_status === 'pending' ? (
            <span className="easy-sidebar-session__status">{status.label}</span>
          ) : null}
        </button>
        <span className="easy-sidebar-session__actions" aria-label={`${session.name || '会话'}操作`}>
          <button type="button" className="easy-sidebar-session__action easy-sidebar-session__action--rename" title="重命名" aria-label={`重命名 ${session.name || '会话'}`} onClick={() => setEditingSession(session)}>
            <Pencil className="h-3 w-3" />
          </button>
          <button type="button" className="easy-sidebar-session__action easy-sidebar-session__action--delete" title="删除" aria-label={`删除 ${session.name || '会话'}`} onClick={() => setDeletingSession(session)}>
            <Trash2 className="h-3 w-3" />
          </button>
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-screen flex-col" style={{ background: 'var(--bg-primary)', fontSize: '11px' }} data-page="easy-mode">
      <TopNav />
      <div className="flex min-h-0 flex-1">
        <ResizablePanel
          storageKey="mobius:ui:sidebar:easy-mode-recent"
          defaultWidth={268}
          minWidth={139}
          maxWidth={380}
          side="left"
          className="easy-sidebar flex flex-col"
        >
          <div className="easy-sidebar-primary">
            <button type="button" className={`easy-sidebar-nav ${activePrimaryNav === 'welcome' ? 'is-active' : ''}`} aria-current={activePrimaryNav === 'welcome' ? 'page' : undefined} onClick={openWelcome} title="新建任务">
              <Plus className="h-4 w-4" />
              <span>新任务</span>
            </button>
            <button type="button" className={`easy-sidebar-nav ${activePrimaryNav === 'overview' ? 'is-active' : ''}`} aria-current={activePrimaryNav === 'overview' ? 'page' : undefined} onClick={() => selectPanel('overview')}>
              <Network className="h-4 w-4" />
              <span>全局纵观</span>
            </button>
            <button type="button" className={`easy-sidebar-nav ${activePrimaryNav === 'extensions' ? 'is-active' : ''}`} aria-current={activePrimaryNav === 'extensions' ? 'page' : undefined} onClick={() => selectPanel('extensions')}>
              <Boxes className="h-4 w-4" />
              <span>项目与拓展</span>
            </button>
            <button type="button" className={`easy-sidebar-nav ${activePrimaryNav === 'devices' ? 'is-active' : ''}`} aria-current={activePrimaryNav === 'devices' ? 'page' : undefined} onClick={() => selectPanel('devices')}>
              <MonitorSmartphone className="h-4 w-4" />
              <span>跨设备</span>
            </button>
          </div>

          <div className="easy-sidebar-tools justify-end" aria-label="会话工具">
            <span className="easy-sidebar-tools__label">
              {sessionListMode === 'grouped' ? (
                <>
                  <FolderKanban className="easy-sidebar-tools__label-icon" aria-hidden="true" />
                  项目分组
                </>
              ) : (
                <>
                  <History className="easy-sidebar-tools__label-icon" aria-hidden="true" />
                  近期会话
                </>
              )}
            </span>
            <button type="button" className={sessionSearchOpen ? 'is-active' : ''} onClick={() => setSessionSearchOpen(value => !value)} title="搜索项目、任务或会话" aria-label="搜索项目、任务或会话">
              <SearchIcon className="h-4 w-4" />
            </button>
            <button type="button" onClick={toggleListMode} title={sessionListMode === 'grouped' ? '切换为最近会话列表' : '切换为项目任务分组'} aria-label="切换会话列表模式">
              {sessionListMode === 'grouped' ? <LayoutList className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
            </button>
            <button type="button" onClick={() => openCreateSession()} data-testid="easy-new-session" title="新建会话" aria-label="新建会话">
              <Plus className="h-4 w-4" />
            </button>
          </div>

          {sessionSearchOpen && (
            <label className="easy-sidebar-search">
              <SearchIcon className="h-3.5 w-3.5 flex-shrink-0" />
              <input
                value={sessionQuery}
                onChange={event => setSessionQuery(event.target.value)}
                maxLength={200}
                placeholder="搜索全部工作"
                aria-label="搜索全部项目、任务或会话"
                autoFocus
              />
              {hierarchySearchLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : sessionQuery ? (
                <button type="button" onClick={() => setSessionQuery('')} aria-label="清空搜索"><X className="h-3.5 w-3.5" /></button>
              ) : null}
            </label>
          )}

          <div className="easy-sidebar-list" data-testid="easy-recent-sessions">
            {normalizedSessionQuery ? (
              <div data-testid="easy-global-search-results">
                <div className="easy-sidebar-list__meta">{hierarchySearchLoading ? '正在搜索…' : `${activeHierarchySearch.match_count} 条匹配`}</div>
                {hierarchySearchError ? <div className="easy-sidebar-empty">{hierarchySearchError}</div> : null}
                {!hierarchySearchLoading && !hierarchySearchError && activeHierarchySearch.projects.length === 0 ? <div className="easy-sidebar-empty">没有找到相关工作</div> : null}
                {activeHierarchySearch.projects.map(group => (
                  <section key={group.project.id} className="easy-search-group">
                    <div className="easy-search-group__title"><FolderOpen className="h-3.5 w-3.5" /><span>{group.project.name || group.project.id}</span></div>
                    {group.matches.map(hit => {
                      const key = `${hit.kind}:${hit.id}`
                      return (
                        <button key={key} type="button" className="easy-search-hit" onClick={() => void openSearchSession(group, hit)} disabled={!!openingSearchResult}>
                          <span>{hierarchyHitLabel(hit.kind)}</span>
                          <strong>{hit.title || hit.id}</strong>
                          {openingSearchResult === key ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        </button>
                      )
                    })}
                  </section>
                ))}
              </div>
            ) : loading ? (
              <div className="easy-sidebar-empty">正在加载会话…</div>
            ) : error ? (
              <div className="easy-sidebar-empty">{error}</div>
            ) : visibleSessions.length === 0 ? (
              <div className="easy-sidebar-empty">暂无近期会话</div>
            ) : sessionListMode === 'flat' ? (
              <div className="easy-sidebar-flat" aria-label="最近会话列表">
                {visibleSessions.map(session => renderSessionRow(session))}
              </div>
            ) : (
              <div className="easy-sidebar-groups" aria-label="按项目与任务分组的近期工作">
                {visibleSessionGroups.map(group => {
                  const collapsed = collapsedSessionGroups.has(group.key)
                  const current = group.sessions.some(session => session.session_id === sessionParam)
                  return (
                    <section key={group.key} className={`easy-sidebar-group ${current ? 'is-current' : ''}`}>
                      <button type="button" className="easy-sidebar-group__header" onClick={() => toggleSessionGroup(group.key)} aria-expanded={!collapsed}>
                        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        <CircleDot className="h-3.5 w-3.5" />
                        <span className="min-w-0 flex-1 truncate">{group.subjectTitle} · {group.projectName}</span>
                        {group.activeCount > 0 ? <span className="easy-sidebar-group__running">{group.activeCount}</span> : null}
                      </button>
                      {!collapsed && <div className="easy-sidebar-group__sessions">{group.sessions.map(session => renderSessionRow(session, true))}</div>}
                    </section>
                  )
                })}
              </div>
            )}
          </div>

          <div className="easy-sidebar-footer" aria-label="快捷入口">
            <button type="button" onClick={() => { setAssistantBubbleEnabled(true); window.dispatchEvent(new Event('mobius:assistant:open')) }} title="打开小莫" aria-label="打开小莫"><Bot className="h-[17px] w-[17px]" /></button>
            <button type="button" onClick={() => window.openAdminOverlay?.()} title="系统设置" aria-label="系统设置"><Settings className="h-[17px] w-[17px]" /></button>
            <button type="button" className={activePanel === 'context' ? 'is-active' : ''} onClick={() => selectPanel('context')} title="记忆与技能" aria-label="记忆与技能"><BrainCircuit className="h-[17px] w-[17px]" /></button>
          </div>
        </ResizablePanel>

        {activePanel === 'overview' ? (
          <main className="easy-content easy-content--overview" data-testid="easy-overview-panel">
            <Suspense fallback={<Loading text="正在加载全局纵观…" />}><EmbeddedOverviewCluster embedded /></Suspense>
          </main>
        ) : activePanel === 'extensions' ? (
          <main className="easy-content" data-testid="easy-extensions-panel">
            <div className="easy-content-header"><Boxes className="h-5 w-5" /><div><h1>系统拓展</h1><p>当前系统中可用的拓展应用</p></div><span>{extensionProjects.length}</span></div>
            <div className="easy-extension-grid">
              {extensionProjects.length === 0 ? <div className="easy-content-empty"><Puzzle className="h-8 w-8" /><span>当前没有可用拓展</span></div> : extensionProjects.map((project: any) => (
                <button key={project.id} type="button" className="easy-extension-card" disabled={project.disabled} onClick={() => window.open(`/extension/${encodeURIComponent(project.extension_name)}/`, '_blank', 'noopener,noreferrer')}>
                  <span className="easy-extension-card__icon"><Puzzle className="h-5 w-5" /></span>
                  <span className="min-w-0 flex-1"><strong>{project.name || project.extension_name}</strong><small>{project.description || '莫比乌斯拓展应用'}</small></span>
                  <ChevronRight className="h-4 w-4" />
                </button>
              ))}
            </div>
          </main>
        ) : activePanel === 'devices' ? (
          <main className="easy-content" data-testid="easy-devices-panel">
            <div className="easy-content-header"><MonitorSmartphone className="h-5 w-5" /><div><h1>跨设备</h1><p>AIMUX 可协作设备与连接状态</p></div>{remotesLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <span>{remotes.length}</span>}</div>
            {remotesError ? <div className="easy-content-empty"><Cpu className="h-8 w-8" /><span>{remotesError}</span></div> : (
              <div className="easy-device-list">
                {remotes.length === 0 && !remotesLoading ? <div className="easy-content-empty"><MonitorSmartphone className="h-8 w-8" /><span>暂无已登记的协作设备</span></div> : remotes.map((remote: any, index) => {
                  const connected = remote.reachable === true || remote.connected === true || remote.status === 'reachable' || remote.event_stream_connected === true
                  const name = remote.name || remote.identifier || remote.host || `设备 ${index + 1}`
                  const detail = [remote.user && remote.hostname ? `${remote.user}@${remote.hostname}` : remote.hostname || remote.host, remote.port ? `:${remote.port}` : '', remote.rtt || remote.latency].filter(Boolean).join(' ')
                  return <div key={name} className="easy-device-row"><span className="easy-device-row__icon"><MonitorSmartphone className="h-5 w-5" /></span><span className="min-w-0 flex-1"><strong>{name}</strong><small>{detail || 'AIMUX remote'}</small></span><span className={`easy-device-row__status ${connected ? 'is-online' : ''}`}><i />{connected ? '在线' : '离线'}</span></div>
                })}
              </div>
            )}
          </main>
        ) : activePanel === 'context' ? (
          <main className="easy-content easy-content--context" data-testid="easy-context-panel">
            <div className="easy-content-header"><BrainCircuit className="h-5 w-5" /><div><h1>记忆与技能</h1><p>管理新会话默认可用的个人上下文</p></div></div>
            <div className="easy-context-tabs"><button type="button" className={contextTab === 'skills' ? 'is-active' : ''} onClick={() => setContextTab('skills')}><Sparkles className="h-3.5 w-3.5" />技能</button><button type="button" className={contextTab === 'memories' ? 'is-active' : ''} onClick={() => setContextTab('memories')}><BrainCircuit className="h-3.5 w-3.5" />记忆</button></div>
            <div className="easy-context-body">
              <Suspense fallback={<Loading text="正在加载..." />}>
                {contextTab === 'skills' ? <SkillsManager scope="user" /> : <MemoriesManager scope="user" />}
              </Suspense>
            </div>
          </main>
        ) : sessionTransitioning ? (
          <main className="easy-content easy-content--empty" data-testid="easy-session-transition">
            <div className="easy-session-transition-loader" role="status" aria-live="polite">
              <div className="easy-session-transition-loader__orb">
                <Sparkles className="easy-session-transition-loader__spark" />
                <span className="easy-session-transition-loader__ring" />
              </div>
              <strong>正在打开新项目…</strong>
              <span>正在载入会话与工作区</span>
            </div>
          </main>
        ) : showWelcome ? (
          <main className="easy-content easy-content--welcome" data-testid="easy-welcome-panel">
            <div className="easy-welcome-card">
              <MobiusLogo size={46} className="easy-welcome-logo" />
              <h1>{timeGreeting(user?.display_name)}<br />您需要莫比乌斯执行什么任务？</h1>
              <EasySessionModeTabs selection={welcomeSelection} onChange={setWelcomeSelection} />
              <div id="easy-welcome-composer" role="tabpanel" aria-labelledby={`easy-welcome-mode-${welcomeSelection.createProject ? 1 : 0}`}>
                <EasySessionChatInput
                  mode="create_session_mode"
                  input={welcomePrompt}
                  inputPlaceholder="描述你想让莫比乌斯完成的任务…"
                  theme={theme}
                  onChange={event => setWelcomePrompt(event.target.value)}
                  onSend={submitWelcomePrompt}
                  submitDisabled={welcomeCreating || (welcomeSelection.createProject && !welcomeSelection.projectName.trim())}
                  submitTooltip={welcomeSelection.createProject && !welcomeSelection.projectName.trim()
                      ? '请填写项目名'
                      : '开始新会话'}
                  toolbar={
                    <EasySessionConfigBar
                      selection={welcomeSelection}
                      onChange={next => {
                        const restored = !next.createProject && welcomeSelection.createProject
                          ? { ...next, ...readEasyLastSelection() }
                          : next
                        setWelcomeSelection(restored)
                        if (!next.createProject && welcomeSelection.createProject) showWelcomeSelectionNotice()
                      }}
                      projects={projects}
                      recentSessions={sessions}
                      dark={theme !== 'light'}
                    />
                  }
                />
                {welcomeSelectionNotice && !welcomeSelection.createProject ? (
                  <div className="easy-selection-notice" role="status">
                    当前选择：{projects.find(project => String(project.id) === welcomeSelection.projectId)?.name || '未选择项目'}
                    {' · '}
                    {welcomeSelection.issueTitle || '未选择任务'}
                  </div>
                ) : null}
              </div>
              <div className="easy-welcome-suggestions"><span>钉钉办公</span><span>文档创作</span><span>数据分析</span><span>多人工作台</span><span>创意设计</span><span>深度调研</span></div>
            </div>
          </main>
        ) : loading ? (
          // 与会话页/其它面板同一张卡片: 裸 Loading 铺满整块会丢掉左边线与左上圆角.
          <main className="easy-content easy-content--empty" data-testid="easy-loading-panel">
            <Loading text="正在加载工作导航..." />
          </main>
        ) : currentSession && contextMatchesProject ? (
          <Suspense fallback={<Loading text="正在加载会话..." />}>
            <ChatArea
              layout="easy"
              onMessageSent={scheduleRefreshAfterSend}
              easyProjectControl={{
                selectedProjectId: effectiveProject || selectedSession?.project_id || undefined,
                selectedProjectName: selectedProjectOption?.name || selectedSession?.project_name || projects.find((project: any) => project.id === selectedSession?.project_id)?.name,
                projects: projectOptions,
                onSelectProject: selectProjectFilter,
                onCreateProject: () => setCreateKind('project'),
              }}
            />
          </Suspense>
        ) : (
          <main className="easy-content easy-content--empty" data-testid="easy-project-empty">
            <FolderKanban className="h-9 w-9" />
            <strong>暂无可打开的近期会话</strong>
            <span>从左侧新建会话后开始工作</span>
            <button type="button" onClick={() => openCreateSession()}><Plus className="h-4 w-4" />新建会话</button>
          </main>
        )}
      </div>
      {createKind && (
        <Suspense fallback={null}>
        <GlobalCreateRoot
          kind={createKind}
          ctx={{ projectId: createDefaultProjectId, issueId: createDefaultIssueId }}
          initialPrompt={welcomePrompt}
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
        </Suspense>
      )}
      {editingSession && (
        <Suspense fallback={null}>
        <RenameSessionModal
          session={editingSession}
          onClose={() => setEditingSession(null)}
          onRenamed={(updated: RecentSession) => {
            setSessions(current => current.map(session => session.session_id === updated.session_id ? { ...session, ...updated } : session))
            if (currentSession?.session_id === updated.session_id) {
              setCurrentSession({
                ...currentSession,
                ...updated,
                issue_title: updated.issue_title ?? undefined,
                project_name: updated.project_name ?? undefined,
              } as any)
            }
            setEditingSession(null)
          }}
        />
        </Suspense>
      )}
      {deletingSession && (
        <Suspense fallback={null}>
        <ConfirmModal
          title="删除会话"
          message={`确定删除会话「${deletingSession.name || deletingSession.session_id}」？删除后将立即永久删除，不再保留。`}
          onConfirm={handleDeleteSession}
          onClose={() => setDeletingSession(null)}
          confirmText="删除"
          confirmClass="bg-red-500 hover:bg-red-600"
        />
        </Suspense>
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
      {createErrorToast && (
        <ToastCard
          tone="error"
          icon={<X className="h-4 w-4" strokeWidth={2} />}
          title="会话创建失败"
          subtitle={createErrorToast.message}
          onClose={() => setCreateErrorToast(null)}
        />
      )}
    </div>
  )
}
