import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Activity,
  Brain,
  CircleDot,
  Database,
  Eye,
  EyeOff,
  FlaskConical,
  Folder,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Sparkles,
  Star,
  X,
} from 'lucide-react'
import { useStore, api } from '../store'
import { TopNav, timeAgo } from '../components/shell'
import { usePagination, PaginationControls } from '../components/pagination'
import { ConfirmModal, NewProjectModal, ProjectSettingsModal, ExtensionDeleteModal } from '../components/modals'
import { ListLoadingHint } from '../components/list-loading-hint'
import { PrimaryActionButton } from '../components/primary-action-button'
import { SkillsManager } from '../components/skills'
import { MemoriesManager } from '../components/memories'
import { ResizablePanel } from '../components/resizable-panel'
import { SearchMatchText } from '../components/search-match-text'
import {
  effectiveProjectCardBorderTheme,
  projectCardHeaderStyle,
  projectCardThemeStyle,
} from '../services/project-card-themes'
import {
  EMPTY_PROJECT_HIERARCHY_SEARCH,
  hierarchyHitLabel,
  hierarchyHitUrl,
  type ProjectHierarchyGroup,
  type ProjectHierarchyHit,
  type ProjectHierarchySearchResponse,
} from '../services/project-hierarchy-search'

type ProjectFilterKey = 'owned' | 'starred' | 'extension'
const PROJECT_FILTERS: Array<{ key: ProjectFilterKey; label: string; title: string }> = [
  { key: 'owned', label: '我的', title: '我创建的项目' },
  { key: 'starred', label: '关注', title: '我关注的项目' },
  { key: 'extension', label: '拓展', title: '莫比乌斯拓展项目' },
]

// /u/:user 主区项目卡片每页显示数量; 超过即分页, 避免一次性渲染过多卡片.
const PROJECT_PAGE_SIZE = 16

// =====================================================================
// 项目汇总页 /u/:user
// 左侧 sidebar：按用户分组的所有项目清单
// 右侧：当前 :user 的所有 project 卡片，每张卡显示其 issues 概览
// =====================================================================
function sortProjectsForDisplay(items: any[]) {
  return [...items].sort((a: any, b: any) => {
    const starDiff = Number(!!b.starred) - Number(!!a.starred)
    if (starDiff !== 0) return starDiff
    const activityA = a.last_session_activity_at ? Date.parse(a.last_session_activity_at) : -Infinity
    const activityB = b.last_session_activity_at ? Date.parse(b.last_session_activity_at) : -Infinity
    if (activityA !== activityB) return activityB - activityA
    const activeDiff = new Date(b.last_active || 0).getTime() - new Date(a.last_active || 0).getTime()
    if (activeDiff !== 0) return activeDiff
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
  })
}

function projectVisibilityLabel(value: any) {
  if (value === 'public') return '公开'
  return '私有'
}

function matchesProjectFilters(project: any, filters: ProjectFilterKey[], userId: string) {
  if (filters.length === 0) return true
  return filters.some((key) => (
    (key === 'owned' && project?.created_by === userId)
    || (key === 'starred' && !!project?.starred)
    || (key === 'extension' && project?.kind === 'extension')
  ))
}

function projectMatchesSearch(project: any, query: string) {
  if (!query.trim()) return true
  const q = query.trim().toLowerCase()
  return String(project?.name || '').toLowerCase().includes(q)
    || String(project?.description || '').toLowerCase().includes(q)
}

// 导航按钮: <button> 外观但走 SPA navigate.
// ⚠️ 必须定义在组件外(模块顶层)! 之前定义在 UserPage 函数体内, 导致每次 UserPage 重渲染
// LinklessNav 都是新的函数引用(= 新组件类型), React 按组件类型 reconcile 时把所有 <LinklessNav>
// 实例 unmount/remount -> 按钮 DOM 节点在连点期间被替换 -> 浏览器 mousedown/mouseup 落在不同节点实例
// 而不触发 click -> 连点偶发无响应. 提到顶层后引用稳定, 重渲染只更新 props 不重挂节点.
function LinklessNav({ to, className = '', children, onClick, onAuxClick, ...props }: any) {
  const navigate = useNavigate()
  const go = (event: any) => {
    if (!to) return
    if (event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.button === 1) {
      window.open(to, '_blank', 'noopener,noreferrer')
      return
    }
    navigate(to)
  }
  return (
    <button
      type="button"
      {...props}
      className={`appearance-none border-0 bg-transparent text-left cursor-pointer ${className}`}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        go(event)
      }}
      onAuxClick={(event) => {
        onAuxClick?.(event)
        if (event.defaultPrevented) return
        if (event.button !== 1) return
        event.preventDefault()
        go(event)
      }}
    >
      {children}
    </button>
  )
}

function HierarchyHitIcon({ kind, className = '' }: { kind: ProjectHierarchyHit['kind']; className?: string }) {
  if (kind === 'issue') return <CircleDot className={className} />
  if (kind === 'research') return <FlaskConical className={className} />
  return <MessageSquare className={className} />
}

