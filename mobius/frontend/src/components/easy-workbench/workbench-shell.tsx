import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { History, MoreHorizontal, Plus, Search } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { ConversationRail, type ConversationRailItem } from './conversation-rail'
import { LayoutModeSwitch } from './layout-mode-switch'
import { SearchModal } from '../search-modal'
import { SettingsPanel, type SettingsSection } from './settings-panel'
import { GlobalCreateRoot, type CreateKind } from '../global-create'
import { prepareWorkbenchObjectNavigation, sessionPath } from '../../services/easy-workbench/workbench-navigation'
import { useWorkbenchPaneResize } from '../../services/easy-workbench/pane-resize'

type WorkbenchShellSlot = 'topbar' | 'preview' | 'right' | 'dock'

type WorkbenchShellTargets = Record<WorkbenchShellSlot, HTMLElement | null>

const WorkbenchShellPortalContext = createContext<WorkbenchShellTargets | null>(null)

export function WorkbenchShellPortal({ slot, children }: { slot: WorkbenchShellSlot; children: ReactNode }) {
  const targets = useContext(WorkbenchShellPortalContext)
  const target = targets?.[slot]
  return target ? createPortal(children, target) : null
}

export function useWorkbenchShellSlot(slot: WorkbenchShellSlot) {
  return useContext(WorkbenchShellPortalContext)?.[slot] ?? null
}

function WorkbenchGlobalTopbar({
  title,
  onNewConversation,
  onOpenSearch,
}: {
  title: string
  onNewConversation: () => void
  onOpenSearch: (trigger: HTMLElement) => void
}) {
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement | null>(null)
  const moreButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!moreOpen) return
    const closeOnOutside = (event: PointerEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMoreOpen(false)
      moreButtonRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [moreOpen])

  return (
    <div className="workbench-global-topbar flex h-full min-w-0 items-center gap-1 px-3">
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('mobius:open-history'))}
        className="workbench-icon-btn xl:hidden"
        aria-label="历史"
        title="历史"
      >
        <History aria-hidden="true" />
      </button>
      <strong className="min-w-0 flex-1 truncate px-1 text-[13px] font-medium" style={{ color: 'var(--text-strong)' }}>
        {title}
      </strong>
      <button
        type="button"
        onClick={event => onOpenSearch(event.currentTarget)}
        className="workbench-icon-btn"
        aria-label="搜索 ⌘K"
        title="搜索 ⌘K"
      >
        <Search aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onNewConversation}
        className="workbench-icon-btn"
        aria-label="新会话"
        title="新会话 ⌘N"
      >
        <Plus aria-hidden="true" />
      </button>
      <div className="relative flex-shrink-0" ref={moreRef}>
        <button
          ref={moreButtonRef}
          type="button"
          className={`workbench-icon-btn${moreOpen ? ' is-active' : ''}`}
          aria-label="更多"
          title="更多"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(value => !value)}
        >
          <MoreHorizontal aria-hidden="true" />
        </button>
        {moreOpen && (
          <div className="workbench-overflow-menu" role="menu" aria-label="更多操作">
            <LayoutModeSwitch variant="menu-item" onSelect={() => setMoreOpen(false)} />
          </div>
        )}
      </div>
    </div>
  )
}

