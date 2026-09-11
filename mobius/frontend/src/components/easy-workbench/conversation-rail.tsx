import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Folder,
  MessagesSquare,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Palette,
  Globe2,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../store'
import { pollRecursive } from '../../services/polling'
import { logUiEvent } from '../../services/easy-workbench/ui-observability'
import {
  creationHomeNavigation,
  easyResearchNavigation,
  homeNavigation,
  navigateToWorkbenchObject,
  researchHomeNavigation,
  sessionNavigation,
  sessionPath,
} from '../../services/easy-workbench/workbench-navigation'
import { openExtensionPanel } from './extension-panel'
import { useWorkbenchPaneResize } from '../../services/easy-workbench/pane-resize'

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
  starred?: number | boolean
}

type ProjectFolder = {
  projectId: string
  projectName: string
  items: ConversationRailItem[]
  runningCount: number
}

type ProjectCollapseState = Record<string, boolean>

type ResearchSummary = {
  id: string
  project_id: string
  title: string
  status: string
  running_session_count: number
  active_session_count: number
  session_count?: number
  last_active: string
}

// 「我的创作」条目: 已注册扩展 (极简列表: 名称 + 版本号)。
type CreationExtension = {
  name: string
  display_name?: string
  description?: string
  version?: string
}

type AimuxRemote = {
  name: string
  type: string
  hostname?: string
  status: string
  rtt_ms: number | null
}

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

