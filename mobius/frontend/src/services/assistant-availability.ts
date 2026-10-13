// 小莫助理 (「小莫光点」浮动入口) 前端可用性 —— 临时措施 (2026-10-13 用户要求):
// 关闭期间普通用户看不到任何小莫入口 (光点 / 设置开关 / 极简快捷入口 / 项目「小莫预设」页).
// 与后端 backend/services/user-isolation/index.ts 的 ASSISTANT_NORMAL_USER_BLOCKED 同名同义,
// 后端是真正的闸门 (/api/assistant/* 403), 这里只负责隐藏入口 —— 恢复时两处一起改回 false.
export const ASSISTANT_NORMAL_USER_BLOCKED = true

export function assistantAllowedFor(user: { role?: string } | null | undefined): boolean {
  if (!ASSISTANT_NORMAL_USER_BLOCKED) return true
  return user?.role === 'admin'
}
