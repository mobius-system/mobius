export type ProjectCardBorderThemeId =
  | 'auto'
  | 'neutral'
  | 'agentjet-gold'
  | 'agentjet-cyan'
  | 'latex-paper'
  | 'latex-violet'
  | 'emerald-copper'

export type ProjectCardBorderTheme = {
  id: Exclude<ProjectCardBorderThemeId, 'auto'>
  label: string
  description: string
  swatches: [string, string, string]
  background: string
  borderColor: string
  headerBorderColor: string
  hoverBorderColor: string
  accentColor: string
  iconColor: string
  shadow: string
  hoverShadow: string
}

export type ProjectCardBorderThemeOption = {
  id: ProjectCardBorderThemeId
  label: string
  description: string
  swatches: [string, string, string]
}

export const PROJECT_CARD_BORDER_THEME_IDS: ProjectCardBorderThemeId[] = [
  'auto',
  'neutral',
  'agentjet-gold',
  'agentjet-cyan',
  'latex-paper',
  'latex-violet',
  'emerald-copper',
]

const NEUTRAL_THEME: ProjectCardBorderTheme = {
  id: 'neutral',
  label: '默认蓝灰',
  description: '沿用当前项目卡片的克制边框。',
  swatches: ['#111827', '#60a5fa', '#94a3b8'],
  background: 'var(--bg-primary)',
  borderColor: 'var(--border-color)',
  headerBorderColor: 'var(--border-color)',
  hoverBorderColor: 'rgba(59,130,246,0.30)',
  accentColor: '#60a5fa',
  iconColor: '#60a5fa',
  shadow: 'none',
  hoverShadow: 'none',
}

const THEMES: Record<Exclude<ProjectCardBorderThemeId, 'auto'>, ProjectCardBorderTheme> = {
  neutral: NEUTRAL_THEME,
  'agentjet-gold': {
    id: 'agentjet-gold',
    label: 'AgentJet 金墨',
    description: '石墨底色配香槟金边，适合核心项目。',
    swatches: ['#111827', '#f4c95d', '#64748b'],
    background: 'linear-gradient(135deg, rgba(244,201,93,0.085) 0%, rgba(148,163,184,0.035) 46%, var(--bg-primary) 100%)',
    borderColor: 'rgba(244,201,93,0.58)',
    headerBorderColor: 'rgba(244,201,93,0.30)',
    hoverBorderColor: 'rgba(250,204,21,0.78)',
    accentColor: '#facc15',
    iconColor: '#f4c95d',
    shadow: '0 0 0 1px rgba(244,201,93,0.08) inset',
    hoverShadow: '0 14px 34px rgba(244,201,93,0.10), 0 0 0 1px rgba(244,201,93,0.10) inset',
  },
  'agentjet-cyan': {
    id: 'agentjet-cyan',
    label: 'AgentJet 冷焰',
    description: '喷气蓝青配靛紫暗面，技术感更强。',
    swatches: ['#0f172a', '#22d3ee', '#6366f1'],
    background: 'linear-gradient(135deg, rgba(34,211,238,0.080) 0%, rgba(99,102,241,0.070) 44%, var(--bg-primary) 100%)',
    borderColor: 'rgba(34,211,238,0.52)',
    headerBorderColor: 'rgba(99,102,241,0.30)',
    hoverBorderColor: 'rgba(34,211,238,0.76)',
    accentColor: '#22d3ee',
    iconColor: '#22d3ee',
    shadow: '0 0 0 1px rgba(34,211,238,0.07) inset',
    hoverShadow: '0 14px 34px rgba(34,211,238,0.10), 0 0 0 1px rgba(99,102,241,0.10) inset',
  },
  'latex-paper': {
    id: 'latex-paper',
    label: 'LaTeX 纸白',
    description: '论文纸白、蓝色批注和一点琥珀高亮。',
    swatches: ['#f8fafc', '#2563eb', '#f59e0b'],
    background: 'linear-gradient(135deg, rgba(248,250,252,0.105) 0%, rgba(37,99,235,0.050) 48%, var(--bg-primary) 100%)',
    borderColor: 'rgba(226,232,240,0.46)',
    headerBorderColor: 'rgba(37,99,235,0.22)',
    hoverBorderColor: 'rgba(96,165,250,0.72)',
    accentColor: '#60a5fa',
    iconColor: '#93c5fd',
    shadow: '0 0 0 1px rgba(226,232,240,0.06) inset',
    hoverShadow: '0 14px 34px rgba(37,99,235,0.08), 0 0 0 1px rgba(226,232,240,0.10) inset',
  },
  'latex-violet': {
    id: 'latex-violet',
    label: '学术紫蓝',
    description: '紫色章节感配青色注释，适合文档类项目。',
    swatches: ['#1e1b4b', '#a78bfa', '#38bdf8'],
    background: 'linear-gradient(135deg, rgba(167,139,250,0.095) 0%, rgba(56,189,248,0.052) 52%, var(--bg-primary) 100%)',
    borderColor: 'rgba(167,139,250,0.52)',
    headerBorderColor: 'rgba(56,189,248,0.24)',
    hoverBorderColor: 'rgba(196,181,253,0.76)',
    accentColor: '#c4b5fd',
    iconColor: '#a78bfa',
    shadow: '0 0 0 1px rgba(167,139,250,0.07) inset',
    hoverShadow: '0 14px 34px rgba(167,139,250,0.10), 0 0 0 1px rgba(56,189,248,0.08) inset',
  },
  'emerald-copper': {
    id: 'emerald-copper',
    label: '代码绿铜',
    description: '终端绿配铜色边缘，强调工程与产物感。',
    swatches: ['#052e2b', '#34d399', '#f59e0b'],
    background: 'linear-gradient(135deg, rgba(52,211,153,0.075) 0%, rgba(245,158,11,0.055) 52%, var(--bg-primary) 100%)',
    borderColor: 'rgba(52,211,153,0.46)',
    headerBorderColor: 'rgba(245,158,11,0.24)',
    hoverBorderColor: 'rgba(52,211,153,0.72)',
    accentColor: '#34d399',
    iconColor: '#34d399',
    shadow: '0 0 0 1px rgba(52,211,153,0.06) inset',
    hoverShadow: '0 14px 34px rgba(52,211,153,0.09), 0 0 0 1px rgba(245,158,11,0.08) inset',
  },
}

