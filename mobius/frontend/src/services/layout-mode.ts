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
