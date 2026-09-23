// 顶栏「+」新建菜单 (快捷会话 / 任务 / 研究) 选择列表的预热与 scope 约定.
//
// 为什么需要预热: 列表缓存只在"用户成功打开过一次菜单"之后才落盘, 因此每个人/每个浏览器
// 的第一次打开、以及缓存被清掉之后, 菜单里项目/任务下拉仍要等接口才出得来 —— 用户看到的
// 就是"一打开就在转圈". 这里在应用空闲时提前把同一份列表拉回来写进缓存, 打开即秒开.
//
// 已有缓存的 scope 直接跳过 (不重复打接口); 打开菜单时仍照常后台 revalidate 覆盖.
// Cache-writing is skipped when an entry already exists, so no extra API traffic on repeat loads.
import { api } from '../store'
import { readListCache, writeListCache } from './list-swr-cache'

// scope 常量集中在这里, 预热与菜单读取共用, 避免两边字符串写歪导致缓存永远命中不了.
export const PROJECTS_SCOPE = 'projects-all'
export const issuesScope = (projectId: string) => `issues-active:${projectId}`
export const researchesScope = (projectId: string) => `researches-active:${projectId}`

const pick = (r: any, key: string): any[] => (Array.isArray(r) ? r : (r?.[key] || []))

/*
 * Idle-time预热新建菜单用到的三份列表: 项目列表 + 当前项目的可用任务/研究.
 */
export function warmCreateMenuLists(userId?: string, projectId?: string) {
  if (!readListCache(PROJECTS_SCOPE, userId)) {
    api('/api/projects').then((r: any) => writeListCache(PROJECTS_SCOPE, userId, pick(r, 'projects'))).catch(() => {})
  }
  if (!projectId) return
  // 只预热"当前所在项目"的任务/研究: 菜单默认就落在当前项目, 其余项目打开时再拉
  // Only the current project is warmed — that is where the menu opens by default
  if (!readListCache(issuesScope(projectId), userId)) {
    api(`/api/projects/${projectId}/issues?status=active`).then((r: any) => writeListCache(issuesScope(projectId), userId, pick(r, 'issues'))).catch(() => {})
  }
  if (!readListCache(researchesScope(projectId), userId)) {
    api(`/api/projects/${projectId}/researches?status=active`).then((r: any) => writeListCache(researchesScope(projectId), userId, pick(r, 'researches'))).catch(() => {})
  }
}

/*
 * 应用空闲时跑 warm, requestIdleCallback 不可用的浏览器 (Safari) 退化为延时 1.5s.
 */
export function warmCreateMenuListsOnIdle(userId?: string, projectId?: string) {
  if (typeof window === 'undefined') return () => {}
  const idle = (window as any).requestIdleCallback as undefined | ((cb: () => void, opts?: { timeout: number }) => number)
  if (typeof idle === 'function') {
    const id = idle(() => warmCreateMenuLists(userId, projectId), { timeout: 3000 })
    return () => (window as any).cancelIdleCallback?.(id)
  }
  const timer = window.setTimeout(() => warmCreateMenuLists(userId, projectId), 1500)
  return () => window.clearTimeout(timer)
}
