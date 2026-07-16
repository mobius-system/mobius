import type { ButtonHTMLAttributes, ReactNode } from 'react'

// 统一的主操作按钮: 把此前散落在 UserPage / ProjectItemsPanel / IssuePage 等页面里
// 重复手写的 "btn-primary + rounded-lg + flex + 图标 + 文案" 组合收口成一个组件,
// 方便复用并保证视觉一致 (新建项目 / 新建 Issue / 新会话 等同类按钮).
//
// 统一尺寸与样式: 所有主操作按钮一律 h-8 px-3 text-[12px] gap-1.5, 图标建议 w-3.5 h-3.5,
// 不带额外阴影 / 字重; flex-shrink-0 防止在 flex 行(侧栏/卡片头)里被压缩. 视觉基底
// .btn-primary (见 index.css) 已自带 opacity/transform 过渡与 :disabled 态
// (opacity 0.35 + not-allowed), 故不再每处重复 disabled:opacity-* / disabled:cursor-*.
//
// 图标 icon 由调用方传入; 标签后的额外内容 (如新会话的 Sparkles 徽标) 直接放在 children 里,
// 按钮的 gap 会自动均分间距.
export type PrimaryActionButtonProps = {
  /** 左侧图标, 一般传 lucide 图标或内联 svg (建议 w-3.5 h-3.5) */
  icon?: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>

export function PrimaryActionButton({
  icon,
  className = '',
  children,
  ...rest
}: PrimaryActionButtonProps) {
  return (
    <button
      className={`btn-primary rounded-lg flex flex-shrink-0 items-center transition-colors h-7 px-3 text-[12px] gap-1.5 ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
