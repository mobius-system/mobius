export type WorkbenchFocusTarget = 'composer' | 'main-heading'
export type SystemVisualizationKind = 'overview' | 'cluster'

export type WorkbenchReturnContext = 'home' | 'session' | 'project'
export type WorkbenchSourceSurface = 'issue' | 'research'

export type WorkbenchNavigationState = {
  workbench: {
    focus: WorkbenchFocusTarget
    returnTo?: string
    sourceSurface?: WorkbenchSourceSurface
  }
}

export type WorkbenchNavigationTarget = {
  path: string
  state: WorkbenchNavigationState
}

export type WorkbenchNavigate = (
  path: string,
  options?: { replace?: boolean; state?: unknown },
) => void

export const WORKBENCH_EXIT_CENTER_TOOL_EVENT = 'mobius:workbench-exit-center-tool'
export const WORKBENCH_CLEAR_OBJECT_SELECTION_EVENT = 'mobius:workbench-clear-object-selection'

type QueryValue = string | number | boolean | null | undefined
type Query = Record<string, QueryValue>

const INTERNAL_ORIGIN = 'https://mobius.invalid'
const WORKBENCH_PATH = /^\/(?:u(?:\/|$)|welcome(?:\/|$))/
const SESSION_RETURN_PATH = /^\/u\/[^/]+\/s\/[^/]+(?:\/|$)/
const PROJECT_RETURN_PATH = /^\/u\/[^/]+\/p\/[^/]+(?:\/|$)/

function segment(value: string) {
  return encodeURIComponent(String(value || ''))
}

function withQuery(path: string, query: Query = {}) {
  const search = new URLSearchParams()
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '' || value === false) return
    search.set(key, value === true ? '1' : String(value))
  })
  const suffix = search.toString()
  return suffix ? `${path}?${suffix}` : path
}

function target(path: string, focus: WorkbenchFocusTarget, returnTo?: string, sourceSurface?: WorkbenchSourceSurface): WorkbenchNavigationTarget {
  const safeReturnTo = safeWorkbenchReturnTo(returnTo)
  return {
    path,
    state: {
      workbench: {
        focus,
        ...(safeReturnTo ? { returnTo: safeReturnTo } : {}),
        ...(sourceSurface ? { sourceSurface } : {}),
      },
    },
  }
}

export function homePath(userId: string, options: { projectId?: string; view?: string; panel?: string } = {}) {
  return withQuery(`/u/${segment(userId)}`, {
    project: options.projectId,
    view: options.view,
    panel: options.panel,
  })
}

export function sessionPath(userId: string, sessionId: string, options: { match?: string; timestamp?: string } = {}) {
  return withQuery(`/u/${segment(userId)}/s/${segment(sessionId)}`, {
    match: options.match,
    ts: options.timestamp,
  })
}

export function projectPath(userId: string, projectId: string, options: { returnTo?: string } = {}) {
  return withQuery(`/u/${segment(userId)}/p/${segment(projectId)}`, {
    returnTo: safeWorkbenchReturnTo(options.returnTo),
  })
}

export function issuePath(
  userId: string,
  projectId: string,
  issueId: string,
  options: { newSession?: boolean; returnTo?: string } = {},
) {
  return withQuery(`/u/${segment(userId)}/p/${segment(projectId)}/i/${segment(issueId)}`, {
    newSession: options.newSession,
    returnTo: safeWorkbenchReturnTo(options.returnTo),
  })
}

export function researchPath(
  userId: string,
  projectId: string,
  researchId: string,
  options: {
    sessionId?: string
    view?: 'graph' | 'blackboard'
    newLeader?: boolean
    returnTo?: string
  } = {},
) {
  return withQuery(`/u/${segment(userId)}/p/${segment(projectId)}/r/${segment(researchId)}`, {
    session: options.sessionId,
    view: options.view,
    newLeader: options.newLeader,
    returnTo: safeWorkbenchReturnTo(options.returnTo),
  })
}

export function systemVisualizationPath(
  userId: string,
  kind: SystemVisualizationKind = 'cluster',
  options: { returnTo?: string } = {},
) {
  const route = kind === 'overview' ? 'mobius_overview' : 'mobius_overview_cluster'
  return withQuery(`/u/${segment(userId)}/${route}`, {
    returnTo: safeWorkbenchReturnTo(options.returnTo),
  })
}

export function homeNavigation(
  userId: string,
  options: { projectId?: string; view?: string; panel?: string; returnTo?: string } = {},
) {
  return target(homePath(userId, options), 'composer', options.returnTo)
}

export function sessionNavigation(
  userId: string,
  sessionId: string,
  options: { match?: string; timestamp?: string; returnTo?: string; sourceSurface?: WorkbenchSourceSurface } = {},
) {
  return target(sessionPath(userId, sessionId, options), 'composer', options.returnTo, options.sourceSurface)
}

export function projectNavigation(userId: string, projectId: string, options: { returnTo?: string } = {}) {
  return target(projectPath(userId, projectId, options), 'main-heading', options.returnTo)
}

export function issueNavigation(
  userId: string,
  projectId: string,
  issueId: string,
  options: { newSession?: boolean; returnTo?: string } = {},
) {
  return target(issuePath(userId, projectId, issueId, options), 'main-heading', options.returnTo)
}

