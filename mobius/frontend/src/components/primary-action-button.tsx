import type { ButtonHTMLAttributes, ReactNode } from 'react'

// 统一的主操作按钮: 把此前散落在 UserPage / ProjectItemsPanel / IssuePage 等页面里
// 重复手写的 "btn-primary + rounded-lg + flex + 图标 + 文案" 组合收口成一个组件,
// 方便复用并保证视觉一致 (新建项目 / 新建 Issue / 新会话 等同类按钮).
//
// 视觉基底 .btn-primary (见 index.css) 已自带 opacity/transform 过渡与 :disabled 态
// (opacity 0.35 + not-allowed), 这里只补尺寸 / 圆角 / 布局 / 颜色过渡, 不再每处重复
// disabled:opacity-* / disabled:cursor-*.
//
// 用法:
//   <PrimaryActionButton size="md" icon={<Plus .../>} onClick={...}>新建项目</PrimaryActionButton>
//   <PrimaryActionButton size="sm" icon={<Plus .../>} disabled={...} onClick={...}>新建 Issue</PrimaryActionButton>
//   <PrimaryActionButton size="sm" icon={<MessageSquarePlus .../>} className="font-semibold shadow-md shadow-black/10"
//     onClick={...}>
//     <span className="whitespace-nowrap">新会话</span>
//     <span className="...badge..."><Sparkles .../></span>
//   </PrimaryActionButton>
//
// 图标 icon 由调用方传入并自行控制尺寸 / flex-shrink-0; 标签后的额外内容 (如新会话的
// Sparkles 徽标) 直接放在 children 里, 按钮的 gap 会自动均分间距.
export type PrimaryActionButtonProps = {
  /** 左侧图标, 一般传 lucide 图标或内联 svg (自行带尺寸 + flex-shrink-0) */
  icon?: ReactNode
  /** 尺寸: md=h-9 px-4 text-[13px] gap-2 (主区主操作, 如新建项目); sm=h-8 px-3 text-[12px] gap-1.5 (列表/侧栏, 如新建 Issue/新会话) */
  size?: 'md' | 'sm'
} & ButtonHTMLAttributes<HTMLButtonElement>

export function PrimaryActionButton({
  icon,
  size = 'md',
  className = '',
  children,
  ...rest
}: PrimaryActionButtonProps) {
  const sizeCls = size === 'md' ? 'h-9 px-4 text-[13px] gap-2' : 'h-8 px-3 text-[12px] gap-1.5'
  return (
    <button
      className={`btn-primary rounded-lg flex items-center transition-colors ${sizeCls} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}
