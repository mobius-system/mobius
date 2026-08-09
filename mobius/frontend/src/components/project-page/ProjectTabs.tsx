import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'

type ProjectTabListProps = {
  children: ReactNode
  className?: string
  style?: CSSProperties
  vertical?: boolean
}

type ProjectTabButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean
  activeClassName?: string
  inactiveColor?: string
}

export function ProjectTabList({ children, className = '', style, vertical = false }: ProjectTabListProps) {
  return (
    <div
      className={
        vertical
          ? `flex flex-col items-stretch gap-1 [&_button]:w-full [&_button]:justify-start ${className}`
          : `flex items-center gap-1 rounded-lg border p-1 ${className}`
      }
      style={
        vertical
          ? style
          : {
              borderColor: 'var(--border-color)',
              background: 'var(--bg-primary)',
              ...style,
            }
      }
    >
      {children}
    </div>
  )
}

export function ProjectTabButton({
  active = false,
  activeClassName = 'bg-blue-500/15 text-blue-400',
  inactiveColor = 'var(--text-muted)',
  className = '',
  style,
  children,
  type = 'button',
  ...props
}: ProjectTabButtonProps) {
  return (
    <button
      type={type}
      className={`h-7 px-3 rounded-md text-[12px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active ? activeClassName : 'hover:bg-[var(--bg-card-hover)]'
      } ${className}`}
      style={active ? style : { color: inactiveColor, ...style }}
      {...props}
    >
      {children}
    </button>
  )
}
