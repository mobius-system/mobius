import type { ButtonHTMLAttributes, ReactNode } from 'react'

type AdvancedInteractionAccent = 'blue' | 'emerald' | 'cyan' | 'violet'

const ACCENT_CLASS: Record<AdvancedInteractionAccent, string> = {
  blue: 'text-blue-400 hover:bg-blue-500/10 hover:border-blue-500/35 focus-visible:border-blue-500/45',
  emerald: 'text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-500/35 focus-visible:border-emerald-500/45',
  cyan: 'text-cyan-400 hover:bg-cyan-500/10 hover:border-cyan-500/35 focus-visible:border-cyan-500/45',
  violet: 'text-violet-400 hover:bg-violet-500/10 hover:border-violet-500/35 focus-visible:border-violet-500/45',
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
  ...props
}: AdvancedInteractionBtnProps) {
  const tooltipText = tooltip || label

  return (
    <button
      {...props}
      type={props.type || 'button'}
      disabled={disabled}
      aria-label={label}
      title={tooltipText}
      className={`group/advanced-interaction relative inline-flex h-10 w-full min-w-0 items-center justify-center rounded-lg border border-[var(--border-color-strong)] bg-transparent px-0 transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 disabled:cursor-not-allowed disabled:opacity-40 ${ACCENT_CLASS[accent]} ${className}`}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] z-30 max-w-[180px] -translate-x-1/2 -translate-y-1 scale-95 whitespace-nowrap rounded-md border border-[var(--border-color)] bg-[var(--modal-bg)] px-2 py-1 text-[11px] font-medium text-[var(--text-primary)] opacity-0 shadow-lg transition-all duration-150 group-hover/advanced-interaction:translate-y-0 group-hover/advanced-interaction:scale-100 group-hover/advanced-interaction:opacity-100 group-focus-visible/advanced-interaction:translate-y-0 group-focus-visible/advanced-interaction:scale-100 group-focus-visible/advanced-interaction:opacity-100"
      >
        {label}
      </span>
      <span className="inline-flex h-5 w-5 items-center justify-center transition-transform duration-200 group-hover/advanced-interaction:-translate-y-0.5 group-hover/advanced-interaction:rotate-[-8deg] group-hover/advanced-interaction:scale-110 group-focus-visible/advanced-interaction:-translate-y-0.5 group-focus-visible/advanced-interaction:rotate-[-8deg] group-focus-visible/advanced-interaction:scale-110">
        {icon}
      </span>
    </button>
  )
}
