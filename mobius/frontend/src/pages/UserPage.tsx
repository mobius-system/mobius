import { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Eye, EyeOff, MoreHorizontal, Settings, Star } from 'lucide-react'
import { useStore, api } from '../store'
import { TopNav, timeAgo } from '../components/shell'
import { usePagination, PaginationControls } from '../components/pagination'
import { ConfirmModal, NewProjectModal, ProjectSettingsModal, ExtensionDeleteModal } from '../components/modals'
import { SkillsManager } from '../components/skills'
import { MemoriesManager } from '../components/memories'
import { ResizablePanel } from '../components/resizable-panel'

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
    const activeDiff = new Date(b.last_active || 0).getTime() - new Date(a.last_active || 0).getTime()
    if (activeDiff !== 0) return activeDiff
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
  })
}

function projectVisibilityLabel(value: any) {
  if (value === 'team') return '同组'
  if (value === 'public') return '公开'
  return '仅自己'
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

export default function UserPage() {
  const params = useParams()
  const navigate = useNavigate()
  const {
    user, projects, setProjects, setCurrentProject, setCurrentIssue, setCurrentResearch, setCurrentSession, setCurrentTask,
    mutedProjectIds, setMutedProjectIds,
  } = useStore()
  const userParam = params.user || user?.id || ''

  const [showNew, setShowNew] = useState(false)
  const [search, setSearch] = useState('')
  const [issuesByProject, setIssuesByProject] = useState<Record<string, any[]>>({})
  const [researchesByProject, setResearchesByProject] = useState<Record<string, any[]>>({})
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

  const openNavTarget = (to: string, event: any) => {
    if (!to) return
    if (event?.metaKey || event?.ctrlKey || event?.shiftKey || event?.button === 1) {
      window.open(to, '_blank', 'noopener,noreferrer')
      return
    }
    navigate(to)
  }

  const LinklessNav = ({ to, className = '', children, onClick, onAuxClick, ...props }: any) => (
    <button
      type="button"
      {...props}
      className={`appearance-none border-0 bg-transparent text-left cursor-pointer ${className}`}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        openNavTarget(to, event)
      }}
      onAuxClick={(event) => {
        onAuxClick?.(event)
        if (event.defaultPrevented) return
        if (event.button !== 1) return
        event.preventDefault()
        openNavTarget(to, event)
      }}
    >
      {children}
    </button>
  )

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
  const myProjects = useMemo(
    () => sortedProjects.filter((p: any) =>
      (isViewingOwnAsAll || userParam === user?.id || p.kind === 'extension' || p.created_by === userParam)
      && !p.hidden
      && !mutedIdSet.has(p.id)
      && matchesProjectFilters(p, projectFilters, user?.id || '')
      && projectMatchesSearch(p, search)
    ),
    [sortedProjects, userParam, user?.id, mutedIdSet, projectFilters, search, isViewingOwnAsAll]
  )
  // 搜索时: 已 mute 的项目也展示, 但带角标; 后端 GET /api/projects 本身在搜索词下会保留 mute 项目.
  const searchMutedProjects = useMemo(
    () => search.trim()
      ? sortedProjects.filter((p: any) =>
        mutedIdSet.has(p.id)
        && (isViewingOwnAsAll || userParam === user?.id || p.kind === 'extension' || p.created_by === userParam)
        && !p.hidden
        && matchesProjectFilters(p, projectFilters, user?.id || '')
        && projectMatchesSearch(p, search)
      )
      : [],
    [sortedProjects, userParam, mutedIdSet, projectFilters, search, user?.id, isViewingOwnAsAll]
  )
  const visibleProjectCount = myProjects.length + (search.trim() ? searchMutedProjects.length : 0)

  // 主区项目卡片分页: 只渲染当前页的 15 个, 翻页时切片切换 (myProjects 本身不变, issues 概览拉取不受影响).
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
    myProjects.forEach((p: any) => {
      if (!issuesByProject[p.id]) {
        api(`/api/projects/${p.id}/issues`).then((issues: any[]) => {
          setIssuesByProject(prev => ({ ...prev, [p.id]: issues || [] }))
        }).catch(() => {})
      }
      if (p.research_enabled && !researchesByProject[p.id]) {
        api(`/api/projects/${p.id}/researches`).then((researches: any[]) => {
          setResearchesByProject(prev => ({ ...prev, [p.id]: researches || [] }))
        }).catch(() => {})
      }
    })
  }, [myProjects])

  // 按 created_by 分组（sidebar）
  const grouped = useMemo(() => {
    const m: Record<string, any[]> = {}
    // 默认视图排除已 mute 的项目; 搜索时保留它们, sidebar 用 muted: true 标记.
    for (const p of sortedProjects) {
      const isMuted = mutedIdSet.has(p.id) || !!p.muted
      if (isMuted && !search.trim()) continue
      if (p.hidden && !isMuted) continue
      if (!(isViewingOwnAsAll || userParam === user?.id || p.kind === 'extension' || p.created_by === userParam)) continue
      if (!matchesProjectFilters(p, projectFilters, user?.id || '')) continue
      const key = p.created_by || '未知'
      if (!m[key]) m[key] = []
      m[key].push(p)
    }
    if (search.trim()) {
      for (const k of Object.keys(m)) {
        m[k] = m[k].filter((p: any) => projectMatchesSearch(p, search))
        if (m[k].length === 0) delete m[k]
      }
    }
    return m
  }, [sortedProjects, search, mutedIdSet, userParam, user?.id, projectFilters])

  const emptyProjectText = search.trim()
    ? '未找到匹配项目'
    : (projectFilters.length > 0 ? '当前筛选下没有项目' : `${userParam} 还没有项目`)

  const pageTitle = projectFilters.length === 0
    ? '全部项目'
    : `${userParam} 的项目`

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--bg-primary)' }}>
      <TopNav />
      <div className="flex flex-1 min-h-0">
        {/* 左侧 sidebar */}
        <ResizablePanel
          storageKey="mobius:ui:sidebar:user-projects"
          defaultWidth={288}
          minWidth={200}
          maxWidth={480}
          side="left"
          data-tour="user-projects-sidebar"
          className="border-r flex flex-col"
          style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
          <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border-color)' }}>
            <span className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>
              所有项目 <span className="ml-1 text-[11px] font-medium">{visibleProjectCount}</span>
            </span>
            <button onClick={() => setShowNew(true)} title="新建项目" data-tour="user-sidebar-new-project"
              className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-[var(--bg-hover)] text-blue-400 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            </button>
          </div>
          <div className="px-3 py-2">
            <div className="relative">
              <svg className="w-3.5 h-3.5 absolute left-2.5 top-[9px]" style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="搜索项目..."
                className="w-full h-8 pl-8 pr-3 rounded-lg text-[12px] focus:outline-none focus:border-blue-500/30"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
            </div>
            <div className="mt-2 rounded-lg border px-2 py-2" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-card)' }}>
              <div className="flex flex-nowrap gap-1.5 overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setProjectFilters([])}
                  title="显示全部未屏蔽项目"
                  className="inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors flex-shrink-0"
                  style={projectFilters.length === 0
                    ? { background: 'rgba(59,130,246,0.16)', borderColor: 'rgba(59,130,246,0.55)', color: '#60a5fa' }
                    : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}
                >
                  全部
                </button>
                {PROJECT_FILTERS.map((item) => {
                  const active = projectFilters.includes(item.key)
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => toggleProjectFilter(item.key)}
                      title={item.title}
                      className="inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors flex-shrink-0"
                      style={active
                        ? { background: 'rgba(59,130,246,0.16)', borderColor: 'rgba(59,130,246,0.55)', color: '#60a5fa' }
                        : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}
                    >
                      {item.label}
                    </button>
                  )
                })}
              </div>
            </div>
            {mutedProjectIds.length > 0 && (
              <button
                type="button"
                onClick={() => { setShowMutedPanel((v) => !v); if (!showMutedPanel) refreshMutedProjects() }}
                className="mt-2 w-full flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-[11px] transition-colors hover:bg-[var(--bg-hover)]"
                style={{ borderColor: 'var(--border-color)', background: 'var(--bg-card)', color: showMutedPanel ? '#60a5fa' : 'var(--text-muted)' }}
              >
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <EyeOff className="h-3.5 w-3.5" />
                  已屏蔽项目
                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.06)' }}>{mutedProjectIds.length}</span>
                </span>
                <span className="text-[10px]">{showMutedPanel ? '收起' : '打开'}</span>
              </button>
            )}
          </div>
          {showMutedPanel && (
            <div className="mx-3 mb-2 rounded-lg border px-3 py-3" style={{ borderColor: 'rgba(248,113,113,0.30)', background: 'rgba(248,113,113,0.04)' }}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>已屏蔽项目</div>
                  <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>这里可以恢复被你屏蔽的项目</div>
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
                        <div className="truncate text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{p.kind === 'extension' ? '拓展项目' : '普通项目'}</div>
                      </LinklessNav>
                      <button
                        type="button"
                        onClick={(e) => unmuteProject(e, p)}
                        disabled={mutedBusyId === p.id}
                        className="inline-flex h-7 items-center gap-1 rounded-full border px-3 text-[11px] font-medium transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
                        style={{ color: '#60a5fa', borderColor: 'rgba(59,130,246,0.35)' }}
                      >
                        <Eye className="h-3.5 w-3.5" />
                        恢复显示
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="flex-1 overflow-y-auto px-2 py-1">
            {Object.entries(grouped).map(([uname, plist]) => (
              <div key={uname} className="mb-3">
                {uname === '未知' ? (
                  <div className="px-3 py-1.5 flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full bg-gradient-to-br from-blue-500/30 to-cyan-500/20 flex items-center justify-center text-blue-300 text-[12px] font-semibold border border-blue-500/20">
                      {uname[0]?.toUpperCase()}
                    </div>
                    <span className="text-[13px] font-semibold tracking-wide" style={{ color: 'var(--text-secondary)' }}>{uname}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)' }}>{plist.length}</span>
                  </div>
                ) : (
                  <LinklessNav to={`/u/${uname}`} data-tour="user-sidebar-group"
                    className="px-3 py-1.5 flex items-center gap-2 rounded-md hover:bg-[var(--bg-hover)] transition-colors">
                    <div className="w-5 h-5 rounded-full bg-gradient-to-br from-blue-500/30 to-cyan-500/20 flex items-center justify-center text-blue-300 text-[12px] font-semibold border border-blue-500/20">
                      {uname[0]?.toUpperCase()}
                    </div>
                    <span className="text-[13px] font-semibold tracking-wide" style={{ color: 'var(--text-secondary)' }}>{uname}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)' }}>{plist.length}</span>
                  </LinklessNav>
                )}
                {plist.map((p: any) => {
                  const isMuted = mutedIdSet.has(p.id)
                  return (
                  <div key={p.id}
                    className="group flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer mb-0.5 transition-all hover:bg-[var(--bg-card-hover)]">
                    <button
                      onClick={(e) => toggleProjectStar(e, p)}
                      disabled={starringProjectId === p.id}
                      title={p.starred ? '取消关注' : '关注项目'}
                      className={`h-6 w-6 flex items-center justify-center rounded-md transition-colors disabled:opacity-50 ${p.starred ? 'opacity-100' : 'opacity-60 group-hover:opacity-100 hover:bg-[var(--bg-hover)]'}`}
                      style={{ color: p.starred ? '#fbbf24' : 'var(--text-muted)' }}>
                      <Star className="w-3.5 h-3.5" fill={p.starred ? 'currentColor' : 'none'} strokeWidth={1.8} />
                    </button>
                    <LinklessNav to={`/u/${p.created_by}/p/${p.id}`}
                      className="flex items-center gap-1.5 min-w-0 flex-1">
                      <svg className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                      <span className="text-[12px] font-medium truncate flex-1" style={{ color: 'var(--text-primary)' }}>{p.name}</span>
                      {isMuted && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded flex-shrink-0" style={{ color: '#f87171', background: 'rgba(248,113,113,0.10)', border: '1px solid rgba(248,113,113,0.30)' }}>已屏蔽</span>
                      )}
                      <span className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" style={{ color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)' }}>{p.issue_count ?? 0}</span>
                    </LinklessNav>
                  </div>
                  )
                })}
              </div>
            ))}
            {Object.keys(grouped).length === 0 && (
              <div className="text-center py-8 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {search.trim() ? '未找到匹配项目' : (projectFilters.length > 0 ? '当前筛选下暂无项目' : '暂无项目')}
              </div>
            )}
          </div>
        </ResizablePanel>

        {/* 右侧主区 */}
        <main data-tour="user-projects-main" className="flex-1 overflow-y-auto p-6" style={{ background: 'var(--bg-secondary)' }}>
          <div className="max-w-6xl mx-auto flex gap-6">
            <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>{pageTitle}</h1>
                <p className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>共 {visibleProjectCount} 个项目</p>
              </div>
              <button onClick={() => setShowNew(true)} data-tour="user-new-project"
                className="h-9 px-4 rounded-lg text-[13px] btn-primary transition-colors flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                新建项目
              </button>
            </div>

            {myProjects.length === 0 ? (
              <div className="rounded-2xl border-dashed border-2 p-12 text-center" style={{ borderColor: 'var(--border-color)' }}>
                <div className="text-[14px] mb-3" style={{ color: 'var(--text-muted)' }}>{emptyProjectText}</div>
                {projectFilters.length > 0 ? (
                  <button onClick={() => setProjectFilters([])}
                    className="h-9 px-4 rounded-lg text-[13px] text-blue-400 bg-blue-500/10 hover:bg-blue-500/15 transition-colors">
                    清空筛选
                  </button>
                ) : (
                  <button onClick={() => setShowNew(true)} data-tour="user-empty-create-project"
                    className="h-9 px-4 rounded-lg text-[13px] text-blue-400 bg-blue-500/10 hover:bg-blue-500/15 transition-colors">
                    创建第一个项目
                  </button>
                )}
              </div>
            ) : (
              <>
              {projectPagination.totalPages > 1 && (
                <div className="mb-4">
                  <PaginationControls {...projectPaginationProps} />
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {projectPagination.pagedItems.map((p: any) => {
                  const issues = issuesByProject[p.id] || []
                  const researches = researchesByProject[p.id] || []
                  const showResearch = !!p.research_enabled && !((p.research_count || 0) === 0 && issues.length > 0)
                  const overviewItems = showResearch ? researches : issues
                  const overviewKind = showResearch ? 'research' : 'issue'
                  const active = issues.filter((i: any) => i.status !== 'completed')
                  const completed = issues.filter((i: any) => i.status === 'completed')
                  const isMuted = mutedIdSet.has(p.id)
                  return (
                    <div key={p.id} data-tour="user-project-card"
                      className={`rounded-xl border overflow-hidden flex flex-col group transition-all min-w-0 ${p.is_self_develop ? 'hover:border-yellow-400/60' : 'hover:border-blue-500/30'}`}
                      style={p.is_self_develop
                        ? { background: 'linear-gradient(135deg, rgba(251,191,36,0.06) 0%, var(--bg-primary) 60%)', borderColor: 'rgba(251,191,36,0.45)' }
                        : { background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}>
                      {/* 卡片头部 */}
                      <div className="px-4 py-3 border-b" style={{ borderColor: p.is_self_develop ? 'rgba(251,191,36,0.25)' : 'var(--border-color)' }}>
                        <div className="flex items-center gap-2 min-w-0">
                          <svg className={`w-4 h-4 flex-shrink-0 ${p.is_self_develop ? 'text-yellow-400' : 'text-blue-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                          <LinklessNav to={`/u/${p.created_by}/p/${p.id}`}
                            className={`text-[14px] font-semibold truncate flex-1 min-w-0 transition-colors ${p.is_self_develop ? 'hover:text-yellow-400' : 'hover:text-blue-400'}`}
                            style={{ color: 'var(--text-primary)' }}
                            title={p.name}>
                            {p.name}
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
                                    {p.can_manage && (
                                      <button
                                        type="button"
                                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditingProject(p); setOpenProjectMenuId(null) }}
                                        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
                                        style={{ color: 'var(--text-primary)' }}
                                      >
                                        <Settings className="h-3.5 w-3.5" />
                                        项目设置
                                      </button>
                                    )}
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
                              自迭代
                            </span>
                          )}
                          {p.bind_path && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded truncate max-w-[150px]" title={p.bind_path}
                              style={{ color: '#60a5fa', background: 'rgba(96,165,250,0.08)' }}>
                              {p.bind_path.split('/').slice(-1)[0] || p.bind_path}
                            </span>
                          )}
                          {p.research_enabled && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
                              style={{ color: '#34d399', background: 'rgba(52,211,153,0.08)' }}>
                              Research
                            </span>
                          )}
                          <span className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
                            style={{ color: '#60a5fa', background: 'rgba(96,165,250,0.08)' }}
                            title="项目可见性">
                            {projectVisibilityLabel(p.visibility)}
                          </span>
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
                          <p className="text-[12px] line-clamp-2 mb-2" style={{ color: 'var(--text-secondary)' }}>{p.description}</p>
                        ) : (
                          <p className="text-[12px] italic mb-2" style={{ color: 'var(--text-muted)' }}>无描述</p>
                        )}
                        <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          <span>{active.length} 进行中</span>
                          <span>{completed.length} 已完成</span>
                          {p.research_enabled && <span>{p.research_count || 0} Research</span>}
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

                      {/* Issues / Research 概览 */}
                      <div className="border-t px-4 py-2.5 flex-1" style={{ borderColor: 'var(--border-color)' }}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-muted)' }}>{showResearch ? 'Research' : 'Issues'}</span>
                          <LinklessNav to={`/u/${p.created_by}/p/${p.id}`}
                            className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors">查看全部 →</LinklessNav>
                        </div>
                        {overviewItems.length === 0 ? (
                          <div className="text-[11px] py-2" style={{ color: 'var(--text-muted)' }}>{showResearch ? '暂无 Research' : '暂无 Issue'}</div>
                        ) : (
                          <div className="space-y-1">
                            {overviewItems.slice(0, 5).map((item: any) => (
                              <LinklessNav key={item.id} to={`/u/${p.created_by}/p/${p.id}/${overviewKind === 'research' ? 'r' : 'i'}/${item.id}`}
                                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--bg-card-hover)] transition-colors group/iss min-w-0">
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
                            {overviewItems.length > 5 && (
                              <div className="text-[11px] py-1 px-2" style={{ color: 'var(--text-muted)' }}>
                                还有 {overviewItems.length - 5} 个...
                              </div>
                            )}
                          </div>
                        )}
                      </div>
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
                            {p.name}
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
                    </div>
                  ))}
                </div>
              </div>
            )}
            </div>
            {userParam === user?.id && (
              <ResizablePanel
                storageKey="mobius:ui:sidebar:user-skills"
                defaultWidth={340}
                minWidth={260}
                maxWidth={520}
                side="right"
                className="hidden lg:block space-y-4"
                style={{ background: 'transparent' }}>
                <div>
                  <div className="mb-3">
                    <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>个人 Skill</h2>
                    <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>用户级 skill, 在你创建的所有 Issue 中默认可用</p>
                  </div>
                  <SkillsManager scope="user" />
                </div>
                <div>
                  <div className="mb-3">
                    <h2 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>个人 Memory</h2>
                    <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>用户级记忆片段, 可随时添加/编辑/删除</p>
                  </div>
                  <MemoriesManager scope="user" />
                </div>
              </ResizablePanel>
            )}
          </div>
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
