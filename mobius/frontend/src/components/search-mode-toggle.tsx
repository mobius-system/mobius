import { FileSearch, Zap } from 'lucide-react'

export type SearchMode = 'deep' | 'quick'

// 搜索模式切换: 与「搜索范围」同款的胶囊分段控件 (圆角描边容器 + 内嵌圆角按钮, 选中态蓝底蓝字)。
export function SearchModeToggle({
  mode,
  onChange,
  compact = false,
}: {
  mode: SearchMode
  onChange: (mode: SearchMode) => void
  compact?: boolean
}) {
  const isQuick = mode === 'quick'
  const seg = 'flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-[length:var(--fs-sm)] font-medium transition-colors'
  const label = `whitespace-nowrap ${compact ? 'hidden min-[520px]:inline' : ''}`
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1 rounded-lg border p-0.5"
      style={{ borderColor: 'var(--border-color)', background: 'var(--bg-card)' }}>
      <button type="button" onClick={() => onChange('quick')} title="快速搜索：仅匹配名称与描述"
        aria-pressed={isQuick}
        className={`${seg} ${isQuick ? 'bg-blue-500/15 text-blue-400' : 'hover:bg-[var(--bg-card-hover)]'}`}
        style={isQuick ? undefined : { color: 'var(--text-muted)' }}>
        <Zap className="h-3 w-3 flex-shrink-0" />
        <span className={label}>快速搜索</span>
      </button>
      <button type="button" onClick={() => onChange('deep')} title="深度搜索：扫描会话内容"
        aria-pressed={!isQuick}
        className={`${seg} ${!isQuick ? 'bg-blue-500/15 text-blue-400' : 'hover:bg-[var(--bg-card-hover)]'}`}
        style={!isQuick ? undefined : { color: 'var(--text-muted)' }}>
        <FileSearch className="h-3 w-3 flex-shrink-0" />
        <span className={label}>深度搜索</span>
      </button>
    </div>
  )
}
