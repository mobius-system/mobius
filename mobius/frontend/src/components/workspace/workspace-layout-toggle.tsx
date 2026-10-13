import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Check, Columns3, ExternalLink, LayoutTemplate, PanelLeft } from 'lucide-react'
import { useStore } from '../../store'
import { useIsMobile } from '../resizable-panel'
import { TopNavActionElement } from '../top-nav-action'
import { useEditorAvailability } from './use-editor-availability'
import { buildVscodeUrl } from '../project-files'

// =====================================================================
// WorkspaceLayoutToggle - 顶栏「布局模式」切换入口.
// 点击弹出选择窗, 在两种视图间切换, 并附带「在 VSCode 中打开」快捷入口:
//   高效会话模式   - 只有对话区, 专注操控智能体.
//   原生文件编辑器 - 在会话右侧打开文件编辑栏 (与 display-files 卡片唤出的是同一个面板).
//   (在 VSCode 中打开) - 新标签页打开 VSCode Web, 需 bind_path + VSCODE_WEB_URL.
// 「原生文件编辑器」不再切到独立的全页三栏布局: 那个布局的文件树+编辑器与本侧栏完全同源,
// 统一收敛到这一个面板, 避免两种「文件编辑器」重复出现.
// 历史遗留的 code-conversation 布局会在此迁移成「会话 + 文件编辑栏」(见下方 effect).
// UserPage / ProjectPage / 移动端完全不渲染 (代码对话为桌面端能力).
// =====================================================================
type ViewKey = 'session' | 'file-editor'

type ViewOption = {
  key: ViewKey
  label: string
  icon: typeof PanelLeft
  available: boolean
  unavailableReason?: string
}

export function WorkspaceLayoutToggle() {
  const params = useParams()
  const isMobile = useIsMobile()
  const mode = useStore(s => s.workspaceLayoutMode)
  const setMode = useStore(s => s.setWorkspaceLayoutMode)
  const fileEditorOpen = useStore(s => s.fileEditorOpen)
  const setFileEditorOpen = useStore(s => s.setFileEditorOpen)
  const currentSession = useStore(s => s.currentSession)
  const currentProject = useStore(s => s.currentProject)

  const onIssueOrResearch = !!(params.issue || params.research)
  // 只在可能用到时才查询 (顶栏全局渲染, 避免无关页面发请求).
  const { bindPath, vscodeWebUrl, codeServerAllowed } = useEditorAvailability(currentProject?.id, onIssueOrResearch && !!currentSession)

  const [open, setOpen] = useState(false)

  // 旧的全页「原生文件编辑器」布局 (code-conversation) 迁移: 换成会话 + 右侧文件编辑栏.
  // Migrate the legacy full-page code-conversation layout to session + right-side file pane.
  useEffect(() => {
    if (mode === 'code-conversation') {
      setMode('session')
      setFileEditorOpen(true)
    }
  }, [mode, setMode, setFileEditorOpen])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    document.addEventListener('click', close)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // UserPage / ProjectPage / 移动端不显示.
  if (!onIssueOrResearch || isMobile) return null

  // landlock 隔离下普通用户无 code-server (codeServerAllowed=false): 不显示 VSCode 入口,
  // 保持菜单为「高效会话模式 / 原生文件编辑器」两项 — 后者就是用户要的原生文件编辑器.
  const vscodeAvailable = !!bindPath && !!vscodeWebUrl && codeServerAllowed
  const fileEditorAvailable = !!currentSession && !!bindPath

  const options: ViewOption[] = [
    {
      key: 'session',
      label: '高效会话模式',
      icon: PanelLeft,
      available: true,
    },
    {
      key: 'file-editor',
      label: '原生文件编辑器',
      icon: Columns3,
      available: fileEditorAvailable,
      unavailableReason: !currentSession ? '请先选择会话' : '项目未绑定路径',
    },
  ]

  // 两个视图互斥: 会话模式 = 纯对话, 文件编辑器 = 会话 + 右侧文件栏.
  // The two views are mutually exclusive: bare chat vs. chat + right-side file pane.
  const isCurrentView = (key: ViewKey) => mode === 'session' && (key === 'file-editor') === fileEditorOpen

  const chooseView = (key: ViewKey) => {
    setMode('session')
    setFileEditorOpen(key === 'file-editor')
    setOpen(false)
  }

  const renderViewOption = (opt: ViewOption) => {
    const Icon = opt.icon
    const isCurrent = isCurrentView(opt.key)
    return (
      <button
        key={opt.key}
        type="button"
        disabled={!opt.available}
        onClick={() => {
          if (!opt.available) return
          chooseView(opt.key)
        }}
        className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 hover:bg-[var(--bg-hover)]"
        style={{ background: isCurrent ? 'var(--bg-active)' : undefined }}
        title={!opt.available ? opt.unavailableReason : undefined}
      >
        <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: isCurrent ? 'var(--accent-primary)' : 'var(--text-muted)' }} strokeWidth={2} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[length:var(--fs-md)] font-medium" style={{ color: 'var(--text-primary)' }}>{opt.label}</span>
            {isCurrent && <Check className="h-3 w-3 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />}
          </div>
        </div>
      </button>
    )
  }

  const openInVscode = () => {
    const url = buildVscodeUrl(vscodeWebUrl, bindPath)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
    setOpen(false)
  }

  return (
    <div className="relative flex-shrink-0">
      <TopNavActionElement
        type="button"
        onClick={(e: any) => { e.stopPropagation(); setOpen(o => !o) }}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tour="top-layout-toggle"
        title="切换工作区布局"
        className="mobius-workspace-toggle"
        style={{
          color: mode !== 'session' || fileEditorOpen ? 'var(--accent-primary)' : 'var(--text-secondary)',
          borderColor: mode !== 'session' || fileEditorOpen ? 'color-mix(in srgb, var(--accent-primary) 45%, var(--border-color))' : 'var(--border-color)',
          background: mode !== 'session' || fileEditorOpen ? 'color-mix(in srgb, var(--accent-primary) 14%, transparent)' : undefined,
        }}
      >
        <LayoutTemplate className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
      </TopNavActionElement>

      {open && (
        <div
          className="absolute right-0 top-9 z-50 w-[300px] rounded-xl p-1.5 shadow-xl"
          style={{ background: 'var(--menu-bg)', border: '1px solid var(--border-color)' }}
          onClick={e => e.stopPropagation()}
        >
          <div className="px-2 py-1.5 text-[length:var(--fs-xs)] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            工作区布局
          </div>
          {renderViewOption(options[0])}
          {vscodeAvailable && (
            <button
              type="button"
              onClick={openInVscode}
              className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
              title="在 VSCode Web 中打开项目目录"
            >
              <ExternalLink className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} strokeWidth={2} />
              <div className="min-w-0 flex-1">
                <span className="text-[length:var(--fs-md)] font-medium" style={{ color: 'var(--text-primary)' }}>在 VSCode 中打开</span>
              </div>
            </button>
          )}
          {renderViewOption(options[1])}
        </div>
      )}
    </div>
  )
}
