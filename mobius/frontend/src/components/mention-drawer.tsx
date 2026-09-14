// @ 引用抽屉: 左侧滑出的「文件 / 智能体」双 Tab 弹层.
// 从 chat.tsx 抽出为共享组件 — 会话输入框 (ChatArea) 与新建会话/研究智能体表单
// (session-mention-picker) 复用同一抽屉, 取代旧版 fixed 浮动候选面板.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeftRight, AtSign, Bot, Check, ChevronRight, Eye, FileText, FolderOpen, Loader2, MessageCircle, RefreshCw, X } from 'lucide-react'
import { api } from '../store'
import { timeAgo } from './shell'
import { FileTreeLevel, type DirState, type Entry } from './project-files'
import { SessionGroupTree } from './session-group-tree'
import { buildRecentSessionTreeGroups } from '../services/recent-session-tree'
import { normalizeRecentSessions, type RecentSession } from '../services/recent-sessions'
import { RecentSessionRow } from './recent-session-row'
import { copyTextToClipboard } from '../utils/clipboard'

function sessionModelLabel(model?: string | null, explicitLabel?: string | null) {
  if (explicitLabel) return explicitLabel
  if (!model) return ''
  const labels: Record<string, string> = {
    opus: 'Opus',
    'opus-4.8': 'Opus',
    codex: 'GPT-5.5 Codex',
    'gpt-5.5': 'GPT-5.5 Codex',
  }
  return labels[model] || model
}

type RemoteFileSource = {
  name: string
  status: string
  remote_path: string
  hostname?: string
  hardware?: string
}

type MentionFileSource = {
  key: string
  kind: 'hub' | 'local' | 'remote'
  name: string
  status?: string
  remote_path?: string
}

export type AgentMentionMode = 'read_only' | 'bidirectional'

export type MentionAgentSession = {
  session_id: string
  name: string
  description?: string
  model?: string
  model_label?: string
  backend?: string
  agent_status?: string
  research_role?: string | null
  scope_type?: 'issue' | 'research'
  last_active?: string
  message_count?: number
  project_id?: string | null
  project_name?: string
  issue_id?: string | null
  issue_title?: string
  research_id?: string | null
  research_title?: string
  group?: 'same_scope' | 'same_project' | 'other_project'
  can_communicate?: boolean
}

type ChatDesktopFileBridge = {
  isDesktop?: boolean
  listProjectLocalFiles?: (projectId: string, path: string) => Promise<{
    ok?: boolean
    error?: string
    bind_path?: string
    entries?: Entry[]
  }>
}

function getChatDesktopFileBridge(): ChatDesktopFileBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as { mobiusDesktop?: ChatDesktopFileBridge }).mobiusDesktop
}

