// 检测 Vite 动态 import 失败（典型场景：后端跑 start.py 重新构建后，
// chunk 文件名 hash 变了，但浏览器还拿着旧 index.html 里的旧 hash 去拉，
// 拉不到就抛 "Failed to fetch dynamically imported module"）。
// 这种情况下应用已经不可用，直接弹原生 confirm 问用户是否立即刷新。
//
// 三道拦截 (任一命中即恢复), 覆盖不同失败路径, 互为兜底:
//   1. lazyWithRetry: 包裹 React.lazy, 在 import() promise reject 时就拦 (最可靠).
//      必须有这一道 -- React 18 的 lazy import 失败不会冒泡到 window.onerror,
//      也不会触发 unhandledrejection (React 内部已消化该 promise rejection),
//      所以单纯靠下面的全局 window 监听抓不到路由懒加载失败, 页面直接白屏.
//   2. StaleChunkErrorBoundary (在 App.tsx): 兜住渲染期抛出的 chunk 错误
//      (transitive 模块失败 / 用户在 confirm 里点了取消), 避免 React 卸载整棵树.
//   3. installStaleChunkHandler: 全局 window error/unhandledrejection, 兜
//      <link rel=modulepreload> / 静态 <script type=module> 加载失败
//      (这些会冒泡到 window, 但 React lazy 不会, 所以 1+2 才是主战场).

import { lazy, type ComponentType } from 'react'

const FAILURE_PATTERNS = [
  'failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'importing a module script failed',
  'failed to load module script',
]

let confirmed = false

export function isStaleChunkError(err: unknown): boolean {
  if (!err) return false
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return FAILURE_PATTERNS.some(p => msg.includes(p))
}

function shouldReload(): boolean {
  if (confirmed) return false
  confirmed = true
  return window.confirm('Mobius似乎刚刚完成一次自我迭代，是否现在立即刷新？')
}

function reloadHard() {
  // 给 index.html 强制走网络，避免 304/强缓存导致继续拉旧 chunk 列表
  const url = new URL(window.location.href)
  url.searchParams.set('__mobius_refresh', String(Date.now()))
  window.location.replace(url.toString())
}

// 统一入口: 命中 stale chunk 就弹 confirm, 用户同意即硬刷新.
export function triggerStaleReload() {
  if (shouldReload()) reloadHard()
}

// 包裹 React.lazy: import() reject 时, 若是 stale chunk, 立即触发恢复, 再把错误
// 往外抛 (交给上层 ErrorBoundary 兜底, 或页面已被 reloadHard 跳走).
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    factory().catch((err: unknown) => {
      if (isStaleChunkError(err)) triggerStaleReload()
      throw err
    }),
  )
}

function handleErrorEvent(event: ErrorEvent) {
  if (isStaleChunkError(event.error ?? event.message) && shouldReload()) {
    reloadHard()
  }
}

function handleRejectionEvent(event: PromiseRejectionEvent) {
  if (isStaleChunkError(event.reason) && shouldReload()) {
    event.preventDefault()
    reloadHard()
  }
}

export function installStaleChunkHandler() {
  if (typeof window === 'undefined') return
  window.addEventListener('error', handleErrorEvent)
  window.addEventListener('unhandledrejection', handleRejectionEvent)
}
