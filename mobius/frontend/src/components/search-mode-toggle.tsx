export type SearchMode = 'deep' | 'quick'

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
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isQuick}
      aria-label={`搜索模式：${isQuick ? '快速搜索' : '深度搜索'}`}
      title="切换搜索模式"
      onClick={() => onChange(isQuick ? 'deep' : 'quick')}
      className={`inline-flex h-7 max-w-full shrink-0 items-center gap-1.5 overflow-hidden rounded-full border text-[11px] transition-colors ${compact ? 'px-2' : 'px-2.5'}`}
      style={{
        color: isQuick ? '#fbbf24' : 'var(--text-secondary)',
        borderColor: isQuick ? 'rgba(251,191,36,0.5)' : 'var(--border-color)',
        background: isQuick ? 'rgba(245,158,11,0.10)' : 'rgba(148,163,184,0.06)',
      }}
    >
      <span className={`font-medium whitespace-nowrap ${compact ? 'hidden min-[520px]:inline' : ''}`}>{isQuick ? '快速搜索' : '深度搜索'}</span>
      <span className={`relative h-3.5 w-6 shrink-0 overflow-hidden rounded-full transition-colors ${isQuick ? 'bg-amber-400/80' : 'bg-slate-500/60'}`}>
        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow-sm transition-transform ${isQuick ? 'translate-x-3' : 'translate-x-0.5'}`} />
      </span>
    </button>
  )
}