export function RemoteFileMentionDrawer({
  projectId,
  issueId,
  researchId,
  currentSessionId,
  open,
  onClose,
  onPickPath,
  onPickAgent,
  initialTab,
}: {
  projectId: string
  issueId?: string
  researchId?: string
  currentSessionId?: string
  open: boolean
  onClose: () => void
  onPickPath: (path: string) => void
  onPickAgent?: (agent: MentionAgentSession, mode: AgentMentionMode) => void
  /** 打开时优先停留的 Tab; 缺省按场景推断 (有会话/任务范围 → 智能体)。 */
  initialTab?: 'files' | 'agents'
}) {
  const [activeTab, setActiveTab] = useState<'files' | 'agents'>(issueId || researchId ? 'agents' : 'files')
  const [sources, setSources] = useState<RemoteFileSource[]>([])
  const [selectedSourceKey, setSelectedSourceKey] = useState('hub')
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const [sourcesError, setSourcesError] = useState('')
  const [agentSessions, setAgentSessions] = useState<MentionAgentSession[]>([])
  const [agentLoading, setAgentLoading] = useState(false)
  const [agentError, setAgentError] = useState('')
  const [pendingAgent, setPendingAgent] = useState<MentionAgentSession | null>(null)
  // 智能体 tab 内的列表范围: 'recent' = 近期活跃会话 (跨项目); 'scoped' = 原同 Scope/同项目相关性列表。
  const [agentListMode, setAgentListMode] = useState<'recent' | 'scoped'>('recent')
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([])
  const [recentLoading, setRecentLoading] = useState(false)
  const [recentError, setRecentError] = useState('')
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']))

  const sourceOptions = useMemo<MentionFileSource[]>(() => {
    const options: MentionFileSource[] = [{ key: 'hub', kind: 'hub', name: '中枢（local）' }]
    const desktop = getChatDesktopFileBridge()
    if (desktop?.isDesktop && desktop.listProjectLocalFiles) {
      options.push({ key: 'local', kind: 'local', name: '本机（local）' })
    }
    for (const source of sources) {
      options.push({
        key: `remote:${source.name}`,
        kind: 'remote',
        name: source.name,
        status: source.status,
        remote_path: source.remote_path,
      })
    }
    return options
  }, [sources])

  const loadSources = useCallback(async () => {
    if (!projectId) return
    setSourcesLoading(true)
    setSourcesError('')
    try {
      const data = await api(`/api/projects/${projectId}/remote-file-sources`)
      const next = Array.isArray(data?.remotes) ? data.remotes as RemoteFileSource[] : []
      setSources(next)
      const desktop = getChatDesktopFileBridge()
      setSelectedSourceKey(current => {
        if (current === 'hub') return current
        if (current === 'local' && desktop?.isDesktop && desktop.listProjectLocalFiles) return current
        return next.some(source => `remote:${source.name}` === current) ? current : 'hub'
      })
    } catch (error: any) {
      setSources([])
      setSelectedSourceKey('hub')
      setSourcesError(error?.message || '加载远程文件来源失败')
    } finally {
      setSourcesLoading(false)
    }
  }, [projectId])

  // 后端 /mention-targets 支持 session_id / issue_id / research_id 三种锚点:
  // 会话输入框用 session_id; 新建会话/研究智能体表单还没有 session, 用 issue_id/research_id。
  const agentScopeUrl = useMemo(() => {
    const params = new URLSearchParams()
    if (currentSessionId) params.set('session_id', currentSessionId)
    else if (issueId) params.set('issue_id', issueId)
    else if (researchId) params.set('research_id', researchId)
    else return ''
    return `/api/sessions/mention-targets?${params.toString()}`
  }, [currentSessionId, issueId, researchId])

  useEffect(() => {
    if (!open) return
    if (initialTab) setActiveTab(initialTab)
    else setActiveTab(currentSessionId || issueId || researchId ? 'agents' : 'files')
    setPendingAgent(null)
  }, [currentSessionId, initialTab, issueId, open, researchId])

  const loadAgentSessions = useCallback(async () => {
    if (!agentScopeUrl) {
      setAgentSessions([])
      return
    }
    setAgentLoading(true)
    setAgentError('')
    try {
      const data = await api(agentScopeUrl)
      const list = Array.isArray(data?.targets) ? data.targets as MentionAgentSession[] : []
      setAgentSessions(list.filter(item => item.session_id !== currentSessionId))
    } catch (error: any) {
      setAgentSessions([])
      setAgentError(error?.message || '加载智能体列表失败')
    } finally {
      setAgentLoading(false)
    }
  }, [agentScopeUrl, currentSessionId])

  useEffect(() => {
    if (!open) return
    void loadSources()
  }, [open, loadSources])

  useEffect(() => {
    if (!open || activeTab !== 'agents') return
    void loadAgentSessions()
  }, [open, activeTab, loadAgentSessions])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (pendingAgent) setPendingAgent(null)
      else onClose()
    }
    // Capture Escape before host pages (for example overview) process their own
    // global Escape shortcut and navigate away while this drawer is open.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose, pendingAgent])

  // 近期活跃会话（跨项目，登录用户自己的），与 IssuePage 侧栏「近期会话」同数据源。
  useEffect(() => {
    if (!open || activeTab !== 'agents') return
    const controller = new AbortController()
    setRecentLoading(true)
    setRecentError('')
    api('/api/tasks/recent?limit=50', { signal: controller.signal })
      .then((value: unknown) => setRecentSessions(normalizeRecentSessions(value)))
      .catch((error: any) => {
        if (error?.name === 'AbortError') return
        setRecentError(error?.message || '近期会话加载失败')
      })
      .finally(() => {
        if (!controller.signal.aborted) setRecentLoading(false)
      })
    return () => controller.abort()
  }, [open, activeTab])

  const loadDir = useCallback(async (relPath: string) => {
    if (!projectId || !selectedSourceKey) return
    const selectedSource = sourceOptions.find(source => source.key === selectedSourceKey)
    if (!selectedSource) return
    setDirs(previous => ({ ...previous, [relPath]: { ...previous[relPath], loading: true, error: undefined } }))
    try {
      const desktop = getChatDesktopFileBridge()
      const data = selectedSource.kind === 'hub'
        ? await api(`/api/projects/${projectId}/files?path=${encodeURIComponent(relPath)}`)
        : selectedSource.kind === 'local'
          ? await desktop?.listProjectLocalFiles?.(projectId, relPath)
          : await api(`/api/projects/${projectId}/remote-files?remote=${encodeURIComponent(selectedSource.name)}&path=${encodeURIComponent(relPath)}`)
      if (selectedSource.kind === 'local' && !data?.ok) throw new Error(data?.error || '加载本机文件失败')
      setDirs(previous => ({ ...previous, [relPath]: { loading: false, entries: Array.isArray(data?.entries) ? data.entries : [] } }))
    } catch (error: any) {
      setDirs(previous => ({ ...previous, [relPath]: { loading: false, error: error?.message || '加载文件目录失败' } }))
    }
  }, [projectId, selectedSourceKey, sourceOptions])

  useEffect(() => {
    if (!open) return
    if (activeTab !== 'files') return
    setDirs({})
    setExpanded(new Set(['/']))
    if (selectedSourceKey) void loadDir('/')
  }, [open, activeTab, selectedSourceKey, loadDir])

  const toggleDir = useCallback((relPath: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(relPath)) next.delete(relPath)
      else {
        next.add(relPath)
        if (!dirs[relPath]) void loadDir(relPath)
      }
      return next
    })
  }, [dirs, loadDir])

  const pickFile = useCallback((entry: Entry) => {
    if (entry.abs_path) onPickPath(entry.abs_path)
  }, [onPickPath])

  const copyPath = useCallback((entry: Entry) => {
    if (entry.abs_path) void copyTextToClipboard(entry.abs_path)
  }, [])

  const pickAgent = useCallback((agent: MentionAgentSession) => {
    if (!onPickAgent) return
    setPendingAgent(agent)
  }, [onPickAgent])

  const confirmAgentMode = useCallback((mode: AgentMentionMode) => {
    if (!pendingAgent || !onPickAgent) return
    const resolvedMode = mode === 'bidirectional' && pendingAgent.can_communicate === false
      ? 'read_only'
      : mode
    onPickAgent(pendingAgent, resolvedMode)
    setPendingAgent(null)
  }, [onPickAgent, pendingAgent])

  // 近期会话 → @ 目标: /api/tasks/recent 字段较轻，先映射成 MentionAgentSession，
  // 复用同一套模式选择弹窗；这些会话属于当前用户自己的近期 Session，可开启交流。
  const pickRecentSession = useCallback((session: RecentSession) => {
    if (!onPickAgent) return
    setPendingAgent({
      session_id: session.session_id,
      name: session.name || session.session_id,
      description: '',
      agent_status: session.agent_status,
      scope_type: session.scope_type,
      last_active: session.last_active,
      project_id: session.project_id || null,
      project_name: session.project_name || '',
      issue_id: session.issue_id || null,
      issue_title: session.issue_title || '',
      research_id: session.research_id || null,
      research_title: session.research_title || '',
      can_communicate: true,
    })
  }, [onPickAgent])

  const filteredAgents = useMemo(() => {
    // 后端已按「精确搜索 → 同 Scope → 同项目 → 运行态 → 最近活跃」稳定排序；
    // 前端不要再按运行态二次排序，否则会把精确 ID/名称命中挤到列表后面。
    return agentSessions
  }, [agentSessions])

  // 树状分组（项目 → 任务/研究 → 会话），与简易模式工作导航共享分组服务与渲染组件。
  // 组间先按后端相关性（同 Scope → 同项目 → 其他项目）排序，同级内保持活跃度排序。
  const agentGroups = useMemo(() => {
    const rankOf = (agent: MentionAgentSession) => (
      agent.group === 'same_scope' ? 0 : agent.group === 'same_project' ? 1 : 2
    )
    return buildRecentSessionTreeGroups(filteredAgents)
      .map(group => ({ group, rank: group.sessions.reduce((min, agent) => Math.min(min, rankOf(agent)), 9) }))
      .sort((a, b) => a.rank - b.rank)
      .map(entry => entry.group)
  }, [filteredAgents])

  const recentGroups = useMemo(() => buildRecentSessionTreeGroups(recentSessions), [recentSessions])

  if (!open) return null
  const selectedSource = sourceOptions.find(source => source.key === selectedSourceKey)
  const rootState = dirs['/']
  const activeLabel = activeTab === 'agents' ? (researchId ? 'Research 智能体' : 'Issue 智能体') : '项目文件'
  const activeHint = activeTab === 'agents'
    ? '选择一个 Session，并明确使用只读引用或开启交流'
    : '选择文件，把绝对路径插入输入框'

  return (
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="选择 @ 目标">
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-black/45 backdrop-blur-[1px]"
        aria-label="关闭 @ 弹层"
        onClick={onClose}
      />
      <aside
        data-testid="remote-file-mention-drawer"
        className="absolute inset-y-0 left-0 flex w-[460px] max-w-[calc(100vw-24px)] flex-col shadow-2xl transition-transform duration-200 ease-out"
        style={{ background: 'var(--modal-bg)', borderRight: '1px solid var(--border-color)' }}
      >
        <div className="flex h-14 flex-shrink-0 items-center gap-3 border-b px-4" style={{ borderColor: 'var(--border-color)' }}>
          <div className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
            <AtSign className="h-4 w-4" strokeWidth={1.8} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{activeLabel}</div>
            <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{activeHint}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-card-hover)] focus-visible:ring-2 focus-visible:ring-blue-500/50"
            style={{ color: 'var(--text-muted)' }}
            title="关闭"
            aria-label="关闭 @ 弹层"
          >
            <X className="h-4 w-4" strokeWidth={1.9} />
          </button>
        </div>

        <div
          className={activeTab === 'files' ? 'flex-shrink-0 border-b p-3' : 'flex min-h-0 flex-1 flex-col border-b p-3'}
          style={{ borderColor: 'var(--border-color)' }}
        >
          <div className="mb-2 flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('files')}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors"
              style={{
                borderColor: activeTab === 'files' ? 'rgba(59,130,246,0.55)' : 'var(--border-color)',
                background: activeTab === 'files' ? 'rgba(59,130,246,0.12)' : 'var(--bg-primary)',
                color: activeTab === 'files' ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              <FileText className="h-3.5 w-3.5" strokeWidth={1.8} />
              文件
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('agents')}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors"
              style={{
                borderColor: activeTab === 'agents' ? 'rgba(59,130,246,0.55)' : 'var(--border-color)',
                background: activeTab === 'agents' ? 'rgba(59,130,246,0.12)' : 'var(--bg-primary)',
                color: activeTab === 'agents' ? 'var(--text-primary)' : 'var(--text-muted)',
              }}
            >
              <Bot className="h-3.5 w-3.5" strokeWidth={1.8} />
              智能体
            </button>
          </div>
          {activeTab === 'files' ? (
            <>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>文件来源</span>
                <button
                  type="button"
                  onClick={() => void loadSources()}
                  disabled={sourcesLoading}
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-50"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <RefreshCw className={`h-3 w-3 ${sourcesLoading ? 'animate-spin' : ''}`} strokeWidth={1.8} />
                  刷新
                </button>
              </div>
              {sourcesLoading && sources.length === 0 ? (
                <div className="flex h-16 items-center justify-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  <Loader2 className="h-4 w-4 animate-spin" />加载文件来源…
                </div>
              ) : (
                <>
                  {sourcesError && <div className="mb-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">远程来源加载失败：{sourcesError}</div>}
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {sourceOptions.map(source => {
                      const active = source.key === selectedSourceKey
                      return (
                        <button
                          key={source.key}
                          type="button"
                          onClick={() => setSelectedSourceKey(source.key)}
                          className="min-w-[150px] rounded-lg border px-3 py-2 text-left transition-colors hover:bg-[var(--bg-card-hover)] focus-visible:ring-2 focus-visible:ring-blue-500/50"
                          style={{ borderColor: active ? 'rgba(59,130,246,0.55)' : 'var(--border-color)', background: active ? 'rgba(59,130,246,0.10)' : 'var(--bg-primary)' }}
                        >
                          <div className="flex items-center gap-2">
                            <span className={`h-2 w-2 flex-shrink-0 rounded-full ${source.kind !== 'remote' || source.status === 'reachable' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                            <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{source.name}</span>
                            {active && <Check className="h-3.5 w-3.5 flex-shrink-0 text-blue-400" strokeWidth={2} />}
                          </div>
                          <div className="mt-1 truncate font-mono text-[10px]" title={source.remote_path || '默认登录目录'} style={{ color: 'var(--text-muted)' }}>
                            {source.kind === 'hub' ? '项目绑定路径' : source.kind === 'local' ? 'Electron 本机路径' : (source.remote_path || '默认登录目录')}
                          </div>
                        </button>
                      )
                    })}
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              {/* 智能体 tab 内的范围切换 — 与 IssuePage 侧栏「任务会话 / 近期会话」同一交互模式 (role=tablist)。 */}
              <div className="mb-2 flex flex-shrink-0 items-center gap-1.5" data-testid="mention-agent-scope-switcher">
                <div className="flex min-w-0 flex-1 rounded-md p-0.5" role="tablist" aria-label="Session 列表范围"
                     style={{ background: 'var(--bg-secondary)' }}>
                  {([
                    ['recent', '近期会话'],
                    ['scoped', '相关智能体'],
                  ] as const).map(([mode, label]) => {
                    const active = agentListMode === mode
                    return (
                      <button
                        key={mode}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-controls="mention-agent-session-list"
                        onClick={() => setAgentListMode(mode)}
                        className="min-w-0 flex-1 truncate rounded px-1 py-1.5 text-[11px] font-medium leading-none transition-colors hover:text-[var(--text-primary)]"
                        style={{
                          color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                          background: active ? 'var(--bg-active)' : 'transparent',
                          boxShadow: active ? '0 1px 2px rgba(0,0,0,0.14)' : undefined,
                        }}
                        title={label}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div id="mention-agent-session-list" role="tabpanel" className="flex min-h-0 flex-1 flex-col">
              {agentListMode === 'recent' ? (
                recentLoading && recentSessions.length === 0 ? (
                  <div className="flex h-16 items-center justify-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    <Loader2 className="h-4 w-4 animate-spin" />加载近期会话…
                  </div>
                ) : recentError ? (
                  <div className="rounded-lg border px-3 py-2 text-[12px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
                    近期会话加载失败：{recentError}
                  </div>
                ) : recentGroups.length === 0 ? (
                  <div className="rounded-lg border px-3 py-2 text-[12px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
                    暂无近期会话。
                  </div>
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto pr-1" aria-label="按项目与任务分组的近期会话" data-testid="mention-recent-session-tree">
                    <SessionGroupTree
                      groups={recentGroups}
                      domIdPrefix="mention-recent-group"
                      renderSession={session => (
                        <RecentSessionRow
                          session={session}
                          active={session.session_id === currentSessionId}
                          onClick={() => pickRecentSession(session)}
                          variant="mention"
                          title={`${session.name || session.session_id} · @ 选择引用或交流方式`}
                        />
                      )}
                    />
                  </div>
                )
              ) : agentLoading && agentSessions.length === 0 ? (
                <div className="flex h-16 items-center justify-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  <Loader2 className="h-4 w-4 animate-spin" />加载智能体…
                </div>
              ) : (
                <>
                  {agentError && <div className="mb-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">智能体加载失败：{agentError}</div>}
                  {!agentScopeUrl ? (
                    <div className="rounded-lg border px-3 py-2 text-[12px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
                      当前会话没有 issue / research 范围，无法 @ 其他智能体。
                    </div>
                  ) : filteredAgents.length === 0 ? (
                    <div className="rounded-lg border px-3 py-2 text-[12px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
                      没有找到可 @ 的智能体。
                    </div>
                  ) : (
                    <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                      <SessionGroupTree
                        groups={agentGroups}
                        domIdPrefix="mention-agent-group"
                        renderSession={agent => {
                          const active = agent.agent_status === 'running'
                          const modelLabel = sessionModelLabel(agent.model, agent.model_label)
                          const relationLabel = agent.group === 'same_scope'
                            ? (agent.scope_type === 'research' ? '同 Research' : '同 Issue')
                            : agent.group === 'same_project' ? '同项目' : '其他项目'
                          return (
                            <button
                              type="button"
                              onClick={() => pickAgent(agent)}
                              className="relative mt-0.5 flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-card-hover)] focus-visible:ring-2 focus-visible:ring-blue-500/50"
                              style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}
                              title={`${agent.name || agent.session_id} · ${agent.session_id}`}
                            >
                              <span className="absolute -left-2.5 top-1/2 w-2 border-t" style={{ borderColor: 'var(--border-color)' }} aria-hidden="true" />
                              <span className={`h-2 w-2 flex-shrink-0 rounded-full ${active ? 'bg-emerald-400' : 'bg-slate-400'}`} />
                              <span className="min-w-0 flex-1">
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium leading-4" style={{ color: 'var(--text-primary)' }}>
                                    {agent.name || agent.session_id}
                                  </span>
                                  {agent.last_active && <span className="flex-shrink-0 text-[9px] tabular-nums leading-3" style={{ color: 'var(--text-muted)' }}>{timeAgo(agent.last_active)}</span>}
                                </span>
                                <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1 text-[9px] leading-3" style={{ color: 'var(--text-muted)' }}>
                                  <span className="max-w-[160px] truncate font-mono">{agent.session_id}</span>
                                  <span className="rounded bg-[var(--bg-card-hover)] px-1.5 py-0.5">{relationLabel}</span>
                                  {modelLabel && <span className="rounded bg-[var(--bg-card-hover)] px-1.5 py-0.5">{modelLabel}</span>}
                                  {agent.backend && <span className="rounded bg-[var(--bg-card-hover)] px-1.5 py-0.5">{agent.backend}</span>}
                                  {agent.research_role && <span className="rounded bg-[var(--bg-card-hover)] px-1.5 py-0.5">{agent.research_role}</span>}
                                </span>
                                {agent.description && (
                                  <span className="mt-1 line-clamp-2 block text-[10px] leading-4" style={{ color: 'var(--text-secondary)' }}>
                                    {agent.description}
                                  </span>
                                )}
                              </span>
                              <span className="flex flex-shrink-0 flex-col items-end gap-0.5">
                                <span className="rounded border px-1.5 py-0.5 text-[9px] leading-3" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
                                  选择模式
                                </span>
                              </span>
                            </button>
                          )
                        }}
                      />
                    </div>
                  )}
                </>
              )}
              </div>
            </div>
          )}
        </div>

        {activeTab === 'files' ? (
          <>
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex h-10 flex-shrink-0 items-center gap-1.5 border-b px-4 text-[11px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
                <FolderOpen className="h-3.5 w-3.5 text-blue-400" strokeWidth={1.8} />
                <span className="truncate">{selectedSource?.name || '未选择来源'}</span>
                {selectedSource && <ChevronRight className="h-3 w-3 flex-shrink-0" />}
                <span className="truncate font-mono">{selectedSource?.kind === 'hub' ? '项目绑定路径' : selectedSource?.kind === 'local' ? 'Electron 本机路径' : (selectedSource?.remote_path || (selectedSource ? '默认登录目录' : ''))}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                {!selectedSource ? null : !rootState ? (
                  <div className="flex h-28 items-center justify-center gap-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    <Loader2 className="h-4 w-4 animate-spin" />加载文件…
                  </div>
                ) : (
                  <FileTreeLevel
                    relPath="/"
                    depth={0}
                    dirs={dirs}
                    expanded={expanded}
                    onToggleDir={toggleDir}
                    onOpenFile={pickFile}
                    onCopyPath={copyPath}
                    vscodeReady
                    fileActionLabel="插入绝对路径"
                  />
                )}
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2 border-t px-4 py-3 text-[11px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
              <FileText className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.8} />
              点击文件后会替换当前的 <code className="rounded bg-[var(--bg-card-hover)] px-1 py-0.5">@</code> 并回到输入框
            </div>
          </>
        ) : (
          <div className="flex flex-shrink-0 items-center gap-2 border-t px-4 py-3 text-[11px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
            <ArrowLeftRight className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.8} />
            选择智能体后会插入当前输入框，并把其上下文或双向桥接语义一起发送给后端
          </div>
        )}
      </aside>
      {pendingAgent && (
        <div className="absolute inset-0 z-[95] flex items-center justify-center px-4" role="dialog" aria-modal="true" aria-labelledby="mention-agent-mode-title">
          <button
            type="button"
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
            aria-label="取消选择智能体连接方式"
            onClick={() => setPendingAgent(null)}
          />
          <div
            className="relative w-full max-w-[430px] overflow-hidden rounded-2xl shadow-2xl"
            style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
            onClick={event => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--border-color)' }}>
              <div className="min-w-0">
                <div id="mention-agent-mode-title" className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  选择连接方式
                </div>
                <div className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-muted)' }} title={pendingAgent.name || pendingAgent.session_id}>
                  为「{pendingAgent.name || pendingAgent.session_id}」选择本次 @ 引用的权限
                </div>
              </div>
              <button
                type="button"
                className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-card-hover)] focus-visible:ring-2 focus-visible:ring-blue-500/50"
                style={{ color: 'var(--text-muted)' }}
                aria-label="关闭连接方式选择"
                onClick={() => setPendingAgent(null)}
              >
                <X className="h-4 w-4" strokeWidth={1.9} />
              </button>
            </div>
            <div className="grid gap-3 p-4 sm:grid-cols-2">
              <button
                type="button"
                className="group rounded-xl border p-3 text-left transition-colors hover:border-blue-400/60 hover:bg-blue-500/[0.06] focus-visible:ring-2 focus-visible:ring-blue-500/50"
                style={{ borderColor: 'rgba(59,130,246,0.35)', background: 'rgba(59,130,246,0.06)' }}
                onClick={() => confirmAgentMode('read_only')}
              >
                <div className="mb-3 flex h-16 items-center justify-center rounded-lg border border-blue-400/20 bg-blue-500/[0.05]" aria-hidden="true">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-400/15 text-blue-300"><Eye className="h-4 w-4" strokeWidth={1.8} /></div>
                    <div className="h-px w-7 bg-blue-300/40" />
                    <div className="h-7 w-7 rounded-md border border-blue-300/40" />
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  <Eye className="h-3.5 w-3.5 text-blue-300" strokeWidth={1.8} />
                  只读引用
                </div>
                <div className="mt-1 text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>带入对方上下文，只查看不发送消息。</div>
              </button>
              <button
                type="button"
                disabled={pendingAgent.can_communicate === false}
                className="group rounded-xl border p-3 text-left transition-colors hover:border-emerald-400/60 hover:bg-emerald-500/[0.06] focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:cursor-not-allowed disabled:opacity-45"
                style={{ borderColor: 'rgba(52,211,153,0.35)', background: 'rgba(52,211,153,0.05)' }}
                onClick={() => confirmAgentMode('bidirectional')}
              >
                <div className="mb-3 flex h-16 items-center justify-center rounded-lg border border-emerald-400/20 bg-emerald-500/[0.05]" aria-hidden="true">
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-300"><MessageCircle className="h-4 w-4" strokeWidth={1.8} /></div>
                    <div className="flex w-7 flex-col gap-1"><div className="h-px w-full bg-emerald-300/60" /><div className="h-px w-full bg-emerald-300/35" /></div>
                    <div className="h-7 w-7 rounded-md border border-emerald-300/40" />
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                  <MessageCircle className="h-3.5 w-3.5 text-emerald-300" strokeWidth={1.8} />
                  开启交流
                </div>
                <div className="mt-1 text-[10px] leading-4" style={{ color: 'var(--text-muted)' }}>
                  允许当前会话向对方发送交流请求。{pendingAgent.can_communicate === false ? '该智能体不支持交流。' : ''}
                </div>
              </button>
            </div>
            <div className="border-t px-5 py-3 text-[10px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
              你可以在输入框中的智能体标签上随时调整这次引用的方式。
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
