import type { CSSProperties, ElementType, ReactNode } from 'react'

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

export function topNavActionClassName({
  iconOnly = false,
  interactive = true,
  className = '',
}: {
  iconOnly?: boolean
  interactive?: boolean
  className?: string
} = {}) {
  return cx(
    'mobius-topnav-action inline-flex h-7 shrink-0 items-center rounded-lg border transition-colors',
    iconOnly ? 'w-7 justify-center px-0' : 'gap-1.5 px-2',
    interactive && 'hover:bg-[var(--bg-card-hover)]',
    className,
  )
}

export function topNavActionStyle(style?: CSSProperties): CSSProperties {
  return {
    color: 'var(--text-secondary)',
    borderColor: 'var(--border-color)',
    ...style,
  }
}

type TopNavActionElementProps = {
  as?: ElementType
  iconOnly?: boolean
  interactive?: boolean
  className?: string
  style?: CSSProperties
  children?: ReactNode
  [key: string]: any
}

export function TopNavActionElement({
  as: Component = 'button',
  iconOnly = false,
  interactive = true,
  className,
  style,
  children,
  ...props
}: TopNavActionElementProps) {
  return (
    <Component
      {...props}
      className={topNavActionClassName({ iconOnly, interactive, className })}
      style={topNavActionStyle(style)}
    >
      {children}
    </Component>
  )
}
