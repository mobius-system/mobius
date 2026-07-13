import { useParams } from 'react-router-dom'
import { Columns2, PanelLeft } from 'lucide-react'
import { useStore } from '../../store'
import { useIsMobile } from '../resizable-panel'
import { useEditorAvailability } from './use-editor-availability'

// =====================================================================
// WorkspaceLayoutToggle — 顶栏「会话 / 代码对话」双态切换按钮.
// 仅在 IssuePage/ResearchPage 路由且当前有 currentSession 时可用; 另需项目具备
// bind_path + 可用 VSCODE_WEB_URL (经 useEditorAvailability 查询, 模块级缓存).
// 不满足条件时按钮禁用并给出对应 tooltip; UserPage/ProjectPage/移动端完全不渲染.
// 只负责切换 store.workspaceLayoutMode, 不负责页面布局 (由各页面按 mode 条件渲染).
// =====================================================================
export function WorkspaceLayoutToggle() {
  const params = useParams()
  const isMobile = useIsMobile()
  const mode = useStore(s => s.workspaceLayoutMode)
  const toggle = useStore(s => s.toggleWorkspaceLayoutMode)
  const currentSession = useStore(s => s.currentSession)
  const currentProject = useStore(s => s.currentProject)

  const onIssueOrResearch = !!(params.issue || params.research)
  // 只在可能用到时才查询 (顶栏全局渲染, 避免无关页面发请求).
  const { bindPath, vscodeWebUrl } = useEditorAvailability(currentProject?.id, onIssueOrResearch && !!currentSession)

  // UserPage / ProjectPage / 移动端不显示 (v1 代码对话为桌面端能力).
  if (!onIssueOrResearch || isMobile) return null

  const editorChat = mode === 'editor-chat'
  const canEnter = !!currentSession && !!bindPath && !!vscodeWebUrl

  let title: string
  if (!currentSession) title = '选择 Session 后进入代码对话模式'
  else if (!bindPath) title = '当前项目未绑定路径，无法进入代码对话模式'
  else if (!vscodeWebUrl) title = '当前项目未配置 Web 编辑器（VSCODE_WEB_URL）'
  else title = editorChat ? '代码对话模式（点击切回会话模式）' : '代码对话：左侧编辑代码，右侧与 Agent 对话'

  return (
    <button
      type="button"
      onClick={() => { if (canEnter) toggle() }}
      disabled={!canEnter}
      aria-pressed={editorChat}
      aria-label="切换到代码对话模式"
      title={title}
      data-tour="top-layout-toggle"
      className="mobius-workspace-toggle h-8 flex shrink-0 items-center gap-1.5 rounded-lg px-2 border transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        color: editorChat ? 'var(--accent-primary)' : 'var(--text-secondary)',
        borderColor: editorChat ? 'color-mix(in srgb, var(--accent-primary) 45%, var(--border-color))' : 'var(--border-color)',
        background: editorChat ? 'color-mix(in srgb, var(--accent-primary) 14%, transparent)' : undefined,
      }}
    >
      {editorChat
        ? <Columns2 className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />
        : <PanelLeft className="w-3.5 h-3.5 shrink-0" strokeWidth={2} />}
      <span className="text-[12px] font-medium whitespace-nowrap">{editorChat ? '代码对话' : '会话'}</span>
    </button>
  )
}