export const PROJECT_CARD_BORDER_THEME_OPTIONS: ProjectCardBorderThemeOption[] = [
  {
    id: 'auto',
    label: '自动',
    description: '自迭代项目保留金边，其他项目使用默认边框。',
    swatches: ['#111827', '#f4c95d', '#60a5fa'],
  },
  ...PROJECT_CARD_BORDER_THEME_IDS
    .filter((id): id is Exclude<ProjectCardBorderThemeId, 'auto'> => id !== 'auto')
    .map(id => ({
      id,
      label: THEMES[id].label,
      description: THEMES[id].description,
      swatches: THEMES[id].swatches,
    })),
]

export function normalizeProjectCardBorderThemeId(value: unknown): ProjectCardBorderThemeId {
  const id = typeof value === 'string' ? value.trim() : ''
  return PROJECT_CARD_BORDER_THEME_IDS.includes(id as ProjectCardBorderThemeId)
    ? id as ProjectCardBorderThemeId
    : 'auto'
}

export function projectCardBorderThemeById(id: ProjectCardBorderThemeId): ProjectCardBorderTheme {
  return id === 'auto' ? NEUTRAL_THEME : THEMES[id] || NEUTRAL_THEME
}

export function effectiveProjectCardBorderTheme(project: any): ProjectCardBorderTheme {
  const id = normalizeProjectCardBorderThemeId(project?.card_border_theme)
  if (id === 'auto') return project?.is_self_develop ? THEMES['agentjet-gold'] : NEUTRAL_THEME
  return projectCardBorderThemeById(id)
}

export function projectCardThemeStyle(theme: ProjectCardBorderTheme): Record<string, string> {
  return {
    '--project-card-border': theme.borderColor,
    '--project-card-hover-border': theme.hoverBorderColor,
    '--project-card-accent': theme.accentColor,
    '--project-card-shadow': theme.shadow,
    '--project-card-hover-shadow': theme.hoverShadow,
    background: theme.background,
    borderColor: theme.borderColor,
    boxShadow: theme.shadow,
  }
}

export function projectCardHeaderStyle(theme: ProjectCardBorderTheme): Record<string, string> {
  return {
    borderColor: theme.headerBorderColor,
  }
}
