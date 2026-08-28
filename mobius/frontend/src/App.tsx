import { Component, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { ToastCard } from './components/toast-card'
import { useStore, api } from './store'
import { startTextRedactionRuntime } from './services/text-redaction'
import { THEME_NAMES } from './theme'
import { applyCustomThemeToRoot, loadActiveCustomThemeId, loadCustomThemes } from './services/custom-themes'
import { pollRecursive } from './services/polling'
import { DesktopTitleBar } from './components/window-controls'
import { WorkbenchShell } from './components/workbench-shell'
import { AdminOverlayHost } from './components/admin-overlay'
import { lazyWithRetry, isStaleChunkError, triggerStaleReload } from './services/handle-stale-chunk'
import { buildNormalModeTargetUrl, useLayoutMode } from './services/layout-mode'
import { LayoutModeChoiceModal } from './components/layout-mode-choice-modal'
import {
  homePath,
  legacySessionRedirect,
  navigateToWorkbench,
  sessionNavigation,
} from './services/workbench-navigation'
import { detectClientRuntime } from './services/client-distribution'

const Login = lazyWithRetry(() => import('./pages/Login'))
const Welcome = lazyWithRetry(() => import('./pages/Welcome'))
const UserPage = lazyWithRetry(() => import('./pages/UserPage'))
const WorkPage = lazyWithRetry(() => import('./pages/WorkPage'))
const EasyModePage = lazyWithRetry(() => import('./pages/EasyModePage'))
const MobiusOverviewPage = lazyWithRetry(() => import('./pages/MobiusOverviewPage'))
const MobiusOverviewClusterPage = lazyWithRetry(() => import('./pages/MobiusOverviewClusterPage'))
const ProjectPage = lazyWithRetry(() => import('./pages/ProjectPage'))
const IssuePage = lazyWithRetry(() => import('./pages/IssuePage'))
const ResearchPage = lazyWithRetry(() => import('./pages/ResearchPage'))
const AssistantChat = lazyWithRetry(() => import('./components/assistant-chat').then(module => ({ default: module.AssistantChat })))
const TourController = lazyWithRetry(() => import('./components/tour-controller').then(module => ({ default: module.TourController })))
// 桌面端多 tab 卡片栏（实验版 0.0.12）：仅 isDesktop 渲染，web 端自退场，lazy 不进网页端首屏 bundle。
const DesktopTabBar = lazyWithRetry(() => import('./components/desktop-tab-bar').then(module => ({ default: module.DesktopTabBar })))

// 渲染期 chunk 加载失败兜底: 自迭代重新部署后, 旧 tab 拉不到新 chunk 会在 render 抛错.
// 没有 ErrorBoundary 时 React 18 会卸载整棵树 -> 白屏, 且该错误不冒泡到 window.onerror.
// 这里捕获后, 若是 stale chunk 就走 triggerStaleReload (弹 confirm 硬刷新); 否则给手动刷新入口.
class StaleChunkErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(err: unknown) {
    if (isStaleChunkError(err)) triggerStaleReload()
  }
  render() {
    if (this.state.hasError) {
      return (
        <div
          className="flex h-screen w-screen flex-col items-center justify-center gap-3"
          style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}
        >
          <div className="text-sm">页面加载失败，可能是 Mobius 刚完成一次自我迭代。</div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border px-4 py-1.5 text-sm transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-primary)', borderColor: 'var(--border-color-strong)' }}
          >
            立即刷新
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const SELF_ITERATION_STORAGE_KEY = 'mobius:self-iteration:backend-code-version'
const SELF_ITERATION_WINDOW_MS = 3 * 60 * 1000
const SELF_ITERATION_TOAST_DURATION_MS = 15 * 1000
const SELF_ITERATION_POLL_MS = 20 * 1000

type BackendHealth = {
  version?: string
  code_version?: string
  git_commit?: string | null
  started_at_ms?: number
  uptime_ms?: number
}

function RouteFallback() {
  return (
    <div
      className="flex h-screen w-screen items-center justify-center"
      style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)' }}
      role="status"
      aria-label="正在加载"
    >
      <div
        className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent"
        aria-hidden="true"
      />
    </div>
  )
}

// 桌面端: 把窗口按钮图标色上报给主进程 setTitleBarOverlay。
// overlay 背景透明 → 直接透出顶栏 var(--bg-primary) (切主题自动变色), 故这里只需让按钮图标色随主题明暗。
// rAF 延迟一帧, 确保 class / 自定义主题 style 都已落到 :root 再读 CSS 变量。Web 端无 mobiusDesktop → 直接 no-op。
function pushDesktopTitleBarTheme() {
  const md = typeof window !== 'undefined'
    ? (window as { mobiusDesktop?: { isDesktop?: boolean; setTitleBarOverlay?: (o: { color?: string; symbolColor?: string }) => Promise<unknown> } }).mobiusDesktop
    : undefined
  if (!md?.isDesktop || typeof md.setTitleBarOverlay !== 'function') return
  requestAnimationFrame(() => {
    const cs = getComputedStyle(document.documentElement)
    const color = cs.getPropertyValue('--bg-primary').trim() || '#0a0e16'
    const symbolColor = cs.getPropertyValue('--text-primary').trim() || '#e5e7eb'
    md.setTitleBarOverlay!({ color, symbolColor }).catch(() => {})
  })
}

function healthCodeVersion(health: BackendHealth) {
  return health.code_version || health.git_commit || health.version || null
}

function healthUptimeMs(health: BackendHealth) {
  if (typeof health.uptime_ms === 'number') return health.uptime_ms
  if (typeof health.started_at_ms === 'number') return Date.now() - health.started_at_ms
  return null
}

function readRememberedCodeVersion() {
  try {
    return localStorage.getItem(SELF_ITERATION_STORAGE_KEY)
  } catch (_) {
    return null
  }
}

function rememberCodeVersion(codeVersion: string) {
  try {
    localStorage.setItem(SELF_ITERATION_STORAGE_KEY, codeVersion)
  } catch (_) {
    /* localStorage may be unavailable in restricted browser modes. */
  }
}

function SelfIterationToast() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let alive = true

    // 自递归轮询: 上一次返回(或超时放弃)后才排下一次, 10s 超时主动 abort, 卡顿时不堆积.
    const stop = pollRecursive(async (signal) => {
      const health = await api('/api/v2/health', { signal }) as BackendHealth
      if (!alive) return

      const codeVersion = healthCodeVersion(health)
      if (!codeVersion) return

      const remembered = readRememberedCodeVersion()
      const uptimeMs = healthUptimeMs(health)
      const backendJustStarted = uptimeMs != null && uptimeMs >= 0 && uptimeMs <= SELF_ITERATION_WINDOW_MS
      const codeChanged = remembered != null && remembered !== codeVersion

      rememberCodeVersion(codeVersion)
      if (backendJustStarted && codeChanged) setVisible(true)
    }, SELF_ITERATION_POLL_MS)
    return () => { alive = false; stop() }
  }, [])

  useEffect(() => {
    if (!visible) return undefined
    const timer = window.setTimeout(() => setVisible(false), SELF_ITERATION_TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [visible])

  if (!visible) return null

  return (
    <ToastCard
      tone="success"
      icon={<CheckCircle2 className="h-4 w-4" strokeWidth={2} />}
      title="Mobius已完成一次自我迭代"
      onClose={() => setVisible(false)}
    />
  )
}

// 小莫(或用户)派出去的任务 Session 跑完时, 在右上角弹一个完成/失败提醒。
// 复用 ToastCard 外观; 完成态来源 = /api/tasks/recent 里 session 的 agent_status
// (后端 agent-status-syncer 写入的单一真相源, completed/failed)。仅当某 session
// 从"进行中(idle/running/waiting)"跳变到终态、且用户当前没停在该会话页时才提醒, 防刷屏。
const ASSISTANT_TASK_POLL_MS = 8000
const ASSISTANT_TASK_SUCCESS_DURATION_MS = 6000

type AssistantTaskDoneEntry = {
  sessionId: string
  name: string
  scopeType: string
  projectId: string | null
  issueId: string | null
  researchId: string | null
  failed: boolean
}

function AssistantTaskDoneToast() {
  const { user } = useStore()
  const navigate = useNavigate()
  const [entry, setEntry] = useState<AssistantTaskDoneEntry | null>(null)
  // entryRef: 让轮询闭包读到最新"当前是否在展示", 不用把 entry 放进 effect 依赖(避免每次弹/收都重启轮询)
  const entryRef = useRef<AssistantTaskDoneEntry | null>(null)
  // 记每个 session 上一次的 agent_status, 用于识别"进行中 → 终态"的跳变
  const prevStatusRef = useRef<Map<string, string>>(new Map())
  // 已提醒过的 session 不再重复提醒(同一次会话内)
  const notifiedRef = useRef<Set<string>>(new Set())
  // 待展示队列: 一次只弹一条; 多个任务在同一轮询窗口内同时完成时按到达顺序依次弹出, 不丢
  const queueRef = useRef<AssistantTaskDoneEntry[]>([])
  // 浏览器 Notification 权限只请求一次; denied 后不再骚扰
  const notifPermissionAskedRef = useRef(false)

  const showEntry = useCallback((e: AssistantTaskDoneEntry | null) => {
    entryRef.current = e
    setEntry(e)
  }, [])

  // 后台标签页: 用浏览器系统级 Notification 提醒(网页内 ToastCard 用户根本看不到)。
  // 需要权限; 点击通知聚焦窗口并深链到对应会话。
  const notifyInBackground = useCallback((e: AssistantTaskDoneEntry) => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'denied') return
    if (Notification.permission !== 'granted') {
      if (notifPermissionAskedRef.current) return
      notifPermissionAskedRef.current = true
      // 权限请求必须由用户手势触发才可靠; 后台自动弹的 requestPermission 多数浏览器会忽略。
      // 这里仍尝试一次(部分浏览器允许), 被忽略也不影响 — 用户下次可见时操作会再触发。
      void Notification.requestPermission().then(() => {})
      return
    }
    const openTarget = e.sessionId
      ? sessionNavigation(user?.id || '', e.sessionId)
      : null
    try {
      const n = new Notification(
        e.failed ? '小莫任务失败' : '小莫已完成任务',
        {
          body: e.name,
          tag: `mobius-task-${e.sessionId}`, // 同 session 去重, 系统层不堆叠
        },
      )
      n.onclick = () => {
        window.focus()
        if (openTarget) navigateToWorkbench(navigate, openTarget)
        n.close()
      }
      // 失败常驻到用户处理; 成功 8s 自动收
      if (!e.failed) setTimeout(() => n.close(), ASSISTANT_TASK_SUCCESS_DURATION_MS)
    } catch {
      /* 某些环境(无 SW 的 http 等)构造会抛, 忽略 */
    }
  }, [user, navigate])

  useEffect(() => {
    if (!user) return
    const stop = pollRecursive(async (signal) => {
      // 后台不再跳过: 跳过就无法察觉任务完成(需求: 不可见时走浏览器 Notification)。
      // 后台标签页浏览器会节流 setTimeout, 轮询自然放缓, 不会请求堆积。
      let recent: any[] = []
      try {
        recent = await api('/api/tasks/recent?limit=50', { signal }) as any[]
      } catch {
        return // 网络抖动/超时忽略, 下一轮再来(pollRecursive 外层也有兜底)
      }
      if (!Array.isArray(recent)) return
      // 短路由不再把 session 放在 query 中；兼容旧长链时仍保留 query 回退。
      const shortRouteMatch = window.location.pathname.match(/\/u\/[^/]+\/s\/([^/]+)/)
      let shortRouteSessionId = ''
      try { shortRouteSessionId = shortRouteMatch?.[1] ? decodeURIComponent(shortRouteMatch[1]) : '' } catch {}
      const currentSessionId = shortRouteSessionId || new URLSearchParams(window.location.search).get('session')
      const visible = document.visibilityState === 'visible'
      for (const s of recent) {
        const sid = String(s?.session_id || '')
        if (!sid) continue
        const status = String(s?.agent_status || 'idle')
        const prev = prevStatusRef.current.get(sid)
        prevStatusRef.current.set(sid, status)
        const wasActive = prev === 'idle' || prev === 'running' || prev === 'waiting'
        const terminal = status === 'completed' || status === 'failed'
        // 仅在 进行中→终态 的跳变、且未提醒过、且不是当前正查看的会话 时入队
        if (wasActive && terminal && !notifiedRef.current.has(sid) && sid !== currentSessionId) {
          notifiedRef.current.add(sid)
          const item: AssistantTaskDoneEntry = {
            sessionId: sid,
            name: String(s?.name || '未命名任务'),
            scopeType: String(s?.scope_type || 'issue'),
            projectId: s?.project_id ?? null,
            issueId: s?.issue_id ?? null,
            researchId: s?.research_id ?? null,
            failed: status === 'failed',
          }
          // 可见 → 网页内 ToastCard(队列依次弹); 不可见 → 浏览器系统通知(即发, 不占网页队列)
          if (visible) {
            queueRef.current.push(item)
          } else {
            notifyInBackground(item)
          }
        }
      }
      // 当前没在展示且队列有积压 → 取下一条
      if (visible && !entryRef.current && queueRef.current.length > 0) {
        showEntry(queueRef.current.shift() as AssistantTaskDoneEntry)
      }
    }, ASSISTANT_TASK_POLL_MS)
    return () => stop()
  }, [user, showEntry, notifyInBackground])

  // 成功自动消失; 失败常驻到用户手动关闭(失败值得多看一眼)。消失后上面 effect 会自动取下一条。
  useEffect(() => {
    if (!entry || entry.failed) return
    const t = window.setTimeout(() => showEntry(null), ASSISTANT_TASK_SUCCESS_DURATION_MS)
    return () => window.clearTimeout(t)
  }, [entry, showEntry])

  // 可见期间入队但还没来得及展示、用户就切走的条目: 切到后台瞬间把积压队列转成系统通知, 不丢提醒。
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return
      while (queueRef.current.length > 0) {
        notifyInBackground(queueRef.current.shift() as AssistantTaskDoneEntry)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [notifyInBackground])

  if (!entry || !user) return null

  // 完成提醒统一打开 Session 短路由，由 WorkPage 还原 Issue/Research 上下文。
  const openTarget = entry.sessionId
    ? sessionNavigation(user.id, entry.sessionId)
    : null

  return (
    <ToastCard
      tone={entry.failed ? 'error' : 'success'}
      icon={entry.failed
        ? <AlertTriangle className="h-4 w-4" strokeWidth={2} />
        : <CheckCircle2 className="h-4 w-4" strokeWidth={2} />}
      title={entry.failed ? '小莫任务失败' : '小莫已完成任务'}
      subtitle={entry.name}
      actionLabel={openTarget ? '查看' : undefined}
      onAction={openTarget ? () => navigateToWorkbench(navigate, openTarget) : undefined}
      onClose={() => showEntry(null)}
    />
  )
}

