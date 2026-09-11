import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Folder, Plus, Search, X } from 'lucide-react'

// 欢迎页 composer 内嵌的项目选择器 (极简模式项目/专项团队两个欢迎页共用)。
// 与早期 inline 版本保持同一交互: 搜索过滤 + 选中态 + 底部新建入口。
export function HomeProjectSelect({
  projects,
  selectedProjectId,
  onSelect,
  onNewProject,
  newLabel = '新建项目',
  menuLabel = '选择项目',
  searchPlaceholder = '搜索项目名称、描述或 ID',
  emptyHint = '没有匹配的项目',
  disabled = false,
}: {
  projects: any[]
  selectedProjectId: string
  onSelect: (projectId: string) => void
  onNewProject?: () => void
  newLabel?: string
  menuLabel?: string
  searchPlaceholder?: string
  emptyHint?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const selectedProject = projects.find(project => project.id === selectedProjectId) || null

  const filteredProjects = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return projects
    return projects.filter((project: any) => [project.name, project.description, project.id]
      .some(value => String(value || '').toLowerCase().includes(keyword)))
  }, [projects, query])

  useEffect(() => {
    if (!open) return
    const onOutsidePointer = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      setQuery('')
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onOutsidePointer)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', onOutsidePointer)
      document.removeEventListener('keydown', onEscape)
    }
  }, [open])

  useEffect(() => {
    if (open) window.requestAnimationFrame(() => searchRef.current?.focus())
    else setQuery('')
  }, [open])

  const pickProject = (projectId: string) => {
    onSelect(projectId)
    setOpen(false)
    setQuery('')
    buttonRef.current?.focus()
  }

  const openNewProject = () => {
    setOpen(false)
    setQuery('')
    onNewProject?.()
  }

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(value => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={menuLabel}
        title={selectedProject?.name || menuLabel}
        className="home-composer-project-select workbench-control-md flex min-w-0 max-w-[260px] items-center gap-2 px-2.5 text-[12px] transition-colors hover:bg-[var(--surface-control-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        style={{ color: 'var(--text-secondary)', background: 'var(--surface-control)' }}
      >
        <Folder className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="min-w-0 flex-1 truncate">{selectedProject?.name || menuLabel}</span>
        <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={menuLabel}
          className="workbench-popover absolute left-0 top-[calc(100%+8px)] z-40 w-[300px] max-w-[calc(100vw-48px)] overflow-hidden p-2"
          style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)' }}
        >
          <div role="search" className="flex h-9 items-center gap-2 rounded-[var(--radius-control)] px-3" style={{ background: 'var(--input-bg)', color: 'var(--text-secondary)' }}>
            <Search className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.8} aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setOpen(false)
                  setQuery('')
                  buttonRef.current?.focus()
                }
              }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] outline-none placeholder:text-[var(--text-muted)]"
              style={{ color: 'var(--text-primary)' }}
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); searchRef.current?.focus() }}
                className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[var(--radius-control)] hover:bg-[var(--surface-control-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                aria-label="清空项目搜索"
                title="清空搜索"
                style={{ color: 'var(--text-muted)' }}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="mt-2 max-h-[240px] overflow-y-auto">
            {filteredProjects.length === 0 ? (
              <div className="px-3 py-7 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>{emptyHint}</div>
            ) : filteredProjects.map((project: any) => {
              const active = project.id === selectedProjectId
              return (
                <button
                  key={project.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  data-active={active ? 'true' : 'false'}
                  onClick={() => pickProject(project.id)}
                  className="workbench-project-option flex min-h-9 w-full items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-left transition-colors hover:bg-[var(--surface-control-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                  title={project.name}
                >
                  <Folder className="h-3.5 w-3.5 flex-shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{project.name}</span>
                  {active && <Check className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} aria-hidden="true" />}
                </button>
              )
            })}
          </div>
          {onNewProject && (
            <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-default)' }}>
              <button
                type="button"
                role="menuitem"
                onClick={openNewProject}
                className="flex min-h-9 w-full items-center gap-2 rounded-[var(--radius-control)] px-3 py-2 text-left text-[12px] font-semibold transition-colors hover:bg-[var(--surface-control-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                style={{ color: 'var(--text-primary)' }}
              >
                <Plus className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} aria-hidden="true" /> {newLabel}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
