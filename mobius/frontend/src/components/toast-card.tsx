import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export type ToastTone = 'success' | 'error' | 'info'

export interface ToastCardProps {
  /** 左侧图标方块底色按 tone 自动配, 图标本身由调用方传入 */
  tone?: ToastTone
  icon: ReactNode
  title: ReactNode
  /** 标题下一行小字(任务名/原因等), 自动截断 */
  subtitle?: ReactNode
  /** 提供则整卡可点击触发(关闭按钮区域已 stopPropagation, 不会误触) */
  onAction?: () => void
  /** 配合 onAction 显示的右侧操作文字, 如"查看" */
  actionLabel?: string
  /** 关闭回调; 不传则不渲染关闭按钮 */
  onClose?: () => void
  className?: string
}

const TONE_ACCENT: Record<ToastTone, string> = {
  success: 'bg-emerald-500/12 text-emerald-400',
  error: 'bg-red-500/12 text-red-400',
  info: 'bg-sky-500/12 text-sky-400',
}

/**
 * 右上角全局通知卡片。抽自原 SelfIterationToast, 作为网页端"后台任务完成提醒"的统一外观。
 *
 * - 定位/层级与原 SelfIterationToast 完全一致: fixed right-4 top-4, z-[10020], 主题色变量。
 * - 不做堆叠: 多条同时出现时由调用方控制只展示一条(当前场景自迭代完成 vs 任务完成基本不同时)。
 * - 无障碍: role=status + aria-live(error=assertive, 其余=polite), 屏幕阅读器会播报。
 */
export function ToastCard({
  tone = 'info',
  icon,
  title,
  subtitle,
  onAction,
  actionLabel,
  onClose,
  className = '',
}: ToastCardProps) {
  const clickable = typeof onAction === 'function'
  return (
    <div
      role="status"
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      className={`fixed right-4 top-4 z-[10020] flex w-[360px] max-w-[calc(100vw-32px)] items-center gap-3 rounded-lg border px-4 py-3 shadow-2xl backdrop-blur${clickable ? ' cursor-pointer' : ''}${className ? ` ${className}` : ''}`}
      style={{
        color: 'var(--text-primary)',
        background: 'color-mix(in srgb, var(--modal-bg) 92%, transparent)',
        borderColor: 'var(--border-color-strong)',
      }}
      onClick={clickable ? onAction : undefined}
    >
      <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${TONE_ACCENT[tone]}`}>
        {icon}
      </div>
      <div className="min-w-0 flex-1 text-sm font-medium leading-5">
        <div className="truncate">{title}</div>
        {subtitle ? <div className="truncate text-xs font-normal opacity-80">{subtitle}</div> : null}
      </div>
      {clickable && actionLabel ? (
        <span className="flex-shrink-0 text-xs font-semibold text-emerald-400">{actionLabel}</span>
      ) : null}
      {typeof onClose === 'function' ? (
        <button
          type="button"
          aria-label="关闭通知"
          title="关闭通知"
          onClick={(e) => { e.stopPropagation(); onClose() }}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-muted)' }}
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  )
}

export default ToastCard
