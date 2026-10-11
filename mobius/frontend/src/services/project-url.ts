/**
 * 项目 URL 拼装.
 *
 * URL 的 :user 段按项目类型分流, 与所有者 (created_by) 无关:
 *   - 拓展项目 (kind='extension') 恒为 /u/system/p/<id>: 拓展由 mobius/extension/ 扫描出来,
 *     所有者是真实用户 (创建它的管理员), 但 URL 命名空间固定, 历史链接不因所有权变更而失效.
 *   - 普通项目沿用 /u/<created_by>/p/<id>.
 */

export interface ProjectUrlTarget {
  id?: string | null
  kind?: string | null
  created_by?: string | null
}

export function projectUserSegment(project: ProjectUrlTarget | null | undefined, fallbackUser = ''): string {
  if (project?.kind === 'extension') return 'system'
  return String(project?.created_by || fallbackUser || '')
}

export function projectHref(project: ProjectUrlTarget | null | undefined, fallbackUser = ''): string {
  const user = projectUserSegment(project, fallbackUser)
  return `/u/${encodeURIComponent(user)}/p/${encodeURIComponent(String(project?.id || ''))}`
}
