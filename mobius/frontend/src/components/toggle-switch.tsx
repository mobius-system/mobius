import { Loader2 } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

// 统一的自定义开关: 用 <button role="switch"> 实现, 不再依赖 sr-only 隐藏复选框.
// 历史上这类开关是 <label><input class="sr-only"><开关span>, sr-only 的 position:absolute
// 会引入两个 bug: 点击获焦时 scrollIntoView 把位置误算到文档原点导致整页上跳; clip 裁掉焦点环
// 导致键盘焦点不可见. 改用 button (文档流内元素) 从源头消除: 获焦落在可视位置不跳屏、自带原生
// focus ring、Space/Enter 原生切换、disabled 原生禁用, 语义用 role=switch + aria-checked.
export type ToggleSwitchProps = {
  checked: boolean
  onChange: (next: boolean) => void
  /** 加载中: 开关右侧显示旋转图标, 且期间忽略切换 (不置 disabled, 故不变暗, 与卡片历史行为一致) */
  loading?: boolean
  /** 开关视觉位置: start=开关在前(单行开关, 默认); end=开关在末尾(卡片型, 配 justify-between) */
  switchPosition?: 'start' | 'end'
  /** 开启时轨道颜色, 默认 #3b82f6 (蓝); 卡片型开关可传历史色如 #10b981(绿)/#0ea5e9(天蓝) 保持原视觉 */
  activeColor?: string
  children?: ReactNode
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'type' | 'role' | 'aria-checked'>

export function ToggleSwitch({
  checked,
  onChange,
  loading = false,
  switchPosition = 'start',
  activeColor = '#3b82f6',
  disabled,
  className = '',
  children,
  ...rest
}: ToggleSwitchProps) {
  const switchVisual = (
    <span
      aria-hidden="true"
      className="relative inline-flex h-5 w-9 flex-shrink-0 rounded-full transition-colors"
      style={{ background: checked ? activeColor : 'var(--input-border)' }}
    >
      <span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform"
        style={{ transform: checked ? 'translateX(18px)' : 'translateX(2px)' }}
      />
      {loading && (
        <Loader2 className="absolute -right-5 top-0.5 h-4 w-4 animate-spin" style={{ color: 'var(--text-muted)' }} />
      )}
    </span>
  )

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      // disabled 按钮不会触发 onClick, 这里再挡一层 loading, 保证保存中不被切换
      onClick={() => { const next = !checked; console.debug('[diag] ToggleSwitch click', { checked, next, disabled, loading }); if (!loading) onChange(next) }}
      className={`select-none text-left ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${className}`}
      {...rest}
    >
      {switchPosition === 'end' ? (
        <>{children}{switchVisual}</>
      ) : (
        <>{switchVisual}{children}</>
      )}
    </button>
  )
}
