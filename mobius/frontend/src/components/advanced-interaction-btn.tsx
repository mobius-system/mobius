import { useCallback, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type AdvancedInteractionAccent = 'blue' | 'emerald' | 'cyan' | 'violet'

const ACCENT_CLASS: Record<AdvancedInteractionAccent, string> = {
  blue: 'text-blue-400 hover:bg-blue-500/10',
  emerald: 'text-emerald-400 hover:bg-emerald-500/10',
  cyan: 'text-cyan-400 hover:bg-cyan-500/10',
  violet: 'text-violet-400 hover:bg-violet-500/10',
}

type AdvancedInteractionBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode
  label: string
  accent?: AdvancedInteractionAccent
  tooltip?: string
}

export function AdvancedInteractionBtn({
  icon,
  label,
  accent = 'emerald',
  tooltip,
  className = '',
  disabled,
  onBlur,
  onFocus,
  onMouseEnter,
  onMouseLeave,
  ...props
}: AdvancedInteractionBtnProps) {
  const tooltipText = tooltip || label
  const tooltipId = useId()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null)

  const updateTooltipPosition = useCallback(() => {
    const button = buttonRef.current
    if (!button || typeof window === 'undefined') return
    const rect = button.getBoundingClientRect()
    const gap = 8
    const tooltipApproxHeight = 30
    const placement = rect.bottom + gap + tooltipApproxHeight <= window.innerHeight ? 'bottom' : 'top'
    const top = placement === 'bottom'
      ? rect.bottom + gap
      : Math.max(8, rect.top - gap)
    const left = Math.min(Math.max(rect.left + rect.width / 2, 12), window.innerWidth - 12)
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

  const showTooltip = useCallback(() => {
    if (disabled) return
    updateTooltipPosition()
    setTooltipOpen(true)
  }, [disabled, updateTooltipPosition])

  const hideTooltip = useCallback(() => {
    setTooltipOpen(false)
  }, [])

  return (
    <>
      <button
        {...props}
        ref={buttonRef}
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
        className={`group/advanced-interaction relative inline-flex h-7 w-full min-w-0 items-center justify-center rounded-md bg-transparent px-0 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-not-allowed disabled:opacity-40 ${ACCENT_CLASS[accent]} ${className}`}
      >
        <span className="inline-flex h-4 w-4 items-center justify-center transition-transform duration-300 ease-out group-hover/advanced-interaction:scale-110 group-focus-visible/advanced-interaction:scale-110">
          {icon}
        </span>
      </button>
      {tooltipOpen && tooltipPos && typeof document !== 'undefined'
        ? createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            className="pointer-events-none fixed z-[1000] max-w-[220px] whitespace-nowrap rounded-md border border-[var(--border-color)] bg-[var(--modal-bg)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] opacity-100 shadow-xl"
            style={{
              left: tooltipPos.left,
              top: tooltipPos.top,
              transform: tooltipPos.placement === 'bottom'
                ? 'translate(-50%, 0)'
                : 'translate(-50%, -100%)',
            }}
          >
            {tooltipText}
          </div>,
          document.body,
        )
        : null}
    </>
  )
}
