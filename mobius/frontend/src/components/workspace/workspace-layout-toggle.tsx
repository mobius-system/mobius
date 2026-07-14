import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Check, Columns2, Columns3, LayoutTemplate, PanelLeft } from 'lucide-react'
import { useStore, type WorkspaceLayoutMode } from '../../store'
import { useIsMobile } from '../resizable-panel'
import { useEditorAvailability } from './use-editor-availability'

// =====================================================================
// WorkspaceLayoutToggle - 顶栏「布局模式」切换入口.
// 点击弹出选择窗, 在三种布局间自由切换:
//   session           - 会话模式: 左 Issue/Session 侧栏 + 右 ChatArea
//   editor-chat       - 代码对话 v1: 左 code-server iframe 编辑器 + 右 ChatArea
//   code-conversation - 代码对话 v2: 左文件浏览器 + 中代码浏览 + 右 ChatArea
// v1 需 bind_path + VSCODE_WEB_URL; v2 只需 bind_path (原生预览不依赖 code-server).
// UserPage / ProjectPage / 移动端完全不渲染 (代码对话为桌面端能力).
// =====================================================================
type ModeOption = {
  mode: WorkspaceLayoutMode
  label: string
  desc: string
  icon: typeof PanelLeft
  available: boolean
  unavailableReason?: string
}

// 按用户要求精确隐藏「代码对话」入口的具体 issue (非项目级, 不波及同项目其它 issue).
// 例如纯 git 提交推送类 issue: session 都是 agent 跑 git 命令, "左代码右对话" 工作区无意义且碍眼.
// 新增同类 issue 时在此追加 ID. 注意: 仅匹配 issue 路由 (/i/:issue), research 路由不受影响.
const WORKSPACE_TOGGLE_HIDDEN_ISSUES = new Set<string>(['a2b72394'])

export function WorkspaceLayoutToggle() {
  const params = useParams()
  const isMobile = useIsMobile()
  const mode = useStore(s => s.workspaceLayoutMode)
  const setMode = useStore(s => s.setWorkspaceLayoutMode)
  const currentSession = useStore(s => s.currentSession)
  const currentProject = useStore(s => s.currentProject)

  const onIssueOrResearch = !!(params.issue || params.research)
  // 只在可能用到时才查询 (顶栏全局渲染, 避免无关页面发请求).
  const { bindPath, vscodeWebUrl } = useEditorAvailability(currentProject?.id, onIssueOrResearch && !!currentSession)

  const [open, setOpen] = useState(false)

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
  // 个别 issue 精确隐藏 (见 WORKSPACE_TOGGLE_HIDDEN_ISSUES 注释).
  if (params.issue && WORKSPACE_TOGGLE_HIDDEN_ISSUES.has(params.issue)) return null

  const v1Available = !!currentSession && !!bindPath && !!vscodeWebUrl
  const v2Available = !!currentSession && !!bindPath

  const options: ModeOption[] = [
    {
      mode: 'session',
      label: '高效会话模式',
      desc: '快速对话，高效操控智能体',
      icon: PanelLeft,
      available: true,
    },
    {
      mode: 'editor-chat',
      label: 'VSCode 编辑',
      desc: '接入内置 VSCode 编辑',
      icon: Columns2,
      available: v1Available,
      unavailableReason: !currentSession ? '请先选择 Session' : !bindPath ? '项目未绑定路径' : '未配置 Web 编辑器 (VSCODE_WEB_URL)',
    },
    {
      mode: 'code-conversation',
      label: '原生文件编辑器',
      desc: '接入原生文件编辑器编辑',
      icon: Columns3,
      available: v2Available,
      unavailableReason: !currentSession ? '请先选择 Session' : '项目未绑定路径',
    },
  ]

  const currentLabel = options.find(o => o.mode === mode)?.label || '会话模式'

  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tour="top-layout-toggle"
        title="切换工作区布局"
        className="mobius-workspace-toggle h-8 flex shrink-0 items-center gap-1.5 rounded-lg px-2 border transition-colors"
        style={{
          color: mode !== 'session' ? 'var(--accent-primary)' : 'var(--text-secondary)',
          borderColor: mode !== 'session' ? 'color-mix(in srgb, var(--accent-primary) 45%, var(--border-color))' : 'var(--border-color)',
          background: mode !== 'session' ? 'color-mix(in srgb, var(--accent-primary) 14%, transparent)' : undefined,
        }}
      >
        <LayoutTemplate className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
        {/* <span className="text-[12px] font-medium whitespace-nowrap">{currentLabel}</span> */}
      </button>

      {open && (
        <div
          className="absolute right-0 top-9 z-50 w-[300px] rounded-xl p-1.5 shadow-xl"
          style={{ background: 'var(--menu-bg)', border: '1px solid var(--border-color)' }}
          onClick={e => e.stopPropagation()}
        >
          <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            工作区布局
          </div>
          {options.map(opt => {
            const Icon = opt.icon
            const isCurrent = mode === opt.mode
            return (
              <button
                key={opt.mode}
                type="button"
                disabled={!opt.available}
                onClick={() => {
                  if (!opt.available) return
                  setMode(opt.mode)
                  setOpen(false)
                }}
                className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 hover:bg-[var(--bg-hover)]"
                style={{ background: isCurrent ? 'var(--bg-active)' : undefined }}
                title={!opt.available ? opt.unavailableReason : undefined}
              >
                <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: isCurrent ? 'var(--accent-primary)' : 'var(--text-muted)' }} strokeWidth={2} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{opt.label}</span>
                    {isCurrent && <Check className="h-3 w-3 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />}
                  </div>
                  {/* <div className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>{opt.desc}</div>
                  {!opt.available && opt.unavailableReason && (
                    <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>{opt.unavailableReason}</div>
                  )} */}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
