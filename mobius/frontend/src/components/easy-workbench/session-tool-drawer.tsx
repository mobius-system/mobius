import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Brain, Code2, Files, FileDiff, GitBranch, MoreHorizontal, PanelRightClose, Plus, Puzzle, Terminal } from 'lucide-react'

export type SessionToolTab = 'files' | 'diff' | 'terminal' | 'editor' | 'skill' | 'memory' | 'git'

export const SESSION_TOOL_TAB_LABELS: Record<SessionToolTab, string> = {
  files: '文件',
  diff: '改动',
  terminal: '终端',
  editor: '编辑器',
  skill: '技能',
  memory: '记忆',
  git: 'Git',
}

const TOOL_TABS: Array<{ id: SessionToolTab; label: string; icon: ReactNode }> = [
  { id: 'files', label: SESSION_TOOL_TAB_LABELS.files, icon: <Files className="h-3.5 w-3.5" /> },
  { id: 'diff', label: SESSION_TOOL_TAB_LABELS.diff, icon: <FileDiff className="h-3.5 w-3.5" /> },
  { id: 'terminal', label: SESSION_TOOL_TAB_LABELS.terminal, icon: <Terminal className="h-3.5 w-3.5" /> },
  { id: 'editor', label: SESSION_TOOL_TAB_LABELS.editor, icon: <Code2 className="h-3.5 w-3.5" /> },
  { id: 'skill', label: SESSION_TOOL_TAB_LABELS.skill, icon: <Puzzle className="h-3.5 w-3.5" /> },
  { id: 'memory', label: SESSION_TOOL_TAB_LABELS.memory, icon: <Brain className="h-3.5 w-3.5" /> },
  { id: 'git', label: SESSION_TOOL_TAB_LABELS.git, icon: <GitBranch className="h-3.5 w-3.5" /> },
]

const SESSION_TOOL_SELECTION_KEY = 'mobius:session-tool-selection'

