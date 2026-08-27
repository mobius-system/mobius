import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, MessageSquare, Plus, Search, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '../store'
import { logUiEvent } from '../services/ui-observability'

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
  if (item.agent_status === 'failed' || item.status === 'failed') return { label: '失败', color: '#f87171' }
  if (item.agent_status === 'running') return { label: '进行中', color: '#38bdf8' }
  if (item.agent_status === 'pending' || item.agent_status === 'waiting') return { label: '等待', color: '#f59e0b' }
  if (item.agent_status === 'completed' || item.status === 'completed') return { label: '完成', color: '#4ade80' }
  return null
}

export function conversationPath(userId: string, item: ConversationRailItem) {
  if (!item.session_id) return ''
  return `/u/${userId}/s/${encodeURIComponent(item.session_id)}`
}

export function ConversationRail({
  userId,
  activeSessionId,
  projectId,
  onNewConversation,
  onOpenConversation,
  refreshKey,
}: {
  userId: string
  activeSessionId?: string | null
  projectId?: string | null
  onNewConversation: () => void
  onOpenConversation?: (item: ConversationRailItem) => void
  refreshKey?: number
}) {
  const navigate = useNavigate()
  const [items, setItems] = useState<ConversationRailItem[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [projectCollapseState, setProjectCollapseState] = useState<ProjectCollapseState>(loadProjectCollapseState)
  const drawerSearchRef = useRef<HTMLInputElement | null>(null)
  const drawerTriggerRef = useRef<HTMLElement | null>(null)

  const closeDrawer = () => {
    setDrawerOpen(false)
    window.requestAnimationFrame(() => drawerTriggerRef.current?.focus())
  }

  useEffect(() => {
    const openDrawer = () => {
      drawerTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setDrawerOpen(true)
      window.requestAnimationFrame(() => drawerSearchRef.current?.focus())
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
    let cancelled = false
    setLoading(true)
    setError('')
    api('/api/tasks/recent?limit=100')
      .then((result: any) => {
        if (cancelled) return
        setItems(Array.isArray(result) ? result : [])
      })
      .catch((reason: any) => {
        if (!cancelled) setError(reason?.message || '历史会话加载失败')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [refreshKey, userId])

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
        : folder.items.filter(item => String(item.name || '未命名会话').toLowerCase().includes(normalizedQuery))
      return matchingItems.length ? [{ ...folder, items: matchingItems }] : []
    })
  }, [normalizedQuery, projectFolders])

  const folderIsExpanded = (folder: ProjectFolder) => {
    if (normalizedQuery) return true
    const containsActiveSession = Boolean(activeSessionId)
      && folder.items.some(item => item.session_id === activeSessionId)
    if (containsActiveSession) return true
    const storedCollapseState = projectCollapseState[projectFolderKey(folder.projectId)]
    if (storedCollapseState !== undefined) return !storedCollapseState
    return Boolean(projectId) && folder.projectId === projectId
  }

  const toggleFolder = (folder: ProjectFolder) => {
    const containsActiveSession = Boolean(activeSessionId)
      && folder.items.some(item => item.session_id === activeSessionId)
    if (normalizedQuery || containsActiveSession) return
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
    const path = conversationPath(userId, item)
    if (!path) return
    logUiEvent('history_opened', { session_id: item.session_id, project_id: item.project_id })
    onOpenConversation?.(item)
    setDrawerOpen(false)
    navigate(path)
  }

  const renderRail = (drawer = false) => (
    <aside
      className={`flex h-full w-[272px] flex-shrink-0 flex-col border-r ${drawer ? 'relative z-10 max-w-[calc(100vw-32px)] shadow-lg' : ''}`}
      style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}
      aria-label="最近会话"
    >
      {drawer && (
        <div className="flex h-10 items-center justify-between border-b px-3" style={{ borderColor: 'var(--border-color)' }}>
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>历史会话</span>
          <button type="button" onClick={closeDrawer} aria-label="关闭历史会话"
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-secondary)' }}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="space-y-2 border-b p-3" style={{ borderColor: 'var(--border-color)' }}>
        <button type="button" onClick={() => { setDrawerOpen(false); onNewConversation() }}
          className="flex h-8 w-full items-center justify-center gap-2 rounded-md border text-[12px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
          <Plus className="h-4 w-4" /> 新会话
        </button>
        <label className="relative block">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input ref={drawer ? drawerSearchRef : undefined} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索会话"
            className="h-8 w-full rounded-md pl-8 pr-3 text-[12px] outline-none focus:border-blue-500/40"
            style={{ color: 'var(--text-primary)', background: 'var(--input-bg)', border: '1px solid var(--input-border)' }} />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {loading ? (
          <div className="px-2 py-5 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中…</div>
        ) : error ? (
          <div className="px-2 py-5 text-center text-[12px]" style={{ color: '#f87171' }}>{error}</div>
        ) : visibleFolders.length === 0 ? (
          <div className="px-2 py-5 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无会话</div>
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
                      className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-hover)]"
                      style={{ background: focused ? 'var(--bg-active)' : undefined }}>
                      {expanded
                        ? <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                        : <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
                      <Folder className="h-3.5 w-3.5 flex-shrink-0" style={{ color: focused ? 'var(--accent-primary)' : 'var(--text-secondary)' }} />
                      <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                        {folder.projectName}
                      </span>
                      {folder.runningCount > 0 && (
                        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: '#38bdf8' }}
                          title={`${folder.runningCount} 个运行中会话`} aria-label={`${folder.runningCount} 个运行中会话`} />
                      )}
                    </button>
                    {expanded && (
                      <div id={folderPanelId} className="mt-0.5 space-y-0.5">
                        {folder.items.map(item => {
                          const active = item.session_id === activeSessionId
                          const status = statusMeta(item)
                          return (
                            <button key={item.session_id} type="button" onClick={() => openConversation(item)}
                              className="flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pl-7 pr-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
                              style={{ background: active ? 'var(--bg-active)' : undefined }} aria-current={active ? 'page' : undefined}>
                              <MessageSquare className="h-3.5 w-3.5 flex-shrink-0" style={{ color: active ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
                              <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                                {item.name || '未命名会话'}
                              </span>
                              {status && (
                                <span className="flex flex-shrink-0 items-center gap-1 text-[9px]" style={{ color: status.color }}>
                                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.color }} />
                                  {status.label}
                                </span>
                              )}
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
    </aside>
  )

  return (
    <>
      <div className="hidden h-full xl:block">{renderRail()}</div>
      {drawerOpen && (
        <div className="fixed inset-x-0 bottom-0 top-[52px] z-[60] xl:hidden" role="dialog" aria-modal="true" aria-label="历史会话">
          <button type="button" className="absolute inset-0 bg-black/35" onClick={closeDrawer} aria-label="关闭历史会话" />
          {renderRail(true)}
        </div>
      )}
    </>
  )
}
