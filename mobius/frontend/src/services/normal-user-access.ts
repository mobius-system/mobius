import { useSyncExternalStore } from 'react'

// =====================================================================
// 临时措施 (2026-10-13, 用户决策): 普通用户对小莫的全部访问被关闭.
//
// 开关只有后端一处 (backend/services/user-isolation/index.ts:
// NORMAL_USER_ACCESS_BLOCKED), 前端从公开接口 /api/auth/config 读回来, 用来:
//   1. 登录页展示封禁提示 (admin 仍可正常登录);
//   2. 已登录会话若角色不是 admin (理论到不了, 兜底) 一律不渲染任何应用界面.
//
// 后端恢复 (开关改回 false 并重新部署) 后, 这个提示层自动消失, 无需再改前端.
// =====================================================================

let blocked = false
const listeners = new Set<() => void>()

export function setNormalUserAccessBlocked(next: boolean): void {
  if (blocked === next) return
  blocked = next
  listeners.forEach((listener) => listener())
}

export function isNormalUserAccessBlocked(): boolean {
  return blocked
}

export function useNormalUserAccessBlocked(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => blocked,
    () => false,
  )
}

// 启动时拉一次开关. 用裸 fetch (不引 store 的 api, 避免模块循环), 失败按「未封禁」处理,
// 真正的拦截在后端 — 前端这层只负责把界面收起来.
export async function refreshNormalUserAccessBlocked(apiBase = ''): Promise<void> {
  try {
    const res = await fetch(`${apiBase}/api/auth/config`)
    const data = await res.json().catch(() => ({}))
    setNormalUserAccessBlocked(data?.normal_user_access_blocked === true)
  } catch {
    /* 网络失败保持原值 */
  }
}
