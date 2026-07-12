import { Suspense, lazy, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { CheckCircle2, X } from 'lucide-react'
import { useStore, api } from './store'
import { startTextRedactionRuntime } from './services/text-redaction'
import { THEME_NAMES } from './theme'
import { applyCustomThemeToRoot, loadActiveCustomThemeId, loadCustomThemes } from './services/custom-themes'

const Login = lazy(() => import('./pages/Login'))
const UserPage = lazy(() => import('./pages/UserPage'))
const ProjectPage = lazy(() => import('./pages/ProjectPage'))
const IssuePage = lazy(() => import('./pages/IssuePage'))
const ResearchPage = lazy(() => import('./pages/ResearchPage'))
const AssistantChat = lazy(() => import('./components/assistant-chat').then(module => ({ default: module.AssistantChat })))
const TourController = lazy(() => import('./components/tour-controller').then(module => ({ default: module.TourController })))

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
    const symbolColor = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#e5e7eb'
    md.setTitleBarOverlay!({ color: 'rgba(0,0,0,0)', symbolColor }).catch(() => {})
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
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<RootRedirect />} />
          <Route path="/u/:user" element={<UserPage />} />
          <Route path="/u/:user/p/:project" element={<ProjectPage />} />
          <Route path="/u/:user/p/:project/i/:issue" element={<IssuePage />} />
          <Route path="/u/:user/p/:project/r/:research" element={<ResearchPage />} />
          <Route path="*" element={<RootRedirect />} />
        </Routes>
      </Suspense>
      <SelfIterationToast />
      <Suspense fallback={null}>
        <TourController />
      </Suspense>
      <Suspense fallback={null}>
        <AssistantChat />
      </Suspense>
    </>
  )
}

export default function App() {
  const { token, user, theme, backgroundFlowEnabled, logout } = useStore()

  useEffect(() => {
    if (token && !user) {
      api('/api/auth/me').then(u => useStore.getState().setAuth(token, u)).catch(() => logout())
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

  if (!token || !user) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Login />
      </Suspense>
    )
  }

  return (
    <BrowserRouter>
      <AuthenticatedApp />
    </BrowserRouter>
  )
}