export function WorkbenchShell({
  userId,
  activeSessionId,
  projectId,
  onNewConversation,
  onOpenConversation,
  refreshKey,
  topbar,
  topbarTitle = 'Home',
  children,
}: {
  userId: string
  activeSessionId?: string | null
  projectId?: string | null
  onNewConversation: () => void
  onOpenConversation?: (item: ConversationRailItem) => void
  refreshKey?: number
  topbar?: ReactNode | null
  topbarTitle?: string
  children: ReactNode
}) {
  const navigate = useNavigate()
  const [targets, setTargets] = useState<WorkbenchShellTargets>({ topbar: null, preview: null, right: null, dock: null })
  const [showSearch, setShowSearch] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [createKind, setCreateKind] = useState<CreateKind | null>(null)
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSection>('general')
  const searchReturnFocusRef = useRef<HTMLElement | null>(null)
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null)
  const railResize = useWorkbenchPaneResize({
    storageKey: 'mobius:ui:workbench:rail-width',
    cssVariable: '--rail-width',
    defaultWidth: 280,
    minWidth: 208,
    maxWidth: 420,
    side: 'left',
  })
  const toolDrawerResize = useWorkbenchPaneResize({
    storageKey: 'mobius:ui:workbench:tool-drawer-width',
    cssVariable: '--tool-drawer-width',
    defaultWidth: 260,
    minWidth: 220,
    maxWidth: 520,
    side: 'right',
  })

  const setSlotTarget = useCallback((slot: WorkbenchShellSlot, element: HTMLElement | null) => {
    setTargets(current => current[slot] === element ? current : { ...current, [slot]: element })
  }, [])
  const setTopbarTarget = useCallback((element: HTMLElement | null) => {
    setSlotTarget('topbar', element)
  }, [setSlotTarget])
  const setPreviewTarget = useCallback((element: HTMLElement | null) => {
    setSlotTarget('preview', element)
  }, [setSlotTarget])
  const setRightTarget = useCallback((element: HTMLElement | null) => {
    setSlotTarget('right', element)
  }, [setSlotTarget])
  const setDockTarget = useCallback((element: HTMLElement | null) => {
    setSlotTarget('dock', element)
  }, [setSlotTarget])

  const openSearch = useCallback((trigger?: HTMLElement | null) => {
    searchReturnFocusRef.current = trigger
      || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setShowSearch(true)
  }, [])

  const openSettings = useCallback((trigger?: HTMLElement | null, section: SettingsSection = 'general') => {
    settingsReturnFocusRef.current = trigger
      || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setSettingsInitialSection(section)
    setShowSearch(false)
    setShowSettings(true)
  }, [])

  const startNewConversation = useCallback(() => {
    prepareWorkbenchObjectNavigation()
    onNewConversation()
  }, [onNewConversation])

  const openSearchResult = useCallback((path: string) => {
    const target = new URL(path, window.location.origin)
    const sessionId = target.searchParams.get('session')
    if (!sessionId) {
      navigate(path)
      return
    }
    navigate(sessionPath(userId, sessionId, {
      match: target.searchParams.get('match') || undefined,
      timestamp: target.searchParams.get('ts') || undefined,
    }))
  }, [navigate, userId])

  useEffect(() => {
    const handleOpenSettings = (event: Event) => {
      const requested = (event as CustomEvent<{ section?: SettingsSection }>).detail?.section
      const section: SettingsSection = requested === 'context' || requested === 'connections' || requested === 'advanced' || requested === 'admin'
        ? requested
        : 'general'
      openSettings(undefined, section)
    }
    const handleOpenSearch = () => openSearch()
    window.addEventListener('mobius:open-settings', handleOpenSettings)
    window.addEventListener('mobius:open-search', handleOpenSearch)
    return () => {
      window.removeEventListener('mobius:open-settings', handleOpenSettings)
      window.removeEventListener('mobius:open-search', handleOpenSearch)
    }
  }, [openSearch, openSettings])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return
      const modifier = event.metaKey || event.ctrlKey
      if (!modifier || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openSearch()
      }
      if (event.key.toLowerCase() === 'n') {
        const target = event.target
        if (target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable)) return
        event.preventDefault()
        startNewConversation()
      }
      if (event.key === ',' || event.code === 'Comma') {
        event.preventDefault()
        openSettings()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openSearch, openSettings, startNewConversation])

  return (
    <WorkbenchShellPortalContext.Provider value={targets}>
      <div className="mobius-workbench workbench-shell h-screen min-h-0" data-workbench-shell>
        <ConversationRail
          userId={userId}
          activeSessionId={activeSessionId}
          projectId={projectId}
          onNewConversation={startNewConversation}
          onNewProject={() => setCreateKind('project')}
          onOpenConversation={onOpenConversation}
          onOpenSearch={trigger => openSearch(trigger)}
          onOpenSettings={trigger => openSettings(trigger)}
          refreshKey={refreshKey}
          resizeHandle={railResize}
        />
        <section className="workbench-shell__workspace min-h-0 min-w-0">
          <header
            ref={setTopbarTarget}
            className="workbench-shell__topbar min-w-0"
            style={{ background: 'var(--surface-topbar)' }}
            data-workbench-topbar
          >
            {topbar ?? (
              <WorkbenchGlobalTopbar
                title={topbarTitle}
                onNewConversation={startNewConversation}
                onOpenSearch={openSearch}
              />
            )}
          </header>
          <div className="workbench-shell__content min-h-0 min-w-0">
            <main className="workbench-shell__main min-h-0 min-w-0">{children}</main>
            <aside
              ref={setPreviewTarget}
              className="workbench-shell__preview min-h-0"
              aria-label="文件预览"
              data-workbench-preview
            />
          </div>
          <aside
            ref={setRightTarget}
            className="workbench-shell__right min-h-0"
            aria-label="会话工作区"
          >
            <div
              className="workbench-pane-resize-handle workbench-pane-resize-handle--right"
              data-testid="workbench-tool-drawer-resize-handle"
              role="separator"
              aria-label="调整右侧工作区宽度"
              aria-orientation="vertical"
              aria-valuemin={220}
              aria-valuemax={520}
              aria-valuenow={toolDrawerResize.width}
              tabIndex={0}
              onPointerDown={toolDrawerResize.handlePointerDown}
              onDoubleClick={toolDrawerResize.handleDoubleClick}
              onKeyDown={toolDrawerResize.handleKeyDown}
              title="拖拽调整右侧工作区宽度 · 双击恢复默认"
            />
          </aside>
          <div ref={setDockTarget} className="workbench-shell__dock empty:hidden" />
        </section>
      </div>
      {showSearch && (
        <SearchModal
          onClose={() => setShowSearch(false)}
          onNavigate={openSearchResult}
        />
      )}
      {createKind && (
        <GlobalCreateRoot
          kind={createKind}
          ctx={{ projectId: projectId || undefined }}
          onClose={() => setCreateKind(null)}
          onNavigate={path => navigate(path)}
        />
      )}
      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          returnFocusRef={settingsReturnFocusRef}
          initialSection={settingsInitialSection}
        />
      )}
    </WorkbenchShellPortalContext.Provider>
  )
}
