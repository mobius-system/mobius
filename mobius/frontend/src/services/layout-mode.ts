import { useSyncExternalStore } from 'react'

export const LAYOUT_MODE_STORAGE_KEY = 'layout_mode'
export const LAYOUT_MODE_CHANGE_EVENT = 'mobius:layout-mode-change'

export type LayoutMode = 'easy_mode' | 'normal_mode'

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
