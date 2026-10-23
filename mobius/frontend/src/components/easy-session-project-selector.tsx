// =====================================================================
// 简易模式会话页: 输入框上方的「更改项目」入口 + 项目 breadcrumb (issue 2026-10-13).
// 复用 ChatArea 已有 easyProjectControl.props / state / refs, 在 chat.tsx 调用本组件即可.
// =====================================================================
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, FolderOpen, Search } from 'lucide-react'

export type EasyProjectOption = {
  id: string
  name: string
  kind?: string
  default_model?: string | null
}

export type EasyProjectControl = {
  selectedProjectId?: string
  selectedProjectName?: string
  projects: EasyProjectOption[]
  onSelectProject: (projectId: string | null) => void
  onCreateProject: () => void
}

type EasyProjectMenuState = {
  open: boolean
  query: string
  buttonRef: RefObject<HTMLButtonElement>
  menuRef: RefObject<HTMLDivElement>
  closeMenu: () => void
  openMenu: () => void
  setQuery: (q: string) => void
}

type Props = EasyProjectControl & {
  /** 是否检测到 ⌘⇧O 快捷键 (用 ref 暴露, 由父级挂全局监听) */
  shortcutHint?: string
  /** 额外类 */
  className?: string
}

export function EasySessionProjectSelector({
  selectedProjectId,
  selectedProjectName,
  projects,
  onSelectProject,
  onCreateProject,
  shortcutHint = '⌘⇧O',
  className = '',
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

  // 弹窗定位
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const el = buttonRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const width = Math.min(420, Math.max(320, window.innerWidth - 16))
      setPos({
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
        width,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  // 全局快捷键: ⌘⇧O (Mac) / Ctrl+Shift+O (Win/Linux) → 弹窗.
  // 即使焦点在输入框 (INPUT/TEXTAREA/contentEditable) 也要响应, 方便用户边打字边切项目.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'o') return
      const wantMeta = isMac ? e.metaKey : e.ctrlKey
      if (wantMeta && e.shiftKey && !e.altKey) {
        e.preventDefault()
        setOpen(v => !v)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isMac])

  // 弹窗外点击/Esc 关闭
  useLayoutEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (buttonRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  // 弹窗外点击/Esc 关闭
  useLayoutEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (buttonRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  const filtered = query.trim()
    ? projects.filter(p => p.name.toLowerCase().includes(query.trim().toLowerCase()))
    : projects

  return (
    <div className={`easy-project-selector flex min-w-0 items-center gap-2 ${className}`}>
      {/* 顶部 pill 按钮: 未选项目时显示「点击选择项目」; 已选项目时显示项目名 + 「点击可修改」 */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={selectedProjectId ? `当前项目: ${selectedProjectName || '项目'}, 点击修改` : '点击选择项目'}
        data-testid="easy-project-trigger"
        className="easy-project-trigger inline-flex h-7 max-w-full items-center gap-1.5 rounded-full px-3 text-[length:var(--fs-sm)] font-medium transition-colors hover:bg-[var(--bg-card-hover)]"
        style={{
          background: open ? 'rgba(59,130,246,0.12)' : 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          color: 'var(--text-secondary)',
        }}
        title={selectedProjectId ? `当前项目: ${selectedProjectName || '项目'} · 点击可修改` : '点击选择项目'}
      >
        <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" style={{ color: open ? '#60a5fa' : 'var(--text-muted)' }} />
        <span className="truncate font-medium">
          {selectedProjectId
            ? (selectedProjectName || '项目')
            : '点击选择项目'}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} style={{ color: 'var(--text-muted)' }} />
      </button>

      {/* 弹窗: 项目搜索/选择 */}
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="选择项目"
          data-testid="easy-session-project-menu"
          className="fixed z-[97] overflow-hidden rounded-2xl shadow-2xl"
          style={{
            left: pos.left,
            bottom: pos.bottom,
            width: pos.width,
            background: 'var(--modal-bg)',
            border: '1px solid var(--border-color)',
            boxShadow: '0 18px 48px -12px rgba(0,0,0,0.5)',
            padding: 8,
          } as CSSProperties}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 rounded-xl px-2.5 py-1.5"
               style={{ background: 'color-mix(in srgb, var(--bg-secondary) 80%, transparent)' }}>
            <Search className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索项目..."
              className="min-w-0 flex-1 border-0 bg-transparent text-[length:var(--fs-sm)] outline-none"
              style={{ color: 'var(--text-primary)' }}
              autoFocus
            />
            {selectedProjectId && (
              <button
                type="button"
                onClick={() => { onSelectProject(null); setOpen(false) }}
                className="flex-shrink-0 rounded px-1.5 py-0.5 text-[length:var(--fs-xs)]"
                style={{ color: 'var(--text-muted)' }}
              >
                清除
              </button>
            )}
          </div>
          <div className="mt-1 max-h-[320px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-2 py-3 text-center text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>
                {query.trim() ? '未找到匹配项目' : '暂无可用项目'}
              </div>
            ) : (
              filtered.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { onSelectProject(p.id); setOpen(false) }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] transition-colors hover:bg-[var(--bg-hover)]"
                  style={{
                    color: 'var(--text-primary)',
                    background: p.id === selectedProjectId ? 'rgba(59,130,246,0.12)' : undefined,
                  }}
                >
                  <FolderOpen className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.kind && (
                    <span className="text-[10px] flex-shrink-0 px-1.5 py-0.5 rounded"
                          style={{ background: 'var(--bg-card-hover)', color: 'var(--text-muted)' }}>
                      {p.kind}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
          {/* 新建项目: 固定在弹窗底部, 不随项目列表滚动 (issue 2026-10-17) */}
          <div className="mt-0.5 border-t pt-0.5" style={{ borderColor: 'var(--border-color)' }}>
            <button
              type="button"
              onClick={() => { setOpen(false); onCreateProject() }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1 text-left text-[length:var(--fs-sm)] transition-colors hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--accent-primary)' }}
            >
              <span className="text-sm leading-none">+</span>
              <span>新建项目</span>
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