function HierarchyHitRow({
  project,
  hit,
  query,
  variant,
}: {
  project: any
  hit: ProjectHierarchyHit
  query: string
  variant: 'sidebar' | 'card'
}) {
  const isSession = hit.kind === 'session' || hit.kind === 'research_agent'
  const descriptionMatched = hit.matched_fields.includes('description') && !!hit.description
  return (
    <LinklessNav
      to={hierarchyHitUrl(project, hit)}
      data-project-hierarchy-hit={variant === 'sidebar' ? hit.id : undefined}
      data-project-card-hierarchy-hit={variant === 'card' ? hit.id : undefined}
      title={`${hierarchyHitLabel(hit.kind)}：${hit.title}`}
      className={`w-full min-w-0 rounded-md transition-colors hover:bg-[var(--bg-card-hover)] ${
        variant === 'sidebar' ? 'flex gap-2 px-2 py-1.5' : 'flex gap-2.5 px-2 py-2'
      }`}
    >
      <HierarchyHitIcon
        kind={hit.kind}
        className={`mt-0.5 flex-shrink-0 ${variant === 'sidebar' ? 'h-3 w-3' : 'h-3.5 w-3.5'}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className="flex-shrink-0 rounded px-1 py-0.5 text-[9px] leading-none"
            style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.05)' }}
          >
            {hierarchyHitLabel(hit.kind)}
          </span>
          <span className={`${variant === 'sidebar' ? 'text-[11px]' : 'text-[12px]'} min-w-0 truncate font-medium`} style={{ color: 'var(--text-primary)' }}>
            <SearchMatchText text={hit.title || '未命名'} query={query} />
          </span>
        </span>
        {isSession && hit.parent_title && (
          <span className="mt-0.5 block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
            位于 {hit.parent_kind === 'research' ? '研究' : '任务'} · {hit.parent_title}
          </span>
        )}
        {descriptionMatched && (
          <span className="mt-0.5 block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <SearchMatchText text={hit.description} query={query} />
          </span>
        )}
      </span>
    </LinklessNav>
  )
}

export default function UserPage() {
  const params = useParams()
  const navigate = useNavigate()
  const {
    user, projects, setProjects, setCurrentProject, setCurrentIssue, setCurrentResearch, setCurrentSession, setCurrentTask,
    mutedProjectIds, setMutedProjectIds,
  } = useStore()
  const userParam = params.user || user?.id || ''

  const [showNew, setShowNew] = useState(false)
  // 用户主页改为「左侧导航 + 右侧单视图」: 项目 / 记忆 / 技能 / 数据 / 监控 / 配置. 记忆/技能源自原 Z3 右栏.
  type UserView = 'projects' | 'memory' | 'skills' | 'data' | 'monitor' | 'config'
  const USER_VIEWS: UserView[] = ['projects', 'memory', 'skills', 'data', 'monitor', 'config']
  const [activeView, setActiveView] = useState<UserView>(() => {
    try {
      const v = localStorage.getItem('mobius:ui:user-page:view')
      return (USER_VIEWS as string[]).includes(v as string) ? (v as UserView) : 'projects'
    } catch { return 'projects' }
  })
  useEffect(() => { try { localStorage.setItem('mobius:ui:user-page:view', activeView) } catch {} }, [activeView])
  const [search, setSearch] = useState('')
  const [hierarchySearch, setHierarchySearch] = useState<ProjectHierarchySearchResponse>(EMPTY_PROJECT_HIERARCHY_SEARCH)
  const [hierarchySearchLoading, setHierarchySearchLoading] = useState(false)
  const [hierarchySearchError, setHierarchySearchError] = useState('')
  const [issuesByProject, setIssuesByProject] = useState<Record<string, any[]>>({})
  const [researchesByProject, setResearchesByProject] = useState<Record<string, any[]>>({})
  const [overviewByProject, setOverviewByProject] = useState<Record<string, any>>({})
  // 卡片 issue/research 概览的加载态: 拉取期间显示 loading, 而不是闪现"暂无 Issue".
  const [issuesLoadingByProject, setIssuesLoadingByProject] = useState<Record<string, boolean>>({})
  const [researchesLoadingByProject, setResearchesLoadingByProject] = useState<Record<string, boolean>>({})
  const overviewPreviewRequests = useRef<Set<string>>(new Set())
  const [editingProject, setEditingProject] = useState<any>(null)
  const [hidingProject, setHidingProject] = useState<any>(null)
  // 拓展项目的隐藏/彻底删除入口；普通项目的屏蔽放在项目操作菜单里。
  const [extDeletingProject, setExtDeletingProject] = useState<any>(null)
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null)
  const [starringProjectId, setStarringProjectId] = useState<string | null>(null)
  const [projectFilters, setProjectFilters] = useState<ProjectFilterKey[]>(() => {
    // 上次离开页面时勾选的 chip 筛选: 恢复, 避免每次打开都要重新点.
    // 默认 [] (全部) 与既有语义一致; localStorage 缺失/损坏/越界值都退回默认.
    const uid = String(user?.id || '').trim()
    if (!uid || typeof window === 'undefined') return []
    try {
      const raw = window.localStorage.getItem(`imac:userpage:chip-filter:v1:${uid}`)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      const valid = new Set<string>(['owned', 'starred', 'extension'])
      if (!Array.isArray(parsed)) return []
      const dedup = parsed.filter((k) => typeof k === 'string' && valid.has(k))
      return dedup as ProjectFilterKey[]
    } catch {
      return []
    }
  })
  const [showMutedPanel, setShowMutedPanel] = useState(false)
  const [mutedProjects, setMutedProjects] = useState<any[]>([])
  const [mutedProjectsLoading, setMutedProjectsLoading] = useState(false)
  const [mutedBusyId, setMutedBusyId] = useState<string | null>(null)
  const mutedIdSet = useMemo(() => new Set(mutedProjectIds || []), [mutedProjectIds])
  const normalizedSearch = search.trim().slice(0, 200)

  useEffect(() => {
    const query = search.trim().slice(0, 200)
    if (!query) {
      setHierarchySearch(EMPTY_PROJECT_HIERARCHY_SEARCH)
      setHierarchySearchLoading(false)
      setHierarchySearchError('')
      return
    }

    const controller = new AbortController()
    setHierarchySearchLoading(true)
    setHierarchySearchError('')
    const timer = window.setTimeout(() => {
      api(`/api/projects/hierarchy-search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((result: ProjectHierarchySearchResponse) => setHierarchySearch(result))
        .catch((error: any) => {
          if (error?.name === 'AbortError') return
          setHierarchySearchError('项目内部搜索暂时不可用')
        })
        .finally(() => {
          if (!controller.signal.aborted) setHierarchySearchLoading(false)
        })
    }, 300)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [search])

  // 进入页面清空更深层选择，避免残留
  useEffect(() => {
    setCurrentProject(null)
    setCurrentIssue(null)
    setCurrentResearch(null)
    setCurrentSession(null)
    setCurrentTask(null)
  }, [userParam])

  // 进入页面时拉取已屏蔽项目 ID
  useEffect(() => {
    if (userParam !== user?.id) return
    api('/api/projects/muted').then((arr: any[]) => setMutedProjectIds((arr || []).map((p: any) => p.id))).catch(() => {})
  }, [userParam, user?.id, setMutedProjectIds])

  const refresh = (opts: { showAll?: boolean } = {}) => {
    // 全部模式 (projectFilters 为空): 跳过 user_view_prefs.hide_others_projects,
    // 让用户拿到自己可见的全部项目. 一旦切到 chip 筛选, 收回范围并尊重个人偏好.
    const showAll = opts.showAll ?? (projectFilters.length === 0)
    const url = showAll ? '/api/projects?all=true' : '/api/projects'
    return api(url).then((arr: any[]) => setProjects(sortProjectsForDisplay(arr || []))).catch(() => {})
  }

  const refreshMutedProjects = () => {
    if (userParam !== user?.id) return Promise.resolve()
    setMutedProjectsLoading(true)
    return api('/api/projects/muted')
      .then((arr: any[]) => {
        const items = sortProjectsForDisplay(arr || [])
        setMutedProjects(items)
        setMutedProjectIds(items.map((p: any) => p.id))
      })
      .catch(() => {})
      .finally(() => setMutedProjectsLoading(false))
  }

  useEffect(() => {
    refresh()
  }, [])

  // 切换 chip 筛选时, 重新拉取列表 (?all=true 与否随之变化).
  useEffect(() => {
    refresh()
  }, [projectFilters])

  // 持久化 chip 筛选到 localStorage: 关闭/刷新页面后, 进入 /u/<self> 仍能恢复.
  // 切换账号时把上一账号的筛选清空, 避免看到不属于当前用户的过滤状态.
  useEffect(() => {
    const uid = String(user?.id || '').trim()
    if (!uid || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(`imac:userpage:chip-filter:v1:${uid}`, JSON.stringify(projectFilters))
    } catch {}
  }, [projectFilters, user?.id])

  useEffect(() => {
    if (showMutedPanel) refreshMutedProjects()
  }, [showMutedPanel, userParam, user?.id])

  useEffect(() => {
    if (!openProjectMenuId) return
    const close = () => setOpenProjectMenuId(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [openProjectMenuId])

  const toggleProjectFilter = (key: ProjectFilterKey) => {
    setProjectFilters((current) => (
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
    ))
  }

  // 隐藏 / 取消隐藏单个项目: 后端持久化, 立刻从前端列表过滤掉 (隐藏时) 或追加回来 (取消时).
  const unmuteProject = async (e: any, p: any) => {
    e?.preventDefault?.(); e?.stopPropagation?.()
    if (!p?.id || mutedBusyId === p.id) return
    const wasMuted = mutedIdSet.has(p.id)
    if (!wasMuted) return
    setMutedBusyId(p.id)
    setMutedProjectIds((mutedProjectIds || []).filter((id) => id !== p.id))
    setMutedProjects((items) => items.filter((item) => item.id !== p.id))
    try {
      await api(`/api/projects/${p.id}/unmute`, { method: 'POST' })
      refresh()
    } catch (err: any) {
      setMutedProjectIds([...(mutedProjectIds || []), p.id])
      setMutedProjects((items) => sortProjectsForDisplay([...items, p]))
      alert(err?.message || '恢复显示失败')
    } finally { setMutedBusyId(null) }
  }

  const confirmHideProject = async () => {
    const p = hidingProject
    if (!p?.id || mutedBusyId === p.id) return
    setMutedBusyId(p.id)
    setMutedProjectIds([...(mutedProjectIds || []), p.id])
    try {
      await api(`/api/projects/${p.id}/mute`, { method: 'POST' })
      setHidingProject(null)
      refreshMutedProjects()
    } catch (err: any) {
      setMutedProjectIds((mutedProjectIds || []).filter((id) => id !== p.id))
      alert(err?.message || '屏蔽失败')
    } finally {
      setMutedBusyId(null)
    }
  }

  // 拉取每个 :user 的 project 的 issues 用于卡片预览
  const sortedProjects = useMemo(() => sortProjectsForDisplay(projects as any[]), [projects])
  // 拓展项目 (kind='extension') 由 mobius/extension/ 同步出来, created_by='system',
  // 应在每个用户的项目页都显示, 而不仅限于 system 用户名下.
  // 已隐藏 (p.hidden) 的拓展不显示; 撤销隐藏由管理员面板做.
  // 隐藏 (p.muted): 不在主列表和 sidebar 默认列表出现; 搜索命中时仍出现并带"已隐藏"角标.
  // 主体可见规则: 总能看到自己的项目 + 拓展项目;
  // 当 "全部" 状态 (projectFilters.length === 0) 下, 不再按 created_by 限制到 userParam,
  // 让当前用户看到自己可见的所有项目 (含 public / 关注); 一旦切到某个 chip 才把范围收回到 userParam 视角.
  const isViewingOwnAsAll = projectFilters.length === 0
  const activeHierarchySearch = hierarchySearch.query === normalizedSearch
    ? hierarchySearch
    : { ...EMPTY_PROJECT_HIERARCHY_SEARCH, query: normalizedSearch }
  const hierarchyGroupByProject = useMemo(
    () => new Map(activeHierarchySearch.projects.map((group) => [String(group.project?.id), group])),
    [activeHierarchySearch.projects]
  )
  const searchProjectCandidates = useMemo(() => {
    if (!normalizedSearch) return sortedProjects
    const byId = new Map<string, any>()
    activeHierarchySearch.projects.forEach((group) => {
      if (group.project?.id) byId.set(String(group.project.id), group.project)
    })
    // 本地项目名即时命中，避免防抖请求期间输入框短暂显示空列表。
    sortedProjects.filter((project: any) => projectMatchesSearch(project, normalizedSearch)).forEach((project: any) => {
      if (project?.id && !byId.has(String(project.id))) byId.set(String(project.id), project)
    })
    return Array.from(byId.values())
  }, [activeHierarchySearch.projects, normalizedSearch, sortedProjects])
  const projectIsInView = (project: any) => (
    (isViewingOwnAsAll || userParam === user?.id || project.kind === 'extension' || project.created_by === userParam)
    && !project.hidden
    && matchesProjectFilters(project, projectFilters, user?.id || '')
  )
  const projectIsMuted = (project: any) => mutedIdSet.has(project.id) || !!project.muted
  const myProjects = useMemo(
    () => searchProjectCandidates.filter((project: any) => projectIsInView(project) && !projectIsMuted(project)),
    [searchProjectCandidates, userParam, user?.id, mutedIdSet, projectFilters, isViewingOwnAsAll]
  )
  // 搜索时: 已 mute 的项目也展示, 但带角标; 后端层级搜索同样保留它们.
  const searchMutedProjects = useMemo(
    () => normalizedSearch
      ? searchProjectCandidates.filter((project: any) => projectIsInView(project) && projectIsMuted(project))
      : [],
    [searchProjectCandidates, normalizedSearch, userParam, mutedIdSet, projectFilters, user?.id, isViewingOwnAsAll]
  )
  const visibleProjectCount = myProjects.length + (normalizedSearch ? searchMutedProjects.length : 0)
  const visibleSearchMatchCount = useMemo(() => (
    normalizedSearch
      ? [...myProjects, ...searchMutedProjects].reduce((total, project: any) => total + (hierarchyGroupByProject.get(String(project.id))?.total_matches || 0), 0)
      : 0
  ), [hierarchyGroupByProject, myProjects, normalizedSearch, searchMutedProjects])

  // 主区项目卡片分页: 只渲染当前页的 16 个, 翻页时再按需加载这些卡片的概览.
  const projectPagination = usePagination(myProjects, PROJECT_PAGE_SIZE)
  // 搜索词 / 筛选 chip 变化 → 列表范围改变, 重置到第 1 页, 避免停在超出范围的页.
  useEffect(() => {
    projectPagination.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, projectFilters])

  // 分页控件 props (顶部 + 底部复用同一份).
  const projectPaginationProps = {
    page: projectPagination.page,
    totalPages: projectPagination.totalPages,
    pageStart: projectPagination.pageStart,
    pageEnd: projectPagination.pageEnd,
    totalItems: myProjects.length,
    onPageChange: projectPagination.goToPage,
  }

  const toggleProjectStar = async (e: any, p: any) => {
    e.preventDefault()
    e.stopPropagation()
    if (!p?.id || starringProjectId === p.id) return
    const nextStarred = !p.starred
    const previousProjects = useStore.getState().projects
    setStarringProjectId(p.id)
    setProjects(sortProjectsForDisplay(previousProjects.map((pp: any) => (
      pp.id === p.id ? { ...pp, starred: nextStarred } : pp
    ))))
    try {
      const updated = await api(`/api/projects/${p.id}/star`, {
        method: 'PATCH',
        body: JSON.stringify({ starred: nextStarred }),
      })
      const current = useStore.getState().projects
      setProjects(sortProjectsForDisplay(current.map((pp: any) => (
        pp.id === updated.id ? { ...pp, ...updated } : pp
      ))))
    } catch (err: any) {
      setProjects(previousProjects)
      alert(err?.message || '更新项目关注状态失败')
    } finally {
      setStarringProjectId(null)
    }
  }

  useEffect(() => {
    const pending = projectPagination.pagedItems
      .filter((p: any) => p?.id && !overviewByProject[p.id] && !overviewPreviewRequests.current.has(p.id))
    if (pending.length === 0) return

    pending.forEach((p: any) => {
      overviewPreviewRequests.current.add(p.id)
      setIssuesLoadingByProject(prev => prev[p.id] ? prev : { ...prev, [p.id]: true })
      if (p.research_enabled) {
        setResearchesLoadingByProject(prev => prev[p.id] ? prev : { ...prev, [p.id]: true })
      }
    })
    const ids = pending.map((p: any) => encodeURIComponent(p.id)).join(',')
    api(`/api/projects/overview?ids=${ids}&limit=5`).then((payload: Record<string, any>) => {
      const data = payload || {}
      setOverviewByProject(prev => {
        const next = { ...prev }
        pending.forEach((p: any) => { next[p.id] = data[p.id] || { issues: [], researches: [], issue_counts: { total: 0, active: 0, completed: 0 }, research_counts: { total: 0, active: 0, completed: 0 } } })
        return next
      })
      setIssuesByProject(prev => {
        const next = { ...prev }
        pending.forEach((p: any) => { next[p.id] = data[p.id]?.issues || [] })
        return next
      })
      setResearchesByProject(prev => {
        const next = { ...prev }
        pending.forEach((p: any) => {
          if (p.research_enabled) next[p.id] = data[p.id]?.researches || []
        })
        return next
      })
    }).catch(() => {}).finally(() => {
      pending.forEach((p: any) => {
        overviewPreviewRequests.current.delete(p.id)
        setIssuesLoadingByProject(prev => ({ ...prev, [p.id]: false }))
        if (p.research_enabled) {
          setResearchesLoadingByProject(prev => ({ ...prev, [p.id]: false }))
        }
      })
    })
  }, [projectPagination.pagedItems, overviewByProject])

  // 按 created_by 分组（sidebar）
  const grouped = useMemo(() => {
    const m: Record<string, any[]> = {}
    // 搜索态使用服务端返回的项目候选, 因此内部任务/会话命中也能进入侧栏.
    const candidates = normalizedSearch ? searchProjectCandidates : sortedProjects
    for (const p of candidates) {
      const isMuted = mutedIdSet.has(p.id) || !!p.muted
      if (isMuted && !normalizedSearch) continue
      if (p.hidden && !isMuted) continue
      if (!projectIsInView(p)) continue
      const key = p.created_by || '未知'
      if (!m[key]) m[key] = []
      m[key].push(p)
    }
    return m
  }, [sortedProjects, normalizedSearch, searchProjectCandidates, mutedIdSet, userParam, user?.id, projectFilters, isViewingOwnAsAll])

  const emptyProjectText = normalizedSearch
    ? '未找到匹配项目'
    : (projectFilters.length > 0 ? '当前筛选下没有项目' : `${userParam} 还没有项目`)

  const pageTitle = projectFilters.length === 0
    ? '全部项目'
    : `${userParam} 的项目`

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--bg-primary)' }}>
      <TopNav />
      <div className="flex flex-1 min-h-0">
        {/* 左侧导航边栏: 项目 / 记忆 / 技能 / 数据 / 监控 / 配置 (替换原项目列表侧栏 Z1) */}
        <ResizablePanel
          storageKey="mobius:ui:sidebar:user-nav"
          defaultWidth={192}
          minWidth={160}
          maxWidth={320}
          side="left"
          className="border-r flex flex-col"
          style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
          <div className="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-2">
            {[
              { key: 'projects', label: '项目', icon: <Folder className="w-4 h-4" strokeWidth={1.8} /> },
              ...(userParam === user?.id ? [
                { key: 'memory', label: '记忆', icon: <Brain className="w-4 h-4" strokeWidth={1.8} /> },
                { key: 'skills', label: '技能', icon: <Sparkles className="w-4 h-4" strokeWidth={1.8} /> },
                { key: '__divider__', label: '', icon: null as ReactNode },
                // 「数据 / 监控 / 配置」改为跳转: 数据 -> 系统可视化, 监控 -> 管理中心·运行监控, 配置 -> 管理中心.
                // 这三个不再走 setActiveView 切视图, 因此也不再触发 activeView 高亮.
                { key: 'data', label: '数据', icon: <Database className="w-4 h-4" strokeWidth={1.8} />, action: () => navigate(`/u/${userParam}/mobius_overview_cluster`) },
                { key: 'monitor', label: '监控', icon: <Activity className="w-4 h-4" strokeWidth={1.8} />, action: () => window.openAdminOverlay?.('runtime') },
                { key: 'config', label: '配置', icon: <Settings className="w-4 h-4" strokeWidth={1.8} />, action: () => window.openAdminOverlay?.() },
              ] : []),
            ].map((item) => item.key === '__divider__' ? (
              <div key="__divider__" className="mx-2 my-1 border-t" style={{ borderColor: 'var(--border-color)' }} />
            ) : (
              <button key={item.key} type="button" data-user-nav-key={item.key}
                onClick={() => ((item as any).action ? (item as any).action() : setActiveView(item.key as UserView))}
                className={`flex items-center gap-2 h-9 px-3 rounded-lg text-[13px] transition-colors ${activeView === item.key ? 'bg-blue-500/15 text-blue-400' : 'hover:bg-[var(--bg-hover)]'}`}
                style={activeView === item.key ? undefined : { color: 'var(--text-secondary)' }}>
                {item.icon}{item.label}
              </button>
            ))}
          </div>
        </ResizablePanel>

        {/* 右侧主区 */}
        <main data-tour="user-projects-main" className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6 lg:p-8" style={{ background: 'var(--bg-secondary)' }}>
          {activeView === 'projects' && (
          <div className="w-full max-w-7xl mx-auto">
            {/* 页面标题与项目工具栏保持同一层级，先确认位置再筛选内容。 */}
            <div className="mb-6">
              <div>
                <div className="min-w-0">
                  <h1 className="text-[20px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>{pageTitle}</h1>
                </div>
              </div>

              {/* 搜索、筛选与屏蔽入口集中为一条紧凑工具栏，窄屏自动换行。 */}
              <div className="mt-4 flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center sm:flex-wrap lg:flex-nowrap"
                style={{ background: 'color-mix(in srgb, var(--bg-primary) 42%, transparent)', borderColor: 'var(--border-color)' }}>
                <div className="relative min-w-0 flex-1 sm:min-w-[240px]">
                  <Search className="absolute left-2.5 top-[9px] h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                  <input value={search} onChange={e => setSearch(e.target.value)}
                    maxLength={200}
                    data-project-hierarchy-search
                    placeholder="搜索项目、任务或会话..."
                    className="h-8 w-full rounded-lg pl-8 pr-8 text-[12px] focus:outline-none focus:border-blue-500/30"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                  {hierarchySearchLoading ? (
                    <LoaderCircle className="absolute right-2.5 top-[9px] h-3.5 w-3.5 animate-spin" style={{ color: '#60a5fa' }} />
                  ) : search ? (
                    <button type="button" aria-label="清空搜索" title="清空搜索" onClick={() => setSearch('')}
                      className="absolute right-1.5 top-1 flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]"
                      style={{ color: 'var(--text-muted)' }}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1 rounded-lg border p-1" style={{ borderColor: 'var(--input-border)', background: 'var(--input-bg)' }}>
                  <button type="button" onClick={() => setProjectFilters([])} title="显示全部未屏蔽项目"
                    className={`h-7 rounded-md px-3 text-[11px] transition-colors ${projectFilters.length === 0 ? 'bg-blue-500/15 text-blue-400' : 'hover:bg-[var(--bg-card-hover)]'}`}
                    style={projectFilters.length !== 0 ? { color: 'var(--text-muted)' } : undefined}>全部</button>
                  {PROJECT_FILTERS.map((item) => {
                    const active = projectFilters.includes(item.key)
                    return (
                      <button key={item.key} type="button" onClick={() => toggleProjectFilter(item.key)} title={item.title}
                        className={`h-7 rounded-md px-3 text-[11px] transition-colors ${active ? 'bg-blue-500/15 text-blue-400' : 'hover:bg-[var(--bg-card-hover)]'}`}
                        style={!active ? { color: 'var(--text-muted)' } : undefined}>{item.label}</button>
                    )
                  })}
                </div>
                {mutedProjectIds.length > 0 && (
                  <button type="button" onClick={() => { setShowMutedPanel((v) => !v); if (!showMutedPanel) refreshMutedProjects() }}
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ borderColor: 'var(--border-color)', background: 'var(--bg-card)', color: showMutedPanel ? '#60a5fa' : 'var(--text-muted)' }}>
                    <EyeOff className="h-3.5 w-3.5" /> 已屏蔽项目
                    <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'rgba(255,255,255,0.06)' }}>{mutedProjectIds.length}</span>
                  </button>
                )}
              </div>
              {hierarchySearchError && <div className="mt-2 text-[10px]" style={{ color: '#f87171' }}>{hierarchySearchError}</div>}
              <div className="mt-4 flex min-h-8 flex-wrap items-center justify-between gap-3 border-t pt-3" style={{ borderColor: 'var(--border-color)' }}>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                  <span className="text-[12px]">
                    {normalizedSearch
                      ? `找到 ${visibleProjectCount} 个项目 · ${visibleSearchMatchCount} 条内部匹配`
                      : `共 ${visibleProjectCount} 个项目`}
                    {normalizedSearch && activeHierarchySearch.truncated ? ' · 匹配较多，仅显示最相关结果' : ''}
                  </span>
                  {projectPagination.totalPages > 1 && (
                    <>
                      <span>·</span>
                      <PaginationControls {...projectPaginationProps} inlinePageSwitch />
                    </>
                  )}
                </div>
                <PrimaryActionButton onClick={() => setShowNew(true)} data-tour="user-new-project"
                  icon={<Plus className="h-3.5 w-3.5" strokeWidth={2} />}>
                  新项目
                </PrimaryActionButton>
              </div>
            </div>

            {showMutedPanel && (
              <div className="mb-6 rounded-lg border px-3 py-3" style={{ borderColor: 'rgba(248,113,113,0.30)', background: 'rgba(248,113,113,0.04)' }}>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>已屏蔽项目</div>
                    <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>这里可以恢复被你屏蔽的项目</div>
                  </div>
                  {mutedProjectsLoading && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>加载中...</span>}
                </div>
                {mutedProjects.length === 0 ? (
                  <div className="mt-3 rounded-md border border-dashed px-3 py-4 text-center text-[12px]" style={{ borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
                    暂无已屏蔽项目
                  </div>
                ) : (
                  <div className="mt-3 space-y-2">
                    {mutedProjects.map((p: any) => (
                      <div key={p.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2" style={{ borderColor: 'var(--input-border)', background: 'var(--bg-primary)' }}>
                        <LinklessNav to={`/u/${p.created_by}/p/${p.id}`} className="min-w-0 flex-1">
                          <div className="truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{p.name}</div>
                          <div className="mt-0.5 truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{p.kind === 'extension' ? '拓展项目' : '普通项目'}</div>
                        </LinklessNav>
                        <button
                          type="button"
                          onClick={(e) => unmuteProject(e, p)}
                          disabled={mutedBusyId === p.id}
                          className="inline-flex h-7 items-center gap-1 rounded-full border px-3 text-[11px] font-medium transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
                          style={{ color: '#60a5fa', borderColor: 'rgba(59,130,246,0.35)' }}>
                          <Eye className="h-3.5 w-3.5" />
                          恢复显示
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {myProjects.length === 0 ? (
              <div className="rounded-2xl border-dashed border-2 p-12 text-center" style={{ borderColor: 'var(--border-color)' }}>
                {normalizedSearch && hierarchySearchLoading ? (
                  <ListLoadingHint />
                ) : <div className="text-[14px] mb-3" style={{ color: 'var(--text-muted)' }}>{emptyProjectText}</div>}
                {!hierarchySearchLoading && projectFilters.length > 0 ? (
                  <button onClick={() => setProjectFilters([])}
                    className="h-9 px-4 rounded-lg text-[13px] text-blue-400 bg-blue-500/10 hover:bg-blue-500/15 transition-colors">
                    清空筛选
                  </button>
                ) : !hierarchySearchLoading && !normalizedSearch ? (
                  <button onClick={() => setShowNew(true)} data-tour="user-empty-create-project"
                    className="h-9 px-4 rounded-lg text-[13px] text-blue-400 bg-blue-500/10 hover:bg-blue-500/15 transition-colors">
                    创建第一个项目
                  </button>
                ) : null}
              </div>
            ) : (
              <>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:gap-5">
                {projectPagination.pagedItems.map((p: any) => {
                  const searchGroup = hierarchyGroupByProject.get(String(p.id)) as ProjectHierarchyGroup | undefined
                  const searchMatches = searchGroup?.matches || []
                  const showingSearchMatches = !!normalizedSearch && searchMatches.length > 0
                  const overview = overviewByProject[p.id] || null
                  const issues = issuesByProject[p.id] || []
                  const researches = researchesByProject[p.id] || []
                  const showResearch = !!p.research_enabled && !((p.research_count || 0) === 0 && issues.length > 0)
                  const overviewItems = showResearch ? researches : issues
                  const overviewKind = showResearch ? 'research' : 'issue'
                  const issueCounts = overview?.issue_counts || null
                  const researchCounts = overview?.research_counts || null
                  const activeIssueCount = issueCounts ? issueCounts.active : issues.filter((i: any) => i.status !== 'completed').length
                  const completedIssueCount = issueCounts ? issueCounts.completed : issues.filter((i: any) => i.status === 'completed').length
                  const overviewTotal = showResearch
                    ? (researchCounts?.total ?? overviewItems.length)
                    : (issueCounts?.total ?? overviewItems.length)
                  // 当前卡片展示的概览(research 或 issue)是否仍在拉取: 拉取期间不显示"暂无 XX"空态.
                  const overviewLoading = !!(
                    overviewKind === 'research'
                      ? (researchesLoadingByProject[p.id] && !researchesByProject[p.id])
                      : (issuesLoadingByProject[p.id] && !issuesByProject[p.id])
                  )
                  const isMuted = projectIsMuted(p)
                  const cardTheme = effectiveProjectCardBorderTheme(p)
                  return (
                    <div key={p.id} data-tour="user-project-card"
                      className="project-card-themed rounded-xl border overflow-hidden flex flex-col group transition-all min-w-0"
                      style={projectCardThemeStyle(cardTheme)}>
                      {/* 卡片头部 */}
                      <div className="px-4 py-3 border-b" style={projectCardHeaderStyle(cardTheme)}>
                        <div className="flex items-center gap-2 min-w-0">
                          <svg className="w-4 h-4 flex-shrink-0" style={{ color: cardTheme.iconColor }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                          <LinklessNav to={`/u/${p.created_by}/p/${p.id}`}
                            className="text-[14px] font-semibold truncate flex-1 min-w-0 transition-colors hover:!text-[var(--project-card-accent)]"
                            style={{ color: 'var(--text-primary)' }}
                            title={p.name}>
                            <SearchMatchText text={p.name} query={normalizedSearch} />
                          </LinklessNav>
                          {isMuted && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded flex-shrink-0" style={{ color: '#f87171', background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.30)' }}>已屏蔽</span>
                          )}
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={(e) => toggleProjectStar(e, p)}
                              disabled={starringProjectId === p.id}
                              title={p.starred ? '取消关注' : '关注项目'}
                              className={`h-7 w-7 flex items-center justify-center rounded-lg transition-all disabled:opacity-50 ${p.starred ? 'opacity-100' : 'opacity-60 group-hover:opacity-100 hover:bg-[var(--bg-hover)]'}`}
                              style={{ color: p.starred ? '#fbbf24' : 'var(--text-muted)' }}>
                              <Star className="w-4 h-4" fill={p.starred ? 'currentColor' : 'none'} strokeWidth={1.8} />
                            </button>
                            {p.can_manage && (
                              <button onClick={() => setEditingProject(p)} title="项目设置"
                                className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-[var(--bg-hover)] transition-all" style={{ color: 'var(--text-muted)' }}>
                                <Settings className="w-3.5 h-3.5" strokeWidth={1.8} />
                              </button>
                            )}
                            {userParam === user?.id && (
                              <div className="relative">
                                <button
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpenProjectMenuId((current) => current === p.id ? null : p.id) }}
                                  title="项目操作"
                                  aria-label="项目操作"
                                  className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-[var(--bg-hover)] transition-all"
                                  style={{ color: 'var(--text-muted)' }}>
                                  <MoreHorizontal className="w-3.5 h-3.5" strokeWidth={1.8} />
                                </button>
                                {openProjectMenuId === p.id && (
                                  <div
                                    className="absolute right-0 top-8 z-20 w-44 rounded-xl border p-1 shadow-xl"
                                    style={{ background: 'var(--modal-bg)', borderColor: 'var(--border-color)' }}
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {p.kind !== 'extension' ? (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.preventDefault(); e.stopPropagation()
                                          setOpenProjectMenuId(null)
                                          if (isMuted) {
                                            unmuteProject(e, p)
                                          } else {
                                            setHidingProject(p)
                                          }
                                        }}
                                        disabled={mutedBusyId === p.id}
                                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
                                        style={{ color: isMuted ? '#60a5fa' : '#f87171' }}
                                      >
                                        {isMuted ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                                        {isMuted ? '恢复显示' : '屏蔽项目'}
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExtDeletingProject(p); setOpenProjectMenuId(null) }}
                                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
                                        style={{ color: 'var(--text-primary)' }}
                                      >
                                        <MoreHorizontal className="h-3.5 w-3.5" />
                                        管理拓展显示
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-6">
                          {p.is_self_develop && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 font-medium"
                              style={{ color: '#fbbf24', background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.30)' }}>
                              自进化
                            </span>
                          )}
                          {p.kind === 'extension' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
                              style={{ color: '#a78bfa', background: 'rgba(167,139,250,0.10)' }}
                              title={p.disabled ? '拓展目录已消失, 数据保留中' : '由 mobius/extension/ 自动同步'}>
                              {p.disabled ? '拓展(失效)' : '拓展'}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* 描述 + 元数据 */}
                      <div className="px-4 py-2.5">
                        {p.description ? (
                          <p className="text-[12px] truncate mb-2" style={{ color: 'var(--text-secondary)' }} title={p.description}>
                            <SearchMatchText text={p.description} query={normalizedSearch} />
                          </p>
                        ) : (
                          <p className="text-[12px] italic mb-2" style={{ color: 'var(--text-muted)' }}>无描述</p>
                        )}
                        <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          <span>{activeIssueCount} 进行中</span>
                          <span>{completedIssueCount} 已完成</span>
                          {p.research_enabled && <span>{p.research_count || 0} 研究</span>}
                          <span className="ml-auto">活跃 {timeAgo(p.last_active)}</span>
                        </div>
                      </div>

                      {/* 拓展项目: "进入"按钮 (打开新 tab 进入特殊应用) */}
                      {p.kind === 'extension' && (
                        <div className="border-t px-4 py-2 flex items-center justify-between" style={{ borderColor: 'var(--border-color)' }}>
                          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            特殊拓展应用
                          </span>
                          <button
                            disabled={p.disabled}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (p.disabled) return; window.open(`/extension/${p.extension_name}/`, '_blank') }}
                            title={p.disabled ? '拓展目录已删除' : `打开新 tab 进入 ${p.name}`}
                            className="h-7 px-3 rounded text-[12px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            style={{ color: '#fff', background: p.disabled ? '#475569' : '#6366f1' }}>
                            进入 →
                          </button>
                        </div>
                      )}

                      {/* 搜索态优先展示混合层级命中；只有项目自身命中时保留原概览。 */}
                      {showingSearchMatches ? (
                        <div className="border-t px-4 py-2.5 flex-1" style={{ borderColor: 'var(--border-color)' }}>
                          <div className="mb-1.5 flex items-center justify-between gap-2">
                            <span className="text-[13px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                              命中内容 {searchGroup?.total_matches || searchMatches.length}
                            </span>
                            <LinklessNav to={`/u/${p.created_by}/p/${p.id}`}
                              className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors">进入项目 →</LinklessNav>
                          </div>
                          <div className="min-w-0 space-y-0.5">
                            {searchMatches.slice(0, 5).map((hit) => (
                              <HierarchyHitRow key={`${hit.kind}:${hit.id}`} project={p} hit={hit} query={normalizedSearch} variant="card" />
                            ))}
                            {(searchGroup?.total_matches || 0) > 5 && (
                              <div className="px-2 py-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                另有 {(searchGroup?.total_matches || 0) - 5} 条匹配
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                      <div className="border-t px-4 py-2.5 flex-1" style={{ borderColor: 'var(--border-color)' }}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-muted)' }}>{showResearch ? '研究' : '任务'}</span>
                          <LinklessNav to={`/u/${p.created_by}/p/${p.id}`}
                            className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors">查看全部 →</LinklessNav>
                        </div>
                        {overviewItems.length === 0 ? (
                          overviewLoading ? (
                            <ListLoadingHint compact />
                          ) : (
                            <div className="text-[11px] py-2" style={{ color: 'var(--text-muted)' }}>{showResearch ? '暂无研究' : '暂无任务'}</div>
                          )
                        ) : (
                          <div className="space-y-1 min-w-0">
                            {overviewItems.slice(0, 5).map((item: any) => (
                              <LinklessNav key={item.id} to={`/u/${p.created_by}/p/${p.id}/${overviewKind === 'research' ? 'r' : 'i'}/${item.id}`}
                                className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--bg-card-hover)] transition-colors group/iss min-w-0">
                                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${item.status === 'completed' ? 'bg-green-400' : (overviewKind === 'research' ? 'bg-emerald-400/80' : 'bg-blue-400/70')}`} />
                                <span className={`text-[12px] truncate flex-1 min-w-0 ${item.status === 'completed' ? 'line-through' : ''}`}
                                  style={{ color: item.status === 'completed' ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                                  {item.title}
                                </span>
                                {item.session_count > 0 && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)' }}>{item.session_count}</span>
                                )}
                              </LinklessNav>
                            ))}
                            {overviewTotal > 5 && (
                              <div className="text-[11px] py-1 px-2" style={{ color: 'var(--text-muted)' }}>
                                还有 {overviewTotal - 5} 个...
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      )}
                    </div>
                  )
                })}
              </div>
              {projectPagination.totalPages > 1 && (
                <div className="mt-4">
                  <PaginationControls {...projectPaginationProps} />
                </div>
              )}
              </>
            )}
            {/* 10.7: 搜索命中且当前用户已屏蔽的项目. 仍可见, 但带"已屏蔽"角标; 点击 Eye 图标可恢复显示. */}
            {search.trim() && searchMutedProjects.length > 0 && (
              <div className="mt-6">
                <div className="mb-2 text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                  已屏蔽 - 搜索命中 ({searchMutedProjects.length})
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {searchMutedProjects.map((p: any) => (
                    <div key={p.id} data-tour="user-muted-hit-card"
                      className="rounded-xl border overflow-hidden flex flex-col group transition-all"
                      style={{ background: 'var(--bg-primary)', borderColor: 'rgba(248,113,113,0.45)' }}>
                      <div className="px-4 py-3 border-b" style={{ borderColor: 'rgba(248,113,113,0.30)' }}>
                        <div className="flex items-center gap-2 min-w-0">
                          <LinklessNav to={`/u/${p.created_by}/p/${p.id}`}
                            className="text-[14px] font-semibold truncate flex-1 min-w-0 transition-colors hover:text-blue-400"
                            style={{ color: 'var(--text-primary)' }} title={p.name}>
                            <SearchMatchText text={p.name} query={normalizedSearch} />
                          </LinklessNav>
                          <span className="text-[9px] px-1.5 py-0.5 rounded flex-shrink-0" style={{ color: '#f87171', background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.30)' }}>已屏蔽</span>
                          <button onClick={(e) => unmuteProject(e, p)} disabled={mutedBusyId === p.id}
                            title="恢复显示"
                            aria-label="恢复显示"
                            className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-[var(--bg-hover)] transition-all disabled:opacity-50"
                            style={{ color: '#f87171' }}>
                            <Eye className="w-3.5 h-3.5" strokeWidth={1.8} />
                          </button>
                        </div>
                        <p className="mt-1 text-[11px] pl-1" style={{ color: 'var(--text-muted)' }}>
                          该项目仍在你的屏蔽列表中，仅搜索时可见。点击标题可直接进入；点击右侧按钮可恢复显示。
                        </p>
                      </div>
                      {(hierarchyGroupByProject.get(String(p.id))?.matches.length || 0) > 0 && (
                        <div className="px-3 py-2">
                          {hierarchyGroupByProject.get(String(p.id))!.matches.slice(0, 5).map((hit) => (
                            <HierarchyHitRow key={`${hit.kind}:${hit.id}`} project={p} hit={hit} query={normalizedSearch} variant="card" />
                          ))}
                          {hierarchyGroupByProject.get(String(p.id))!.total_matches > 5 && (
                            <div className="px-2 py-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              另有 {hierarchyGroupByProject.get(String(p.id))!.total_matches - 5} 条匹配
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          )}
          {userParam === user?.id && activeView === 'memory' && (
            <div className="max-w-4xl mx-auto">
              <div className="mb-4">
                <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>个人 Memory</h1>
                <p className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>用户级记忆片段, 可随时添加/编辑/删除</p>
              </div>
              <MemoriesManager scope="user" />
            </div>
          )}
          {userParam === user?.id && activeView === 'skills' && (
            <div className="max-w-4xl mx-auto">
              <div className="mb-4">
                <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>个人 Skill</h1>
                <p className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>用户级 skill, 在你创建的所有任务中默认可用</p>
              </div>
              <SkillsManager scope="user" />
            </div>
          )}
          {userParam === user?.id && activeView === 'data' && (
            <PlaceholderView icon={<Database className="w-6 h-6" strokeWidth={1.5} />} title="数据" desc="项目与系统数据视图。后续将在此汇总项目资料、执行数据与导出内容。" />
          )}
          {userParam === user?.id && activeView === 'monitor' && (
            <PlaceholderView icon={<Activity className="w-6 h-6" strokeWidth={1.5} />} title="监控" desc="系统与服务运行监控。后续将在此展示服务状态、负载与告警。" />
          )}
          {userParam === user?.id && activeView === 'config' && (
            <PlaceholderView icon={<Settings className="w-6 h-6" strokeWidth={1.5} />} title="配置" desc="用户偏好与系统配置。后续将在此提供个性化与系统设置入口。" />
          )}

        </main>
      </div>

      {showNew && <NewProjectModal onClose={() => setShowNew(false)} onCreated={(p: any) => {
        setShowNew(false); refresh()
        if (p?.id && p?.created_by) navigate(`/u/${p.created_by}/p/${p.id}`)
      }} />}
      {editingProject && <ProjectSettingsModal project={editingProject} onClose={() => setEditingProject(null)}
        onSaved={(updated: any) => { setEditingProject(null); setProjects(sortProjectsForDisplay(projects.map((pp: any) => pp.id === updated.id ? { ...pp, ...updated } : pp))) }} />}
      {hidingProject && <ConfirmModal
        title="屏蔽项目"
        message={`屏蔽「${hidingProject.name}」后，它会从你的项目列表和侧边栏隐藏，但不会删除。可在已屏蔽项目中恢复显示。`}
        confirmText="确认屏蔽"
        confirmClass="bg-blue-500 hover:bg-blue-600"
        onConfirm={confirmHideProject}
        onClose={() => setHidingProject(null)}
      />}
      {extDeletingProject && <ExtensionDeleteModal project={extDeletingProject} onClose={() => setExtDeletingProject(null)} onDone={() => { setExtDeletingProject(null); refresh() }} />}
    </div>
  )
}

function PlaceholderView({ icon, title, desc }: { icon: ReactNode; title: string; desc: string }) {
  return (
    <div className="max-w-4xl mx-auto">
      <div className="rounded-2xl border-2 border-dashed p-12 text-center" style={{ borderColor: 'var(--border-color)' }}>
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>{icon}</div>
        <div className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</div>
        <p className="mx-auto mt-2 max-w-md text-[12px] leading-5" style={{ color: 'var(--text-muted)' }}>{desc}</p>
        <div className="mt-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>敬请期待</div>
      </div>
    </div>
  )
}