export function SessionToolDrawer({
  open,
  activeTab,
  sourceLabel,
  objectLabel,
  overflow,
  onSelectTab,
  onCollapse,
  children,
}: {
  open: boolean
  activeTab: SessionToolTab
  sourceLabel?: string
  objectLabel?: string
  overflow?: ReactNode
  onSelectTab: (tab: SessionToolTab) => void
  onCollapse: () => void
  children: ReactNode
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const overflowButtonRef = useRef<HTMLButtonElement | null>(null)
  const overflowPanelRef = useRef<HTMLDivElement | null>(null)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [selectedTabs, setSelectedTabs] = useState<SessionToolTab[]>(() => {
    try {
      const raw = window.localStorage.getItem(SESSION_TOOL_SELECTION_KEY)
      if (!raw) return ['files', 'diff', 'terminal']
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((value): value is SessionToolTab => TOOL_TABS.some(tab => tab.id === value))
    } catch {
      return ['files', 'diff', 'terminal']
    }
  })
  const activeIndex = selectedTabs.findIndex(tab => tab === activeTab)
  const focusableIndex = activeIndex >= 0 ? activeIndex : 0
  const visibleObjectLabel = objectLabel?.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || objectLabel
  const drawerTitle = visibleObjectLabel || SESSION_TOOL_TAB_LABELS[activeTab]
  const drawerSource = sourceLabel || '当前会话'

  useEffect(() => {
    if (!open) {
      setOverflowOpen(false)
      setAddOpen(false)
    }
  }, [open])

  useEffect(() => {
    if (!overflowOpen && !addOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (overflowButtonRef.current?.contains(target) || overflowPanelRef.current?.contains(target)) return
      if ((event.target as Element)?.closest('.session-tool-drawer__add')) return
      if ((event.target as Element)?.closest('[aria-controls="session-tool-add"]')) return
      setOverflowOpen(false)
      setAddOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [addOpen, overflowOpen])

  const selectTab = (tab: SessionToolTab) => {
    setSelectedTabs(previous => {
      if (previous.includes(tab)) return previous
      const next = [...previous, tab]
      try { window.localStorage.setItem(SESSION_TOOL_SELECTION_KEY, JSON.stringify(next)) } catch { /* storage is optional */ }
      return next
    })
    setAddOpen(false)
    setOverflowOpen(false)
    onSelectTab(tab)
  }

  const selectByIndex = (index: number) => {
    if (selectedTabs.length === 0) return
    const normalized = (index + selectedTabs.length) % selectedTabs.length
    setOverflowOpen(false)
    onSelectTab(selectedTabs[normalized])
    tabRefs.current[normalized]?.focus()
  }

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const currentIndex = activeIndex >= 0 ? activeIndex : index
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      selectByIndex(currentIndex + 1)
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      selectByIndex(currentIndex - 1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      selectByIndex(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      selectByIndex(selectedTabs.length - 1)
    }
  }

  return (
    <div
      id="session-tool-drawer"
      className="session-tool-drawer flex h-full min-h-0 flex-col"
      data-session-tool-drawer
      data-open={open ? 'true' : 'false'}
      data-active-tab={activeTab}
      aria-hidden={!open}
      {...(!open ? { inert: '' } : {}) as any}
    >
      <header className="session-tool-drawer__header">
        <div className="session-tool-drawer__titlebar">
          <div className="session-tool-drawer__identity">
            <div className="session-tool-drawer__title" title={objectLabel || drawerTitle}>{drawerTitle}</div>
            <div className="session-tool-drawer__source" data-session-tool-source title={drawerSource}>{drawerSource}</div>
          </div>
          <button
            type="button"
            onClick={onCollapse}
            className="session-tool-drawer__header-action"
            aria-label="收起工作区"
            title="收起工作区"
          >
            <PanelRightClose aria-hidden />
          </button>
        </div>
        {selectedTabs.length > 0 && (
          <div className="session-tool-drawer__nav">
            <div className="session-tool-drawer__tabs" role="tablist" aria-label="工作区面板" aria-orientation="horizontal">
              {selectedTabs.map((tabId, index) => {
                const tab = TOOL_TABS.find(item => item.id === tabId)
                if (!tab) return null
                return (
                  <button
                    id={`session-tool-tab-${tab.id}`}
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-controls="session-tool-tabpanel"
                    aria-selected={activeTab === tab.id}
                    aria-label={tab.label}
                    tabIndex={index === focusableIndex ? 0 : -1}
                    ref={element => { tabRefs.current[index] = element }}
                    onClick={() => { setOverflowOpen(false); onSelectTab(tab.id) }}
                    onKeyDown={event => handleTabKeyDown(event, index)}
                    className={`session-tool-drawer__tab${activeTab === tab.id ? ' is-active' : ''}`}
                    title={tab.label}
                  >
                    <span className="session-tool-drawer__tab-icon" aria-hidden>{tab.icon}</span>
                    <span className="session-tool-drawer__tab-label">{tab.label}</span>
                  </button>
                )
              })}
              <button
                ref={overflowButtonRef}
                type="button"
                onClick={() => { setAddOpen(value => !value); setOverflowOpen(false) }}
                className="session-tool-drawer__tab-add"
                aria-label="添加工作区面板"
                aria-controls="session-tool-add"
                aria-expanded={addOpen}
                title="添加面板"
              >
                <Plus aria-hidden />
              </button>
            </div>
          </div>
        )}
        {addOpen && (
          <div id="session-tool-add" className="session-tool-drawer__add workbench-popover" role="menu" aria-label="添加工作区面板">
            <div className="session-tool-drawer__add-title">添加面板</div>
            {TOOL_TABS.map(tab => (
              selectedTabs.includes(tab.id) ? null : (
                <button key={tab.id} type="button" role="menuitem" className="session-tool-drawer__add-item" onClick={() => selectTab(tab.id)}>
                  <span className="session-tool-drawer__tab-icon" aria-hidden>{tab.icon}</span>
                  <span>{tab.label}</span>
                  {activeTab === tab.id && <span className="session-tool-drawer__add-current">当前</span>}
                </button>
              )
            ))}
            {overflow && (
              <button type="button" role="menuitem" className="session-tool-drawer__add-item" onClick={() => { setAddOpen(false); setOverflowOpen(true) }}>
                <MoreHorizontal className="h-4 w-4" aria-hidden />
                <span>更多操作</span>
              </button>
            )}
          </div>
        )}
        {overflow && overflowOpen && (
          <div
            ref={overflowPanelRef}
            id="session-tool-overflow"
            className="session-tool-drawer__overflow workbench-popover"
            role="group"
            aria-label="更多会话动作"
            onClickCapture={event => {
              const target = event.target
              if (target instanceof Element && target.closest('button:not(:disabled)')) setOverflowOpen(false)
            }}
            onKeyDown={event => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              setOverflowOpen(false)
              overflowButtonRef.current?.focus()
            }}
          >
            {overflow}
          </div>
        )}
      </header>
      <div
        id="session-tool-tabpanel"
        className="session-tool-drawer__body min-h-0 flex-1 overflow-auto p-2"
        role="tabpanel"
        aria-labelledby={`session-tool-tab-${activeTab}`}
      >
        {selectedTabs.length === 0 ? (
          <div className="session-tool-drawer__chooser" role="list" aria-label="选择工作区面板">
            <div className="session-tool-drawer__chooser-heading">选择工作区面板</div>
            <div className="session-tool-drawer__chooser-copy">常用面板会保留在这里，也可随时通过 + 添加。</div>
            {TOOL_TABS.map(tab => (
              <button key={tab.id} type="button" className="session-tool-drawer__chooser-item" onClick={() => selectTab(tab.id)}>
                <span className="session-tool-drawer__chooser-icon" aria-hidden>{tab.icon}</span>
                <span>{tab.label}</span>
                <span className="session-tool-drawer__chooser-hint">添加</span>
              </button>
            ))}
            {overflow && (
              <button type="button" className="session-tool-drawer__chooser-item" onClick={() => setOverflowOpen(true)}>
                <span className="session-tool-drawer__chooser-icon" aria-hidden><MoreHorizontal className="h-4 w-4" /></span>
                <span>更多操作</span>
                <span className="session-tool-drawer__chooser-hint">打开</span>
              </button>
            )}
          </div>
        ) : children}
      </div>
    </div>
  )
}
