import { useEffect, useMemo, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Copy, Download, FolderOpen, MoreHorizontal, Plus, Trash2, Upload, X } from 'lucide-react'
import { ProjectUserContextWhitelist } from '../context-whitelist'
import { ToggleSwitch } from '../toggle-switch'
import { MemoriesManager } from '../memories'
import { OpenInVSCodeButton } from '../project-files'
import { SkillsManager } from '../skills'
import { UserPicker } from '../user-picker'
import { timeAgo } from '../shell'
import { api, useStore } from '../../store'
import { ProjectCardThemePicker } from '../project-card-theme-picker'
import { readContextSetupDemoState } from '../../services/context-setup-demo'
import {
  PROJECT_IMPORT_DEMO_TOUR_EVENT,
  patchProjectImportDemoState,
  readProjectImportDemoState,
} from '../../services/project-import-demo'
import { ProjectArchitecturePanel } from './ProjectArchitecturePanel'
import { ProjectAssistantPresetPanel } from './ProjectAssistantPresetPanel'
import { ProjectPackagePanel } from './ProjectPackagePanel'
import { ProjectTodosPanel } from './ProjectTodosPanel'
import { ProjectOverflowTabs, type OverflowTab } from './ProjectOverflowTabs'
import { ExpandableTextarea } from '../expandable-textarea'
import type { GitRepoDraft } from './types'
import {
  FORGOTTEN_FLAG_BACKOFF_MAX,
  FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX,
  FORGOTTEN_FLAG_PATIENCE_MAX,
} from './utils'

type ProjectMetaValues = {
  editName: string
  editDesc: string
  editBindPath: string
  editGitRepos: GitRepoDraft[]
  editDefaultUseWorktree: boolean
  editResearchEnabled: boolean
  editVisibility: 'private' | 'team' | 'public' | 'allowlist'
  editAllowUserIds: string[]
  editCanPostIssue: boolean
  editCanRunSession: boolean
  editDefaultModel: string
  editCardBorderTheme: string
  editForgottenFlagMessage: string
  editForgottenFlagIssueInit: string
  editForgottenFlagIssueBackoff: string
  editForgottenFlagIssuePatience: string
  editForgottenFlagResearchInit: string
  editForgottenFlagResearchBackoff: string
  editForgottenFlagResearchPatience: string
}

type ProjectMetaSetters = {
  setEditName: Dispatch<SetStateAction<string>>
  setEditDesc: Dispatch<SetStateAction<string>>
  setEditBindPath: Dispatch<SetStateAction<string>>
  setEditBindPathManual: Dispatch<SetStateAction<boolean>>
  setEditGitRepos: Dispatch<SetStateAction<GitRepoDraft[]>>
  setEditDefaultUseWorktree: Dispatch<SetStateAction<boolean>>
  setEditResearchEnabled: Dispatch<SetStateAction<boolean>>
  setEditVisibility: Dispatch<SetStateAction<'private' | 'team' | 'public' | 'allowlist'>>
  setEditAllowUserIds: Dispatch<SetStateAction<string[]>>
  setEditCanPostIssue: Dispatch<SetStateAction<boolean>>
  setEditCanRunSession: Dispatch<SetStateAction<boolean>>
  setEditDefaultModel: Dispatch<SetStateAction<string>>
  setEditCardBorderTheme: Dispatch<SetStateAction<string>>
  setEditForgottenFlagMessage: Dispatch<SetStateAction<string>>
  setEditForgottenFlagIssueInit: Dispatch<SetStateAction<string>>
  setEditForgottenFlagIssueBackoff: Dispatch<SetStateAction<string>>
  setEditForgottenFlagIssuePatience: Dispatch<SetStateAction<string>>
  setEditForgottenFlagResearchInit: Dispatch<SetStateAction<string>>
  setEditForgottenFlagResearchBackoff: Dispatch<SetStateAction<string>>
  setEditForgottenFlagResearchPatience: Dispatch<SetStateAction<string>>
}

type ProjectSettingsPanelProps = {
  project: any
  values: ProjectMetaValues
  setters: ProjectMetaSetters
  metaErr: string
  savingMeta: boolean
  metaDirty: boolean
  onDeleteProject: () => void
  onOpenPathPicker: () => void
  onArchitectureSessionCreated: (issue: any, session: any) => void
}

type SettingsPane = 'settings' | 'versions' | 'architecture' | 'todos' | 'package' | 'assistant'

const PROJECT_VISIBILITY_OPTIONS: Array<{ value: 'private' | 'team' | 'public' | 'allowlist'; label: string; description: string }> = [
  { value: 'private', label: '仅自己', description: '只有项目创建者和管理员可见、可建任务单。' },
  { value: 'team', label: '同组', description: '同一群组用户可见，可创建任务单和执行会话。' },
  { value: 'public', label: '公开', description: '所有登录用户可见，可创建任务单、执行会话并打开文件。' },
  { value: 'allowlist', label: '指定用户', description: '只有项目创建者、管理员和允许名单中的用户可见。' },
]

type GitTrackingCommit = {
  hash: string
  short_hash: string
  author_name: string
  author_email: string
  date: string
  relative_date: string
  subject: string
  refs?: string[]
}

type GitTrackingState = {
  available: boolean
  bind_path?: string
  repo_path?: string
  repo_name?: string
  branch?: string
  head?: string
  remote?: string
  dirty?: boolean
  dirty_count?: number
  staged_count?: number
  unstaged_count?: number
  untracked_count?: number
  reason?: string
  log_error?: string
  commits?: GitTrackingCommit[]
  updated_at?: string
}

type GitTrackingAction = 'pull' | 'push' | 'stage'

const GIT_TRACKING_ACTIONS: Array<{ key: GitTrackingAction; label: string; description: string }> = [
  { key: 'pull', label: '拉取', description: 'git pull --ff-only' },
  { key: 'push', label: '推送', description: 'git push' },
  { key: 'stage', label: '暂存', description: 'git add -A' },
]

