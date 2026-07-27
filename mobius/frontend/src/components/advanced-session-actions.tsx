import { Archive, BookOpen, FileDiff, Hash, History, Loader2, Network, Replace, ScrollText, Terminal } from 'lucide-react'
import { AdvancedInteractionBtn } from './advanced-interaction-btn'
import { ProjectPortEntryButton } from './project-files'

type AdvancedSessionActionsProps = {
  sessionId?: string | null
  projectId?: string | null
  issueId?: string | null
  researchId?: string | null
  vscodeSubPath?: string | null
  jsonlEntryCount: number
  showJsonlMeta: boolean
  connectionReady: boolean
  projectKnowledgeSending: boolean
  variant?: 'default' | 'compact'
  onOpenFileChanges: () => void
  onOpenBashCommands: () => void
  onOpenInputReplay: () => void
  onToggleJsonlMeta: () => void
  onRequestRunProject: (mainProjectPortPath: string) => void
  onOpenTerminal: () => void
  onOpenCooperablePc: () => void
  onOpenKnowledge: () => void
  onSendProjectKnowledge: () => void | Promise<void>
  onContinueWithModel: () => void
}

/**
 * 当前会话的高级操作入口。
 *
 * default 用于标准会话输入侧栏；compact 用于简易模式输入框左侧。两种布局
 * 共用同一份按钮定义，避免入口、禁用条件与提示文案发生漂移。
 */
export function AdvancedSessionActions({
  sessionId,
  projectId,
  issueId,
  researchId,
  vscodeSubPath,
  jsonlEntryCount,
  showJsonlMeta,
  connectionReady,
  projectKnowledgeSending,
  variant = 'default',
  onOpenFileChanges,
  onOpenBashCommands,
  onOpenInputReplay,
  onToggleJsonlMeta,
  onRequestRunProject,
  onOpenTerminal,
  onOpenCooperablePc,
  onOpenKnowledge,
  onSendProjectKnowledge,
  onContinueWithModel,
}: AdvancedSessionActionsProps) {
  const compact = variant === 'compact'
  const hasSession = !!sessionId
  const canOpenKnowledge = !!projectId && !!issueId
  const canContinue = hasSession && (!!issueId || !!researchId)
  const canSendProjectKnowledge = jsonlEntryCount > 0 && !!projectId && connectionReady && !projectKnowledgeSending

  return (
    <div
      className={`advanced-session-actions mobius-chat-input-actions flex flex-col gap-1.5${compact ? ' advanced-session-actions--compact w-[176px] flex-none rounded-lg border p-1.5 shadow-sm' : ''}`}
      style={compact ? { background: 'var(--input-bg)', borderColor: 'var(--border-color)' } : undefined}
      data-testid="advanced-session-actions"
      data-variant={variant}
      aria-label="高级会话按钮组"
    >
      <div className="grid grid-cols-5 items-stretch gap-2">
        <AdvancedInteractionBtn
          onClick={onOpenFileChanges}
          disabled={!hasSession}
          label="查看文件修改"
          tooltip="查看当前会话所有文件修改"
          accent="blue"
          icon={<FileDiff className="h-4 w-4" strokeWidth={1.9} />}
        />
        <AdvancedInteractionBtn
          onClick={onOpenBashCommands}
          disabled={!hasSession}
          data-tour="session-bash-commands"
          label="查看运行命令"
          tooltip="查看当前会话运行的所有Bash命令"
          accent="emerald"
          icon={<ScrollText className="h-4 w-4" strokeWidth={1.9} />}
        />
        <AdvancedInteractionBtn
          onClick={onOpenInputReplay}
          disabled={!hasSession}
          label="回放输入"
          tooltip="回放输入"
          accent="blue"
          icon={<History className="h-4 w-4" strokeWidth={1.9} />}
        />
        <AdvancedInteractionBtn
          onClick={onToggleJsonlMeta}
          disabled={jsonlEntryCount === 0}
          label={showJsonlMeta ? '隐藏时间与序号' : '显示时间与序号'}
          tooltip={showJsonlMeta ? '隐藏 JSONL 卡片标题里的序号与时间前缀' : '在 JSONL 卡片标题里显示 #序号 与 MM-DD HH:MM:SS 时间前缀'}
          accent="blue"
          aria-pressed={showJsonlMeta}
          className={showJsonlMeta ? 'bg-blue-500/15' : ''}
          icon={<Hash className="h-4 w-4" strokeWidth={1.9} />}
        />
        <ProjectPortEntryButton
          projectId={projectId}
          subPath={vscodeSubPath}
          label="进入项目端口"
          triggerVariant="advanced"
          onRequestRunProject={onRequestRunProject}
        />
      </div>

      <div className="mx-1 h-px bg-[var(--border-color)] opacity-40" aria-hidden />

      <div className="grid grid-cols-5 items-stretch gap-2">
        <AdvancedInteractionBtn
          onClick={onOpenTerminal}
          disabled={!hasSession}
          label="打开终端"
          tooltip="打开当前会话终端"
          accent="emerald"
          icon={<Terminal className="h-4 w-4" strokeWidth={1.9} />}
        />
        <AdvancedInteractionBtn
          onClick={onOpenCooperablePc}
          data-tour="session-cooperable-pc"
          disabled={!hasSession}
          label="可合作计算机"
          tooltip="声明可合作计算机 (勾选 aimux remote, 生成声明直接发给当前 agent, 不写 Memory)"
          accent="amber"
          icon={<Network className="h-4 w-4" strokeWidth={1.9} />}
        />
        <AdvancedInteractionBtn
          onClick={onOpenKnowledge}
          disabled={!canOpenKnowledge}
          label="查看当前知识"
          tooltip="查看当前知识 (项目知识 / 本任务知识)"
          accent="cyan"
          icon={<BookOpen className="h-4 w-4" strokeWidth={1.9} />}
        />
        <AdvancedInteractionBtn
          onClick={onSendProjectKnowledge}
          disabled={!canSendProjectKnowledge}
          label="项目知识沉淀到记忆"
          tooltip={projectKnowledgeSending ? '正在发送项目知识沉淀指令...' : '请智能体整理并更新项目级与任务级可复用知识'}
          accent="violet"
          icon={projectKnowledgeSending
            ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.9} />
            : <Archive className="h-4 w-4" strokeWidth={1.9} />}
        />
        <AdvancedInteractionBtn
          onClick={onContinueWithModel}
          disabled={!canContinue}
          label="修改模型并继续"
          tooltip="修改模型并继续"
          accent="violet"
          icon={<Replace className="h-4 w-4" strokeWidth={1.9} />}
        />
      </div>

      <div className="mx-1 h-px bg-[var(--border-color)] opacity-40" aria-hidden />
    </div>
  )
}
