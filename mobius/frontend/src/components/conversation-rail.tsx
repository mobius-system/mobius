import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  Home,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  UserRound,
  X,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api, useStore } from '../store'
import { pollRecursive } from '../services/polling'
import { logUiEvent } from '../services/ui-observability'
import {
  homeNavigation,
  navigateToWorkbenchObject,
  sessionNavigation,
  sessionPath,
} from '../services/workbench-navigation'

const COLLAPSED_PROJECTS_STORAGE_KEY = 'mobius:ui:conversation-rail:collapsed'
const UNNAMED_PROJECT_KEY = '__unnamed_project__'

export type ConversationRailItem = {
  session_id: string
  name?: string
  project_id?: string | null
  project_name?: string | null
  issue_id?: string | null
  issue_title?: string | null
  research_id?: string | null
  research_title?: string | null
  scope_type?: 'issue' | 'research'
  agent_status?: string
  status?: string
  last_active?: string
}

type ProjectFolder = {
  projectId: string
  projectName: string
  items: ConversationRailItem[]
  runningCount: number
}

type ProjectCollapseState = Record<string, boolean>

function lastActiveTime(item?: ConversationRailItem) {
  const timestamp = item?.last_active ? new Date(item.last_active).getTime() : 0
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function projectFolderKey(projectId: string) {
  return projectId || UNNAMED_PROJECT_KEY
}

function loadProjectCollapseState(): ProjectCollapseState {
  if (typeof window === 'undefined') return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COLLAPSED_PROJECTS_STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
    )
  } catch {
    return {}
  }
}

function statusMeta(item: ConversationRailItem) {
  if (item.agent_status === 'failed' || item.status === 'failed') return { label: '失败', color: 'var(--status-danger)' }
  if (item.agent_status === 'running') return { label: '进行中', color: 'var(--status-running)' }
  if (item.agent_status === 'pending' || item.agent_status === 'waiting') return { label: '等待', color: 'var(--status-waiting)' }
  if (item.agent_status === 'completed' || item.status === 'completed') return { label: '完成', color: 'var(--status-success)' }
  return null
}