function formatCommitDate(date: string) {
  const d = new Date(date)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function normalizeSingleLineText(value: string) {
  return value.replace(/[\r\n]+/g, ' ')
}

function isAssistantProject(project: any, userId?: string) {
  if (!project?.id || project?.created_by !== userId) return false
  const id = String(project.id)
  const name = String(project.name || '')
  const description = String(project.description || '')
  return /^xm-[a-f0-9]{10}$/.test(id)
    && (name.endsWith('的小莫助理') || name.endsWith('的小莫项目') || description.includes('小莫'))
}

function GitTrackingPanel({
  data,
  loading,
  error,
  onRefresh,
  currentCommitHash,
  isSelfDevelop,
  canDeployVersion,
  deployingHash,
  hardResettingHash,
  deployMessage,
  deployError,
  canRunGitAction,
  gitActionRunning,
  gitActionMessage,
  gitActionError,
  onGitAction,
  onDeployVersion,
  onHardResetVersion,
}: {
  data: GitTrackingState | null
  loading: boolean
  error: string
  onRefresh: () => void
  currentCommitHash?: string
  isSelfDevelop?: boolean
  canDeployVersion?: boolean
  deployingHash?: string
  hardResettingHash?: string
  deployMessage?: string
  deployError?: string
  canRunGitAction?: boolean
  gitActionRunning?: GitTrackingAction | ''
  gitActionMessage?: string
  gitActionError?: string
  onGitAction?: (action: GitTrackingAction) => void
  onDeployVersion?: (commit: GitTrackingCommit) => void
  onHardResetVersion?: (commit: GitTrackingCommit) => void
}) {
  const commits = data?.commits || []
  const [gitMenuOpen, setGitMenuOpen] = useState(false)
  const showGitActionMenu = !!data?.available && !!canRunGitAction && !!onGitAction
  const gitActionBusy = !!gitActionRunning
  const statusText = data?.dirty
    ? `有 ${data.dirty_count || 0} 个未提交变更`
    : '工作区干净'

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>版本追踪</h3>
            {data?.available && (
              <span className={`text-[11px] px-2 py-0.5 rounded-full border ${data.dirty ? 'text-amber-400 bg-amber-500/10 border-amber-500/25' : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25'}`}>
                {statusText}
              </span>
            )}
          </div>
          <div className="mt-1 text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
            {data?.available
              ? `${data.repo_path || ''}${data.branch ? ` · ${data.branch}` : ''}${data.head ? ` · ${data.head}` : ''}`
              : (data?.reason || error || '绑定路径下未检测到 Git 仓库')}
          </div>
        </div>
        <div className="relative flex shrink-0 items-center gap-2">
          <button type="button" onClick={onRefresh} disabled={loading}
            className="h-8 px-3 rounded-lg text-[12px] bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors border border-blue-500/20 disabled:opacity-50">
            {loading ? '刷新中...' : '刷新'}
          </button>
          {showGitActionMenu && (
            <>
              {gitMenuOpen && (
                <button
                  type="button"
                  aria-label="关闭 Git 操作菜单"
                  className="fixed inset-0 z-20 cursor-default bg-transparent"
                  onClick={() => setGitMenuOpen(false)}
                />
              )}
              <button
                type="button"
                aria-label="Git 操作"
                title="Git 操作"
                disabled={loading || gitActionBusy}
                onClick={() => setGitMenuOpen((value) => !value)}
                className="relative z-30 inline-flex h-8 w-8 items-center justify-center rounded-lg border border-blue-500/20 bg-blue-500/10 text-blue-400 transition-colors hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50">
                <MoreHorizontal className="h-4 w-4" strokeWidth={1.8} />
              </button>
              {gitMenuOpen && (
                <div className="absolute right-0 top-10 z-30 w-44 overflow-hidden rounded-lg border shadow-xl"
                  style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
                  {GIT_TRACKING_ACTIONS.map((item) => {
                    const runningThisAction = gitActionRunning === item.key
                    return (
                      <button
                        key={item.key}
                        type="button"
                        disabled={gitActionBusy}
                        onClick={() => {
                          setGitMenuOpen(false)
                          onGitAction?.(item.key)
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-55"
                        style={{ color: 'var(--text-primary)' }}>
                        {item.key === 'pull' ? <Download className="h-3.5 w-3.5 text-blue-400" strokeWidth={1.8} /> : null}
                        {item.key === 'push' ? <Upload className="h-3.5 w-3.5 text-emerald-400" strokeWidth={1.8} /> : null}
                        {item.key === 'stage' ? <Plus className="h-3.5 w-3.5 text-amber-400" strokeWidth={1.8} /> : null}
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{runningThisAction ? `${item.label}中...` : item.label}</span>
                          <span className="block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{item.description}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {loading && !data && (
        <div className="text-[12px] px-3 py-8 rounded-lg border text-center" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-color)' }}>
          正在检测绑定路径中的 Git 仓库...
        </div>
      )}

      {!loading && error && (
        <div className="text-[12px] px-3 py-2 rounded-lg border border-red-500/25 bg-red-500/10 text-red-400">
          {error}
        </div>
      )}

      {deployMessage && (
        <div className="text-[12px] px-3 py-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 text-emerald-400">
          {deployMessage}
        </div>
      )}

      {deployError && (
        <div className="text-[12px] px-3 py-2 rounded-lg border border-red-500/25 bg-red-500/10 text-red-400">
          {deployError}
        </div>
      )}

      {gitActionMessage && (
        <div className="text-[12px] px-3 py-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 text-emerald-400">
          {gitActionMessage}
        </div>
      )}

      {gitActionError && (
        <div className="whitespace-pre-wrap text-[12px] px-3 py-2 rounded-lg border border-red-500/25 bg-red-500/10 text-red-400">
          {gitActionError}
        </div>
      )}

      {!loading && data && !data.available && (
        <div className="text-[12px] px-3 py-8 rounded-lg border border-dashed text-center" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-color)' }}>
          {data.reason || '绑定路径下未检测到 Git 仓库'}
        </div>
      )}

      {data?.available && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
              <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>分支</div>
              <div className="text-[12px] truncate font-mono" style={{ color: 'var(--text-primary)' }}>{data.branch || 'HEAD'}</div>
            </div>
            <div className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
              <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>当前 HEAD</div>
              <div className="text-[12px] truncate font-mono" style={{ color: 'var(--text-primary)' }}>{data.head || '--'}</div>
            </div>
            <div className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
              <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>未提交</div>
              <div className="text-[12px] truncate" style={{ color: data.dirty ? '#f59e0b' : 'var(--text-primary)' }}>
                {data.dirty_count || 0} 个文件
              </div>
            </div>
          </div>

          {data.remote && (
            <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }} title={data.remote}>
              origin: {data.remote}
            </div>
          )}

          {data.log_error && (
            <div className="text-[12px] px-3 py-2 rounded-lg border border-amber-500/25 bg-amber-500/10 text-amber-400">
              {data.log_error}
            </div>
          )}

          {commits.length === 0 ? (
            <div className="text-[12px] px-3 py-8 rounded-lg border border-dashed text-center" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-color)' }}>
              当前仓库还没有提交记录
            </div>
          ) : (
            <div className="space-y-2">
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>近期 commits</div>
              {commits.map((commit) => {
                const isCurrentVersion = !!isSelfDevelop && !!currentCommitHash && commit.hash === currentCommitHash
                const canRollbackToCommit = !!isSelfDevelop && !!currentCommitHash && !isCurrentVersion && !!canDeployVersion && !!onDeployVersion
                const canHardResetToCommit = !!isSelfDevelop && !!currentCommitHash && !isCurrentVersion && !!canDeployVersion && !!onHardResetVersion
                const versionActionInProgress = !!deployingHash || !!hardResettingHash
                const deployingThisCommit = deployingHash === commit.hash
                const hardResettingThisCommit = hardResettingHash === commit.hash
                return (
                <div key={commit.hash}
                  className={`rounded-lg border px-3 py-2.5 ${isCurrentVersion ? 'mobius-current-version-commit' : ''}`}
                  style={{
                    borderColor: isCurrentVersion ? 'rgba(251,191,36,0.72)' : 'var(--border-color)',
                    background: isCurrentVersion
                      ? 'linear-gradient(135deg, rgba(251,191,36,0.12), var(--bg-secondary) 46%)'
                      : 'var(--bg-secondary)',
                  }}>
                  <div className="flex flex-col items-start gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="shrink-0 text-[11px] px-1.5 py-0.5 rounded border font-mono"
                        style={{ color: '#60a5fa', borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}
                        title={commit.hash}>
                        {commit.short_hash}
                      </code>
                      {isCurrentVersion && (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border font-medium"
                          style={{ color: '#fbbf24', borderColor: 'rgba(251,191,36,0.38)', background: 'rgba(251,191,36,0.14)' }}>
                          当前版本
                        </span>
                      )}
                      {canRollbackToCommit && (
                        <button
                          type="button"
                          disabled={versionActionInProgress}
                          onClick={() => onDeployVersion?.(commit)}
                          className="h-7 px-2.5 rounded-md text-[11px] border border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/18 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                          {deployingThisCommit ? '正在回退...' : '回退到此版本'}
                        </button>
                      )}
                      {canHardResetToCommit && (
                        <button
                          type="button"
                          disabled={versionActionInProgress}
                          onClick={() => onHardResetVersion?.(commit)}
                          className="h-7 px-2.5 rounded-md text-[11px] border border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                          {hardResettingThisCommit ? '正在硬回退...' : '回退并撤销未来更改'}
                        </button>
                      )}
                    </div>
                    <div className="min-w-0 w-full">
                      <div className="text-[13px] leading-5 break-words" style={{ color: 'var(--text-primary)' }}>
                        {commit.subject || '(无提交信息)'}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        <span className="truncate max-w-[220px]" title={commit.author_email}>{commit.author_name || 'unknown'}</span>
                        <span>·</span>
                        <span>{formatCommitDate(commit.date) || commit.relative_date}</span>
                        {commit.relative_date && <span>· {commit.relative_date}</span>}
                        {!!commit.refs?.length && (
                          <span className="truncate max-w-full" title={commit.refs.join(', ')}>· {commit.refs.join(', ')}</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SettingsCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
      <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
        <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
      </div>
      <div className="p-4 space-y-3">
        {children}
      </div>
    </section>
  )
}

// 本机工作路径行 — 仅 Electron 桌面端渲染。读写桌面端 userData 里存的 project 本机路径
// (与 aimux 调度本机/PC 任务模式同源)。支持复制 + 更改 (走 pickDirectory/confirmProjectPath)。
// 浏览器里 window.mobiusDesktop 不存在 → 返回 null, 不占位。
function LocalPcPathRow({ projectId }: { projectId: string }) {
  const md: any = typeof window !== 'undefined' ? (window as any).mobiusDesktop : undefined
  const isDesktop = !!md?.isDesktop
  const [path, setPath] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!isDesktop) return
    let cancelled = false
    md.getProjectLocalPath?.(projectId).then((p: string | null | undefined) => { if (!cancelled) setPath(p || '') })
    return () => { cancelled = true }
  }, [isDesktop, projectId])
  if (!isDesktop) return null
  const edit = async () => {
    if (busy || !md?.pickDirectory) return
    const picked = await md.pickDirectory()
    if (!picked) return
    setBusy(true)
    try {
      const r = await md.confirmProjectPath?.(projectId, picked)
      if (r?.ok) setPath(picked)
    } finally { setBusy(false) }
  }
  const copy = async () => {
    if (!path) return
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch { setCopied(false) }
  }
  return (
    <div>
      <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>本机工作路径（桌面端 · aimux 调度本机时使用）</label>
      <div className="flex min-w-0 flex-nowrap items-center gap-2">
      <input value={path} readOnly placeholder="未绑定"
        className="flex-1 min-w-0 max-w-[20rem] h-9 px-3 rounded-lg text-[13px] font-mono truncate"
        style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
      <button type="button" onClick={copy} disabled={!path}
        title={copied ? '已复制' : '复制路径'} aria-label={copied ? '已复制' : '复制路径'}
        className="h-9 w-9 flex-shrink-0 rounded-lg text-[12px] bg-[var(--bg-card-hover)] transition-colors border flex items-center justify-center disabled:opacity-40"
        style={{ color: copied ? '#34d399' : 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
        {copied ? <span className="text-[11px] font-medium">已复制</span> : <Copy className="h-3.5 w-3.5" strokeWidth={1.8} />}
      </button>
      <button type="button" onClick={edit} disabled={busy}
        className="h-9 flex-shrink-0 px-3 rounded-lg text-[12px] bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors border border-blue-500/20 flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40">
        <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.8} />
        <span>{busy ? '…' : path ? '更改' : '选择'}</span>
      </button>
      </div>
    </div>
  )
}

export function ProjectSettingsPanel({
  project,
  values,
  setters,
  metaErr,
  savingMeta,
  metaDirty,
  onDeleteProject,
  onOpenPathPicker,
  onArchitectureSessionCreated,
}: ProjectSettingsPanelProps) {
  const { user } = useStore()
  const {
    editName,
    editDesc,
    editBindPath,
    editGitRepos,
    editDefaultUseWorktree,
    editResearchEnabled,
    editVisibility,
    editAllowUserIds,
    editCanPostIssue,
    editCanRunSession,
    editDefaultModel,
    editCardBorderTheme,
    editForgottenFlagMessage,
    editForgottenFlagIssueInit,
    editForgottenFlagIssueBackoff,
    editForgottenFlagIssuePatience,
    editForgottenFlagResearchInit,
    editForgottenFlagResearchBackoff,
    editForgottenFlagResearchPatience,
  } = values
  const {
    setEditName,
    setEditDesc,
    setEditBindPath,
    setEditBindPathManual,
    setEditGitRepos,
    setEditDefaultUseWorktree,
    setEditResearchEnabled,
    setEditVisibility,
    setEditAllowUserIds,
    setEditCanPostIssue,
    setEditCanRunSession,
    setEditDefaultModel,
    setEditCardBorderTheme,
    setEditForgottenFlagMessage,
    setEditForgottenFlagIssueInit,
    setEditForgottenFlagIssueBackoff,
    setEditForgottenFlagIssuePatience,
    setEditForgottenFlagResearchInit,
    setEditForgottenFlagResearchBackoff,
    setEditForgottenFlagResearchPatience,
  } = setters

  const PaneKey = `mobius:project:pane:${project?.id || ''}`
  const paneInit = (): SettingsPane => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(PaneKey) : null
    return v && (['settings','versions','architecture','todos','package','assistant'] as const).includes(v as SettingsPane) ? v as SettingsPane : 'settings'
  }
  const [activePane, setActivePane] = useState<SettingsPane>(paneInit)
  useEffect(() => { try { localStorage.setItem(PaneKey, activePane) } catch {} }, [PaneKey, activePane])
  const [gitTracking, setGitTracking] = useState<GitTrackingState | null>(null)
  const [gitTrackingLoading, setGitTrackingLoading] = useState(false)
  const [gitTrackingErr, setGitTrackingErr] = useState('')
  const [projectModelOptions, setProjectModelOptions] = useState<Array<{ key: string; label?: string; title?: string; sub?: string }>>([])
  const [backendCommitHash, setBackendCommitHash] = useState('')
  const [deployingHash, setDeployingHash] = useState('')
  const [hardResettingHash, setHardResettingHash] = useState('')
  const [deployMessage, setDeployMessage] = useState('')
  const [deployError, setDeployError] = useState('')
  const [gitActionRunning, setGitActionRunning] = useState<GitTrackingAction | ''>('')
  const [gitActionMessage, setGitActionMessage] = useState('')
  const [gitActionError, setGitActionError] = useState('')
  const [, setImportDemoRefreshKey] = useState(0)
  const [importUploadConfirmBusy, setImportUploadConfirmBusy] = useState(false)
  const [importCleanupBusy, setImportCleanupBusy] = useState(false)
  const [importGuideMessage, setImportGuideMessage] = useState('')
  const [bindPathCopied, setBindPathCopied] = useState(false)
  const importDemoState = readProjectImportDemoState()
  const contextDemoState = readContextSetupDemoState()
  const importDemoActiveForProject = !!importDemoState?.active && importDemoState.projectId === project?.id
  const contextDemoActiveForProject = !!contextDemoState?.active && contextDemoState.projectId === project?.id
  const canManageProject = project?.can_manage !== false
  const projectBindRoot = project?.bind_path ? String(project.bind_path).replace(/\/+$/, '') : ''
  const uploadSampleZipRelPath = (importDemoState?.uploadSampleZipRelPath || 'upload-samples/vanilla-todomvc-upload-sample.zip').replace(/^\/+/, '')
  const downloadToken = (typeof localStorage !== 'undefined' && localStorage.getItem('cc-token')) || ''
  const downloadUrlForRelPath = (relPath?: string) => {
    const rel = (relPath || '').replace(/^\/+/, '')
    if (!projectBindRoot || !rel) return ''
    return `/api/download?path=${encodeURIComponent(`${projectBindRoot}/${rel}`)}${downloadToken ? `&token=${encodeURIComponent(downloadToken)}` : ''}`
  }
  const uploadSampleDownloadUrl = importDemoActiveForProject
    ? downloadUrlForRelPath(uploadSampleZipRelPath)
    : ''
  const showImportUploadCompleteButton = importDemoActiveForProject
    && !!importDemoState?.uploadSampleDownloadedAt
    && !importDemoState?.uploadSampleUploadedAt
  const showImportCleanupButton = importDemoActiveForProject
    && !!importDemoState?.uploadSampleUploadedAt
    && !importDemoState?.uploadSampleClearedAt
  const contextMaterialsZipUrl = contextDemoActiveForProject
    ? downloadUrlForRelPath(contextDemoState?.materialsZipRelPath || 'context-materials/context-setup-materials.zip')
    : ''
  const contextMemoryMaterialUrl = contextDemoActiveForProject
    ? downloadUrlForRelPath(contextDemoState?.memoryMaterialRelPath || 'context-materials/project_knowledge.md')
    : ''
  const contextSkillMaterialUrl = contextDemoActiveForProject
    ? downloadUrlForRelPath(contextDemoState?.skillMaterialRelPath || 'context-materials/weekly-notes-summary/SKILL.md')
    : ''
  const assistantProject = isAssistantProject(project, user?.id)
  const canDeleteProject = project?.created_by === user?.id
  const metaSaveStatus = !canManageProject
    ? '只读'
    : savingMeta
      ? '保存中...'
      : metaDirty
        ? '修改即将自动保存'
        : '已实时保存'
  const metaSaveStatusColor = !canManageProject
    ? 'var(--text-muted)'
    : savingMeta
      ? '#60a5fa'
      : metaDirty
        ? '#f59e0b'
        : '#10b981'

  const loadGitTracking = async () => {
    if (!project?.id) return
    setGitTrackingLoading(true)
    setGitTrackingErr('')
    try {
      const data = await api(`/api/projects/${project.id}/git-tracking?limit=12`)
      setGitTracking(data)
      if (!data?.available && activePane === 'versions') setActivePane('settings')
    } catch (e: any) {
      setGitTrackingErr(e?.message || '读取版本追踪失败')
      if (activePane === 'versions') setActivePane('settings')
    } finally {
      setGitTrackingLoading(false)
    }
  }

  const markImportSampleDownloaded = () => {
    if (!project?.id || !importDemoActiveForProject) return
    patchProjectImportDemoState({ uploadSampleDownloadedAt: Date.now() })
    setImportGuideMessage('样例已开始下载。解压后请打开网页代码编辑器，把文件夹拖进项目目录。')
    setImportDemoRefreshKey((value) => value + 1)
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(PROJECT_IMPORT_DEMO_TOUR_EVENT, { detail: { force: true } }))
    }, 360)
  }

  const confirmImportUploadSample = async () => {
    if (!project?.id || !importDemoActiveForProject || importUploadConfirmBusy) return
    setImportUploadConfirmBusy(true)
    setImportGuideMessage('')
    try {
      const data = await api(`/api/projects/${project.id}/files?path=/`)
      const entries = Array.isArray(data?.entries) ? data.entries : []
      const names = new Set(entries.map((entry: any) => String(entry?.name || '')))
      const hasUploadedFolder = names.has('vanilla-todomvc')
      const hasUploadedContents = names.has('index.html') && names.has('package.json') && names.has('src')
      if (!hasUploadedFolder && !hasUploadedContents) {
        setImportGuideMessage('还没有在项目目录里看到上传样例。请先把解压后的文件夹拖进网页代码编辑器左侧资源管理器，再点击确认。')
        return
      }
      patchProjectImportDemoState({
        uploadSampleUploadedAt: Date.now(),
        uploadWalkthroughCompletedAt: Date.now(),
      })
      setImportGuideMessage('已确认上传样例。下一步可以清空样例，再学习公开仓库下载方式。')
      setImportDemoRefreshKey((value) => value + 1)
      window.dispatchEvent(new CustomEvent(PROJECT_IMPORT_DEMO_TOUR_EVENT, { detail: { force: true } }))
    } catch (e: any) {
      setImportGuideMessage(e?.message || '确认上传样例失败')
    } finally {
      setImportUploadConfirmBusy(false)
    }
  }

  const clearImportUploadSample = async () => {
    if (!project?.id || !importDemoActiveForProject || importCleanupBusy) return
    setImportCleanupBusy(true)
    setImportGuideMessage('')
    try {
      const data = await api(`/api/projects/${project.id}/guided-demo/import/clear-upload-sample`, { method: 'POST' })
      patchProjectImportDemoState({
        uploadWalkthroughCompletedAt: Date.now(),
        uploadSampleClearedAt: Date.now(),
      })
      const removedCount = Array.isArray(data?.removed) ? data.removed.length : 0
      setImportGuideMessage(removedCount > 0
        ? '已清空上传样例，可以继续学习公开仓库下载方式。'
        : '没有发现已上传的样例，可以继续学习公开仓库下载方式。')
      setImportDemoRefreshKey((value) => value + 1)
      window.dispatchEvent(new CustomEvent(PROJECT_IMPORT_DEMO_TOUR_EVENT, { detail: { force: true } }))
    } catch (e: any) {
      setImportGuideMessage(e?.message || '清空上传样例失败')
    } finally {
      setImportCleanupBusy(false)
    }
  }

  useEffect(() => {
    let alive = true
    setGitTracking(null)
    setActivePane('settings')
    const run = async () => {
      if (!project?.id) return
      setGitTrackingLoading(true)
      setGitTrackingErr('')
      try {
        const data = await api(`/api/projects/${project.id}/git-tracking?limit=12`)
        if (!alive) return
        setGitTracking(data)
        if (!data?.available) setActivePane('settings')
      } catch (e: any) {
        if (!alive) return
        setGitTracking(null)
        setGitTrackingErr(e?.message || '读取版本追踪失败')
        setActivePane('settings')
      } finally {
        if (alive) setGitTrackingLoading(false)
      }
    }
    run()
    return () => { alive = false }
  }, [project?.id, project?.bind_path])

  useEffect(() => {
    let alive = true
    if (!project?.is_self_develop) {
      setBackendCommitHash('')
      return () => { alive = false }
    }
    const load = async () => {
      try {
        const health = await api('/api/v2/health')
        const commit = typeof health?.git_commit === 'string'
          ? health.git_commit
          : typeof health?.code_version === 'string'
            ? health.code_version.split('+')[1] || ''
            : ''
        if (alive) setBackendCommitHash(commit)
      } catch {
        if (alive) setBackendCommitHash('')
      }
    }
    load()
    return () => { alive = false }
  }, [project?.id, project?.is_self_develop])

  // 项目设置面板需要展示"默认模型偏好"下拉, 选项来自 /api/sessions/model-options.
  // 与 NewSessionModal 用的是同一个端点, 保持模型短键一致 (opus / codex / 管理员导入 key).
  useEffect(() => {
    let alive = true
    api('/api/sessions/model-options')
      .then((arr: any) => {
        if (!alive) return
        const options = Array.isArray(arr) ? arr : []
        setProjectModelOptions(options.map((opt: any) => ({
          key: String(opt?.key || ''),
          label: typeof opt?.label === 'string' ? opt.label : '',
          title: typeof opt?.title === 'string' ? opt.title : '',
          sub: typeof opt?.sub === 'string' ? opt.sub : '',
        })).filter((opt: any) => opt.key))
      })
      .catch(() => { if (alive) setProjectModelOptions([]) })
    return () => { alive = false }
  }, [])

  const deployOtherVersion = async (commit: GitTrackingCommit) => {
    if (!project?.id || !commit?.hash || deployingHash || hardResettingHash) return
    setDeployingHash(commit.hash)
    setDeployMessage('')
    setDeployError('')
    try {
      const result = await api(`/api/projects/${project.id}/deploy-version`, {
        method: 'POST',
        body: JSON.stringify({ git_hash: commit.hash }),
      })
      setDeployMessage(result?.message || `已开始回退到 ${commit.short_hash || commit.hash.slice(0, 7)}`)
    } catch (e: any) {
      setDeployError(e?.message || '启动版本回退失败')
    } finally {
      setDeployingHash('')
    }
  }

  const runGitTrackingAction = async (action: GitTrackingAction) => {
    if (!project?.id || gitActionRunning) return
    setGitActionRunning(action)
    setGitActionMessage('')
    setGitActionError('')
    setDeployMessage('')
    setDeployError('')
    try {
      const result = await api(`/api/projects/${project.id}/git-action`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      if (result?.tracking) {
        setGitTracking(result.tracking)
      } else {
        await loadGitTracking()
      }
      setGitActionMessage(result?.message || 'Git 操作完成')
    } catch (e: any) {
      setGitActionError(e?.message || 'Git 操作失败')
      loadGitTracking().catch(() => {})
    } finally {
      setGitActionRunning('')
    }
  }

  const hardResetVersion = async (commit: GitTrackingCommit) => {
    if (!project?.id || !commit?.hash || deployingHash || hardResettingHash) return
    setHardResettingHash(commit.hash)
    setDeployMessage('')
    setDeployError('')
    try {
      const result = await api(`/api/projects/${project.id}/hard-reset-version`, {
        method: 'POST',
        body: JSON.stringify({ git_hash: commit.hash }),
      })
      setDeployMessage(result?.message || `已开始硬回退到 ${commit.short_hash || commit.hash.slice(0, 7)}`)
    } catch (e: any) {
      setDeployError(e?.message || '启动版本硬回退失败')
    } finally {
      setHardResettingHash('')
    }
  }

  const gitTrackingAvailable = !!gitTracking?.available
  const gitTrackingTitle = gitTrackingLoading
    ? '正在检测 Git 仓库'
    : gitTrackingAvailable
      ? '查看近期 Git commit'
      : (gitTracking?.reason || gitTrackingErr || '绑定路径下未检测到 Git 仓库')
  const embeddedSettingsCardStyle = { '--bg-card': 'var(--bg-secondary)' } as CSSProperties

  // 顶部 tab 列表 (数据驱动): 空间不足时 ProjectOverflowTabs 会把溢出的 tab 收进「⋯」菜单, 而非换行.
  const settingsTabs: OverflowTab[] = useMemo(() => {
    const arr: OverflowTab[] = [
      { key: 'settings', label: '项目设置', active: activePane === 'settings', dataTour: 'project-settings-tab' },
      { key: 'versions', label: '版本追踪', active: activePane === 'versions', disabled: !gitTrackingAvailable, title: gitTrackingTitle },
      { key: 'architecture', label: '系统结构剖析', active: activePane === 'architecture' },
      { key: 'todos', label: '项目待办', active: activePane === 'todos' },
      { key: 'package', label: '打包下载', active: activePane === 'package' },
    ]
    if (assistantProject) arr.push({ key: 'assistant', label: '小莫预设', active: activePane === 'assistant' })
    return arr
  }, [activePane, gitTrackingAvailable, gitTrackingTitle, assistantProject])

  const handleSelectPane = (key: string) => {
    setActivePane(key as SettingsPane)
    if (key === 'versions' && !gitTracking) loadGitTracking()
  }

  return (
    <section data-tour="project-settings-panel" className="w-full lg:w-1/2 overflow-hidden" style={{ borderColor: 'var(--border-color)' }}>
      <div className="flex items-center gap-2" style={{ borderColor: 'var(--border-color)' }}>
        <ProjectOverflowTabs
          tabs={settingsTabs}
          onSelect={handleSelectPane}
          className="flex-1 min-w-0"
        />
      </div>

      {project.kind === 'extension' && (
        <div className="px-5 py-3 border mt-3 rounded-lg text-[12px]"
          style={{ borderColor: 'var(--border-color)', background: 'rgba(167,139,250,0.06)', color: '#a78bfa' }}>
          这是一个特殊拓展项目, 由 <code style={{ background: 'rgba(0,0,0,0.2)', padding: '0 4px', borderRadius: 3 }}>mobius/extension/{project.extension_name}</code> 自动同步.
          名称 / 描述 / 路径 / worktree / Research 由 manifest 锁定, 不可在此修改.
          {project.disabled && <span style={{ color: '#f87171' }}> [目录已消失, 但数据保留]</span>}
          <span className="block mt-1">本项目所有会话必选 mobius-extension skill, 用于带上拓展开发的协议与目录规范.</span>
        </div>
      )}

      <div className="flex items-center gap-2 border rounded-lg mt-3" style={{background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}>

        {activePane === 'assistant' && assistantProject ? (
          <div className="p-5">
            <ProjectAssistantPresetPanel projectId={project.id} />
          </div>
        ) : activePane === 'architecture' ? (
          <div className="p-5">
            <ProjectArchitecturePanel
              projectId={project.id}
              onSessionCreated={onArchitectureSessionCreated}
            />
          </div>
        ) : activePane === 'todos' ? (
          <div className="p-5">
            <ProjectTodosPanel projectId={project.id} canManage={canManageProject} />
          </div>
        ) : activePane === 'package' ? (
          <div className="p-5">
            <ProjectPackagePanel projectId={project.id} />
          </div>
        ) : activePane === 'versions' ? (
          <GitTrackingPanel
            data={gitTracking}
            loading={gitTrackingLoading}
            error={gitTrackingErr}
            onRefresh={loadGitTracking}
            currentCommitHash={backendCommitHash}
            isSelfDevelop={!!project?.is_self_develop}
            canDeployVersion={user?.role === 'admin'}
            deployingHash={deployingHash}
            hardResettingHash={hardResettingHash}
            deployMessage={deployMessage}
            deployError={deployError}
            canRunGitAction={canManageProject}
            gitActionRunning={gitActionRunning}
            gitActionMessage={gitActionMessage}
            gitActionError={gitActionError}
            onGitAction={runGitTrackingAction}
            onDeployVersion={deployOtherVersion}
            onHardResetVersion={hardResetVersion}
          />
        ) : (
        <div className="p-3 space-y-4">
          {!canManageProject && (
            <div className="rounded-lg border px-3 py-2 text-[12px] leading-5"
              style={{ borderColor: 'rgba(59,130,246,0.28)', background: 'rgba(59,130,246,0.08)', color: 'var(--text-secondary)' }}>
              当前账号可以查看和使用此项目；项目设置只有 owner/admin 可以修改。
            </div>
          )}
          {canManageProject && !canDeleteProject && project.kind !== 'extension' && (
            <div className="rounded-lg border px-3 py-2 text-[12px] leading-5"
              style={{ borderColor: 'rgba(245,158,11,0.28)', background: 'rgba(245,158,11,0.08)', color: 'var(--text-secondary)' }}>
              当前账号可以修改项目设置；删除项目只允许项目创建者操作。
            </div>
          )}

          {/* 拓展项目: name / description / bindPath / worktree / research 都由 manifest 锁定 */}
          {project.kind === 'extension' ? null : (
            <SettingsCard title="基本设置">
              <LocalPcPathRow projectId={project.id} />
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>名称</label>
                  <textarea value={editName} disabled={!canManageProject} onChange={e => setEditName(normalizeSingleLineText(e.target.value))}
                    onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
                    rows={2}
                    className="w-full h-20 px-3 py-2 rounded-lg text-left text-[13px] leading-5 resize-none overflow-hidden focus:outline-none focus:border-blue-500/30 disabled:opacity-60"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                </div>
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>描述</label>
                  <ExpandableTextarea value={editDesc} disabled={!canManageProject} onValueChange={setEditDesc} rows={2}
                    overlayTitle="编辑项目描述"
                    className="w-full h-20 px-3 py-2 rounded-lg text-[13px] leading-5 resize-none overflow-hidden focus:outline-none focus:border-blue-500/30 disabled:opacity-60"
                    style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                </div>
                <div className="xl:col-span-2">
                  <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>绑定路径</label>
                  <div className="flex min-w-0 flex-nowrap items-center gap-2">
                    <input value={editBindPath} readOnly disabled={!canManageProject} placeholder="未绑定（限家目录下）"
                      onClick={() => { if (canManageProject) onOpenPathPicker() }}
                      className="flex-1 min-w-0 max-w-[16rem] h-9 px-3 rounded-lg text-[13px] cursor-pointer focus:outline-none focus:border-blue-500/30 disabled:cursor-default disabled:opacity-60 truncate"
                      style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                    <button type="button" onClick={onOpenPathPicker} disabled={!canManageProject}
                      className="h-9 flex-shrink-0 px-3 rounded-lg text-[12px] bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors border border-blue-500/20 flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed">
                      <FolderOpen className="h-3.5 w-3.5" strokeWidth={1.8} />
                      <span>选择路径</span>
                    </button>
                    {!!project.bind_path && editBindPath === (project.bind_path || '') && (
                      <OpenInVSCodeButton
                        key={`${project.id}:${project.bind_path || ''}`}
                        projectId={project.id}
                        mode="direct"
                        showWorktreeOption={false}
                        className="h-9 flex-shrink-0 px-3 rounded-lg text-[12px] bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors border border-blue-500/20 flex items-center gap-1.5 whitespace-nowrap"
                      />
                    )}
                    {editBindPath && (
                      <button type="button" onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(editBindPath)
                          setBindPathCopied(true)
                          setTimeout(() => setBindPathCopied(false), 1200)
                        } catch {
                          setBindPathCopied(false)
                        }
                      }} title={bindPathCopied ? '已复制' : '复制路径'} aria-label={bindPathCopied ? '已复制' : '复制路径'}
                        className={`h-9 w-9 flex-shrink-0 rounded-lg text-[12px] bg-[var(--bg-card-hover)] ${bindPathCopied ? 'text-emerald-400' : 'hover:bg-blue-500/10 hover:text-blue-400'} transition-colors border flex items-center justify-center`}
                        style={{ color: bindPathCopied ? undefined : 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                        {bindPathCopied ? <span className="text-[11px] font-medium">已复制</span> : <Copy className="h-3.5 w-3.5" strokeWidth={1.8} />}
                      </button>
                    )}
                    {importDemoActiveForProject && uploadSampleDownloadUrl && (
                      <a
                        href={uploadSampleDownloadUrl}
                        download
                        onClick={markImportSampleDownloaded}
                        data-tour="project-import-sample-download"
                        className="h-9 px-3 rounded-lg text-[12px] bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 transition-colors border border-emerald-500/25 flex items-center gap-1.5 whitespace-nowrap"
                        title="仅导入演示项目显示：下载上传样例"
                      >
                        <Download className="h-3.5 w-3.5" strokeWidth={1.8} />
                        下载上传样例
                      </a>
                    )}
                    {showImportUploadCompleteButton && (
                      <button
                        type="button"
                        onClick={confirmImportUploadSample}
                        disabled={importUploadConfirmBusy}
                        data-tour="project-import-confirm-upload-sample"
                        className="h-9 px-3 rounded-lg text-[12px] bg-sky-500/15 text-sky-500 hover:bg-sky-500/25 transition-colors border border-sky-500/25 flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                        title="仅导入演示项目显示：确认已经把上传样例拖进项目目录"
                      >
                        <Upload className="h-3.5 w-3.5" strokeWidth={1.8} />
                        {importUploadConfirmBusy ? '检查中...' : '我已完成上传'}
                      </button>
                    )}
                    {showImportCleanupButton && (
                      <button
                        type="button"
                        onClick={clearImportUploadSample}
                        disabled={importCleanupBusy}
                        data-tour="project-import-clear-upload-sample"
                        className="h-9 px-3 rounded-lg text-[12px] bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 transition-colors border border-amber-500/25 flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                        title="仅导入演示项目显示：清空刚才上传的样例并继续"
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                        {importCleanupBusy ? '清理中...' : '清空上传样例'}
                      </button>
                    )}
                    {contextDemoActiveForProject && contextMaterialsZipUrl && (
                      <a
                        href={contextMaterialsZipUrl}
                        download
                        data-tour="project-context-materials-download"
                        className="h-9 px-3 rounded-lg text-[12px] bg-cyan-500/15 text-cyan-500 hover:bg-cyan-500/25 transition-colors border border-cyan-500/25 flex items-center gap-1.5 whitespace-nowrap"
                        title="仅资料配置演示项目显示：下载演示素材包"
                      >
                        <Download className="h-3.5 w-3.5" strokeWidth={1.8} />
                        下载资料包
                      </a>
                    )}
                    {contextDemoActiveForProject && contextMemoryMaterialUrl && (
                      <a
                        href={contextMemoryMaterialUrl}
                        download
                        data-tour="project-context-memory-download"
                        className="h-9 px-3 rounded-lg text-[12px] bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 transition-colors border border-emerald-500/25 flex items-center gap-1.5 whitespace-nowrap"
                        title="仅资料配置演示项目显示：下载项目知识文件"
                      >
                        <Download className="h-3.5 w-3.5" strokeWidth={1.8} />
                        下载项目知识
                      </a>
                    )}
                    {contextDemoActiveForProject && contextSkillMaterialUrl && (
                      <a
                        href={contextSkillMaterialUrl}
                        download
                        data-tour="project-context-skill-download"
                        className="h-9 px-3 rounded-lg text-[12px] bg-violet-500/15 text-violet-500 hover:bg-violet-500/25 transition-colors border border-violet-500/25 flex items-center gap-1.5 whitespace-nowrap"
                        title="仅资料配置演示项目显示：下载技能文件"
                      >
                        <Download className="h-3.5 w-3.5" strokeWidth={1.8} />
                        下载技能文件
                      </a>
                    )}
                    {importDemoActiveForProject && importGuideMessage && (
                      <div className="basis-full text-[11px] text-amber-500 leading-5">
                        {importGuideMessage}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </SettingsCard>
          )}

          {project.kind === 'extension' ? null : (
            <SettingsCard title="默认模型偏好">
              <div>
                <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>本项目新建执行会话时，默认套用的模型</label>
                <select
                  value={editDefaultModel}
                  disabled={!canManageProject}
                  onChange={e => setEditDefaultModel(e.target.value)}
                  className="w-full h-9 px-3 rounded-lg text-[13px] focus:outline-none focus:border-blue-500/30 disabled:opacity-60"
                  style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }}
                >
                  <option value="">未指定（跟随系统默认）</option>
                  {projectModelOptions.map(opt => (
                    <option key={opt.key} value={opt.key}>
                      {opt.title || opt.label || opt.key}
                    </option>
                  ))}
                  {editDefaultModel && !projectModelOptions.some(opt => opt.key === editDefaultModel) && (
                    <option value={editDefaultModel} disabled>
                      {editDefaultModel}（当前已不可用，建议改回未指定）
                    </option>
                  )}
                </select>
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  选择「未指定」时，新建执行会话沿用系统全局默认模型；选择具体模型后，该项目下新建执行会话的模型下拉会初始套用它，用户仍可在创建时手动改。已存在的执行会话和 Research Agent 团队的模型不受影响。
                </p>
              </div>
            </SettingsCard>
          )}

          <SettingsCard title="项目外观">
            <ProjectCardThemePicker
              value={editCardBorderTheme}
              disabled={!canManageProject}
              project={project}
              onChange={setEditCardBorderTheme}
            />
          </SettingsCard>

          {metaErr && <div className="text-[12px] text-red-400">{metaErr}</div>}
          {/* <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span className="text-[11px]" style={{ color: metaSaveStatusColor }}>{metaSaveStatus}</span>
          </div> */}

          <div className="pt-2" style={embeddedSettingsCardStyle}>
            <SkillsManager scope="project" projectId={project.id} />
          </div>
          <div className="pt-2" style={embeddedSettingsCardStyle}>
            <MemoriesManager scope="project" projectId={project.id} />
          </div>
          <div className="pt-2" style={embeddedSettingsCardStyle}>
            <ProjectUserContextWhitelist projectId={project.id} />
          </div>

          {project.kind === 'extension' ? null : (
            <SettingsCard title="拓展功能">
              <div>
                <ToggleSwitch
                  checked={!editResearchEnabled && editDefaultUseWorktree}
                  disabled={editResearchEnabled || !canManageProject}
                  onChange={setEditDefaultUseWorktree}
                  className="flex items-center gap-3 text-[13px]"
                  style={{ color: 'var(--text-primary)' }}>
                  默认使用 git worktree
                </ToggleSwitch>
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  {editResearchEnabled
                    ? '已启用研究系统，本项目强制禁用 worktree'
                    : '开启后，本项目新建任务时「使用 git worktree」默认打钩，否则默认不打钩'}
                </p>
              </div>
              <div className="pt-3 border-t" style={{ borderColor: 'var(--border-color)' }}>
                <ToggleSwitch
                  checked={editResearchEnabled}
                  disabled={!canManageProject}
                  onChange={enabled => {
                    setEditResearchEnabled(enabled)
                    if (enabled) setEditDefaultUseWorktree(false)
                  }}
                  className="flex items-center gap-3 text-[13px]"
                  style={{ color: 'var(--text-primary)' }}>
                  启用 Research 系统
                </ToggleSwitch>
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>开启后，本项目会显示研究入口；研究与任务并列管理。启用时会自动禁用 git worktree</p>
              </div>
              <div className="pt-3 border-t" style={{ borderColor: 'var(--border-color)' }}>
                <div className="flex items-center justify-between mb-2 gap-2">
                  <label className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>Git 仓库（可添加多个）</label>
                  <button type="button"
                    disabled={!canManageProject}
                    onClick={() => setEditGitRepos([...editGitRepos, { url: '', name: '' }])}
                    className="h-7 px-2.5 rounded-md text-[11px] bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors border border-blue-500/20 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed">
                    <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
                    添加仓库
                  </button>
                </div>
                {editGitRepos.length === 0 ? (
                  <div className="text-[11px] px-3 py-2 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                    暂无仓库，点击右上方"添加仓库"
                  </div>
                ) : (
                  <div className="space-y-2">
                    {editGitRepos.map((repo, idx) => (
                      <div key={idx} className="grid grid-cols-1 xl:grid-cols-[8rem_minmax(0,1fr)_2.25rem] gap-2">
                        <input value={repo.name || ''}
                          disabled={!canManageProject}
                          onChange={e => setEditGitRepos(editGitRepos.map((r, i) => i === idx ? { ...r, name: e.target.value } : r))}
                          placeholder="别名（可选）"
                          className="w-full h-9 px-3 rounded-lg text-[13px] focus:outline-none focus:border-blue-500/30 disabled:opacity-60"
                          style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                        <input value={repo.url}
                          disabled={!canManageProject}
                          onChange={e => setEditGitRepos(editGitRepos.map((r, i) => i === idx ? { ...r, url: e.target.value } : r))}
                          placeholder="git@github.com:org/repo.git 或 https://..."
                          className="w-full h-9 px-3 rounded-lg text-[13px] focus:outline-none focus:border-blue-500/30 disabled:opacity-60"
                          style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                        <button type="button"
                          disabled={!canManageProject}
                          onClick={() => setEditGitRepos(editGitRepos.filter((_, i) => i !== idx))}
                          title="删除仓库"
                          aria-label="删除仓库"
                          className="h-9 w-9 rounded-lg text-[12px] bg-[var(--bg-card-hover)] hover:bg-red-500/10 hover:text-red-400 transition-colors border disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
                          style={{ color: 'var(--text-muted)', borderColor: 'var(--input-border)' }}>
                          <X className="h-3.5 w-3.5" strokeWidth={1.9} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </SettingsCard>
          )}

          <SettingsCard title="巡检设置 - Agent鞭策设置">
            <div>
              <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>Agent偷懒时的自动提醒消息</label>
              <ExpandableTextarea value={editForgottenFlagMessage} disabled={!canManageProject} onValueChange={setEditForgottenFlagMessage} rows={4}
                overlayTitle="编辑自动提醒消息"
                className="w-full px-3 py-2 rounded-lg text-[13px] resize-y focus:outline-none focus:border-blue-500/30 disabled:opacity-60"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>后台每 60s 巡检，若某会话Agent已停工但running.flag未删除，自动向该会话发送此消息，鞭策其继续工作。</p>
            </div>
            <div>
              <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>被遗忘 running.flag 提醒策略</label>
              <div className="space-y-3">
                <div>
                  <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>任务会话</div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Init（分钟）</div>
                      <input type="number" min={1} max={FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX} step={1}
                        value={editForgottenFlagIssueInit}
                        disabled={!canManageProject}
                        onChange={e => setEditForgottenFlagIssueInit(e.target.value)}
                        className="w-full h-9 px-3 rounded-lg text-[13px] focus:outline-none focus:border-blue-500/30 disabled:opacity-60"
                        style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                    </div>
                    <div>
                      <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Backoff（倍数）</div>
                      <input type="number" min={1} max={FORGOTTEN_FLAG_BACKOFF_MAX} step={0.01}
                        value={editForgottenFlagIssueBackoff}
                        disabled={!canManageProject}
                        onChange={e => setEditForgottenFlagIssueBackoff(e.target.value)}
                        className="w-full h-9 px-3 rounded-lg text-[13px] focus:outline-none focus:border-blue-500/30 disabled:opacity-60"
                        style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                    </div>
                    <div>
                      <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Patience（次数）</div>
                      <input type="number" min={1} max={FORGOTTEN_FLAG_PATIENCE_MAX} step={1}
                        value={editForgottenFlagIssuePatience}
                        disabled={!canManageProject}
                        onChange={e => setEditForgottenFlagIssuePatience(e.target.value)}
                        className="w-full h-9 px-3 rounded-lg text-[13px] focus:outline-none focus:border-blue-500/30 disabled:opacity-60"
                        style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                    </div>
                  </div>
                </div>
                <div>
                  <div className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>研究智能体</div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Init（分钟）</div>
                      <input type="number" min={30} max={FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX} step={1}
                        value={editForgottenFlagResearchInit}
                        disabled={!canManageProject}
                        onChange={e => setEditForgottenFlagResearchInit(e.target.value)}
                        className="w-full h-9 px-3 rounded-lg text-[13px] focus:outline-none focus:border-blue-500/30 disabled:opacity-60"
                        style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                    </div>
                    <div>
                      <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Backoff（倍数）</div>
                      <input type="number" min={1} max={FORGOTTEN_FLAG_BACKOFF_MAX} step={0.01}
                        value={editForgottenFlagResearchBackoff}
                        disabled={!canManageProject}
                        onChange={e => setEditForgottenFlagResearchBackoff(e.target.value)}
                        className="w-full h-9 px-3 rounded-lg text-[13px] focus:outline-none focus:border-blue-500/30 disabled:opacity-60"
                        style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                    </div>
                    <div>
                      <div className="text-[10px] mb-1" style={{ color: 'var(--text-muted)' }}>Patience（次数）</div>
                      <input type="number" min={1} max={FORGOTTEN_FLAG_PATIENCE_MAX} step={1}
                        value={editForgottenFlagResearchPatience}
                        disabled={!canManageProject}
                        onChange={e => setEditForgottenFlagResearchPatience(e.target.value)}
                        className="w-full h-9 px-3 rounded-lg text-[13px] focus:outline-none focus:border-blue-500/30 disabled:opacity-60"
                        style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: 'var(--text-primary)' }} />
                    </div>
                  </div>
                </div>
              </div>
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>默认任务: 10 / 2 / 3；研究: 30 / 5 / 5。第 N 次后的下一次等待为 Init × Backoff^N；达到 Patience 后只记录日志。</p>
            </div>
          </SettingsCard>

          {project.kind === 'extension' ? null : (
            <SettingsCard title="权限设置">
              <div>
                <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>项目可见性</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {PROJECT_VISIBILITY_OPTIONS.map((option) => {
                    const active = editVisibility === option.value
                    return (
                      <button key={option.value} type="button" disabled={!canManageProject} onClick={() => setEditVisibility(option.value)}
                        title={option.description}
                        className="h-8 rounded-lg border text-[12px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        style={active
                          ? { background: 'rgba(59,130,246,0.18)', borderColor: 'rgba(59,130,246,0.48)', color: '#60a5fa' }
                          : { background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--text-muted)' }}>
                        {option.label}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  {PROJECT_VISIBILITY_OPTIONS.find(option => option.value === editVisibility)?.description}
                </p>
                <div className="mt-2 space-y-1.5">
                  <ToggleSwitch
                    checked={editCanPostIssue}
                    disabled={!canManageProject}
                    onChange={setEditCanPostIssue}
                    className="flex items-center gap-3 text-[12px]"
                    style={{ color: 'var(--text-secondary)' }}>
                    读者可创建任务单 (private 永远只允许 owner, 不受此开关影响)
                  </ToggleSwitch>
                  <ToggleSwitch
                    checked={editCanRunSession}
                    disabled={!canManageProject}
                    onChange={setEditCanRunSession}
                    className="flex items-center gap-3 text-[12px]"
                    style={{ color: 'var(--text-secondary)' }}>
                    读者可启动执行会话 (同上, private 永远只允许 owner)
                  </ToggleSwitch>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3">
                <div>
                  <label className="block text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>
                    添加用户
                    {editVisibility !== 'allowlist' && (
                      <span className="ml-1.5" style={{ color: 'var(--text-muted)' }}>
                        （仅在「指定用户」可见性下生效）
                      </span>
                    )}
                  </label>
                  <UserPicker
                    selectedIds={editAllowUserIds}
                    onChange={setEditAllowUserIds}
                    disabled={!canManageProject}
                    placeholder={editVisibility === 'allowlist' ? '输入用户名或 ID 添加...' : '先把可见性切到「指定用户」再添加'}
                    emptyHint={editVisibility === 'allowlist' ? '还没有添加任何允许用户' : '可见性非 allowlist，允许名单暂不生效'}
                  />
                  {editAllowUserIds.length > 0 && (
                    <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                      在「指定用户」可见性下，只有项目创建者、管理员和这里列出的用户可见。
                    </p>
                  )}
                </div>
              </div>
            </SettingsCard>
          )}

          {canDeleteProject && project.kind !== 'extension' && (
            <section className="rounded-lg border overflow-hidden"
              style={{ borderColor: 'rgba(239,68,68,0.38)', background: 'var(--bg-secondary)' }}>
              <div className="px-4 py-3 border-b" style={{ borderColor: 'rgba(239,68,68,0.25)' }}>
                <h3 className="text-[13px] font-semibold text-red-400">危险操作</h3>
              </div>
              <div className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px]" style={{ color: 'var(--text-primary)' }}>删除项目</div>
                    <p className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>
                      删除后，该项目及其全部 Issue、执行会话、项目知识与绑定目录资料将无法恢复。点击后需要完成多重确认。
                    </p>
                  </div>
                  <button onClick={onDeleteProject} title="删除项目（需要多重确认）"
                    data-tour="project-delete"
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-red-500/45 bg-red-500/10 px-3 text-[12px] font-medium text-red-400 transition-colors hover:bg-red-500 hover:text-white">
                    <Trash2 className="h-4 w-4" strokeWidth={1.8} />
                    删除项目
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>
        )}
      </div>
    </section>
  )
}