function RootRedirect() {
  const { user } = useStore()
  if (!user) return null
  return <Navigate to={homePath(user.id)} replace />
}

function WorkbenchMainFallback() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center" role="status" aria-label="正在加载">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
    </div>
  )
}

function decodeWorkbenchPathSegment(value: string | undefined) {
  if (!value) return ''
  try { return decodeURIComponent(value) } catch { return '' }
}

function WorkbenchRouteLayout() {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { currentIssue, currentProject, currentSession } = useStore()
  const userId = params.user || ''
  const search = new URLSearchParams(location.search)
  const sessionRouteMatch = location.pathname.match(/^\/u\/[^/]+\/s\/([^/]+)\/?$/)
  const issueRouteMatch = location.pathname.match(/^\/u\/[^/]+\/p\/([^/]+)\/i\/([^/]+)\/?$/)
  const isHomeRoute = location.pathname === homePath(userId)
  const isIssueRoute = !!issueRouteMatch
  const advancedHome = isHomeRoute && search.get('view') === 'projects'
  const activeSessionId = decodeWorkbenchPathSegment(sessionRouteMatch?.[1]) || search.get('session') || ''
  const sessionProjectId = currentSession?.session_id === activeSessionId
    ? String((currentSession as any)?.project_id || '')
    : ''
  const routeProjectId = decodeWorkbenchPathSegment(issueRouteMatch?.[1])
  const projectId = routeProjectId || sessionProjectId || search.get('project') || currentProject?.id || ''
  const topbarTitle = activeSessionId
    ? 'Session'
    : isIssueRoute
      ? currentIssue?.title || 'Issue'
      : 'Home'

  const startNewConversation = useCallback(() => {
    if (isIssueRoute) {
      const next = new URLSearchParams(location.search)
      next.delete('session')
      const suffix = next.toString()
      navigate(`${location.pathname}${suffix ? `?${suffix}` : ''}`)
    } else {
      navigate(homePath(userId, { projectId }))
    }
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('mobius:new-conversation')), 80)
  }, [isIssueRoute, location.pathname, location.search, navigate, projectId, userId])

  if (advancedHome) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Outlet />
      </Suspense>
    )
  }

  return (
    <WorkbenchShell
      userId={userId}
      activeSessionId={activeSessionId}
      projectId={projectId}
      onNewConversation={startNewConversation}
      topbarTitle={topbarTitle}
    >
      <Suspense fallback={<WorkbenchMainFallback />}>
        <Outlet />
      </Suspense>
    </WorkbenchShell>
  )
}

