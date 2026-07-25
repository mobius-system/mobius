import { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type AdvancedInteractionAccent = 'blue' | 'emerald' | 'cyan' | 'violet' | 'amber'

const ACCENT_CLASS: Record<AdvancedInteractionAccent, string> = {
  blue: 'text-blue-400 hover:bg-blue-500/10',
  emerald: 'text-emerald-400 hover:bg-emerald-500/10',
  cyan: 'text-cyan-400 hover:bg-cyan-500/10',
  violet: 'text-violet-400 hover:bg-violet-500/10',
  amber: 'text-amber-400 hover:bg-amber-500/10',
}

type AdvancedInteractionBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode
  label: string
  accent?: AdvancedInteractionAccent
  tooltip?: string
  buttonClassName?: string
  iconClassName?: string
  motion?: 'tilt' | 'breathe'
}

export const AdvancedInteractionBtn = forwardRef<HTMLButtonElement, AdvancedInteractionBtnProps>(function AdvancedInteractionBtn({
  icon,
  label,
  accent = 'emerald',
  tooltip,
  buttonClassName,
  className = '',
  disabled,
  iconClassName,
  motion = 'tilt',
  onBlur,
  onFocus,
  onMouseEnter,
  onMouseLeave,
  ...props
}, forwardedRef) {
  const tooltipText = tooltip || label
  const tooltipId = useId()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  // tooltipPos 为 null 时 tooltip 以 visibility:hidden 渲染并测量; 测量后 setTooltipPos 得到经四向边距 clamp 的最终坐标, 此后可见.
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null)

  // 测量 tooltip 自身宽高 + 按钮位置, 计算不溢出视口四边的坐标. 关键: clamp 的是 tooltip 的左/右/上/下边 (考虑自身半宽/半高), 而非只 clamp 中心点 (旧实现只 clamp 中心点 → 宽 tooltip 右半仍溢出).
  const updateTooltipPosition = useCallback(() => {
    const button = buttonRef.current
    if (!button || typeof window === 'undefined') return
    const rect = button.getBoundingClientRect()
    const gap = 8
    const margin = 8 // 视口边距留白
    const vw = window.innerWidth
    const vh = window.innerHeight
    // 测量已渲染 (可能仍 hidden) 的 tooltip 自身宽高; 首次渲染前 tooltipRef 为 null, 用 0 兜底 (后续 useLayoutEffect 会用实测值重算).
    const tip = tooltipRef.current
    const tw = tip ? tip.offsetWidth : 0
    const th = tip ? tip.offsetHeight : 0
    const approxH = th || 30
    // 纵向 placement: 按钮下方放得下就 bottom, 否则 top; 若都放不下 (按钮很高) 退回 bottom 由后续 clamp 兜底.
    const placement = rect.bottom + gap + approxH <= vh - margin ? 'bottom' : (rect.top - gap - approxH >= margin ? 'top' : 'bottom')
    const top = placement === 'bottom'
      ? Math.min(rect.bottom + gap, vh - margin - approxH)
      : Math.max(margin, rect.top - gap - approxH)
    // 横向: 以按钮中心为基准, 但 clamp 让 tooltip 左边 >= margin 且 右边 <= vw - margin (考虑自身半宽 tw/2).
    // clamp 中心点范围: [margin + tw/2, vw - margin - tw/2]; tw 未知 (0) 时退化为旧中心点 clamp, 不影响后续测量重算.
    const center = rect.left + rect.width / 2
    const minCenter = margin + tw / 2
    const maxCenter = vw - margin - tw / 2
    const left = tw > 0 ? Math.min(Math.max(center, minCenter), maxCenter) : Math.min(Math.max(center, margin), vw - margin)
    setTooltipPos({ left, top, placement })
  }, [])

  useEffect(() => {
    if (!tooltipOpen) return
    updateTooltipPosition()
    window.addEventListener('resize', updateTooltipPosition)
    window.addEventListener('scroll', updateTooltipPosition, true)
    return () => {
      window.removeEventListener('resize', updateTooltipPosition)
      window.removeEventListener('scroll', updateTooltipPosition, true)
    }
  }, [tooltipOpen, updateTooltipPosition])

  // 首帧: tooltip 以 visibility:hidden 渲染用于测量, 此时 tooltipPos 仍为 null. DOM 提交后用实测宽高重算坐标 → setTooltipPos 触发可见重绘. 依赖 tooltipOpen 与 tooltipPos(null→非null 仅触发一次).
  useLayoutEffect(() => {
    if (tooltipOpen && tooltipPos === null) {
      updateTooltipPosition()
    }
  }, [tooltipOpen, tooltipPos, updateTooltipPosition])

  const showTooltip = useCallback(() => {
    // 不预设位置: 先 setTooltipOpen(true), tooltip 以 tooltipPos===null (visibility:hidden) 渲染,
    // useLayoutEffect 测到实测宽高后调 updateTooltipPosition 得到经四向 clamp 的最终坐标, 再可见. 这样宽 tooltip 不会溢出视口.
    setTooltipOpen(true)
  }, [])

  const hideTooltip = useCallback(() => {
    setTooltipOpen(false)
    setTooltipPos(null)
  }, [])

  const setButtonRef = useCallback((node: HTMLButtonElement | null) => {
    buttonRef.current = node
    if (typeof forwardedRef === 'function') {
      forwardedRef(node)
    } else if (forwardedRef) {
      forwardedRef.current = node
    }
  }, [forwardedRef])

  return (
    <>
      <button
        {...props}
        ref={setButtonRef}
        type={props.type || 'button'}
        disabled={disabled}
        aria-label={label}
        aria-describedby={tooltipOpen ? tooltipId : undefined}
        onMouseEnter={(event) => {
          onMouseEnter?.(event)
          showTooltip()
        }}
        onMouseLeave={(event) => {
          onMouseLeave?.(event)
          hideTooltip()
        }}
        onFocus={(event) => {
          onFocus?.(event)
          showTooltip()
        }}
        onBlur={(event) => {
          onBlur?.(event)
          hideTooltip()
        }}
        className={`group/advanced-interaction relative inline-flex ${buttonClassName || 'h-7 w-full rounded-md'} min-w-0 items-center justify-center bg-transparent px-0 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-not-allowed disabled:opacity-40 ${ACCENT_CLASS[accent]} ${className}`}
      >
        <span className={`inline-flex ${iconClassName || 'h-4 w-4'} items-center justify-center transition-transform ${motion === 'breathe' ? 'duration-300 ease-out group-hover/advanced-interaction:scale-110 group-focus-visible/advanced-interaction:scale-110' : 'duration-200 group-hover/advanced-interaction:-translate-y-0.5 group-hover/advanced-interaction:rotate-[-8deg] group-hover/advanced-interaction:scale-110 group-focus-visible/advanced-interaction:-translate-y-0.5 group-focus-visible/advanced-interaction:rotate-[-8deg] group-focus-visible/advanced-interaction:scale-110'}`}>
          {icon}
        </span>
      </button>
      {tooltipOpen && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            // tooltipPos 为 null = 首帧渲染用于测量, visibility:hidden 保持布局以读 offsetWidth/Height, 测量完成 (useLayoutEffect 设了 tooltipPos) 后再可见.
            className="pointer-events-none fixed z-[1000] max-w-[220px] whitespace-nowrap rounded-md border border-[var(--border-color)] bg-[var(--modal-bg)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] shadow-xl"
            style={
              tooltipPos
                ? {
                    left: tooltipPos.left,
                    top: tooltipPos.top,
                    transform: tooltipPos.placement === 'bottom'
                      ? 'translate(-50%, 0)'
                      : 'translate(-50%, -100%)',
                    visibility: 'visible',
                  }
                : { left: 0, top: 0, visibility: 'hidden' }
            }
          >
            {tooltipText}
          </div>,
          document.body,
        )
        : null}
    </>
  )
})
