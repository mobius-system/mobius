import { BookOpen, Brain, Clock, Code2, Cpu, ExternalLink, FileDiff, FolderOpen, GitBranch, History, Loader2, Network, Puzzle, RotateCcw, Share2, Terminal, Wand2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { AdvancedInteractionBtn } from './advanced-interaction-btn'
import { OpenInVSCodeButton, ProjectPortEntryButton } from './project-files'

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
  variant?: 'default' | 'compact' | 'menu' | 'editor' | 'overflow'
  onOpenFileChanges: () => void
  onOpenProjectFiles: () => void
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
  onOpenEditor?: () => void
  editorAvailable?: boolean
  editorLoading?: boolean
  editorOpen?: boolean
  editorUnavailableReason?: string
  onOpenExtensionApp?: () => void
}

function ToolMenuGroup({ label, hint, flat = false, children }: {
  label: string
  hint: string
  flat?: boolean
  children: ReactNode
}) {
  return (
    <section
      className={flat ? 'py-1' : 'rounded-[var(--radius-control)] border p-1.5'}
      style={flat ? undefined : { borderColor: 'var(--border-default)', background: 'var(--surface-base)' }}
    >
      <div className={flat ? 'mb-0.5 px-2' : 'mb-1 px-1.5 pt-0.5'}>
        <div
          className={flat ? 'text-[10px] font-semibold leading-4' : 'text-[11px] font-semibold'}
          style={{ color: flat ? 'var(--text-muted)' : 'var(--text-primary)' }}
          title={flat ? hint : undefined}
        >
          {label}
        </div>
        {!flat && <div className="mt-0.5 text-[9px] leading-3.5" style={{ color: 'var(--text-muted)' }}>{hint}</div>}
      </div>
      <div className={`flex flex-col ${flat ? 'gap-0' : 'gap-1'}`}>{children}</div>
    </section>
  )
}