function EasyModeCompatibility() {
  const location = useLocation()
  const { user } = useStore()
  const userId = user?.id || ''
  return <Navigate to={`/u/${encodeURIComponent(userId)}/easy_mode${location.search}${location.hash}`} replace />
}

function IssueRouteCompatibility() {
  const params = useParams()
  const location = useLocation()
  const redirect = legacySessionRedirect(params.user || '', location.search, location.hash)
  return redirect ? <Navigate to={redirect} replace /> : <IssuePage />
}

// 与 origin/main 保持一致：只有用户首页和 Issue 页需要在首次访问时选择模式。
// 项目、Research、Overview 等高级页不受简易模式接管。
function layoutModeTargetPath(pathname: string) {
  const userHome = pathname.match(/^\/u\/([^/]+)\/?$/)
  if (userHome) return { user: userHome[1] }
  const issuePage = pathname.match(/^\/u\/([^/]+)\/p\/[^/]+\/i\/[^/]+\/?$/)
  if (issuePage) return { user: issuePage[1] }
  return null
}

function NormalSessionRedirect() {
  const params = useParams()
  const { currentSession } = useStore()
  const userId = params.user || ''
  const sessionId = params.session || ''
  const [target, setTarget] = useState('')

  useEffect(() => {
    if (!sessionId) {
      setTarget(homePath(userId))
      return
    }
    let cancelled = false
    const resolveTarget = (session: any) => {
      if (cancelled) return
      setTarget(buildNormalModeTargetUrl({
        user: userId,
        projectId: session?.project_id,
        issueId: session?.issue_id,
        researchId: session?.research_id,
        scopeType: session?.scope_type === 'research' || session?.research_id ? 'research' : 'issue',
        sessionId,
      }))
    }
    if (currentSession?.session_id === sessionId) {
      resolveTarget(currentSession)
      return () => { cancelled = true }
    }
    api(`/api/tasks/${encodeURIComponent(sessionId)}`)
      .then(resolveTarget)
      .catch(() => { if (!cancelled) setTarget(homePath(userId)) })
    return () => { cancelled = true }
  }, [currentSession, sessionId, userId])

  return target ? <Navigate to={target} replace /> : <RouteFallback />
}

