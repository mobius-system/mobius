import { BookOpen, Brain, Cpu, FileDiff, GitBranch, History, Loader2, Network, Puzzle, RotateCcw, Terminal, Wand2 } from 'lucide-react'
import { RemoteAimuxMcpIcon } from './aimux-link-indicator'
import { ProjectPortEntryButton } from './project-files'
import { ButtonVisibilityMenu, UnifiedButton, UnifiedButtonGroup } from './unified-button-group'

type AdvancedSessionActionsProps = {
  sessionId?: string | null
  projectId?: string | null
  issueId?: string | null
  researchId?: string | null
  vscodeSubPath?: string | null
  jsonlEntryCount: number
  connectionReady: boolean
  projectKnowledgeSending: boolean
  variant?: 'default' | 'compact' | 'menu'
  onOpenFileChanges: () => void
  onOpenBashCommands: () => void
  onOpenInputReplay: () => void
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
  connectionReady,
  projectKnowledgeSending,
  variant = 'default',
  onOpenFileChanges,
  onOpenBashCommands,
  onOpenInputReplay,
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

  return (
    <UnifiedButtonGroup
      className={`advanced-session-actions mobius-chat-input-actions flex flex-col gap-1.5${condensed ? ` advanced-session-actions--compact ${compact ? 'w-[176px]' : 'w-[336px] max-w-[calc(100vw-24px)]'} flex-none rounded-lg border p-2 shadow-sm` : ''}`}
      style={condensed ? { background: 'var(--input-bg)', borderColor: 'var(--border-color)' } : undefined}
      data-testid="advanced-session-actions"
      data-variant={variant}
      aria-label="高级会话按钮组"
      visibilityStorageKey="mobius:session-actions:hidden"
    >
      <ButtonVisibilityMenu options={[
        { id: 'file-changes', label: '查看文件修改' },
        { id: 'bash-commands', label: '查看运行命令' },
        { id: 'input-replay', label: '回放输入' },
        { id: 'project-port', label: '进入项目端口' },
        { id: 'terminal', label: '打开终端' },
        { id: 'cooperable-pc', label: '可合作计算机' },
        { id: 'knowledge', label: '查看当前知识' },
        { id: 'send-knowledge', label: '项目知识沉淀到记忆' },
        { id: 'continue-model', label: '修改模型并继续' },
        { id: 'skill', label: 'Skill' },
        { id: 'memory', label: 'Memory' },
        { id: 'git', label: 'Git' },
      ]} />
      {menu && <div className="px-1 text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>查看与工作</div>}
      <div className={`grid ${menu ? 'grid-cols-2 gap-1' : 'grid-cols-4 gap-2'} items-stretch`}>
        <UnifiedButton
          kind="modal"
          buttonId="file-changes"
          onClick={onOpenFileChanges}
          disabled={!hasSession}
          label="查看文件修改"
          tooltip="查看当前会话所有文件修改"
          accent="blue"
          displayLabel={menu}
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
          displayLabel={menu}
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
          displayLabel={menu}
          icon={<RotateCcw className="h-4 w-4" strokeWidth={1.9} />}
        />
        <ProjectPortEntryButton
          buttonId="project-port"
          projectId={projectId}
          subPath={vscodeSubPath}
          label="进入项目端口"
          triggerVariant="advanced"
          advancedDisplayLabel={menu}
          onRequestRunProject={onRequestRunProject}
        />
      </div>

      <div className="mx-1 h-px bg-[var(--border-color)] opacity-40" aria-hidden />

      {menu && <div className="px-1 text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>执行与上下文</div>}
      <div className={`grid ${menu ? 'grid-cols-2 gap-1' : 'grid-cols-5 gap-2'} items-stretch`}>
        <UnifiedButton
          kind="modal"
          buttonId="terminal"
          onClick={onOpenTerminal}
          disabled={!hasSession}
          label="打开终端"
          tooltip="打开当前会话终端"
          accent="emerald"
          displayLabel={menu}
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
          displayLabel={menu}
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
            displayLabel={menu}
            icon={<Network className="h-4 w-4" strokeWidth={1.9} />}
          />
        ) : variant !== 'default' ? (
          <UnifiedButton
            kind="modal"
            buttonId="knowledge"
            onClick={onOpenKnowledge}
            disabled={!canOpenKnowledge}
            label="查看当前知识"
            tooltip="查看当前知识 (项目知识 / 本任务知识)"
            accent="cyan"
            displayLabel={menu}
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
          displayLabel={menu}
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
          displayLabel={menu}
          icon={<Cpu className="h-4 w-4" strokeWidth={1.9} />}
        />
      </div>

      <div className="mx-1 h-px bg-[var(--border-color)] opacity-40" aria-hidden />

      {condensed && (
        <>
        {menu && <div className="px-1 text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>会话配置</div>}
        <div className={`grid ${menu ? 'grid-cols-2 gap-1' : 'grid-cols-3 gap-2'} items-stretch`}>
          <UnifiedButton
            kind="modal"
            buttonId="skill"
            onClick={onOpenSkill}
            disabled={!hasSession}
            label="Skill"
            tooltip="查看当前会话 Skill"
            accent="blue"
            displayLabel={menu}
            iconClassName={menu ? undefined : 'h-4 w-auto gap-1.5'}
            icon={menu ? <Puzzle className="h-4 w-4" strokeWidth={1.9} /> : (
              <>
                <Puzzle className="h-4 w-4" strokeWidth={1.9} />
                <span className="text-[11px] font-medium leading-none">Skill</span>
              </>
            )}
          />
          <UnifiedButton
            kind="modal"
            buttonId="memory"
            onClick={onOpenMemory}
            disabled={!hasSession}
            label="Memory"
            tooltip="查看当前会话 Memory"
            accent="cyan"
            displayLabel={menu}
            iconClassName={menu ? undefined : 'h-4 w-auto gap-1.5'}
            icon={menu ? <Brain className="h-4 w-4" strokeWidth={1.9} /> : (
              <>
                <Brain className="h-4 w-4" strokeWidth={1.9} />
                <span className="text-[11px] font-medium leading-none">Memory</span>
              </>
            )}
          />
          <UnifiedButton
            kind="modal"
            buttonId="git"
            onClick={onOpenGit}
            disabled={!hasSession || !projectId}
            label="Git"
            tooltip="查看当前项目 Git 仓库"
            accent="amber"
            displayLabel={menu}
            iconClassName={menu ? undefined : 'h-4 w-auto gap-1.5'}
            icon={menu ? <GitBranch className="h-4 w-4" strokeWidth={1.9} /> : (
              <>
                <GitBranch className="h-4 w-4" strokeWidth={1.9} />
                <span className="text-[11px] font-medium leading-none">Git</span>
              </>
            )}
          />
        </div>
        </>
      )}
    </UnifiedButtonGroup>
  )
}
