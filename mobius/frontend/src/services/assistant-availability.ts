// 小莫助理 (「小莫光点」浮动入口) 前端可用性 —— 开关常量.
// 2026-10-13 曾临时设为 true 隐藏所有小莫入口 (光点 / 设置开关 / 极简快捷入口 / 项目「小莫预设」页);
// 2026-10-22 用户决定「全部恢复」, 已改回 false.
// 与后端 backend/services/user-isolation/index.ts 的 ASSISTANT_NORMAL_USER_BLOCKED 同名同义 ——
// 后端是真正的闸门 (/api/assistant/* 403), 这里只负责隐藏入口, 两处必须一起改.
export const ASSISTANT_NORMAL_USER_BLOCKED = false

export function assistantAllowedFor(user: { role?: string } | null | undefined): boolean {
  if (!ASSISTANT_NORMAL_USER_BLOCKED) return true
  return user?.role === 'admin'
}