function AuthenticatedApp() {
  const { user, assistantBubbleEnabled } = useStore()
  const location = useLocation()
  const clientRuntime = detectClientRuntime()
  const layoutMode = useLayoutMode()

  useEffect(() => startTextRedactionRuntime(), [])

  if (!user) return null
  // 兼容旧链接：根路径或未匹配路由 → 默认进我的项目页
  if (location.pathname === '/' || location.pathname === '') {
    return <Navigate to={homePath(user.id)} replace />
  }
  const modeTarget = layoutModeTargetPath(location.pathname)
  if (modeTarget && !layoutMode) {
    return (
      <>
        <RouteFallback />
        <LayoutModeChoiceModal />
      </>
    )
  }
  return (
    <>
      <StaleChunkErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          {layoutMode === 'easy_mode' ? (
            <Routes>
              <Route path="/" element={<RootRedirect />} />
              <Route path="/welcome" element={<><DesktopTitleBar /><Welcome /></>} />
              <Route path="/u/:user" element={<WorkbenchRouteLayout />}>
                <Route index element={<UserPage />} />
                <Route path="s/:session" element={<WorkPage />} />
                <Route path="p/:project/i/:issue" element={<IssueRouteCompatibility />} />
              </Route>
              <Route path="/easy_mode" element={<EasyModeCompatibility />} />
              <Route path="/u/:user/easy_mode" element={<EasyModePage />} />
              <Route path="/u/:user/mobius_overview" element={<MobiusOverviewPage />} />
              <Route path="/u/:user/mobius_overview_cluster" element={<MobiusOverviewClusterPage />} />
              <Route path="/u/:user/p/:project" element={<ProjectPage />} />
              <Route path="/u/:user/p/:project/r/:research" element={<ResearchPage />} />
              <Route path="*" element={<RootRedirect />} />
            </Routes>
          ) : (
            <Routes>
              <Route path="/" element={<RootRedirect />} />
              <Route path="/welcome" element={<><DesktopTitleBar /><Welcome /></>} />
              <Route path="/easy_mode" element={<EasyModeCompatibility />} />
              <Route path="/u/:user/easy_mode" element={<EasyModePage />} />
              <Route path="/u/:user" element={<UserPage />} />
              <Route path="/u/:user/s/:session" element={<NormalSessionRedirect />} />
              <Route path="/u/:user/mobius_overview" element={<MobiusOverviewPage />} />
              <Route path="/u/:user/mobius_overview_cluster" element={<MobiusOverviewClusterPage />} />
              <Route path="/u/:user/p/:project" element={<ProjectPage />} />
              <Route path="/u/:user/p/:project/i/:issue" element={<IssuePage />} />
              <Route path="/u/:user/p/:project/r/:research" element={<ResearchPage />} />
              <Route path="*" element={<RootRedirect />} />
            </Routes>
          )}
        </Suspense>
      </StaleChunkErrorBoundary>
      <SelfIterationToast />
      <AssistantTaskDoneToast />
      <Suspense fallback={null}>
        <TourController />
      </Suspense>
      {assistantBubbleEnabled ? (
        <Suspense fallback={null}>
          <AssistantChat />
        </Suspense>
      ) : null}
      {clientRuntime === 'desktop' ? (
        <Suspense fallback={null}>
          <DesktopTabBar />
        </Suspense>
      ) : null}
      <AdminOverlayHost />
    </>
  )
}

