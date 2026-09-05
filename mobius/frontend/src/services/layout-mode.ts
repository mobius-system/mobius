import { useSyncExternalStore } from 'react'

export const LAYOUT_MODE_STORAGE_KEY = 'layout_mode'
export const LAYOUT_MODE_CHANGE_EVENT = 'mobius:layout-mode-change'
// 会话内呈现密度 (极简/专业) 的独立存储: 与全局 layout_mode 解耦.
// 全局 mode 决定"落在哪个页面" (easy_mode 页 vs Issue/Research 页);
// 呈现密度决定"会话区怎么画" (ChatArea layout=easy vs default), 在原地切换时使用,
// 切换不导航、不卸载组件, 因此代码对话等工作区状态全部保留.
export const SESSION_DENSITY_STORAGE_KEY = 'mobius:ui:session-density'
export const SESSION_DENSITY_CHANGE_EVENT = 'mobius:session-density-change'

export type LayoutMode = 'easy_mode' | 'normal_mode'
export type SessionDensity = 'easy' | 'professional'

export function readLayoutMode(): LayoutMode | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(LAYOUT_MODE_STORAGE_KEY)
    return value === 'easy_mode' || value === 'normal_mode' ? value : null
  } catch {
    return null
  }
}

export function setLayoutMode(mode: LayoutMode) {
  window.localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, mode)
  window.dispatchEvent(new CustomEvent(LAYOUT_MODE_CHANGE_EVENT, { detail: mode }))
}

// 从简易模式切回正常模式时, 根据当前选中的会话构造应回到的目标 URL.
// 优先回到该会话在正常模式下的 Issue/Research 页 (保留 session 参数, 命中后 IssuePage
// 会用 ?session= 自动选中同一会话); 缺少项目/任务上下文时回退到用户主页, 与旧行为一致.
export function buildNormalModeTargetUrl(args: {
  user?: string | null
  projectId?: string | null
  issueId?: string | null
  researchId?: string | null
  scopeType?: 'issue' | 'research' | null
  sessionId?: string | null
}): string {
  const { user, projectId, issueId, researchId, scopeType, sessionId } = args
  // 路由参数理论上一定存在; 缺失时回退到根路径, 由 App 重定向到当前用户主页.
  if (!user) return '/'
  const search = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
  if (scopeType === 'research' && projectId && researchId) {
    return `/u/${user}/p/${projectId}/r/${researchId}${search}`
  }
  if (projectId && issueId) {
    return `/u/${user}/p/${projectId}/i/${issueId}${search}`
  }
  if (projectId && researchId) {
    return `/u/${user}/p/${projectId}/r/${researchId}${search}`
  }
  // 有项目上下文但拿不到具体 Issue/Research 时, 回到项目页而非用户首页,
  // 至少把用户留在原项目范围内, 避免"切个模式就被踢回总首页"的断裂感.
  if (projectId) {
    return `/u/${user}/p/${projectId}`
  }
  return `/u/${user}`
}

function subscribeSessionDensity(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SESSION_DENSITY_STORAGE_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(SESSION_DENSITY_CHANGE_EVENT, listener)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(SESSION_DENSITY_CHANGE_EVENT, listener)
  }
}

// 初始未显式选择时, 跟随全局 layout_mode (easy_mode 用户天然拿到极简呈现).
export function readSessionDensity(): SessionDensity | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(SESSION_DENSITY_STORAGE_KEY)
    return value === 'easy' || value === 'professional' ? value : null
  } catch {
    return null
  }
}

export function setSessionDensity(density: SessionDensity) {
  window.localStorage.setItem(SESSION_DENSITY_STORAGE_KEY, density)
  window.dispatchEvent(new CustomEvent(SESSION_DENSITY_CHANGE_EVENT, { detail: density }))
}

function useSessionDensityBase(): SessionDensity | null {
  return useSyncExternalStore(subscribeSessionDensity, readSessionDensity, () => null)
}

// 会话内呈现密度 hook: 未显式设置时回落到全局模式推导的默认值.
export function useSessionDensity(): SessionDensity {
  const density = useSessionDensityBase()
  const layoutMode = useLayoutMode()
  return density || (layoutMode === 'easy_mode' ? 'easy' : 'professional')
}

function subscribeLayoutMode(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === LAYOUT_MODE_STORAGE_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(LAYOUT_MODE_CHANGE_EVENT, listener)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(LAYOUT_MODE_CHANGE_EVENT, listener)
  }
}

export function useLayoutMode() {
  return useSyncExternalStore(subscribeLayoutMode, readLayoutMode, () => null)
}