function relativeActivityTime(item: ConversationRailItem) {
  const timestamp = lastActiveTime(item)
  if (!timestamp) return ''
  const elapsed = Math.max(0, Date.now() - timestamp)
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} 小时前`
  if (elapsed < 48 * 60 * 60_000) return '昨天'
  if (elapsed < 7 * 24 * 60 * 60_000) return `${Math.floor(elapsed / (24 * 60 * 60_000))} 天前`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function conversationPath(userId: string, item: ConversationRailItem) {
  if (!item.session_id) return ''
  return sessionPath(userId, item.session_id)
}

export function ConversationRail({
  userId,
  activeSessionId,
  projectId,
  onNewConversation,
  onOpenConversation,
  onOpenSearch,
  onOpenSettings,
  refreshKey,
}: {
  userId: string
  activeSessionId?: string | null
  projectId?: string | null
  onNewConversation: () => void
  onOpenConversation?: (item: ConversationRailItem) => void
  onOpenSearch?: (trigger: HTMLElement) => void
  onOpenSettings?: (trigger: HTMLElement) => void
  refreshKey?: number
}) {
  const navigate = useNavigate()
  const { user, logout } = useStore()
  const [items, setItems] = useState<ConversationRailItem[]>([])
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [manualRefreshKey, setManualRefreshKey] = useState(0)
  const [projectCollapseState, setProjectCollapseState] = useState<ProjectCollapseState>(loadProjectCollapseState)
  const drawerTriggerRef = useRef<HTMLElement | null>(null)
  const railSearchReturnFocusRef = useRef<HTMLButtonElement | null>(null)

  const closeDrawer = () => {
    setDrawerOpen(false)
    window.requestAnimationFrame(() => drawerTriggerRef.current?.focus())
  }

  useEffect(() => {
    const openDrawer = () => {
      drawerTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setDrawerOpen(true)
      setSearchOpen(true)
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>('[role="dialog"][aria-label="历史会话"] [data-rail-slot="search"] input')?.focus()
      })
    }
    window.addEventListener('mobius:open-history', openDrawer)
    return () => window.removeEventListener('mobius:open-history', openDrawer)
  }, [])

  useEffect(() => {
    if (!drawerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeDrawer()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])

  useEffect(() => {
    const wideViewport = window.matchMedia('(min-width: 1280px)')
    const syncDrawer = () => {
      if (wideViewport.matches) setDrawerOpen(false)
    }
    wideViewport.addEventListener('change', syncDrawer)
    return () => wideViewport.removeEventListener('change', syncDrawer)
  }, [])

  useEffect(() => {
    const refresh = () => setManualRefreshKey(key => key + 1)
    window.addEventListener('mobius:refresh-conversation-rail', refresh)
    return () => window.removeEventListener('mobius:refresh-conversation-rail', refresh)
  }, [])

  useEffect(() => {
    let active = true
    let firstLoad = true
    setLoading(true)
    setError('')
    const stop = pollRecursive(async (signal) => {
      try {
        const result: any = await api('/api/tasks/recent?limit=100', { signal })
        if (!active) return
        setItems(Array.isArray(result) ? result : [])
        setError('')
      } catch (reason: any) {
        if (active && firstLoad && !signal.aborted) setError(reason?.message || '历史会话加载失败')
      } finally {
        if (active && firstLoad) {
          firstLoad = false
          setLoading(false)
        }
      }
    }, 10_000, 10_000)
    return () => {
      active = false
      stop()
    }
  }, [manualRefreshKey, refreshKey, userId])

  const projectFolders = useMemo(() => {
    const folders = new Map<string, ProjectFolder>()
    const sortedItems = [...items].sort((left, right) => lastActiveTime(right) - lastActiveTime(left))

    sortedItems.forEach(item => {
      const itemProjectId = item.project_id || ''
      const itemProjectName = itemProjectId ? (item.project_name || '未命名项目') : '未命名项目'
      const folderKey = projectFolderKey(itemProjectId)
      const folder = folders.get(folderKey) || {
        projectId: itemProjectId,
        projectName: itemProjectName,
        items: [],
        runningCount: 0,
      }
      folder.items.push(item)
      if (item.agent_status === 'running') folder.runningCount += 1
      folders.set(folderKey, folder)
    })

    return Array.from(folders.values()).sort(
      (left, right) => lastActiveTime(right.items[0]) - lastActiveTime(left.items[0]),
    )
  }, [items])

  const normalizedQuery = query.trim().toLowerCase()
  const visibleFolders = useMemo(() => {
    if (!normalizedQuery) return projectFolders
    return projectFolders.flatMap(folder => {
      const projectMatches = folder.projectName.toLowerCase().includes(normalizedQuery)
      const matchingItems = projectMatches
        ? folder.items
        : folder.items.filter(item => [item.name || '未命名会话', item.session_id]
          .some(value => String(value).toLowerCase().includes(normalizedQuery)))
      return matchingItems.length ? [{ ...folder, items: matchingItems }] : []
    })
  }, [normalizedQuery, projectFolders])

  const folderIsExpanded = (folder: ProjectFolder) => {
    if (normalizedQuery) return true
    const storedCollapseState = projectCollapseState[projectFolderKey(folder.projectId)]
    if (storedCollapseState !== undefined) return !storedCollapseState
    return true
  }

  const toggleFolder = (folder: ProjectFolder) => {
    if (normalizedQuery) return
    const folderKey = projectFolderKey(folder.projectId)
    const nextCollapsed = folderIsExpanded(folder)
    setProjectCollapseState(current => {
      const next = { ...current, [folderKey]: nextCollapsed }
      try {
        window.localStorage.setItem(COLLAPSED_PROJECTS_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // localStorage 不可用时，折叠状态仅在当前页面生效。
      }
      return next
    })
  }

  const openConversation = (item: ConversationRailItem) => {
    if (!item.session_id) return
    logUiEvent('history_opened', { session_id: item.session_id, project_id: item.project_id })
    onOpenConversation?.(item)
    setDrawerOpen(false)
    navigateToWorkbenchObject(navigate, sessionNavigation(userId, item.session_id))
  }

  const openHome = () => {
    setDrawerOpen(false)
    navigateToWorkbenchObject(navigate, homeNavigation(userId))
  }

  const openRailSearch = (trigger: HTMLButtonElement) => {
    railSearchReturnFocusRef.current = trigger
    setSearchOpen(true)
    window.requestAnimationFrame(() => {
      trigger.closest('aside')?.querySelector<HTMLInputElement>('[data-rail-slot="search"] input')?.focus()
    })
  }

  const closeRailSearch = () => {
    setSearchOpen(false)
    setQuery('')
    window.requestAnimationFrame(() => railSearchReturnFocusRef.current?.focus())
  }

  const renderRail = (drawer = false) => (
    <aside
      className={`conversation-rail relative flex h-full w-[280px] flex-shrink-0 flex-col ${drawer ? 'z-10 max-w-[calc(100vw-32px)] shadow-lg' : ''}`}
      style={{ width: 'var(--rail-width)', background: 'var(--surface-sidebar)' }}
      aria-label="最近会话"
    >
      <div data-rail-slot="header" className="p-2">
        <div className="flex items-center gap-1">
          <button type="button" onClick={openHome} aria-label="回到 Home" title="回到 Home"
            className="workbench-control-md inline-flex min-w-0 flex-1 items-center gap-2 px-2 text-left hover:bg-[var(--surface-control-hover)]"
            style={{ color: 'var(--text-primary)' }}>
            <Home className="h-4 w-4 flex-shrink-0" />
            <span className="truncate text-[12px] font-semibold">Mobius</span>
          </button>
          <button type="button" onClick={() => { setDrawerOpen(false); onNewConversation() }} aria-label="新会话" title="新会话"
            className="workbench-control-md inline-flex w-8 items-center justify-center hover:bg-[var(--surface-control-hover)]" style={{ color: 'var(--text-secondary)' }}>
            <Plus className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => setManualRefreshKey(key => key + 1)} disabled={loading} aria-label="刷新会话" title="刷新会话"
            className="workbench-control-md inline-flex w-8 items-center justify-center hover:bg-[var(--surface-control-hover)] disabled:opacity-50" style={{ color: 'var(--text-secondary)' }}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button type="button" onClick={event => openRailSearch(event.currentTarget)} aria-label="搜索会话" title="按项目、标题或 Session ID 搜索"
            className="workbench-control-md inline-flex w-8 items-center justify-center hover:bg-[var(--surface-control-hover)]" style={{ color: searchOpen ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
            <Search className="h-4 w-4" />
          </button>
          {drawer && (
            <button type="button" onClick={closeDrawer} aria-label="关闭历史会话" title="关闭历史会话"
              className="workbench-control-md inline-flex w-8 items-center justify-center hover:bg-[var(--surface-control-hover)]" style={{ color: 'var(--text-secondary)' }}>
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div data-rail-slot="search" className={`${searchOpen ? 'block' : 'hidden'} border-b p-2`} style={{ borderColor: 'var(--border-default)' }}>
        <label className="relative block">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              closeRailSearch()
            }}
            placeholder="搜索 Project / Session / ID"
            aria-label="搜索 Project、Session 或 Session ID"
            className="workbench-control-md w-full pl-8 pr-8 text-[12px] outline-none"
            style={{ color: 'var(--text-primary)', background: 'var(--surface-control)', border: '1px solid var(--border-strong)' }}
          />
          <button type="button" onClick={closeRailSearch} aria-label="关闭会话搜索" className="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded hover:bg-[var(--surface-control-hover)]" style={{ color: 'var(--text-muted)' }}>
            <X className="h-3.5 w-3.5" />
          </button>
        </label>
        <button type="button" onClick={event => onOpenSearch?.(event.currentTarget)} className="mt-1.5 px-1 text-[10px] hover:underline" style={{ color: 'var(--text-muted)' }}>
          搜索消息内容（⌘/Ctrl K）
        </button>
      </div>

      <div data-rail-slot="body" className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {loading ? (
          <div className="px-2 py-5 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中…</div>
        ) : error ? (
          <div className="px-2 py-5 text-center text-[12px]" style={{ color: 'var(--status-danger)' }}>{error}</div>
        ) : visibleFolders.length === 0 ? (
          <div className="px-2 py-5 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>{normalizedQuery ? '没有匹配的会话' : '暂无会话'}</div>
        ) : (
          <div>
            <h2 className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>项目</h2>
            <div className="space-y-1">
              {visibleFolders.map(folder => {
                const folderKey = projectFolderKey(folder.projectId)
                const expanded = folderIsExpanded(folder)
                const focused = Boolean(projectId) && folder.projectId === projectId
                const folderPanelId = `conversation-folder-${drawer ? 'drawer' : 'desktop'}-${encodeURIComponent(folderKey)}`
                return (
                  <section key={folderKey}>
                    <button type="button" onClick={() => toggleFolder(folder)}
                      aria-expanded={expanded} aria-controls={folderPanelId}
                      className="flex min-h-[var(--control-height-sm)] w-full min-w-0 items-center gap-1.5 rounded-[12px] px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-control-hover)]"
                      style={{ background: focused ? 'var(--surface-active)' : undefined }}>
                      {expanded
                        ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                        : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
                      <Folder className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-secondary)' }} />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        {folder.projectName}
                      </span>
                      {folder.runningCount > 0 && (
                        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: 'var(--status-running)' }}
                          title={`${folder.runningCount} 个运行中会话`} aria-label={`${folder.runningCount} 个运行中会话`} />
                      )}
                    </button>
                    {expanded && (
                      <div id={folderPanelId} className="mt-0.5 space-y-0.5">
                        {folder.items.map(item => {
                          const active = item.session_id === activeSessionId
                          const status = statusMeta(item)
                          const relativeTime = relativeActivityTime(item)
                          return (
                            <button key={item.session_id} type="button" onClick={() => openConversation(item)}
                              className="flex min-h-[var(--control-height-sm)] w-full min-w-0 items-center gap-2 rounded-[12px] py-1.5 pl-7 pr-2 text-left transition-colors hover:bg-[var(--surface-control-hover)]"
                              style={{ background: active ? 'var(--surface-active)' : undefined }} aria-current={active ? 'page' : undefined}>
                              <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                                {item.name || '未命名会话'}
                              </span>
                              <span className="flex flex-shrink-0 items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                {status && (
                                  <span className={`h-1.5 w-1.5 rounded-full ${item.agent_status === 'running' ? 'animate-pulse' : ''}`}
                                    style={{ background: status.color }} title={status.label} aria-label={status.label} />
                                )}
                                {relativeTime && <span>{relativeTime}</span>}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          </div>
        )}
      </div>

      <div data-rail-slot="bottom" className="relative p-2">
        {accountMenuOpen && (
          <div className="workbench-popover absolute bottom-11 left-2 right-2 border p-1" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-overlay)' }}>
            <div className="truncate px-2 py-2 text-[11px]" style={{ color: 'var(--text-primary)' }}>{user?.display_name || user?.id || userId}</div>
            <button type="button" onClick={() => { setAccountMenuOpen(false); logout(); navigate('/') }} className="workbench-control-md flex w-full items-center gap-2 px-2 text-left text-[11px] hover:bg-[var(--status-danger-soft)]" style={{ color: 'var(--status-danger)' }}>
              <LogOut className="h-3.5 w-3.5" /> 退出登录
            </button>
          </div>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1">
          <button type="button" onClick={() => setAccountMenuOpen(value => !value)} className="workbench-control-md flex min-w-0 items-center gap-2 px-2 text-left hover:bg-[var(--surface-control-hover)]" aria-label="账户" aria-expanded={accountMenuOpen} style={{ color: 'var(--text-secondary)' }}>
            <UserRound className="h-4 w-4 flex-shrink-0" />
            <span className="truncate text-[11px]">{user?.display_name || user?.id || userId}</span>
          </button>
          <button type="button" onClick={event => onOpenSettings?.(event.currentTarget)} className="workbench-control-md inline-flex items-center gap-1.5 px-2 hover:bg-[var(--surface-control-hover)]" aria-label="设置" title="设置" style={{ color: 'var(--text-secondary)' }}>
            <SlidersHorizontal className="h-4 w-4" />
            <span className="text-[11px]">设置</span>
          </button>
        </div>
      </div>
    </aside>
  )

  return (
    <>
      <div className="hidden h-full xl:block">{renderRail()}</div>
      {drawerOpen && (
        <div className="workbench-layer-drawer fixed inset-x-0 bottom-0 top-[44px] xl:hidden" style={{ top: 'var(--workbench-topbar-height)' }} role="dialog" aria-modal="true" aria-label="历史会话">
          <button type="button" className="absolute inset-0" style={{ background: 'var(--surface-scrim)' }} onClick={closeDrawer} aria-label="关闭历史会话" />
          {renderRail(true)}
        </div>
      )}
    </>
  )
}