export default function App() {
  const { token, user, authChecking, theme, backgroundFlowEnabled, logout } = useStore()

  useEffect(() => {
    if (token && !user) {
      // 标记"会话校验中": 期间 App 渲染加载态而非登录页, 避免弱网下闪现登录页.
      useStore.setState({ authChecking: true })
      api('/api/auth/me')
        .then(u => useStore.getState().setAuth(token, u))
        .catch(() => {
          // 区分"未授权"与"网络错误":
          //  - 401 已在 api() 内清 token 并跳转首页, 这里仅收尾 authChecking.
          //  - 网络错误(fetch reject)时 token 仍有效, 不主动 logout, 保留 token
          //    以便刷新后继续校验, 避免弱网偶发失败把已登录用户误踢回登录页.
          const tokenStillValid = !!localStorage.getItem('cc-token')
          useStore.setState({ authChecking: false })
          if (!tokenStillValid) logout()
        })
    }
  }, [token])

  useEffect(() => {
    const root = document.documentElement
    root.classList.remove(...THEME_NAMES)
    root.classList.add(theme)
    pushDesktopTitleBarTheme()
  }, [theme])

  useEffect(() => {
    document.documentElement.classList.toggle('mobius-bg-flow', backgroundFlowEnabled)
  }, [backgroundFlowEnabled])

  // 自定义主题的覆写 :root.style 必须在每次基础主题切换时重新套一次,
  // 因为 .dark 等类本身的 CSS 变量是在 cascade 较低优先级生效的.
  useEffect(() => {
    const activeId = loadActiveCustomThemeId()
    if (!activeId) { applyCustomThemeToRoot(null); return }
    const map = loadCustomThemes()
    applyCustomThemeToRoot(map[activeId] || null)
    pushDesktopTitleBarTheme()
  }, [theme])

  // 有 token 但会话尚在校验: 显示加载态, 而不是登录页(消除弱网下闪现登录页).
  if (token && authChecking && !user) {
    return <RouteFallback />
  }

  if (!token || !user) {
    return (
      <StaleChunkErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          <Login />
        </Suspense>
      </StaleChunkErrorBoundary>
    )
  }

  return (
    <BrowserRouter>
      <AuthenticatedApp />
    </BrowserRouter>
  )
}
