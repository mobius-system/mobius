import React from 'react'
import ReactDOM from 'react-dom/client'
import './native-easy/index.css'
import 'katex/dist/katex.min.css'
import { installStaleChunkHandler } from './native-easy/services/handle-stale-chunk'

const LOCATION_MESSAGE = 'mobius:native-easy-location'
const HOST_LOCATION_MESSAGE = 'mobius:native-easy-host-location'
const LAYOUT_MODE_STORAGE_KEY = 'layout_mode'
const LAYOUT_MODE_CHANGE_EVENT = 'mobius:layout-mode-change'

const EASY_HOST_PATH = /^\/u\/([^/]+)\/easy_mode\/?$/
const WORKBENCH_HOME_PATH = /^\/u\/([^/]+)\/?$/
const WORKBENCH_SESSION_PATH = /^\/u\/([^/]+)\/s\/([^/]+)\/?$/
const WORKBENCH_ISSUE_PATH = /^\/u\/([^/]+)\/p\/([^/]+)\/i\/([^/]+)\/?$/

function safeAppPath(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null
  try {
    const url = new URL(value, window.location.origin)
    if (url.origin !== window.location.origin) return null
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
}

function currentAppPath() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function appUrl(path: string) {
  return new URL(path, window.location.origin)
}

function withSearchAndHash(pathname: string, search: URLSearchParams, hash: string) {
  const query = search.toString()
  return `${pathname}${query ? `?${query}` : ''}${hash}`
}

function sameWorkbenchUser(path: string, encodedUser: string) {
  const url = appUrl(path)
  const match = url.pathname.match(/^\/u\/([^/]+)(?:\/|$)/)
  return match?.[1] === encodedUser
}

// 外层继续使用稳定的 /easy_mode 地址，隔离包内部则恢复原版 Workbench 路由。
// 这是两套旧界面共存时的关键区别：/u/:user 是截图中的项目工作台，
// /u/:user/easy_mode 是后来新增的“工作导航”页。
function hostPathToNativeWorkbench(path: string) {
  const safePath = safeAppPath(path)
  if (!safePath) return null
  const url = appUrl(safePath)
  const easyMatch = url.pathname.match(EASY_HOST_PATH)
  if (!easyMatch) return safePath

  const encodedUser = easyMatch[1]
  const nativePath = safeAppPath(url.searchParams.get('native'))
  if (nativePath && sameWorkbenchUser(nativePath, encodedUser)) return nativePath

  const search = new URLSearchParams(url.search)
  const sessionId = search.get('session')
  const projectId = search.get('project')
  const issueId = search.get('issue')
  search.delete('native')

  if (projectId && issueId) {
    search.delete('project')
    search.delete('issue')
    return withSearchAndHash(
      `/u/${encodedUser}/p/${encodeURIComponent(projectId)}/i/${encodeURIComponent(issueId)}`,
      search,
      url.hash,
    )
  }
  if (sessionId) {
    search.delete('session')
    return withSearchAndHash(
      `/u/${encodedUser}/s/${encodeURIComponent(sessionId)}`,
      search,
      url.hash,
    )
  }
  return withSearchAndHash(`/u/${encodedUser}`, search, url.hash)
}

function readLayoutMode() {
  try {
    return window.localStorage.getItem(LAYOUT_MODE_STORAGE_KEY)
  } catch {
    return null
  }
}

function nativeWorkbenchPathToHost(path: string) {
  const safePath = safeAppPath(path)
  if (!safePath || readLayoutMode() !== 'easy_mode') return safePath

  const url = appUrl(safePath)
  const homeMatch = url.pathname.match(WORKBENCH_HOME_PATH)
  if (homeMatch) {
    return withSearchAndHash(`/u/${homeMatch[1]}/easy_mode`, new URLSearchParams(url.search), url.hash)
  }

  const sessionMatch = url.pathname.match(WORKBENCH_SESSION_PATH)
  if (sessionMatch) {
    const search = new URLSearchParams(url.search)
    search.set('session', decodeURIComponent(sessionMatch[2]))
    return withSearchAndHash(`/u/${sessionMatch[1]}/easy_mode`, search, url.hash)
  }

  const issueMatch = url.pathname.match(WORKBENCH_ISSUE_PATH)
  if (issueMatch) {
    const search = new URLSearchParams(url.search)
    search.set('project', decodeURIComponent(issueMatch[2]))
    search.set('issue', decodeURIComponent(issueMatch[3]))
    return withSearchAndHash(`/u/${issueMatch[1]}/easy_mode`, search, url.hash)
  }

  const userMatch = url.pathname.match(/^\/u\/([^/]+)(?:\/|$)/)
  if (!userMatch) return safePath
  const search = new URLSearchParams()
  search.set('native', safePath)
  return withSearchAndHash(`/u/${userMatch[1]}/easy_mode`, search, '')
}

function notifyHostLocation() {
  if (window.parent === window) return
  const path = nativeWorkbenchPathToHost(currentAppPath())
  if (!path) return
  window.parent.postMessage({ type: LOCATION_MESSAGE, path }, window.location.origin)
}

function installLocationBridge() {
  const rawPushState = window.history.pushState.bind(window.history)
  const rawReplaceState = window.history.replaceState.bind(window.history)

  window.history.pushState = ((data: unknown, unused: string, url?: string | URL | null) => {
    rawPushState(data, unused, url)
    notifyHostLocation()
  }) as History['pushState']
  window.history.replaceState = ((data: unknown, unused: string, url?: string | URL | null) => {
    rawReplaceState(data, unused, url)
    notifyHostLocation()
  }) as History['replaceState']

  window.addEventListener('popstate', notifyHostLocation)
  window.addEventListener(LAYOUT_MODE_CHANGE_EVENT, () => {
    // LayoutModeSwitch 会先写模式、再同步 navigate。等本轮同步代码结束后再上报，
    // 避免先把尚未转换完的 Workbench session 地址送给常规模式。
    queueMicrotask(notifyHostLocation)
  })
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return
    if (event.data?.type !== HOST_LOCATION_MESSAGE) return
    const nextPath = hostPathToNativeWorkbench(event.data?.path)
    if (!nextPath || nextPath === currentAppPath()) return
    rawReplaceState(window.history.state, '', nextPath)
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
  })
}

async function bootstrap() {
  const hostRoute = safeAppPath(new URLSearchParams(window.location.search).get('route')) || '/'
  if (appUrl(hostRoute).pathname.match(EASY_HOST_PATH)) {
    try { window.localStorage.setItem(LAYOUT_MODE_STORAGE_KEY, 'easy_mode') } catch { /* restricted storage */ }
  }
  const requestedRoute = hostPathToNativeWorkbench(hostRoute) || '/'
  window.history.replaceState(window.history.state, '', requestedRoute)
  installLocationBridge()
  installStaleChunkHandler()
  const { default: App } = await import('./native-easy/App')
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
  notifyHostLocation()
}

void bootstrap()
