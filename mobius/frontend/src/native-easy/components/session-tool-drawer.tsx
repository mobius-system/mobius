import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Brain, Code2, Files, FileDiff, GitBranch, MoreHorizontal, PanelRightClose, Puzzle, Terminal } from 'lucide-react'

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
  const activeIndex = TOOL_TABS.findIndex(tab => tab.id === activeTab)
  const focusableIndex = activeIndex >= 0 ? activeIndex : 0
  const visibleObjectLabel = objectLabel?.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || objectLabel

  useEffect(() => {
    if (!open) setOverflowOpen(false)
  }, [open])

  useEffect(() => {
    if (!overflowOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (overflowButtonRef.current?.contains(target) || overflowPanelRef.current?.contains(target)) return
      setOverflowOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [overflowOpen])

  const selectByIndex = (index: number) => {
    const normalized = (index + TOOL_TABS.length) % TOOL_TABS.length
    setOverflowOpen(false)
    onSelectTab(TOOL_TABS[normalized].id)
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
      selectByIndex(TOOL_TABS.length - 1)
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
        <div className="session-tool-drawer__chrome">
          <div className="session-tool-drawer__tabs" role="tablist" aria-label="会话工具" aria-orientation="horizontal">
            {TOOL_TABS.map((tab, index) => (
              <button
                id={`session-tool-tab-${tab.id}`}
                key={tab.id}
                type="button"
                role="tab"
                aria-controls="session-tool-tabpanel"
                aria-selected={activeTab === tab.id}
                aria-label={tab.label}
                tabIndex={index === focusableIndex ? 0 : -1}
                ref={element => {
                  tabRefs.current[index] = element
                }}
                onClick={() => {
                  setOverflowOpen(false)
                  onSelectTab(tab.id)
                }}
                onKeyDown={event => handleTabKeyDown(event, index)}
                className={`session-tool-drawer__tab${activeTab === tab.id ? ' is-active' : ''}`}
                title={tab.label}
              >
                <span className="session-tool-drawer__tab-icon" aria-hidden>{tab.icon}</span>
              </button>
            ))}
          </div>
          <div className="session-tool-drawer__header-actions">
            {overflow && (
              <button
                ref={overflowButtonRef}
                type="button"
                onClick={() => setOverflowOpen(value => !value)}
                className="session-tool-drawer__header-action"
                aria-label="更多会话动作"
                aria-controls="session-tool-overflow"
                aria-expanded={overflowOpen}
                title="更多会话动作"
              >
                <MoreHorizontal aria-hidden />
              </button>
            )}
            <button
              type="button"
              onClick={onCollapse}
              className="session-tool-drawer__header-action"
              aria-label="关闭工具并返回来源"
              title="关闭工具并返回来源"
            >
              <PanelRightClose aria-hidden />
            </button>
          </div>
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
        </div>
        {(sourceLabel || objectLabel) && (
          <div className="session-tool-drawer__source" data-session-tool-source>
            {sourceLabel && <span className="flex-shrink-0">{sourceLabel}</span>}
            {sourceLabel && objectLabel && <span aria-hidden>·</span>}
            {objectLabel && <span className="min-w-0 truncate font-mono" title={objectLabel}>{visibleObjectLabel}</span>}
          </div>
        )}
      </header>
      <div
        id="session-tool-tabpanel"
        className="session-tool-drawer__body min-h-0 flex-1 overflow-auto p-2"
        role="tabpanel"
        aria-labelledby={`session-tool-tab-${activeTab}`}
      >
        {children}
      </div>
    </div>
  )
}
