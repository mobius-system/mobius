// =====================================================================
// 简易模式「会话内」输入框左侧的工具入口 (与欢迎页的 EasySessionConfigBar 并列, 同一个位置).
//
// 弹出的工具菜单就是标准布局那份「会话统一按钮组」(UnifiedButtonGroup + SessionSkillMemoryEditor),
// 按钮本体仍由 AdvancedSessionActions 定义 —— 标准布局把它放在输入侧栏, 简易模式只是把它搬进浮层,
// 所以入口、禁用条件、显示开关在两处完全一致, 不存在第二份定义.
//
// 浮层走 portal 到 body: 输入框带 backdrop-filter + overflow:hidden, 直接放在里面会被当成包含块裁掉.
// =====================================================================
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Wrench, X } from 'lucide-react'
import { UnifiedButton } from './unified-button-group'

const PANEL_MAX_WIDTH = 380
const PANEL_MIN_WIDTH = 280
const PANEL_MAX_HEIGHT = 560
const VIEWPORT_MARGIN = 8

export function EasySessionToolBar({ children, label = '会话工具', disabled = false, panelLabel = '会话工具' }: {
  /** 工具菜单内容: 标准布局同一份会话统一按钮组 */
  children: ReactNode
  label?: string
  disabled?: boolean
  panelLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [pos, setPos] = useState<{ left: number; right: number; bottom: number; width: number; maxHeight: number } | null>(null)

  // 位置在打开时算一次, 之后跟随滚动/改窗重算.
  // 输入框贴着视口底部, 所以面板用 bottom 贴住按钮上沿向上生长 (高度随内容, 不预留空白),
  // maxHeight 兜住矮视口, 超出部分由面板内部滚动.
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const el = triggerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const width = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2))
      setPos({
        left: Math.min(Math.max(VIEWPORT_MARGIN, rect.left), Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)),
        right: Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right),
        bottom: Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.top + VIEWPORT_MARGIN),
        width,
        maxHeight: Math.min(PANEL_MAX_HEIGHT, Math.max(200, rect.top - VIEWPORT_MARGIN * 2)),
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

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <UnifiedButton
        ref={triggerRef}
        kind="modal"
        label={label}
        disabled={disabled}
        accent="violet"
        aria-expanded={open}
        icon={<Wrench className="h-3.5 w-3.5" strokeWidth={2} />}
        iconClassName="h-3.5 w-3.5"
        buttonClassName="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full transition-colors hover:bg-[var(--bg-card-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        // 与同一行右侧的麦克风/终止/加急/发送保持同一套无边框圆形样式: 用背景色而非描边表示展开态.
        style={{ color: open ? '#60a5fa' : '#d1d5db', background: open ? 'rgba(59,130,246,0.14)' : undefined }}
        onClick={() => setOpen(value => !value)}
      />
      {open && pos && createPortal(
        <div className="fixed inset-0 z-[95]" onMouseDown={() => setOpen(false)}>
          <div
            role="dialog"
            aria-label={panelLabel}
            data-testid="easy-session-tool-menu"
            className="absolute flex flex-col overflow-hidden rounded-2xl shadow-2xl"
            style={{
              left: pos.left,
              right: pos.right,
              bottom: pos.bottom,
              width: pos.width,
              maxHeight: pos.maxHeight,
              background: 'var(--modal-bg)',
              border: '1px solid var(--border-color)',
              boxShadow: '0 18px 48px -12px rgba(0,0,0,0.5)',
            }}
            onMouseDown={event => event.stopPropagation()}
          >
            <header className="flex flex-shrink-0 items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--border-color)' }}>
              <span className="min-w-0 truncate text-[length:var(--fs-md)] font-semibold" style={{ color: 'var(--text-primary)' }}>{panelLabel}</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭会话工具菜单"
                className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-card-hover)]"
                style={{ color: 'var(--text-muted)' }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
