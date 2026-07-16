import {
  PROJECT_CARD_BORDER_THEME_OPTIONS,
  effectiveProjectCardBorderTheme,
  normalizeProjectCardBorderThemeId,
  projectCardBorderThemeById,
  type ProjectCardBorderThemeId,
} from '../services/project-card-themes'

type Props = {
  value: string | null | undefined
  disabled?: boolean
  project?: any
  onChange: (value: ProjectCardBorderThemeId) => void
}

export function ProjectCardThemePicker({ value, disabled = false, project, onChange }: Props) {
  const current = normalizeProjectCardBorderThemeId(value)
  return (
    <div>
      <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>项目卡片边框主题</label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {PROJECT_CARD_BORDER_THEME_OPTIONS.map((option) => {
          const active = current === option.id
          const preview = option.id === 'auto'
            ? effectiveProjectCardBorderTheme({ ...(project || {}), card_border_theme: 'auto' })
            : projectCardBorderThemeById(option.id)
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option.id)}
              className="min-w-0 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              style={{
                background: active ? preview.background : 'var(--input-bg)',
                borderColor: active ? preview.borderColor : 'var(--input-border)',
                boxShadow: active ? preview.shadow : 'none',
              }}
              title={option.description}
            >
              <div className="flex items-center gap-2">
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  {option.swatches.map((color) => (
                    <span
                      key={color}
                      className="h-3.5 w-3.5 rounded-full border"
                      style={{ background: color, borderColor: 'rgba(255,255,255,0.24)' }}
                    />
                  ))}
                  <span className="truncate text-[12px] font-medium" style={{ color: active ? preview.accentColor : 'var(--text-primary)' }}>
                    {option.label}
                  </span>
                </span>
                {active && (
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                    style={{ color: preview.accentColor, background: 'rgba(255,255,255,0.055)' }}>
                    当前
                  </span>
                )}
              </div>
              <p className="mt-1 line-clamp-2 text-[11px] leading-4" style={{ color: 'var(--text-muted)' }}>
                {option.description}
              </p>
            </button>
          )
        })}
      </div>
    </div>
  )
}
