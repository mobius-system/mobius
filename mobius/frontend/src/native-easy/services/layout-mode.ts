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

export function buildNormalModeTargetUrl(args: {
  user?: string | null
  projectId?: string | null
  issueId?: string | null
  researchId?: string | null
  scopeType?: 'issue' | 'research' | null
  sessionId?: string | null
}): string {
  const { user, projectId, issueId, researchId, scopeType, sessionId } = args
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
