import { lazy, Suspense, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { DraftingCompass, Loader2, X } from 'lucide-react'

/*
 * ProjectBlueprintDrawer — full-screen drawer hosting the project blueprint pane.
 * Shares the .mobius-drawer shell (backdrop + slide-in) with the mobile
 * project-settings drawer, and reuses ProjectBlueprintPanel unchanged.
 */
const ProjectBlueprintPanel = lazy(() =>
  import('./ProjectBlueprintPanel').then(module => ({ default: module.ProjectBlueprintPanel }))
)

export function ProjectBlueprintDrawer({
  open,
  projectId,
  onClose,
}: {
  open: boolean
  projectId: string
  onClose: () => void
}) {
  // Esc 关闭并锁定 body 滚动, 与 ProjectPage 的项目设置抽屉同源.
  // Close on Escape and lock body scroll, matching the project-settings drawer.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open || !projectId) return null

  return createPortal(
    <>
      <div className="mobius-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="mobius-drawer mobius-drawer--right mobius-drawer--full mobius-drawer--open"
        role="dialog"
        aria-modal="true"
        aria-label="项目蓝图"
      >
        {/* ✨ 抽屉头: 标题 + 关闭按钮 */}
        {/* ✨ Drawer header: title and close button */}
        <div
          className="flex h-11 flex-shrink-0 items-center gap-2 border-b px-3"
          style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}
        >
          <DraftingCompass className="h-4 w-4 flex-shrink-0" strokeWidth={1.8} style={{ color: 'var(--accent-primary)' }} />
          <span className="text-[length:var(--fs-lg)] font-medium" style={{ color: 'var(--text-primary)' }}>项目蓝图</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-muted)' }}
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
        {/* ✨ 主体撑满剩余高度, 蓝图面板内部树/预览各自滚动 */}
        {/* ✨ Body fills the remaining height; the pane scrolls its tree/preview internally */}
        <div className="flex min-h-0 flex-1 flex-col">
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center gap-2" style={{ color: 'var(--text-muted)' }}>
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-[length:var(--fs-md)]">正在加载项目蓝图…</span>
              </div>
            }
          >
            <ProjectBlueprintPanel projectId={projectId} />
          </Suspense>
        </div>
      </aside>
    </>,
    document.body
  )
}
