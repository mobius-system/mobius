import { BookOpen, Brain, Clock, Cpu, FileDiff, GitBranch, History, Loader2, Network, Puzzle, RotateCcw, Terminal, Wand2 } from 'lucide-react'
import { RemoteAimuxMcpIcon } from './aimux-link-indicator'
import { ProjectPortEntryButton } from './project-files'
import { UnifiedButton } from './unified-button-group'

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
  variant?: 'default' | 'compact' | 'menu'
  onOpenFileChanges: () => void
  onOpenBashCommands: () => void
  onOpenInputReplay: () => void
  onToggleJsonlMeta: () => void
  onRequestRunProject: (mainProjectPortPath: string) => void
  onOpenTerminal: () => void
  onOpenCooperablePc: () => void
  onOpenKnowledge: () => void
  onOpenResearchGraph?: () => void
  onSendProjectKnowledge: () => void | Promise<void>
  onContinueWithModel: () => void
  onOpenSkill: () => void
  onOpenMemory: () => void
  onOpenGit: () => void
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
  onOpenResearchGraph,
  onSendProjectKnowledge,
  onContinueWithModel,
  onOpenSkill,
  onOpenMemory,
  onOpenGit,
}: AdvancedSessionActionsProps) {
  const compact = variant === 'compact'
  const menu = variant === 'menu'
  const condensed = variant !== 'default'
  const hasSession = !!sessionId
  const canOpenKnowledge = !!projectId && !!issueId
  const canContinue = hasSession && (!!issueId || !!researchId)
  const canSendProjectKnowledge = jsonlEntryCount > 0 && !!projectId && connectionReady && !projectKnowledgeSending
  const displayLabel = menu
  const controlClassName = condensed ? undefined : 'h-9 w-9 flex-none rounded-md'

  const actionButtons = (
    <>
      <UnifiedButton
        kind="modal"
        buttonId="file-changes"
        onClick={onOpenFileChanges}
        disabled={!hasSession}
        label="查看文件修改"
        tooltip="查看当前会话所有文件修改"
        accent="blue"
        displayLabel={displayLabel}
        className={controlClassName}
        icon={<FileDiff className="h-4 w-4" strokeWidth={1.9} />}
      />
      <UnifiedButton
        kind="modal"
        buttonId="bash-commands"
        onClick={onOpenBashCommands}
        disabled={!hasSession}
        data-tour="session-bash-commands"
        label="查看运行命令"
        tooltip="查看当前会话运行的所有Bash命令"
        accent="emerald"
        displayLabel={displayLabel}
        className={controlClassName}
        icon={<History className="h-4 w-4" strokeWidth={1.9} />}
      />
      <UnifiedButton
        kind="modal"
        buttonId="input-replay"
        onClick={onOpenInputReplay}
        disabled={!hasSession}
        label="回放输入"
        tooltip="回放输入"
        accent="blue"
        displayLabel={displayLabel}
        className={controlClassName}
        icon={<RotateCcw className="h-4 w-4" strokeWidth={1.9} />}
      />
      <UnifiedButton
        kind="normal"
        buttonId="jsonl-meta"
        onClick={onToggleJsonlMeta}
        disabled={jsonlEntryCount === 0}
        label={showJsonlMeta ? '隐藏时间与序号' : '显示时间与序号'}
        tooltip={showJsonlMeta ? '隐藏 JSONL 卡片标题里的序号与时间前缀' : '在 JSONL 卡片标题里显示 #序号 与 MM-DD HH:MM:SS 时间前缀'}
        accent="blue"
        displayLabel={displayLabel}
        className={`${showJsonlMeta ? 'bg-blue-500/15' : ''} ${controlClassName || ''}`}
        icon={<Clock className="h-4 w-4" strokeWidth={1.9} />}
      />
      <ProjectPortEntryButton
        buttonId="project-port"
        projectId={projectId}
        subPath={vscodeSubPath}
        label="进入项目端口"
        triggerVariant="advanced"
        advancedDisplayLabel={displayLabel}
        className={controlClassName}
        onRequestRunProject={onRequestRunProject}
      />
      <UnifiedButton
        kind="modal"
        buttonId="terminal"
        onClick={onOpenTerminal}
        disabled={!hasSession}
        label="打开终端"
        tooltip="打开当前会话终端"
        accent="emerald"
        displayLabel={displayLabel}
        className={controlClassName}
        icon={<Terminal className="h-4 w-4" strokeWidth={1.9} />}
      />
      <UnifiedButton
        kind="modal"
        buttonId="cooperable-pc"
        onClick={onOpenCooperablePc}
        data-tour="session-cooperable-pc"
        disabled={!hasSession}
        label="可合作计算机"
        tooltip="声明可合作计算机 (勾选 aimux remote, 生成声明直接发给当前 agent, 不写 Memory)"
        accent="amber"
        displayLabel={displayLabel}
        className={controlClassName}
        icon={<RemoteAimuxMcpIcon className="h-4 w-4 scale-125" />}
      />
      {researchId && onOpenResearchGraph ? (
        <UnifiedButton
          kind="normal"
          buttonId="knowledge"
          onClick={onOpenResearchGraph}
          label="Research Graph"
          tooltip="跳转到 Research Graph"
          accent="cyan"
          displayLabel={displayLabel}
          className={controlClassName}
          icon={<Network className="h-4 w-4" strokeWidth={1.9} />}
        />
      ) : variant !== 'default' ? (
        <UnifiedButton
          kind="modal"
          buttonId="knowledge"
          onClick={onOpenKnowledge}
          disabled={!canOpenKnowledge}
          label="查看当前项目知识/任务知识"
          tooltip="查看当前项目知识/任务知识"
          accent="cyan"
          displayLabel={displayLabel}
          className={controlClassName}
          icon={<BookOpen className="h-4 w-4" strokeWidth={1.9} />}
        />
      ) : null}
      <UnifiedButton
        kind="normal"
        buttonId="send-knowledge"
        onClick={onSendProjectKnowledge}
        disabled={!canSendProjectKnowledge}
        label="项目知识沉淀到记忆"
        tooltip={projectKnowledgeSending ? '正在发送项目知识沉淀指令...' : '请智能体整理并更新项目级与任务级可复用知识'}
        accent="violet"
        displayLabel={displayLabel}
        className={controlClassName}
        icon={projectKnowledgeSending
          ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.9} />
          : <Wand2 className="h-4 w-4" strokeWidth={1.9} />}
      />
      <UnifiedButton
        kind="modal"
        buttonId="continue-model"
        onClick={onContinueWithModel}
        disabled={!canContinue}
        label="修改模型并继续"
        tooltip="修改模型并继续"
        accent="violet"
        displayLabel={displayLabel}
        className={controlClassName}
        icon={<Cpu className="h-4 w-4" strokeWidth={1.9} />}
      />
      {condensed && (
        <>
          <UnifiedButton kind="modal" buttonId="skill" onClick={onOpenSkill} disabled={!hasSession} label="Skill" tooltip="查看当前会话 Skill" accent="blue" displayLabel={displayLabel} icon={<Puzzle className="h-4 w-4" strokeWidth={1.9} />} />
          <UnifiedButton kind="modal" buttonId="memory" onClick={onOpenMemory} disabled={!hasSession} label="Memory" tooltip="查看当前会话 Memory" accent="cyan" displayLabel={displayLabel} icon={<Brain className="h-4 w-4" strokeWidth={1.9} />} />
          <UnifiedButton kind="modal" buttonId="git" onClick={onOpenGit} disabled={!hasSession || !projectId} label="Git" tooltip="查看当前项目 Git 仓库" accent="amber" displayLabel={displayLabel} icon={<GitBranch className="h-4 w-4" strokeWidth={1.9} />} />
        </>
      )}
    </>
  )

  if (!condensed) {
    return <>{actionButtons}</>
  }

  return (
    <div
      className={`advanced-session-actions mobius-chat-input-actions flex flex-col gap-1.5${condensed ? ` advanced-session-actions--compact ${compact ? 'w-[176px]' : 'w-[336px] max-w-[calc(100vw-24px)]'} flex-none rounded-lg border p-2 shadow-sm` : ''}`}
      style={condensed ? { background: 'var(--input-bg)', borderColor: 'var(--border-color)' } : undefined}
      data-testid="advanced-session-actions"
      data-variant={variant}
      aria-label="高级会话按钮组"
    >
      {menu && <div className="px-1 text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>当前会话工具</div>}
      <div className={`flex flex-wrap items-stretch ${menu ? 'gap-1' : 'gap-2'}`}>
        {actionButtons}
      </div>
    </div>
  )
}
