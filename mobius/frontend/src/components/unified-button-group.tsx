import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type UnifiedButtonKind = 'modal' | 'expand-tab' | 'boolean-switch' | 'normal'
export type UnifiedButtonAccent = 'blue' | 'emerald' | 'cyan' | 'violet' | 'amber'

export type VisibilityOption = { id: string; label: string }
type ButtonGroupContextValue = { hiddenIds: Set<string>; setHidden: (id: string, hidden: boolean) => void }

const ButtonGroupContext = createContext<ButtonGroupContextValue | null>(null)

const ACCENT_CLASS: Record<UnifiedButtonAccent, string> = {
  blue: 'text-blue-400 hover:bg-blue-500/10',
  emerald: 'text-emerald-400 hover:bg-emerald-500/10',
  cyan: 'text-cyan-400 hover:bg-cyan-500/10',
  violet: 'text-violet-400 hover:bg-violet-500/10',
  amber: 'text-amber-400 hover:bg-amber-500/10',
}

export function UnifiedButtonGroup({ className = '', visibilityStorageKey, onVisibilityChange, children, ...props }: HTMLAttributes<HTMLDivElement> & {
  visibilityStorageKey?: string
  onVisibilityChange?: (hiddenIds: Set<string>) => void
}) {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => {
    if (!visibilityStorageKey || typeof window === 'undefined') return new Set()
    try {
      const stored = JSON.parse(window.localStorage.getItem(visibilityStorageKey) || '[]')
      return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [])
    } catch {
      return new Set()
    }
  })

  useEffect(() => {
    if (!visibilityStorageKey || typeof window === 'undefined') return
    window.localStorage.setItem(visibilityStorageKey, JSON.stringify([...hiddenIds]))
  }, [hiddenIds, visibilityStorageKey])

  useEffect(() => {
    onVisibilityChange?.(hiddenIds)
  }, [hiddenIds, onVisibilityChange])

  const setHidden = useCallback((id: string, hidden: boolean) => {
    setHiddenIds((previous) => {
      const next = new Set(previous)
      if (hidden) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  return (
    <ButtonGroupContext.Provider value={{ hiddenIds, setHidden }}>
      <div role="group" className={className} {...props}>{children}</div>
    </ButtonGroupContext.Provider>
  )
}

export function useUnifiedButtonGroup() {
  return useContext(ButtonGroupContext)
}

/** 显示设置 Tab 的内容。触发 Tab 由拥有 active panel 状态的父组件渲染。 */
export function ButtonVisibilitySwitchList({ options, className = '' }: { options: VisibilityOption[]; className?: string }) {
  const context = useContext(ButtonGroupContext)
  if (!context) return null
  return (
    <div className={`space-y-0.5 ${className}`}>
      {options.map((option) => (
        <UnifiedButton
          key={option.id}
          kind="boolean-switch"
          label={option.label}
          checked={!context.hiddenIds.has(option.id)}
          onCheckedChange={(visible) => context.setHidden(option.id, !visible)}
          className="w-full hover:bg-[var(--bg-card-hover)]"
        />
      ))}
    </div>
  )
}

type UnifiedButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role' | 'aria-checked' | 'aria-pressed'> & {
  kind?: UnifiedButtonKind
  buttonId?: string
  icon?: ReactNode
  label: string
  accent?: UnifiedButtonAccent
  tooltip?: string
  displayLabel?: boolean
  /** 视觉标签可比无障碍标签更短，例如“显示设置”保留完整 aria-label。 */
  visibleLabel?: string
  active?: boolean
  checked?: boolean
  onCheckedChange?: (next: boolean) => void
  activeClassName?: string
  inactiveClassName?: string
  buttonClassName?: string
  iconClassName?: string
  badge?: ReactNode
  motion?: 'tilt' | 'breathe' | 'none'
}

/** 统一的弹窗、展开 Tab、布尔开关和普通命令按钮。 */
export const UnifiedButton = forwardRef<HTMLButtonElement, UnifiedButtonProps>(function UnifiedButton({
  kind = 'normal', buttonId, icon, label, visibleLabel, accent = 'emerald', tooltip, displayLabel = false,
  active = false, checked = false, onCheckedChange, activeClassName = '', inactiveClassName = '',
  buttonClassName, iconClassName, badge, motion = 'tilt', className = '', disabled, onClick,
  onBlur, onFocus, onMouseEnter, onMouseLeave, ...props
}, forwardedRef) {
  const group = useContext(ButtonGroupContext)
  const tooltipId = useId()
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null)
  const isTab = kind === 'expand-tab'
  const isSwitch = kind === 'boolean-switch'
  const renderedLabel = visibleLabel || label
  const showTooltip = !!(tooltip || label) && (isTab || !displayLabel) && !isSwitch

  const updateTooltipPosition = useCallback(() => {
    const button = buttonRef.current
    if (!button || typeof window === 'undefined') return
    const rect = button.getBoundingClientRect()
    const margin = 8
    const tip = tooltipRef.current
    const width = tip?.offsetWidth || 0
    const height = tip?.offsetHeight || 30
    const placement = rect.bottom + 8 + height <= window.innerHeight - margin ? 'bottom' : 'top'
    const top = placement === 'bottom' ? Math.min(rect.bottom + 8, window.innerHeight - margin - height) : Math.max(margin, rect.top - 8 - height)
    const center = rect.left + rect.width / 2
    const left = width > 0 ? Math.min(Math.max(center, margin + width / 2), window.innerWidth - margin - width / 2) : center
    setTooltipPos({ left, top, placement })
  }, [])

  useEffect(() => {
    if (!tooltipOpen) return
    updateTooltipPosition()
    window.addEventListener('resize', updateTooltipPosition)
    window.addEventListener('scroll', updateTooltipPosition, true)
    return () => { window.removeEventListener('resize', updateTooltipPosition); window.removeEventListener('scroll', updateTooltipPosition, true) }
  }, [tooltipOpen, updateTooltipPosition])
  useLayoutEffect(() => { if (tooltipOpen && tooltipPos === null) updateTooltipPosition() }, [tooltipOpen, tooltipPos, updateTooltipPosition])

  const setButtonRef = useCallback((node: HTMLButtonElement | null) => {
    buttonRef.current = node
    if (typeof forwardedRef === 'function') forwardedRef(node)
    else if (forwardedRef) forwardedRef.current = node
  }, [forwardedRef])
  const hideTooltip = useCallback(() => { setTooltipOpen(false); setTooltipPos(null) }, [])

  if (buttonId && group?.hiddenIds.has(buttonId)) return null

  const defaultClassName = isTab
    ? `group/unified-button inline-flex h-9 min-w-[62px] flex-none items-center justify-center gap-1.5 overflow-hidden rounded-md border px-2 text-center text-[12px] leading-snug transition-[background-color,border-color,transform,box-shadow] duration-150 hover:-translate-y-px hover:border-[var(--border-color-strong)] hover:bg-[var(--bg-card-hover)] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40 ${ACCENT_CLASS[accent]}`
    : isSwitch
      ? 'group/unified-button inline-flex min-h-7 min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40'
      : `group/unified-button relative inline-flex min-w-0 items-center ${displayLabel ? 'min-h-9 w-full justify-start gap-2 rounded-md px-2 py-1.5 text-left' : 'h-9 w-9 flex-none justify-center rounded-md px-0'} bg-transparent transition-[background-color,border-color,transform,box-shadow] duration-150 hover:-translate-y-px hover:bg-[var(--bg-card-hover)] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-not-allowed disabled:opacity-40 ${ACCENT_CLASS[accent]}`
  const iconMotion = motion === 'breathe'
    ? 'duration-300 ease-out group-hover/unified-button:scale-110 group-focus-visible/unified-button:scale-110'
    : motion === 'tilt'
      ? 'duration-200 group-hover/unified-button:-translate-y-0.5 group-hover/unified-button:rotate-[-8deg] group-hover/unified-button:scale-110 group-focus-visible/unified-button:-translate-y-0.5 group-focus-visible/unified-button:rotate-[-8deg] group-focus-visible/unified-button:scale-110'
      : 'duration-200'

  return (
    <>
      <button
        {...props}
        ref={setButtonRef}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-describedby={showTooltip && tooltipOpen ? tooltipId : undefined}
        {...(kind === 'modal' ? { 'aria-haspopup': 'dialog' as const } : {})}
        {...(isTab ? { 'aria-pressed': active, 'aria-expanded': active } : {})}
        {...(isSwitch ? { role: 'switch', 'aria-checked': checked } : {})}
        onMouseEnter={(event) => { onMouseEnter?.(event); if (showTooltip) setTooltipOpen(true) }}
        onMouseLeave={(event) => { onMouseLeave?.(event); hideTooltip() }}
        onFocus={(event) => { onFocus?.(event); if (showTooltip) setTooltipOpen(true) }}
        onBlur={(event) => { onBlur?.(event); hideTooltip() }}
        onClick={(event) => { onClick?.(event); if (isSwitch && !event.defaultPrevented) onCheckedChange?.(!checked) }}
        className={`${buttonClassName || defaultClassName} ${isTab ? (active ? activeClassName : inactiveClassName) : ''} ${className}`}
      >
        {isSwitch ? <><span className="min-w-0 flex-1 truncate">{label}</span><span aria-hidden="true" className="relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors" style={{ background: checked ? 'var(--accent-primary)' : 'var(--input-border)' }}><span className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform" style={{ transform: checked ? 'translateX(18px)' : 'translateX(2px)' }} /></span></> : <>
          {icon && <span className={`inline-flex ${iconClassName || 'h-4 w-4'} flex-shrink-0 items-center justify-center transition-transform ${iconMotion}`}>{icon}</span>}
          {(displayLabel || isTab) && <span className="min-w-0 truncate text-[11px] font-medium leading-4">{renderedLabel}</span>}
          {badge}
        </>}
      </button>
      {showTooltip && tooltipOpen && typeof document !== 'undefined' ? createPortal(
        <div ref={tooltipRef} id={tooltipId} role="tooltip" className="pointer-events-none fixed z-[1000] max-w-[220px] whitespace-nowrap rounded-md border border-[var(--border-color)] bg-[var(--modal-bg)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] shadow-xl" style={tooltipPos ? { left: tooltipPos.left, top: tooltipPos.top, transform: tooltipPos.placement === 'bottom' ? 'translate(-50%, 0)' : 'translate(-50%, -100%)', visibility: 'visible' } : { left: 0, top: 0, visibility: 'hidden' }}>{tooltip || label}</div>, document.body) : null}
    </>
  )
})