// AIMUX remote 状态 → 左栏圆点样式。与项目列表的运行状态圆点同一套颜色变量。
function remoteStatusMeta(remote: AimuxRemote) {
  const status = String(remote.status || '').toLowerCase()
  if (status === 'connected' || status === 'ok' || status === 'reachable') return { label: '已连接', color: 'var(--status-success)' }
  if (status === 'auth-required') return { label: '需要认证', color: 'var(--status-waiting)' }
  if (status === 'unknown') return { label: '未知', color: 'var(--text-muted)' }
  return { label: '离线', color: 'var(--status-danger)' }
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
  onOpenConversation,
  onOpenSearch,
  onOpenSettings,
  refreshKey,
  resizeHandle,
}: {
  userId: string
  activeSessionId?: string | null
  projectId?: string | null
  onOpenConversation?: (item: ConversationRailItem) => void
  onOpenSearch?: (trigger: HTMLElement) => void
  onOpenSettings?: (trigger: HTMLElement) => void
  refreshKey?: number
  resizeHandle?: ReturnType<typeof useWorkbenchPaneResize>
}) {
  const navigate = useNavigate()
  const [items, setItems] = useState<ConversationRailItem[]>([])
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [manualRefreshKey, setManualRefreshKey] = useState(0)
  const [projectCollapseState, setProjectCollapseState] = useState<ProjectCollapseState>(loadProjectCollapseState)
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({ projects: true, studio: true, creations: true, world: true })
  const [researches, setResearches] = useState<ResearchSummary[]>([])
  const [creations, setCreations] = useState<CreationExtension[]>([])
  const [remotes, setRemotes] = useState<AimuxRemote[]>([])
  // 项目会话条目的右键菜单 (重命名/星标/删除), 坐标用 viewport fixed 定位。
  const [sessionMenu, setSessionMenu] = useState<{ x: number; y: number; item: ConversationRailItem } | null>(null)
  const [renameDraft, setRenameDraft] = useState<{ item: ConversationRailItem; value: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ConversationRailItem | null>(null)
  const [menuActionBusy, setMenuActionBusy] = useState(false)
  const drawerTriggerRef = useRef<HTMLElement | null>(null)
  const railSearchReturnFocusRef = useRef<HTMLButtonElement | null>(null)

  const closeSessionMenu = useCallback(() => setSessionMenu(null), [])

  // 右键菜单打开时: 点击别处 / Esc / 滚动 都关闭, 避免 stale 菜单飘在错误位置。
  useEffect(() => {
    if (!sessionMenu) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-session-context-menu]')) return
      closeSessionMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSessionMenu()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [sessionMenu, closeSessionMenu])

  const patchLocalItem = useCallback((sessionId: string, patch: Partial<ConversationRailItem>) => {
    setItems(prev => prev.map(row => row.session_id === sessionId ? { ...row, ...patch } : row))
  }, [])

  const toggleSessionStar = useCallback(async (item: ConversationRailItem) => {
    const next = !item.starred
    patchLocalItem(item.session_id, { starred: next ? 1 : 0 })
    try {
      await api(`/api/tasks/${encodeURIComponent(item.session_id)}/star`, {
        method: 'PATCH',
        body: JSON.stringify({ starred: next }),
      })
    } catch {
      patchLocalItem(item.session_id, { starred: next ? 0 : 1 })
    }
  }, [patchLocalItem])

  const submitRename = useCallback(async () => {
    if (!renameDraft) return
    const name = renameDraft.value.trim()
    const item = renameDraft.item
    setRenameDraft(null)
    if (!name || name === item.name) return
    const previousName = item.name
    patchLocalItem(item.session_id, { name })
    try {
      await api(`/api/tasks/${encodeURIComponent(item.session_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      })
    } catch {
      patchLocalItem(item.session_id, { name: previousName })
    }
  }, [renameDraft, patchLocalItem])

  const confirmDeleteSession = useCallback(async () => {
    if (!pendingDelete) return
    const item = pendingDelete
    setMenuActionBusy(true)
    try {
      await api(`/api/tasks/${encodeURIComponent(item.session_id)}`, { method: 'DELETE' })
      setItems(prev => prev.filter(row => row.session_id !== item.session_id))
      setPendingDelete(null)
      setManualRefreshKey(key => key + 1)
    } catch {
      // 删除失败保持条目不动, 下次刷新会还原。
    } finally {
      setMenuActionBusy(false)
    }
  }, [pendingDelete])

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
    // 星标会话排最前 (各项目内), 其余按最近活跃。
    const sortedItems = [...items].sort((left, right) => {
      const starDiff = Number(!!right.starred) - Number(!!left.starred)
      if (starDiff !== 0) return starDiff
      return lastActiveTime(right) - lastActiveTime(left)
    })

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

  // 工作室：多智能体 Research 真实列表。项目卡片自带 research_count，
  // 只对有 Research 的项目各发一次 /api/projects/:id/researches。
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    api('/api/projects', { signal: controller.signal })
      .then(async (projects: any[]) => {
        const hosts = (Array.isArray(projects) ? projects : [])
          .filter(project => Number(project?.research_count) > 0)
        const lists = await Promise.all(hosts.map(project =>
          api(`/api/projects/${project.id}/researches`, { signal: controller.signal })
            .then((rows: any[]) => (Array.isArray(rows) ? rows : []).map(row => ({ ...row, project_id: project.id })))
            .catch(() => [] as ResearchSummary[]),
        ))
        if (!active) return
        const merged = lists.flat() as ResearchSummary[]
        merged.sort((left, right) =>
          new Date(right.last_active || 0).getTime() - new Date(left.last_active || 0).getTime())
        setResearches(merged)
      })
      .catch(() => {
        // 静默失败：工作室没有数据时仅显示空态，不打扰项目列表。
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [manualRefreshKey, refreshKey])

  // 我的创作：已注册扩展极简列表 (与专家模式拓展卡同一数据源, 名称+版本号)。
  // 点击条目时的「扩展 → 专属会话」解析在 openExtension 里按需进行。
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    api('/api/extensions', { signal: controller.signal })
      .then((data: any) => {
        if (!active) return
        const rows = Array.isArray(data?.extensions) ? data.extensions : []
        setCreations(rows)
      })
      .catch(() => {
        // 拓展注册表不可用时保持空列表。
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [])

  // 我的世界：AIMUX 远程连接清单（设备/外部服务真实状态）。
  useEffect(() => {
    let active = true
    let firstLoad = true
    const stop = pollRecursive(async (signal) => {
      const data: any = await api('/api/aimux/remotes', { signal })
      if (!active) return
      setRemotes(Array.isArray(data?.remotes) ? data.remotes : [])
      if (firstLoad) firstLoad = false
    }, 30_000, 75_000)
    return () => {
      active = false
      stop()
    }
  }, [])

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
    // 用户明确折叠后，尊重该选择，即使项目包含当前或运行中的会话。
    const storedCollapseState = projectCollapseState[projectFolderKey(folder.projectId)]
    if (storedCollapseState !== undefined) return !storedCollapseState
    return true
  }

  const toggleFolder = (folder: ProjectFolder) => {
    // 搜索结果需要保持可见；其它情况下允许用户收起任何项目，包括当前会话所属项目。
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

  // 栏目「+」统一新建入口: 项目/专项团队/我的创作 → 各自欢迎页; 我的世界 → 设置面板
  // 「连接与客户端」(设备/连接的添加表单在设置里, 不重复造)。

  // 项目「+」→ 回极简模式欢迎界面 (原左上角 Mobius 主页按钮的行为), 在首页 composer 开始新对话。
  const openHomeFromProjects = useCallback(() => {
    setDrawerOpen(false)
    navigateToWorkbenchObject(navigate, homeNavigation(userId))
  }, [navigate, userId])

  // 专项团队「+」→ 专属欢迎页 (/easy_mode?view=research), 只跟 Leader 对话完成组队。
  const openResearchHome = useCallback(() => {
    setDrawerOpen(false)
    navigateToWorkbenchObject(navigate, researchHomeNavigation(userId))
  }, [navigate, userId])

  // 我的创作「+」→ 专属欢迎页 (/easy_mode?view=creation), 项目默认拓展项目,
  // 一句话开始迭代所选拓展, 进会话后右侧实时预览。
  const openCreationHome = useCallback(() => {
    setDrawerOpen(false)
    navigateToWorkbenchObject(navigate, creationHomeNavigation(userId))
  }, [navigate, userId])

  // 专项团队：进入极简版团队页 (/easy_mode?research=)，不出极简模式。
  const openResearch = (research: ResearchSummary) => {
    logUiEvent('history_opened', { research_id: research.id, project_id: research.project_id, surface: 'studio' })
    setDrawerOpen(false)
    navigateToWorkbenchObject(navigate, easyResearchNavigation(userId, research.id, { projectId: research.project_id }))
  }

  // 我的创作：点扩展条目 = 「专属会话 + 右侧浏览器」一起打开。
  // 会话解析: 扩展项目 ext_<name> 下最近活跃的 issue 会话; 一个都没有时
  // 现场兜底创建 issue + 会话 (每个扩展保证有能修改它本身的 Mobius 会话)。
  const openExtension = (entry: CreationExtension) => {
    const extensionName = entry.name
    const displayName = entry.display_name || extensionName
    const panelPayload = {
      name: extensionName,
      displayName,
      url: `/extension/${encodeURIComponent(extensionName)}/`,
    }
    logUiEvent('history_opened', { extension: extensionName, surface: 'creations' })
    setDrawerOpen(false)
    const goWithPanel = (sessionId: string) => {
      navigateToWorkbenchObject(navigate, sessionNavigation(userId, sessionId))
      window.setTimeout(() => openExtensionPanel(panelPayload), 150)
    }
    ;(async () => {
      try {
        const projects: any[] = await api('/api/projects')
        const project = (Array.isArray(projects) ? projects : [])
          .find(candidate => candidate?.kind === 'extension' && candidate?.extension_name === extensionName)
        let sessionId = ''
        let issueId = ''
        if (project) {
          const issues: any = await api(`/api/projects/${project.id}/issues`)
          const rows = Array.isArray(issues) ? issues : (issues?.issues || [])
          for (const issue of rows) {
            const sessions: any = await api(`/api/issues/${issue.id}/sessions`)
            const list = (Array.isArray(sessions) ? sessions : []) as any[]
            const latest = list.sort((left, right) =>
              new Date(right.last_active || 0).getTime() - new Date(left.last_active || 0).getTime())[0]
            if (latest) { sessionId = latest.session_id; issueId = issue.id; break }
          }
          if (!sessionId) {
            // 扩展项目存在但没有可用 issue 会话: 兜底建 issue + 会话。
            const issue: any = await api(`/api/projects/${project.id}/issues`, {
              method: 'POST',
              body: JSON.stringify({
                title: `${displayName} · 拓展维护`,
                description: `维护和迭代拓展 ${extensionName} 的专属会话：修改前端页面与后端 handler，验收时在右侧浏览器预览拓展页面。`,
              }),
            })
            if (issue?.id) {
              issueId = issue.id
              const session: any = await api(`/api/issues/${issue.id}/sessions`, {
                method: 'POST',
                body: JSON.stringify({ name: `${displayName} · 拓展维护` }),
              })
              if (session?.session_id) sessionId = session.session_id
            }
          }
        }
        if (sessionId) {
          goWithPanel(sessionId)
        } else if (activeSessionId) {
          // 兜底失败但已有活动会话: 只开右侧浏览器。
          openExtensionPanel(panelPayload)
        } else {
          // 没有任何会话可进: 至少把扩展页以新标签打开, 不让点击无响应。
          window.open(panelPayload.url, '_blank')
        }
      } catch {
        // 接口异常: 保持旧行为 (有活动会话开侧栏, 否则新标签), 不让点击无响应。
        if (activeSessionId) openExtensionPanel(panelPayload)
        else window.open(panelPayload.url, '_blank')
      }
    })()
  }

  // 我的世界：打开设置面板「连接与客户端」（AIMUX 指引/设备连接所在处）。
  const openConnections = () => {
    logUiEvent('settings_opened', { surface: 'world', section: 'connections' })
    setDrawerOpen(false)
    window.dispatchEvent(new CustomEvent('mobius:open-settings', { detail: { section: 'connections' } }))
  }

  const closeRailSearch = () => {
    setSearchOpen(false)
    setQuery('')
    window.requestAnimationFrame(() => railSearchReturnFocusRef.current?.focus())
  }

  const renderRail = (drawer = false) => (
    <aside
      className={`conversation-rail relative flex h-full min-h-0 max-h-full w-[280px] flex-shrink-0 flex-col overflow-hidden ${drawer ? 'z-10 max-w-[calc(100vw-32px)] shadow-lg' : ''}`}
      style={{ width: 'var(--rail-width)', background: 'var(--surface-sidebar)' }}
      aria-label="最近会话"
    >
      {!drawer && resizeHandle && (
        <div
          className="workbench-pane-resize-handle workbench-pane-resize-handle--left"
          data-testid="workbench-rail-resize-handle"
          role="separator"
          aria-label="调整左侧会话栏宽度"
          aria-orientation="vertical"
          aria-valuemin={208}
          aria-valuemax={420}
          aria-valuenow={resizeHandle.width}
          tabIndex={0}
          onPointerDown={resizeHandle.handlePointerDown}
          onDoubleClick={resizeHandle.handleDoubleClick}
          onKeyDown={resizeHandle.handleKeyDown}
          title="拖拽调整左侧会话栏宽度 · 双击恢复默认"
        />
      )}
      {/* 左上角按钮区已移除 (Home/新会话/新建项目/搜索 四按钮下放进各栏目「+」或由顶栏 ⌘N/⌘K 承接)。
          移动端 drawer 仅保留关闭按钮。 */}
      {drawer && (
        <div data-rail-slot="header" className="flex flex-shrink-0 justify-end p-2">
          <button type="button" onClick={closeDrawer} aria-label="关闭历史会话" title="关闭历史会话"
            className="workbench-control-md inline-flex w-8 items-center justify-center hover:bg-[var(--surface-control-hover)]" style={{ color: 'var(--text-secondary)' }}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div data-rail-slot="search" className={`${searchOpen ? 'block' : 'hidden'} flex-shrink-0 border-b p-2`} style={{ borderColor: 'var(--border-default)' }}>
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

      <div data-rail-slot="body" className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 py-3">
        {/* 项目滚动区: 收起时随内容收缩 (shrink 允许压缩), 不再强占 flex-1 留大片空白 */}
        <div className="min-h-0 overflow-y-auto" style={{ flexGrow: sectionOpen.projects ? 1 : 0, flexShrink: 1, flexBasis: sectionOpen.projects ? 0 : 'auto' }}>
          {loading ? (
            <div className="px-2 py-5 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中…</div>
          ) : error ? (
            <div className="px-2 py-5 text-center text-[12px]" style={{ color: 'var(--status-danger)' }}>{error}</div>
          ) : visibleFolders.length === 0 ? (
            <div className="px-2 py-5 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>{normalizedQuery ? '没有匹配的会话' : '暂无会话'}</div>
          ) : (
            <div>
              {/* 一级栏目分组卡: 微表面色 + 描边 + accent 竖线, 与二级条目拉开层次 */}
              <div className="overflow-hidden rounded-[12px] border" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}>
                <SectionHeader
                  icon={MessagesSquare}
                  label="项目"
                  open={sectionOpen.projects}
                  onToggle={() => setSectionOpen(s => ({ ...s, projects: !s.projects }))}
                  plusLabel="开始新对话"
                  onPlus={openHomeFromProjects}
                />
              {sectionOpen.projects && <div className="space-y-1 p-1.5">
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
                          const starred = !!item.starred
                          return (
                            <button key={item.session_id} type="button"
                              onClick={() => openConversation(item)}
                              onContextMenu={event => {
                                event.preventDefault()
                                setSessionMenu({ x: event.clientX, y: event.clientY, item })
                              }}
                              className="group/session flex min-h-[var(--control-height-sm)] w-full min-w-0 items-center gap-2 rounded-[12px] py-1.5 pl-7 pr-2 text-left transition-colors hover:bg-[var(--surface-control-hover)]"
                              style={{ background: active ? 'var(--surface-active)' : undefined }} aria-current={active ? 'page' : undefined}>
                              {starred && (
                                <Star className="h-3 w-3 flex-shrink-0 fill-current" style={{ color: '#f59e0b' }} aria-label="已星标" />
                              )}
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
            </div>}
              </div>
            </div>
          )}
        </div>
        {/* 固定常驻区：专项团队 / 我的创作 / 我的世界。项目再多也不被挤出左栏。 */}
        <div className="mt-2 flex-shrink-0 space-y-2">
              {([
                { key: 'studio', label: '专项团队', icon: Sparkles, plusLabel: '新建专项团队', onPlus: openResearchHome },
                { key: 'creations', label: '我的创作', icon: Palette, plusLabel: '迭代我的拓展', onPlus: openCreationHome },
                { key: 'world', label: '我的世界', icon: Globe2, plusLabel: '添加设备 / 连接', onPlus: openConnections },
              ] as const).map(({ key, label, icon: Icon, plusLabel, onPlus }) => (
                <div key={key} className="overflow-hidden rounded-[12px] border" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}>
                  <SectionHeader
                    icon={Icon}
                    label={label}
                    open={sectionOpen[key]}
                    onToggle={() => setSectionOpen(s => ({ ...s, [key]: !s[key] }))}
                    plusLabel={plusLabel}
                    onPlus={onPlus}
                  >
                    {key === 'studio' && researches.some(r => r.running_session_count > 0) && (
                      <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full animate-pulse" style={{ background: 'var(--status-running)' }} title="有 Research 正在运行" aria-label="有 Research 正在运行" />
                    )}
                  </SectionHeader>
                  {sectionOpen[key] && key === 'studio' && (
                    researches.length === 0 ? (
                      <div className="px-3 py-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>暂无进行中的多智能体任务</div>
                    ) : (
                      <div className="space-y-0.5 p-1.5">
                        {researches.slice(0, 8).map(research => (
                          <button key={research.id} type="button" onClick={() => openResearch(research)}
                            className="flex min-h-[var(--control-height-sm)] w-full min-w-0 items-center gap-2 rounded-[12px] py-1.5 pl-7 pr-2 text-left transition-colors hover:bg-[var(--surface-control-hover)]"
                            title={research.title || research.id}>
                            <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                              {research.title || research.id}
                            </span>
                            <span className="flex flex-shrink-0 items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              {(research.running_session_count || 0) > 0 && (
                                <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: 'var(--status-running)' }} title="运行中" aria-label="运行中" />
                              )}
                              <span>{Number(research.session_count) || 0} 会话</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )
                  )}
                  {sectionOpen[key] && key === 'creations' && (
                    creations.length === 0 ? (
                      <div className="px-3 py-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>暂无已注册的创作工具</div>
                    ) : (
                      <div className="space-y-0.5 p-1.5">
                        {creations.map(entry => (
                          <button key={entry.name} type="button" onClick={() => openExtension(entry)}
                            className="flex min-h-[var(--control-height-sm)] w-full min-w-0 items-center gap-2 rounded-[12px] py-1.5 pl-7 pr-2 text-left transition-colors hover:bg-[var(--surface-control-hover)]"
                            title={entry.description || entry.display_name || entry.name}>
                            <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                              {entry.display_name || entry.name}
                            </span>
                            {entry.version && <span className="flex-shrink-0 text-[10px]" style={{ color: 'var(--text-muted)' }}>v{entry.version}</span>}
                          </button>
                        ))}
                      </div>
                    )
                  )}
                  {sectionOpen[key] && key === 'world' && (
                    remotes.length === 0 ? (
                      <button type="button" onClick={openConnections} className="w-full px-3 py-2 text-left text-[10px] hover:underline" style={{ color: 'var(--text-muted)' }}>
                        连接你的第一台设备 →
                      </button>
                    ) : (
                      <div className="space-y-0.5 p-1.5">
                        {remotes.map(remote => {
                          const meta = remoteStatusMeta(remote)
                          return (
                            <button key={remote.name} type="button" onClick={openConnections}
                              className="flex min-h-[var(--control-height-sm)] w-full min-w-0 items-center gap-2 rounded-[12px] py-1.5 pl-7 pr-2 text-left transition-colors hover:bg-[var(--surface-control-hover)]"
                              title={`${remote.type || 'ssh'} · ${remote.hostname || remote.name} · ${meta.label}`}>
                              <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                                {remote.name}
                              </span>
                              <span className="flex flex-shrink-0 items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} title={meta.label} aria-label={meta.label} />
                                {typeof remote.rtt_ms === 'number' && <span>{remote.rtt_ms}ms</span>}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    )
                  )}
                </div>
              ))}
            </div>
      </div>

      <div data-rail-slot="bottom" className="flex-shrink-0 p-2">
        {/* 账户管理已并入设置面板「账户」分类, 左下角只保留设置入口. */}
        <button type="button" onClick={event => onOpenSettings?.(event.currentTarget)} className="workbench-control-md flex w-full items-center gap-1.5 px-2 hover:bg-[var(--surface-control-hover)]" aria-label="设置" title="设置与账户" style={{ color: 'var(--text-secondary)' }}>
          <SlidersHorizontal className="h-4 w-4 flex-shrink-0" />
          <span className="text-[11px]">设置</span>
        </button>
      </div>
    </aside>
  )

  return (
    <>
      <div className="hidden h-full min-h-0 max-h-full overflow-hidden xl:block">{renderRail()}</div>
      {drawerOpen && (
        <div className="workbench-layer-drawer fixed inset-x-0 bottom-0 top-[44px] xl:hidden" style={{ top: 'var(--workbench-topbar-height)' }} role="dialog" aria-modal="true" aria-label="历史会话">
          <button type="button" className="absolute inset-0" style={{ background: 'var(--surface-scrim)' }} onClick={closeDrawer} aria-label="关闭历史会话" />
          {renderRail(true)}
        </div>
      )}
      <SessionContextMenu
        menu={sessionMenu}
        onClose={closeSessionMenu}
        onRename={item => { setRenameDraft({ item, value: item.name || '' }); closeSessionMenu() }}
        onToggleStar={item => { void toggleSessionStar(item); closeSessionMenu() }}
        onDelete={item => { setPendingDelete(item); closeSessionMenu() }}
      />
      {renameDraft && (
        <SessionRenameDialog
          initialValue={renameDraft.value}
          value={renameDraft.value}
          title={renameDraft.item.name || '未命名会话'}
          busy={menuActionBusy}
          onCancel={() => setRenameDraft(null)}
          onSubmit={() => void submitRename()}
          onValueChange={value => setRenameDraft(current => current ? { ...current, value } : current)}
        />
      )}
      {pendingDelete && (
        <SessionDeleteDialog
          session={pendingDelete}
          busy={menuActionBusy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmDeleteSession()}
        />
      )}
    </>
  )
}

// ===== 一级栏目标题行: 折叠开关 + 右侧「+」新建按钮 =====
// 标题行含两个交互 (折叠 / 新建), 外层用 div 承载 hover 与分隔线, 内部两个 button 合法嵌套。
// 「+」常驻可见 (收起状态也可新建), 点击 stopPropagation 不触发折叠。
function SectionHeader({
  icon: Icon,
  label,
  open,
  onToggle,
  plusLabel,
  onPlus,
  children,
}: {
  icon: typeof Sparkles
  label: string
  open: boolean
  onToggle: () => void
  plusLabel: string
  onPlus: () => void
  children?: React.ReactNode
}) {
  return (
    <div
      className="flex min-h-[var(--control-height-sm)] w-full items-center gap-1 border-b px-2 py-1.5 text-[12px] font-medium transition-colors hover:bg-[var(--surface-control-hover)]"
      style={{ color: 'var(--text-primary)', borderColor: open ? 'var(--border-default)' : 'transparent' }}
    >
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        <Icon className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
        <span className="truncate">{label}</span>
        {children}
      </button>
      <button
        type="button"
        onClick={event => { event.stopPropagation(); onPlus() }}
        aria-label={plusLabel}
        title={plusLabel}
        className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[6px] hover:bg-[var(--surface-control-hover)]"
        style={{ color: 'var(--text-muted)' }}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      {open && <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
    </div>
  )
}

// ===== 项目会话条目右键菜单 (重命名 / 星标 / 删除) =====
// 视觉沿用 workbench-overflow-menu 的浮层语言: 14px 圆角、overlay 底、34px 行高、
// 图标 16px 置灰, 危险项红色。fixed 定位贴右键坐标, 越界时向内收。
function SessionContextMenu({
  menu,
  onClose,
  onRename,
  onToggleStar,
  onDelete,
}: {
  menu: { x: number; y: number; item: ConversationRailItem } | null
  onClose: () => void
  onRename: (item: ConversationRailItem) => void
  onToggleStar: (item: ConversationRailItem) => void
  onDelete: (item: ConversationRailItem) => void
}) {
  if (!menu) return null
  const starred = !!menu.item.starred
  const menuWidth = 208
  const menuHeight = 132
  const x = Math.min(menu.x, window.innerWidth - menuWidth - 8)
  const y = Math.min(menu.y, window.innerHeight - menuHeight - 8)
  return (
    <div
      data-session-context-menu
      role="menu"
      aria-label="会话操作"
      className="workbench-overflow-menu"
      style={{ position: 'fixed', top: y, left: x, right: 'auto', minWidth: menuWidth }}
    >
      <button type="button" role="menuitem" className="workbench-menu-item" onClick={() => onRename(menu.item)}>
        <Pencil aria-hidden="true" />
        <span>重命名</span>
      </button>
      <button type="button" role="menuitem" className="workbench-menu-item" onClick={() => onToggleStar(menu.item)}>
        <Star aria-hidden="true" style={starred ? { color: '#f59e0b', fill: '#f59e0b' } : undefined} />
        <span>{starred ? '取消星标' : '星标'}</span>
      </button>
      <div className="my-1 border-t" style={{ borderColor: 'var(--border-default)' }} aria-hidden="true" />
      <button type="button" role="menuitem" className="workbench-menu-item" style={{ color: 'var(--status-danger)' }} onClick={() => onDelete(menu.item)}>
        <Trash2 aria-hidden="true" style={{ color: 'var(--status-danger)' }} />
        <span>删除对话</span>
      </button>
    </div>
  )
}

// 重命名对话框: 复用全局 modal 的浮层语言 (scrim + 居中卡片), Enter 提交 Esc 取消。
function SessionRenameDialog({
  title,
  initialValue,
  value,
  busy,
  onValueChange,
  onSubmit,
  onCancel,
}: {
  title: string
  initialValue: string
  value: string
  busy: boolean
  onValueChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [initialValue])
  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4" style={{ background: 'var(--surface-scrim)' }} role="dialog" aria-modal="true" aria-label="重命名会话">
      <button type="button" className="absolute inset-0" aria-label="取消重命名" onClick={onCancel} />
      <div className="relative w-full max-w-sm border p-4" style={{ borderRadius: 'var(--radius-panel, 14px)', background: 'var(--surface-overlay)', borderColor: 'var(--border-default)', boxShadow: 'var(--shadow-overlay)' }}>
        <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>重命名会话</div>
        <div className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{title}</div>
        <input
          ref={inputRef}
          value={value}
          onChange={event => onValueChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !busy) { event.preventDefault(); onSubmit() }
            if (event.key === 'Escape') { event.preventDefault(); onCancel() }
          }}
          maxLength={120}
          className="workbench-control-md mt-3 w-full text-[12px] outline-none"
          style={{ color: 'var(--text-primary)', background: 'var(--surface-control)', border: '1px solid var(--border-strong)' }}
          aria-label="会话名称"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="workbench-control-md border px-3 text-[12px] hover:bg-[var(--surface-control-hover)]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>取消</button>
          <button type="button" onClick={onSubmit} disabled={busy || !value.trim()} className="workbench-control-md btn-primary px-3 text-[12px] font-medium disabled:opacity-50">保存</button>
        </div>
      </div>
    </div>
  )
}

// 删除确认: 删除不可撤销 (后端 archive), 文案明确提醒; 只提供 删除/取消 两个出口。
function SessionDeleteDialog({
  session,
  busy,
  onCancel,
  onConfirm,
}: {
  session: ConversationRailItem
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4" style={{ background: 'var(--surface-scrim)' }} role="dialog" aria-modal="true" aria-label="删除会话">
      <button type="button" className="absolute inset-0" aria-label="取消删除" onClick={onCancel} />
      <div className="relative w-full max-w-sm border p-4" style={{ borderRadius: 'var(--radius-panel, 14px)', background: 'var(--surface-overlay)', borderColor: 'var(--border-default)', boxShadow: 'var(--shadow-overlay)' }}>
        <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>删除对话</div>
        <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          确定删除「{session.name || '未命名会话'}」吗？删除后不会再出现在列表中。
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="workbench-control-md border px-3 text-[12px] hover:bg-[var(--surface-control-hover)]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>取消</button>
          <button type="button" onClick={onConfirm} disabled={busy} className="workbench-control-md px-3 text-[12px] font-medium disabled:opacity-50" style={{ background: 'var(--status-danger)', color: '#fff' }}>删除</button>
        </div>
      </div>
    </div>
  )
}
