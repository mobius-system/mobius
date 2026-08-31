/**
 * easy-route-state.ts — 极简模式路由状态的唯一权威 (URL ↔ 状态双向转换)。
 *
 * 极简模式用查询参数承载全部导航状态, 不再引入新的路径段:
 *   /u/:user/easy_mode?section=projects
 *   /u/:user/easy_mode?section=research&research=<id>&agent=<sessionId>
 *   /u/:user/easy_mode?section=online
 *   /u/:user/easy_mode?project=<id>&session=<sessionId>     (projects 缺省形态)
 *
 * 所有跳转入口 (App.tsx 重定向 / 任务完成 Toast / 全局搜索 / 各组件链接)
 * 必须经由这里的 builder 构造 URL, 禁止在组件里手拼 /easy_mode?... 字符串。
 */

export type EasySection = 'projects' | 'research' | 'online'

export type EasyRouteState = {
  section: EasySection
  projectId?: string
  sessionId?: string
  researchId?: string
  agentId?: string
  view?: string
}

export const EASY_SECTION_VALUES: EasySection[] = ['projects', 'research', 'online']

export function normalizeEasySection(value: string | null | undefined): EasySection {
  return EASY_SECTION_VALUES.includes(value as EasySection) ? (value as EasySection) : 'projects'
}

// 从 useSearchParams 的 URLSearchParams 解析极简路由状态。
export function parseEasyModeRouteState(query: URLSearchParams): EasyRouteState {
  const section = normalizeEasySection(query.get('section'))
  return {
    section,
    projectId: query.get('project') || undefined,
    sessionId: query.get('session') || undefined,
    researchId: query.get('research') || undefined,
    agentId: query.get('agent') || undefined,
    view: query.get('view') || undefined,
  }
}

type BuildArgs = {
  user: string
  section?: EasySection
  projectId?: string | null
  sessionId?: string | null
  researchId?: string | null
  agentId?: string | null
  /** 保留调用方已有的其他查询参数 (如 view) */
  keepQuery?: URLSearchParams
}

// 构造极简模式 URL。只写入有值的参数; section=projects 时省略 (缺省即 projects)。
export function buildEasyModeTargetUrl({
  user,
  section = 'projects',
  projectId,
  sessionId,
  researchId,
  agentId,
  keepQuery,
}: BuildArgs): string {
  const params = new URLSearchParams()
  if (section !== 'projects') params.set('section', section)
  if (projectId) params.set('project', projectId)
  if (researchId) params.set('research', researchId)
  if (sessionId) params.set('session', sessionId)
  if (agentId) params.set('agent', agentId)
  const view = keepQuery?.get('view')
  if (view && !params.get('view')) params.set('view', view)
  const qs = params.toString()
  return `/u/${encodeURIComponent(user)}/easy_mode${qs ? `?${qs}` : ''}`
}

// 从普通模式上下文 (project/issue/research/session) 推导应跳到的极简目标。
// research 会话 → research 区并带 agent; 其余 → projects 区并带 session。
export function buildEasyModeUrlFromContext(args: {
  user: string
  projectId?: string | null
  sessionId?: string | null
  scopeType?: string | null
  researchId?: string | null
}): string {
  const isResearch = args.scopeType === 'research' && !!args.researchId
  if (isResearch) {
    return buildEasyModeTargetUrl({
      user: args.user,
      section: 'research',
      projectId: args.projectId || undefined,
      researchId: args.researchId,
      agentId: args.sessionId,
    })
  }
  return buildEasyModeTargetUrl({
    user: args.user,
    section: 'projects',
    projectId: args.projectId || undefined,
    sessionId: args.sessionId,
  })
}
