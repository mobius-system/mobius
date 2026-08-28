export const LOGO_REVIEW_DEMO_TOUR_EVENT = 'imac:logo-review-demo-tour:start'
export const LOGO_REVIEW_DEMO_STATE_KEY = 'imac-demo:mobius-dot-logo-space-review'

export const LOGO_REVIEW_PROJECT_ID = '9986bdc3'
export const LOGO_REVIEW_PROJECT_NAME = '莫比乌斯光点标志空间案例'
export const LOGO_REVIEW_ISSUE_TITLE = '设计莫比乌斯光点标志空间'
export const LOGO_REVIEW_SESSION_NAME = '迭代 Three.js 光点标志空间'
export const LOGO_REVIEW_EXTENSION_PROJECT_ID = 'ext_dot-logo-3d'
export const LOGO_REVIEW_EXTENSION_NAME = 'dot-logo-3d'
export const LOGO_REVIEW_EXTENSION_URL = '/extension/dot-logo-3d/'

export type LogoReviewDemoState = {
  active?: boolean
  startedAt?: number
  completedAt?: number
  sessionCompletedAt?: number
  projectId: string
  projectName: string
  projectDescription?: string
  projectRelPath?: string
  issueTitle: string
  issueDescription?: string
  sessionName: string
  sessionDescription?: string
  extensionProjectId: string
  extensionName: string
  extensionUrl: string
  issueId?: string
  sessionId?: string
  cleanupProjectId?: string
  cleanupProjectName?: string
  cleanupProjectRelPath?: string
}

export const LOGO_REVIEW_DEMO_DEFAULTS = {
  projectId: LOGO_REVIEW_PROJECT_ID,
  projectName: LOGO_REVIEW_PROJECT_NAME,
  issueTitle: LOGO_REVIEW_ISSUE_TITLE,
  sessionName: LOGO_REVIEW_SESSION_NAME,
  extensionProjectId: LOGO_REVIEW_EXTENSION_PROJECT_ID,
  extensionName: LOGO_REVIEW_EXTENSION_NAME,
  extensionUrl: LOGO_REVIEW_EXTENSION_URL,
} satisfies Omit<
  LogoReviewDemoState,
  'active' | 'startedAt' | 'completedAt' | 'issueId' | 'sessionId' | 'cleanupProjectId' | 'cleanupProjectName' | 'cleanupProjectRelPath'
>

export function createLogoReviewDemoState(patch: Partial<LogoReviewDemoState> = {}): LogoReviewDemoState {
  return {
    active: true,
    startedAt: Date.now(),
    ...LOGO_REVIEW_DEMO_DEFAULTS,
    ...patch,
  }
}

function normalizeLogoReviewDemoState(value: unknown): LogoReviewDemoState | null {
  if (!value || typeof value !== 'object') return null
  return {
    active: true,
    ...LOGO_REVIEW_DEMO_DEFAULTS,
    ...(value as Partial<LogoReviewDemoState>),
  }
}

export function readLogoReviewDemoState(): LogoReviewDemoState | null {
  try {
    const raw = sessionStorage.getItem(LOGO_REVIEW_DEMO_STATE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return normalizeLogoReviewDemoState(parsed)
  } catch {
    return null
  }
}

export function writeLogoReviewDemoState(state: LogoReviewDemoState) {
  try {
    sessionStorage.setItem(LOGO_REVIEW_DEMO_STATE_KEY, JSON.stringify(state))
  } catch {}
}

export function patchLogoReviewDemoState(patch: Partial<LogoReviewDemoState>) {
  const current = readLogoReviewDemoState() || createLogoReviewDemoState()
  writeLogoReviewDemoState({ ...current, ...patch })
}

export function completeLogoReviewDemoState() {
  patchLogoReviewDemoState({ active: false, completedAt: Date.now() })
}

export function isLogoReviewDemoCleanupProject(projectId?: string) {
  const state = readLogoReviewDemoState()
  return !!state?.active && !!projectId && state.cleanupProjectId === projectId
}

export function isLogoReviewDemoSession(sessionId?: string) {
  const state = readLogoReviewDemoState()
  return !!state?.active && !!sessionId && state.sessionId === sessionId
}
