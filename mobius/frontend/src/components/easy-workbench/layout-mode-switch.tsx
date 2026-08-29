import { LayoutPanelTop, Menu } from 'lucide-react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../../store'
import { buildNormalModeTargetUrl, setLayoutMode, useLayoutMode, type LayoutMode } from '../../services/layout-mode'
import { homePath, sessionPath } from '../../services/easy-workbench/workbench-navigation'

const MODE_OPTIONS: Array<{
  mode: LayoutMode
  label: string
  icon: typeof Menu
}> = [
  { mode: 'easy_mode', label: '简易', icon: Menu },
  { mode: 'normal_mode', label: '常规', icon: LayoutPanelTop },
]

export function LayoutModeSwitch({
  variant = 'segmented',
  onSelect,
  testId,
  tourId,
}: {
  variant?: 'segmented' | 'menu-item'
  onSelect?: () => void
  testId?: string
  tourId?: string
} = {}) {
  const { user, currentProject, currentIssue, currentResearch, currentSession } = useStore()
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const layoutMode = useLayoutMode()

  const switchMode = (targetMode: LayoutMode) => {
    if (layoutMode === targetMode) return

    const search = new URLSearchParams(location.search)
    const routeSessionId = params.session || search.get('session')
    const sessionContext = !routeSessionId || currentSession?.session_id === routeSessionId
      ? currentSession
      : null
    const userId = params.user || sessionContext?.user_id || user?.id || ''
    const sessionId = routeSessionId || currentSession?.session_id || null

    setLayoutMode(targetMode)
    if (targetMode === 'normal_mode') {
      const researchId = params.research || sessionContext?.research_id || currentResearch?.id
      navigate(buildNormalModeTargetUrl({
        user: userId,
        projectId: params.project || sessionContext?.project_id || search.get('project') || currentProject?.id,
        issueId: params.issue || sessionContext?.issue_id || currentIssue?.id,
        researchId,
        scopeType: sessionContext?.scope_type === 'research' || researchId ? 'research' : 'issue',
        sessionId,
      }))
      return
    }

    navigate(sessionId ? sessionPath(userId, sessionId) : homePath(userId))
  }

  if (variant === 'menu-item') {
    const targetMode: LayoutMode = layoutMode === 'easy_mode' ? 'normal_mode' : 'easy_mode'
    const target = MODE_OPTIONS.find(option => option.mode === targetMode)!
    const Icon = target.icon
    return (
      <button
        type="button"
        role="menuitem"
        data-testid={testId || 'layout-mode-switch'}
        data-tour={tourId}
        className="workbench-menu-item"
        onClick={() => {
          onSelect?.()
          switchMode(targetMode)
        }}
      >
        <Icon aria-hidden="true" />
        <span>切换到{target.label}模式</span>
      </button>
    )
  }

  return (
    <div
      role="group"
      aria-label="界面模式"
      data-testid="layout-mode-switch"
      className="inline-flex h-8 flex-shrink-0 items-center rounded-md border p-0.5"
      style={{ background: 'var(--surface-control)', borderColor: 'var(--border-default)' }}
    >
      {MODE_OPTIONS.map(({ mode, label, icon: Icon }) => {
        const selected = layoutMode === mode
        return (
          <button
            key={mode}
            type="button"
            aria-label={`切换到${label}模式`}
            aria-pressed={selected}
            title={selected ? `${label}模式（当前）` : `切换到${label}模式`}
            onClick={() => switchMode(mode)}
            className="inline-flex h-[26px] min-w-7 items-center justify-center gap-1 rounded-[4px] px-1.5 text-[11px] font-medium transition-colors hover:bg-[var(--surface-control-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-primary)]"
            style={{
              background: selected ? 'var(--surface-active)' : 'transparent',
              color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <span className={selected ? 'hidden sm:inline' : 'hidden xl:inline'}>{label}</span>
          </button>
        )
      })}
    </div>
  )
}
