import { Loader2 } from 'lucide-react'
import { CodeConversationPane } from '../workspace/code-conversation-pane'
import { useEditorAvailability } from '../workspace/use-editor-availability'

/*
 * ProjectBlueprintPanel — 项目设置的「项目蓝图」面板.
 * 原生文件编辑器 (CodeConversationPane) 的蓝图变体薄壳: 树根锁定
 * <HIDDEN_FOLDER_NAME>/blueprints、默认 HTML 预览、可切源码编辑保存,
 * 树/编辑器/保存/右键管理全部继承自原组件 (mode='blueprint').
 */
export function ProjectBlueprintPanel({ projectId }: { projectId: string }) {
  const { bindPath, loading } = useEditorAvailability(projectId, true)

  if (!bindPath) {
    return (
      <div
        className="flex h-[420px] w-full flex-col items-center justify-center gap-2 rounded-xl border"
        style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
      >
        {loading ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            <div className="text-[length:var(--fs-md)]">正在加载项目路径…</div>
          </>
        ) : (
          <div className="text-[length:var(--fs-md)]">项目未绑定路径，无法使用项目蓝图</div>
        )}
      </div>
    )
  }

  return (
    /* 面板尺寸 = 父容器尺寸 (高度 100% / 宽度 100%), 不留任何缝隙:
       外层给足确定高度 (h-full 链路), 这里用 h-full 撑满; 内部树/预览各自内部滚动. */
    <div
      className="h-full w-full overflow-hidden rounded-xl border"
      style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}
    >
      <CodeConversationPane projectId={projectId} bindPath={bindPath} mode="blueprint" variant="page" />
    </div>
  )
}
