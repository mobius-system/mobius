import { Component, Suspense, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { CheckCircle2, X } from 'lucide-react'
import { useStore, api } from './store'
import { startTextRedactionRuntime } from './services/text-redaction'
import { THEME_NAMES } from './theme'
import { applyCustomThemeToRoot, loadActiveCustomThemeId, loadCustomThemes } from './services/custom-themes'
import { DesktopTitleBar } from './components/window-controls'
import { lazyWithRetry, isStaleChunkError, triggerStaleReload } from './services/handle-stale-chunk'

const Login = lazyWithRetry(() => import('./pages/Login'))
const Welcome = lazyWithRetry(() => import('./pages/Welcome'))
const UserPage = lazyWithRetry(() => import('./pages/UserPage'))
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

    const checkBackendVersion = async () => {
      try {
        const health = await api('/api/v2/health') as BackendHealth
        if (!alive) return

        const codeVersion = healthCodeVersion(health)
        if (!codeVersion) return

        const remembered = readRememberedCodeVersion()
        const uptimeMs = healthUptimeMs(health)
        const backendJustStarted = uptimeMs != null && uptimeMs >= 0 && uptimeMs <= SELF_ITERATION_WINDOW_MS
        const codeChanged = remembered != null && remembered !== codeVersion

        rememberCodeVersion(codeVersion)
        if (backendJustStarted && codeChanged) setVisible(true)
      } catch (_) {
        /* Health polling should not affect normal app startup. */
      }
    }

    checkBackendVersion()
    const poll = window.setInterval(checkBackendVersion, SELF_ITERATION_POLL_MS)
    return () => { alive = false; window.clearInterval(poll) }
  }, [])

  useEffect(() => {
    if (!visible) return undefined
    const timer = window.setTimeout(() => setVisible(false), SELF_ITERATION_TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [visible])

  if (!visible) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 top-4 z-[10020] flex w-[360px] max-w-[calc(100vw-32px)] items-center gap-3 rounded-lg border px-4 py-3 shadow-2xl backdrop-blur"
      style={{
        color: 'var(--text-primary)',
        background: 'color-mix(in srgb, var(--modal-bg) 92%, transparent)',
        borderColor: 'var(--border-color-strong)',
      }}>
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-400">
        <CheckCircle2 className="h-4 w-4" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1 text-sm font-medium leading-5">
        Mobius已完成一次自我迭代
      </div>
      <button
        type="button"
        aria-label="关闭通知"
        title="关闭通知"
        onClick={() => setVisible(false)}
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
        style={{ color: 'var(--text-muted)' }}>
        <X className="h-4 w-4" strokeWidth={2} />
      </button>
    </div>
  )
}

function RootRedirect() {
  const { user } = useStore()
  if (!user) return null
  return <Navigate to={`/u/${user.id}`} replace />
}

function AuthenticatedApp() {
  const { user } = useStore()
  const location = useLocation()

  useEffect(() => startTextRedactionRuntime(), [])

  if (!user) return null
  // 兼容旧链接：根路径或未匹配路由 → 默认进我的项目页
  if (location.pathname === '/' || location.pathname === '') {
    return <Navigate to={`/u/${user.id}`} replace />
  }
  return (
    <>
      <StaleChunkErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<RootRedirect />} />
            <Route path="/welcome" element={<><DesktopTitleBar /><Welcome /></>} />
            <Route path="/u/:user" element={<UserPage />} />
            <Route path="/u/:user/p/:project" element={<ProjectPage />} />
            <Route path="/u/:user/p/:project/i/:issue" element={<IssuePage />} />
            <Route path="/u/:user/p/:project/r/:research" element={<ResearchPage />} />
            <Route path="*" element={<RootRedirect />} />
          </Routes>
        </Suspense>
      </StaleChunkErrorBoundary>
      <SelfIterationToast />
      <Suspense fallback={null}>
        <TourController />
      </Suspense>
      <Suspense fallback={null}>
        <AssistantChat />
      </Suspense>
      <Suspense fallback={null}>
        <DesktopTabBar />
      </Suspense>
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