function WorkspaceEditorMenuGroup({
  projectId,
  vscodeSubPath,
  onOpenEditor,
  editorAvailable,
  editorLoading,
  editorOpen,
  editorUnavailableReason,
  onOpenExtensionApp,
}: Pick<AdvancedSessionActionsProps,
  'projectId' | 'vscodeSubPath' | 'onOpenEditor' | 'editorAvailable' | 'editorLoading'
  | 'editorOpen' | 'editorUnavailableReason' | 'onOpenExtensionApp'>) {
  return (
    <ToolMenuGroup label="编辑器" hint="先在当前会话旁按需打开；VSCode 新窗口保留为第二动作">
      {onOpenEditor && (
        <AdvancedInteractionBtn
          onClick={onOpenEditor}
          disabled={!editorAvailable || editorLoading}
          label={editorOpen ? '编辑器已打开' : editorLoading ? '正在检查编辑器…' : '打开编辑器'}
          tooltip={editorUnavailableReason || '在当前会话旁打开编辑器'}
          title={!editorAvailable ? editorUnavailableReason : '在当前会话旁打开编辑器'}
          accent="neutral"
          displayLabel
          aria-pressed={editorOpen}
          data-workbench-open-editor
          icon={editorLoading
            ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.9} />
            : <Code2 className="h-4 w-4" strokeWidth={1.9} />}
        />
      )}
      {editorAvailable || !onOpenEditor ? (
        <OpenInVSCodeButton
          projectId={projectId}
          subPath={vscodeSubPath}
          mode="direct"
          showWorktreeOption={!!vscodeSubPath}
          className="group/advanced-interaction relative inline-flex min-h-9 w-full min-w-0 items-center justify-start gap-2 rounded-md bg-transparent px-2 py-1.5 text-left text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-control-hover)]"
        />
      ) : (
        <AdvancedInteractionBtn
          disabled
          label="打开 VSCode"
          tooltip={editorUnavailableReason || '需要项目 bind path 与 code-server'}
          title={editorUnavailableReason || '需要项目 bind path 与 code-server'}
          accent="neutral"
          displayLabel
          icon={<ExternalLink className="h-4 w-4" strokeWidth={1.9} />}
        />
      )}
      {onOpenEditor && !editorAvailable && (
        <div className="px-2 pb-1 text-[10px] leading-4" style={{ color: 'var(--status-waiting)' }} data-workbench-editor-prerequisite>
          {editorUnavailableReason || '编辑器需要项目 bind path 与 code-server。'}
        </div>
      )}
      {onOpenExtensionApp && (
        <AdvancedInteractionBtn
          onClick={onOpenExtensionApp}
          label="拓展应用"
          tooltip="在新窗口打开当前项目拓展应用"
          accent="neutral"
          displayLabel
          icon={<ExternalLink className="h-4 w-4" strokeWidth={1.9} />}
        />
      )}
    </ToolMenuGroup>
  )
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
  onOpenProjectFiles,
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
  onOpenEditor,
  editorAvailable = false,
  editorLoading = false,
  editorOpen = false,
  editorUnavailableReason,
  onOpenExtensionApp,
}: AdvancedSessionActionsProps) {
  const compact = variant === 'compact'
  const menu = variant === 'menu'
  const editorOnly = variant === 'editor'
  const overflow = variant === 'overflow'
  const condensed = variant !== 'default'
  const hasSession = !!sessionId
  const canOpenKnowledge = !!projectId && !!issueId
  const canContinue = hasSession && (!!issueId || !!researchId)
  const canSendProjectKnowledge = jsonlEntryCount > 0 && !!projectId && connectionReady && !projectKnowledgeSending

  const editorMenuGroup = (
    <WorkspaceEditorMenuGroup
      projectId={projectId}
      vscodeSubPath={vscodeSubPath}
      onOpenEditor={onOpenEditor}
      editorAvailable={editorAvailable}
      editorLoading={editorLoading}
      editorOpen={editorOpen}
      editorUnavailableReason={editorUnavailableReason}
      onOpenExtensionApp={onOpenExtensionApp}
    />
  )

  if (editorOnly) {
    return (
      <div
        className="advanced-session-actions advanced-session-actions--menu mobius-chat-input-actions w-full min-w-0"
        data-testid="advanced-session-actions"
        data-variant={variant}
        aria-label="编辑器工具"
      >
        {editorMenuGroup}
      </div>
    )
  }

  if (overflow) {
    return (
      <div
        className="advanced-session-actions advanced-session-actions--overflow mobius-chat-input-actions flex w-full min-w-0 flex-col gap-1"
        data-testid="advanced-session-actions"
        data-variant={variant}
        aria-label="更多会话动作分组"
      >
        <ToolMenuGroup label="继续方式" hint="修改模型会新建 Session" flat>
          <AdvancedInteractionBtn
            onClick={onContinueWithModel}
            disabled={!canContinue}
            label="修改模型并继续（新会话）"
            tooltip="新建一个 Session 并从当前 Session 继续"
            accent="neutral"
            displayLabel
            icon={<Cpu className="h-4 w-4" strokeWidth={1.9} />}
          />
          <AdvancedInteractionBtn
            onClick={onOpenInputReplay}
            disabled={!hasSession}
            label="回放输入"
            tooltip="选择历史输入并放回 composer"
            accent="neutral"
            displayLabel
            icon={<RotateCcw className="h-4 w-4" strokeWidth={1.9} />}
          />
          <AdvancedInteractionBtn
            onClick={onToggleJsonlMeta}
            disabled={jsonlEntryCount === 0}
            label={showJsonlMeta ? '隐藏时间与序号' : '显示时间与序号'}
            tooltip="切换当前会话记录的时间与序号"
            accent="neutral"
            displayLabel
            aria-pressed={showJsonlMeta}
            className={showJsonlMeta ? 'bg-[var(--surface-active)]' : ''}
            icon={<Clock className="h-4 w-4" strokeWidth={1.9} />}
          />
        </ToolMenuGroup>

        <ToolMenuGroup label="运行与协作" hint="运行记录与项目环境" flat>
          <AdvancedInteractionBtn
            onClick={onOpenBashCommands}
            disabled={!hasSession}
            data-tour="session-bash-commands"
            label="运行命令"
            tooltip="查看当前 Session 已运行的 Bash 命令"
            accent="neutral"
            displayLabel
            icon={<History className="h-4 w-4" strokeWidth={1.9} />}
          />
          <ProjectPortEntryButton
            projectId={projectId}
            subPath={vscodeSubPath}
            label="项目端口"
            triggerVariant="advanced"
            advancedDisplayLabel
            onRequestRunProject={onRequestRunProject}
          />
          <AdvancedInteractionBtn
            onClick={onOpenCooperablePc}
            data-tour="session-cooperable-pc"
            disabled={!hasSession}
            label="可合作计算机"
            tooltip="声明当前 Session 可使用的 AIMUX 远程计算机"
            accent="neutral"
            displayLabel
            icon={<Share2 className="h-4 w-4" strokeWidth={1.9} />}
          />
        </ToolMenuGroup>

        <ToolMenuGroup label="知识" hint="查看或沉淀当前知识" flat>
          <AdvancedInteractionBtn
            onClick={onOpenKnowledge}
            disabled={!canOpenKnowledge}
            label="当前知识"
            tooltip="查看当前项目知识与本任务知识"
            accent="neutral"
            displayLabel
            icon={<BookOpen className="h-4 w-4" strokeWidth={1.9} />}
          />
          <AdvancedInteractionBtn
            onClick={onSendProjectKnowledge}
            disabled={!canSendProjectKnowledge}
            label="知识沉淀"
            tooltip={projectKnowledgeSending ? '正在发送知识沉淀指令' : '请智能体整理当前项目与任务的可复用知识'}
            accent="neutral"
            displayLabel
            icon={projectKnowledgeSending
              ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.9} />
              : <Wand2 className="h-4 w-4" strokeWidth={1.9} />}
          />
        </ToolMenuGroup>

        {researchId && onOpenResearchGraph && (
          <ToolMenuGroup label="Research" hint="进入研究工作面" flat>
            <AdvancedInteractionBtn
              onClick={onOpenResearchGraph}
              label="Research Graph"
              tooltip="打开当前研究的 Graph"
              accent="neutral"
              displayLabel
              icon={<Network className="h-4 w-4" strokeWidth={1.9} />}
            />
          </ToolMenuGroup>
        )}
      </div>
    )
  }

  if (menu) {
    return (
      <div
        className="advanced-session-actions advanced-session-actions--menu mobius-chat-input-actions flex w-full min-w-0 flex-col gap-2 rounded-[var(--radius-panel)] border p-2"
        style={{ background: 'var(--surface-overlay)', borderColor: 'var(--border-strong)' }}
        data-testid="advanced-session-actions"
        data-variant={variant}
        aria-label="当前会话工具分组"
      >
        <div className="grid grid-cols-1 gap-2">
          <ToolMenuGroup label="文件" hint="浏览项目文件，或查看本 Session 改过的文件">
            <AdvancedInteractionBtn
              onClick={onOpenProjectFiles}
              disabled={!projectId}
              label="项目文件"
              tooltip="在文件工作台中浏览和预览项目文件；引用路径可直接键入 @"
              accent="neutral"
              displayLabel
              icon={<FolderOpen className="h-4 w-4" strokeWidth={1.9} />}
            />
            <AdvancedInteractionBtn
              onClick={onOpenFileChanges}
              disabled={!hasSession}
              label="会话文件修改"
              tooltip="查看当前 Session 的文件修改"
              accent="neutral"
              displayLabel
              icon={<FileDiff className="h-4 w-4" strokeWidth={1.9} />}
            />
          </ToolMenuGroup>

          <ToolMenuGroup label="Diff / Git" hint="只查看已有改动、仓库状态与运行命令">
            <AdvancedInteractionBtn
              onClick={onOpenGit}
              disabled={!hasSession || !projectId}
              label="Git 变更与历史"
              tooltip="先选择 Git source，再查看中枢变更与历史；本地和远端仅显示状态"
              accent="neutral"
              displayLabel
              icon={<GitBranch className="h-4 w-4" strokeWidth={1.9} />}
            />
            <AdvancedInteractionBtn
              onClick={onOpenBashCommands}
              disabled={!hasSession}
              data-tour="session-bash-commands"
              label="运行命令"
              tooltip="查看当前 Session 已运行的 Bash 命令"
              accent="neutral"
              displayLabel
              icon={<History className="h-4 w-4" strokeWidth={1.9} />}
            />
          </ToolMenuGroup>

          <ToolMenuGroup label="终端" hint="按需打开，不在会话右侧常驻">
            <AdvancedInteractionBtn
              onClick={onOpenTerminal}
              disabled={!hasSession}
              label="打开终端"
              tooltip="选择当前目录或 attach Agent 后台"
              accent="neutral"
              displayLabel
              icon={<Terminal className="h-4 w-4" strokeWidth={1.9} />}
            />
            <ProjectPortEntryButton
              projectId={projectId}
              subPath={vscodeSubPath}
              label="项目端口"
              triggerVariant="advanced"
              advancedDisplayLabel
              onRequestRunProject={onRequestRunProject}
            />
            <AdvancedInteractionBtn
              onClick={onOpenCooperablePc}
              data-tour="session-cooperable-pc"
              disabled={!hasSession}
              label="可合作计算机"
              tooltip="声明当前 Session 可使用的 AIMUX 远程计算机"
              accent="neutral"
              displayLabel
              icon={<Share2 className="h-4 w-4" strokeWidth={1.9} />}
            />
          </ToolMenuGroup>

          {editorMenuGroup}

          <ToolMenuGroup label="本会话上下文" hint="查看创建 Session 时定型的快照；全量管理在 Settings">
            <AdvancedInteractionBtn
              onClick={onOpenSkill}
              disabled={!hasSession}
              label="本会话 Skill 快照"
              tooltip="只查看当前 Session 的 Skill 快照"
              accent="neutral"
              displayLabel
              icon={<Puzzle className="h-4 w-4" strokeWidth={1.9} />}
            />
            <AdvancedInteractionBtn
              onClick={onOpenMemory}
              disabled={!hasSession}
              label="本会话 Memory 快照"
              tooltip="只查看当前 Session 的 Memory 快照"
              accent="neutral"
              displayLabel
              icon={<Brain className="h-4 w-4" strokeWidth={1.9} />}
            />
            <AdvancedInteractionBtn
              onClick={onOpenKnowledge}
              disabled={!canOpenKnowledge}
              label="当前知识"
              tooltip="查看当前项目知识与本任务知识"
              accent="neutral"
              displayLabel
              icon={<BookOpen className="h-4 w-4" strokeWidth={1.9} />}
            />
            <AdvancedInteractionBtn
              onClick={onSendProjectKnowledge}
              disabled={!canSendProjectKnowledge}
              label="知识沉淀"
              tooltip={projectKnowledgeSending ? '正在发送知识沉淀指令' : '请智能体整理当前项目与任务的可复用知识'}
              accent="neutral"
              displayLabel
              icon={projectKnowledgeSending
                ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.9} />
                : <Wand2 className="h-4 w-4" strokeWidth={1.9} />}
            />
          </ToolMenuGroup>

          <ToolMenuGroup label="继续方式" hint="不会热切模型；修改模型会创建新的 Session">
            <AdvancedInteractionBtn
              onClick={onContinueWithModel}
              disabled={!canContinue}
              label="修改模型并继续（新会话）"
              tooltip="新建一个 Session 并从当前 Session 继续"
              accent="neutral"
              displayLabel
              icon={<Cpu className="h-4 w-4" strokeWidth={1.9} />}
            />
            <AdvancedInteractionBtn
              onClick={onOpenInputReplay}
              disabled={!hasSession}
              label="回放输入"
              tooltip="选择历史输入并放回 composer"
              accent="neutral"
              displayLabel
              icon={<RotateCcw className="h-4 w-4" strokeWidth={1.9} />}
            />
            <AdvancedInteractionBtn
              onClick={onToggleJsonlMeta}
              disabled={jsonlEntryCount === 0}
              label={showJsonlMeta ? '隐藏时间与序号' : '显示时间与序号'}
              tooltip="切换当前会话记录的时间与序号"
              accent="neutral"
              displayLabel
              aria-pressed={showJsonlMeta}
              className={showJsonlMeta ? 'bg-[var(--surface-active)]' : ''}
              icon={<Clock className="h-4 w-4" strokeWidth={1.9} />}
            />
          </ToolMenuGroup>

          {researchId && onOpenResearchGraph && (
            <ToolMenuGroup label="Research" hint="进入当前研究的高级工作面，关闭后仍可返回本 Session">
              <AdvancedInteractionBtn
                onClick={onOpenResearchGraph}
                label="Research Graph"
                tooltip="打开当前研究的 Graph"
                accent="neutral"
                displayLabel
                icon={<Network className="h-4 w-4" strokeWidth={1.9} />}
              />
            </ToolMenuGroup>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`advanced-session-actions mobius-chat-input-actions flex flex-col gap-1.5${condensed ? ` advanced-session-actions--compact ${compact ? 'w-[176px]' : 'w-[336px] max-w-[calc(100vw-24px)]'} flex-none rounded-lg border p-2 shadow-sm` : ''}`}
      style={condensed ? { background: 'var(--input-bg)', borderColor: 'var(--border-color)' } : undefined}
      data-testid="advanced-session-actions"
      data-variant={variant}
      aria-label="高级会话按钮组"
    >
      <div className="grid grid-cols-5 gap-2 items-stretch">
        <AdvancedInteractionBtn
          onClick={onOpenFileChanges}
          disabled={!hasSession}
          label="查看文件修改"
          tooltip="查看当前会话所有文件修改"
          accent="neutral"
          displayLabel={false}
          icon={<FileDiff className="h-4 w-4" strokeWidth={1.9} />}
        />
        <AdvancedInteractionBtn
          onClick={onOpenBashCommands}
          disabled={!hasSession}
          data-tour="session-bash-commands"
          label="查看运行命令"
          tooltip="查看当前会话运行的所有Bash命令"
          accent="neutral"
          displayLabel={false}
          icon={<History className="h-4 w-4" strokeWidth={1.9} />}
        />
        <AdvancedInteractionBtn
          onClick={onOpenInputReplay}
          disabled={!hasSession}
          label="回放输入"
          tooltip="回放输入"
          accent="neutral"
          displayLabel={false}
          icon={<RotateCcw className="h-4 w-4" strokeWidth={1.9} />}
        />
        <AdvancedInteractionBtn
          onClick={onToggleJsonlMeta}
          disabled={jsonlEntryCount === 0}
          label={showJsonlMeta ? '隐藏时间与序号' : '显示时间与序号'}
          tooltip={showJsonlMeta ? '隐藏 JSONL 卡片标题里的序号与时间前缀' : '在 JSONL 卡片标题里显示 #序号 与 MM-DD HH:MM:SS 时间前缀'}
          accent="neutral"
          displayLabel={false}
          aria-pressed={showJsonlMeta}
          className={showJsonlMeta ? 'bg-blue-500/15' : ''}
          icon={<Clock className="h-4 w-4" strokeWidth={1.9} />}
        />
        <ProjectPortEntryButton
          projectId={projectId}
          subPath={vscodeSubPath}
          label="进入项目端口"
          triggerVariant="advanced"
          advancedDisplayLabel={false}
          onRequestRunProject={onRequestRunProject}
        />
      </div>

      <div className="mx-1 h-px bg-[var(--border-color)] opacity-40" aria-hidden />

      <div className="grid grid-cols-5 gap-2 items-stretch">
        <AdvancedInteractionBtn
          onClick={onOpenTerminal}
          disabled={!hasSession}
          label="打开终端"
          tooltip="打开当前会话终端"
          accent="neutral"
          displayLabel={false}
          icon={<Terminal className="h-4 w-4" strokeWidth={1.9} />}
        />
        <AdvancedInteractionBtn
          onClick={onOpenCooperablePc}
          data-tour="session-cooperable-pc"
          disabled={!hasSession}
          label="可合作计算机"
          tooltip="声明可合作计算机 (勾选 aimux remote, 生成声明直接发给当前 agent, 不写 Memory)"
          accent="neutral"
          displayLabel={false}
          icon={<Share2 className="h-4 w-4" strokeWidth={1.9} />}
        />
        {researchId && onOpenResearchGraph ? (
          <AdvancedInteractionBtn
            onClick={onOpenResearchGraph}
            label="Research Graph"
            tooltip="跳转到 Research Graph"
            accent="neutral"
            displayLabel={false}
            icon={<Network className="h-4 w-4" strokeWidth={1.9} />}
          />
        ) : (
          <AdvancedInteractionBtn
            onClick={onOpenKnowledge}
            disabled={!canOpenKnowledge}
            label="查看当前知识"
            tooltip="查看当前知识 (项目知识 / 本任务知识)"
            accent="neutral"
            displayLabel={false}
            icon={<BookOpen className="h-4 w-4" strokeWidth={1.9} />}
          />
        )}
        <AdvancedInteractionBtn
          onClick={onSendProjectKnowledge}
          disabled={!canSendProjectKnowledge}
          label="项目知识沉淀到记忆"
          tooltip={projectKnowledgeSending ? '正在发送项目知识沉淀指令...' : '请智能体整理并更新项目级与任务级可复用知识'}
          accent="neutral"
          displayLabel={false}
          icon={projectKnowledgeSending
            ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.9} />
            : <Wand2 className="h-4 w-4" strokeWidth={1.9} />}
        />
        <AdvancedInteractionBtn
          onClick={onContinueWithModel}
          disabled={!canContinue}
          label="修改模型并继续（新会话）"
          tooltip="新建一个 Session 并从当前 Session 继续"
          accent="neutral"
          displayLabel={false}
          icon={<Cpu className="h-4 w-4" strokeWidth={1.9} />}
        />
      </div>

      <div className="mx-1 h-px bg-[var(--border-color)] opacity-40" aria-hidden />

      {condensed && (
        <>
        <div className="grid grid-cols-3 gap-2 items-stretch">
          <AdvancedInteractionBtn
            onClick={onOpenSkill}
            disabled={!hasSession}
            label="本会话 Skill 快照"
            tooltip="查看本会话 Skill 快照"
            accent="neutral"
            displayLabel={false}
            iconClassName="h-4 w-auto gap-1.5"
            icon={(
              <>
                <Puzzle className="h-4 w-4" strokeWidth={1.9} />
                <span className="text-[11px] font-medium leading-none">Skill</span>
              </>
            )}
          />
          <AdvancedInteractionBtn
            onClick={onOpenMemory}
            disabled={!hasSession}
            label="本会话 Memory 快照"
            tooltip="查看本会话 Memory 快照"
            accent="neutral"
            displayLabel={false}
            iconClassName="h-4 w-auto gap-1.5"
            icon={(
              <>
                <Brain className="h-4 w-4" strokeWidth={1.9} />
                <span className="text-[11px] font-medium leading-none">Memory</span>
              </>
            )}
          />
          <AdvancedInteractionBtn
            onClick={onOpenGit}
            disabled={!hasSession || !projectId}
            label="Git"
            tooltip="选择 Git source；中枢可查看变更与历史"
            accent="neutral"
            displayLabel={false}
            iconClassName="h-4 w-auto gap-1.5"
            icon={(
              <>
                <GitBranch className="h-4 w-4" strokeWidth={1.9} />
                <span className="text-[11px] font-medium leading-none">Git</span>
              </>
            )}
          />
        </div>
        </>
      )}
    </div>
  )
}