export function researchNavigation(
  userId: string,
  projectId: string,
  researchId: string,
  options: { sessionId?: string; view?: 'graph' | 'blackboard'; newLeader?: boolean; returnTo?: string } = {},
) {
  return target(researchPath(userId, projectId, researchId, options), 'main-heading', options.returnTo)
}

export function systemVisualizationNavigation(
  userId: string,
  kind: SystemVisualizationKind = 'cluster',
  options: { returnTo?: string } = {},
) {
  return target(systemVisualizationPath(userId, kind, options), 'main-heading', options.returnTo)
}

export function researchGraphNavigation(userId: string, projectId: string, researchId: string, sessionId: string) {
  const returnTo = sessionPath(userId, sessionId)
  return researchNavigation(userId, projectId, researchId, {
    sessionId,
    view: 'graph',
    returnTo,
  })
}

export function navigateToWorkbench(
  navigate: WorkbenchNavigate,
  destination: WorkbenchNavigationTarget,
  options: { replace?: boolean } = {},
) {
  navigate(destination.path, { ...options, state: destination.state })
}

export function exitWorkbenchCenterTool() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(WORKBENCH_EXIT_CENTER_TOOL_EVENT))
}

export function clearWorkbenchObjectSelection() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(WORKBENCH_CLEAR_OBJECT_SELECTION_EVENT))
}

export function prepareWorkbenchObjectNavigation() {
  // 对象导航顺序是 UI 契约：先退出中心工具，再清对象选择，之后才允许改 URL / 聚焦。
  exitWorkbenchCenterTool()
  clearWorkbenchObjectSelection()
}

export function navigateToWorkbenchObject(
  navigate: WorkbenchNavigate,
  destination: WorkbenchNavigationTarget,
  options: { replace?: boolean } = {},
) {
  prepareWorkbenchObjectNavigation()
  navigateToWorkbench(navigate, destination, options)
}

export function safeWorkbenchReturnTo(value: unknown, fallback = ''): string {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    return fallback && fallback !== candidate ? safeWorkbenchReturnTo(fallback) : ''
  }
  try {
    const url = new URL(candidate, INTERNAL_ORIGIN)
    if (url.origin !== INTERNAL_ORIGIN || !WORKBENCH_PATH.test(url.pathname)) throw new Error('external route')
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return fallback && fallback !== candidate ? safeWorkbenchReturnTo(fallback) : ''
  }
}

export function readWorkbenchReturnTo(search: string | URLSearchParams, fallback = '') {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  return safeWorkbenchReturnTo(params.get('returnTo'), fallback)
}

export function readWorkbenchFocusTarget(state: unknown): WorkbenchFocusTarget | null {
  if (!state || typeof state !== 'object') return null
  const focus = (state as { workbench?: { focus?: unknown } }).workbench?.focus
  return focus === 'composer' || focus === 'main-heading' ? focus : null
}

export function readWorkbenchSourceSurface(state: unknown): WorkbenchSourceSurface | null {
  if (!state || typeof state !== 'object') return null
  const source = (state as { workbench?: { sourceSurface?: unknown } }).workbench?.sourceSurface
  return source === 'issue' || source === 'research' ? source : null
}

export function returnNavigation(
  value: unknown,
  fallback = '',
  focus: WorkbenchFocusTarget = 'composer',
): WorkbenchNavigationTarget | null {
  const path = safeWorkbenchReturnTo(value, fallback)
  return path ? target(path, focus) : null
}

export function workbenchLocationPath(
  location: { pathname?: string; search?: string; hash?: string },
  fallback = '',
) {
  return safeWorkbenchReturnTo(
    `${location.pathname || ''}${location.search || ''}${location.hash || ''}`,
    fallback,
  )
}

export function workbenchReturnContext(value: unknown): WorkbenchReturnContext {
  const path = safeWorkbenchReturnTo(value)
  if (SESSION_RETURN_PATH.test(path)) return 'session'
  if (PROJECT_RETURN_PATH.test(path)) return 'project'
  return 'home'
}

export function workbenchReturnLabel(value: unknown) {
  const context = workbenchReturnContext(value)
  if (context === 'session') return '返回来源会话'
  if (context === 'project') return '返回来源项目'
  return '返回工作台'
}

export function advancedPageReturnNavigation(value: unknown, fallback = '') {
  const path = safeWorkbenchReturnTo(value, fallback)
  if (!path) return null
  const focus: WorkbenchFocusTarget = workbenchReturnContext(path) === 'project'
    ? 'main-heading'
    : 'composer'
  return target(path, focus)
}

export function focusWorkbenchTarget(focus: WorkbenchFocusTarget, root: ParentNode = document) {
  const selector = focus === 'composer'
    ? '[data-workbench-composer]'
    : '[data-workbench-main-heading]'
  const element = root.querySelector<HTMLElement>(selector)
  if (!element) return false
  element.focus({ preventScroll: true })
  return true
}

export function legacySessionRedirect(
  userId: string,
  search: string | URLSearchParams,
  hash = '',
) {
  const params = new URLSearchParams(typeof search === 'string' ? search : search.toString())
  const sessionId = params.get('session')
  if (!sessionId) return null
  params.delete('session')
  const suffix = params.toString()
  const safeHash = hash.startsWith('#') ? hash : ''
  return `${sessionPath(userId, sessionId)}${suffix ? `?${suffix}` : ''}${safeHash}`
}
