import { Lock } from 'lucide-react'
import { useStore } from '../store'

// 临时措施 (2026-10-13) 的封禁页: 普通用户打开小莫时看到的唯一界面.
// 背景见 services/normal-user-access.ts — 后端开关 NORMAL_USER_ACCESS_BLOCKED = true 时生效.
// 页面上不放任何通往应用内部的入口 (项目/会话/拓展/设置全隐藏), 只留退出登录.
export function NormalUserAccessBlocked() {
  const logout = useStore((s) => s.logout)
  const branding = useStore((s) => s.branding)
  const systemName = branding.systemNameZh || branding.systemNameEn || '小莫'

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 select-none"
      style={{ background: 'var(--bg-secondary)' }}
    >
      <div
        className="w-full max-w-[460px] rounded-2xl border px-6 py-7 text-center"
        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}
      >
        <span
          className="mb-4 inline-grid h-11 w-11 place-items-center rounded-xl"
          style={{ background: 'color-mix(in srgb, var(--accent-primary) 16%, transparent)', color: 'var(--accent-primary)' }}
        >
          <Lock className="h-5 w-5" />
        </span>
        <h1 className="text-[length:var(--fs-2xl)] font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          普通用户访问已暂时关闭
        </h1>
        <p className="text-[length:var(--fs-lg)] leading-6 mb-1" style={{ color: 'var(--text-muted)' }}>
          {systemName} 正在做一次安全加固，期间普通用户暂时无法登录和使用。
        </p>
        <p className="text-[length:var(--fs-md)] leading-5" style={{ color: 'var(--text-muted)' }}>
          这是临时措施，恢复后会立即放开，无需你做任何操作。
        </p>
        <button
          type="button"
          onClick={logout}
          className="mt-6 h-9 px-4 rounded-lg border text-[length:var(--fs-md)] transition-colors hover:bg-[var(--bg-hover)]"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}
        >
          退出登录
        </button>
      </div>
    </div>
  )
}
