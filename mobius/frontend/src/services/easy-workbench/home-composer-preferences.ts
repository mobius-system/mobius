export const HOME_LAST_PROJECT_ID_KEY = 'mobius:ui:home:last-project-id'
export const HOME_LAST_MODEL_KEY = 'mobius:ui:home:last-model'

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

function availableStorage(storage?: PreferenceStorage | null): PreferenceStorage | null {
  if (storage !== undefined) return storage
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

export function readHomePreference(key: string, storage?: PreferenceStorage | null): string {
  try {
    const raw = availableStorage(storage)?.getItem(key)
    if (!raw) return ''
    const parsed = JSON.parse(raw)
    return typeof parsed === 'string' ? parsed.trim() : ''
  } catch {
    return ''
  }
}

export function writeHomePreference(key: string, value: string, storage?: PreferenceStorage | null): void {
  try {
    availableStorage(storage)?.setItem(key, JSON.stringify(String(value || '').trim()))
  } catch {
    // localStorage 在隐私模式或被禁用时不阻断首页操作。
  }
}

export function readLastHomeProjectId(storage?: PreferenceStorage | null): string {
  return readHomePreference(HOME_LAST_PROJECT_ID_KEY, storage)
}

export function rememberLastHomeProjectId(projectId: string, storage?: PreferenceStorage | null): void {
  writeHomePreference(HOME_LAST_PROJECT_ID_KEY, projectId, storage)
}

export function readLastHomeModel(storage?: PreferenceStorage | null): string {
  return readHomePreference(HOME_LAST_MODEL_KEY, storage)
}

export function rememberLastHomeModel(model: string, storage?: PreferenceStorage | null): void {
  writeHomePreference(HOME_LAST_MODEL_KEY, model, storage)
}
