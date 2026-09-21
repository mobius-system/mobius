import { AlertTriangle } from 'lucide-react'

/*
 * Shared error banner, styled like the ChatArea one (rounded-xl red banner).
 * Replaces the bare text-red-400 snippets that used to be scattered around.
 */
// 统一错误横幅, 与 ChatArea 同款 rounded-xl 红色 banner
// The shared error banner, matching ChatArea's rounded-xl red style
export function ErrBanner({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  if (!children) return null
  return (
    <div className={`mb-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-[12px] text-red-300 bg-red-500/10 border-red-500/25 ${className}`}>
      <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" strokeWidth={1.75} />
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{children}</div>
    </div>
  )
}
