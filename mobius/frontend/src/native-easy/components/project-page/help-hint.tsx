import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HelpCircle } from 'lucide-react'

// HelpHint — 标题旁的小 "?" 图标, hover/focus 弹出说明气泡.
// 用途: 设置卡 (SettingsCard) 等 section 标题旁, 把"这块设置是干什么的"长说明
// 从开篇正文挪到按需悬浮, 让界面更干净 (见 ProjectSettingsPanel).
// 实现要点:
//   - tooltip 经 createPortal 渲染到 document.body, 避免被卡片 overflow:hidden 裁切;
//   - 首帧 visibility:hidden 测量自身宽高, 再按视口四边 clamp 定位 (上方优先, 放不下翻下方);
//   - hover 与键盘 focus 都能触发 (tabindex=0 + aria-describedby), ESC 关闭.
type HelpHintProps = {
  text: string
  /** 图标尺寸 (px), 默认 13 与 text-[13px] 标题对齐 */
  size?: number
  className?: string
}

export function HelpHint({ text, size = 13, className = '' }: HelpHintProps) {
  const tipId = useId()
  const iconRef = useRef<HTMLSpanElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  // pos 为 null 时 tooltip 以 visibility:hidden 渲染用于测量; 测量后 setPos 得到经视口 clamp 的坐标.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const update = useCallback(() => {
    const icon = iconRef.current
    if (!icon || typeof window === 'undefined') return
    const rect = icon.getBoundingClientRect()
    const gap = 8
    const margin = 8
    const vw = window.innerWidth
    const vh = window.innerHeight
    const tip = tipRef.current
    const tw = tip ? tip.offsetWidth : 0
    const th = tip ? tip.offsetHeight : 0
    const approxH = th || 36
    // 纵向: 上方放得下就 top, 否则 bottom.
    const placement = rect.top - gap - approxH >= margin ? 'top' : 'bottom'
    const top = placement === 'bottom'
      ? Math.min(rect.bottom + gap, vh - margin - approxH)
      : Math.max(margin, rect.top - gap - approxH)
    // 横向: 以图标中心为基准, clamp 让左右都不贴边.
    const center = rect.left + rect.width / 2
    const minCenter = margin + tw / 2
    const maxCenter = vw - margin - tw / 2
    const left = tw > 0 ? Math.min(Math.max(center, minCenter), maxCenter) : Math.min(Math.max(center, margin), vw - margin)
    setPos({ left, top })
  }, [])

  useEffect(() => {
    if (!open) return
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, update])

  // 首帧测量: open 后 pos 仍为 null → DOM 提交后用实测宽高重算 → setPos 触发可见重绘 (仅一次).
  useLayoutEffect(() => {
    if (open && pos === null) update()
  }, [open, pos, update])

  if (!text) return null

  return (
    <>
      <span
        ref={iconRef}
        role="button"
        tabIndex={0}
        aria-label="查看说明"
        aria-describedby={open ? tipId : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
        className={`inline-flex items-center justify-center align-middle rounded-full cursor-help transition-colors ${className}`}
        style={{ color: 'var(--text-muted)', width: size + 4, height: size + 4, lineHeight: 0 }}
      >
        <HelpCircle style={{ width: size, height: size }} strokeWidth={1.8} />
      </span>
      {open && createPortal(
        <div
          ref={tipRef}
          id={tipId}
          role="tooltip"
          className="fixed z-[9999] max-w-[280px] px-3 py-2 rounded-lg text-[12px] leading-5 shadow-lg pointer-events-none"
          style={{
            left: pos?.left,
            top: pos?.top,
            visibility: pos ? 'visible' : 'hidden',
            transform: 'translateX(-50%)',
            // 必须用 --modal-bg (纯色), 而非 --bg-card (rgba alpha≈0.02 近乎透明) ——
            // tooltip 经 portal 渲染到 body, 透明背景会透出页面内容看不清.
            background: 'var(--modal-bg, #111820)',
            border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
            color: 'var(--text-primary, #f1f5f9)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
          }}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  )
}
