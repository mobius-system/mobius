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
  // 顶栏统一"无边框 + hover 高亮"风格: 紧凑, 不像分隔的卡片; hover/active 用背景表态。
  // 旧版每个按钮独立带 rounded-lg + border 在窄顶栏下显得割裂; 用户要求移除边框使之紧凑美观。
  return cx(
    'mobius-topnav-action inline-flex h-7 shrink-0 items-center rounded-md transition-colors',
    iconOnly ? 'w-7 justify-center px-0' : 'gap-1 px-1.5',
    interactive && 'hover:bg-[var(--bg-card-hover)] active:bg-[var(--bg-active)]',
    className,
  )
}

export function topNavActionStyle(style?: CSSProperties): CSSProperties {
  // 默认色仅继承自 --text-secondary; 不再写死 borderColor, 允许调用方用透传 style 自定义.
  return {
    color: 'var(--text-secondary)',
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
