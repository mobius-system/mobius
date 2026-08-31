import { Suspense, lazy, useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Bot, Users, Trash2 } from 'lucide-react'
import { useStore, api } from '../store'
import { TopNav, timeAgo } from '../components/shell'
import { ErrBanner, NewSessionModal, RenameSessionModal, RenameResearchModal, NewResearchLeaderModal } from '../components/modals'
import { ChatArea, SessionRow, isSessionNameMuted } from '../components/chat'
import { AgentStatusDot } from '../components/AgentStatusDot'
import { ProjectFilesCard } from '../components/project-files'
import { Loading } from '../components/shell'
import { ResizablePanel, useIsMobile } from '../components/resizable-panel'
import { usePagination, PaginationControls } from '../components/pagination'
import ResearchGraph from '../components/research-graph'
import ResearchBlackboard from '../components/research-blackboard'
import { useEditorAvailability } from '../components/workspace/use-editor-availability'
import { pollRecursive } from '../services/polling'
import { useSessionDensity } from '../services/layout-mode'

const ResearchAgentTeamModal = lazy(() => import('../components/research-agent-team-modal')
  .then(mod => ({ default: mod.ResearchAgentTeamModal })))
const EditorPane = lazy(() => import('../components/workspace/editor-pane').then(mod => ({ default: mod.EditorPane })))
const CodeConversationPane = lazy(() => import('../components/workspace/code-conversation-pane').then(mod => ({ default: mod.CodeConversationPane })))

// sidebar Research Agent 列表每页 16, 超过即分页.
const SESSION_SIDEBAR_PAGE_SIZE = 16

export default function ResearchPage() {
  const params = useParams()
  const [search, setSearch] = useSearchParams()
  const { projects, setProjects, setCurrentProject, setCurrentIssue, setCurrentResearch,
          sessionsMap, setSessionsMap, currentSession, setCurrentSession, setCurrentTask,
          workspaceLayoutMode, applySessionWorkspaceLayout } = useStore()
  const userParam = params.user || ''
  const projectId = params.project || ''
  const researchId = params.research || ''
  const sessionParam = search.get('session') || ''
  // 会话内呈现密度 (极简/专业): 原地切换 ChatArea 的 layout, 不导航不卸载 (与 IssuePage 一致).
  const sessionDensity = useSessionDensity()
  const currentView = search.get('view')
  const showGraph = currentView === 'graph'
  const showBlackboard = currentView === 'blackboard'

  // Research Agent 与 Issue Session 共用同一套三种工作区布局。此前顶栏能写入
  // workspaceLayoutMode，但 ResearchPage 从未消费该状态，因此三个菜单项点击后均无视觉变化。
  const isMobile = useIsMobile()
  const { bindPath: editorBindPath, vscodeWebUrl: editorVscodeUrl } = useEditorAvailability(projectId, !!currentSession)
  const workspaceViewActive = !!currentSession && !showGraph && !showBlackboard
  const editorAvailable = workspaceViewActive && !!editorBindPath && !!editorVscodeUrl
  const useEditorChat = workspaceLayoutMode === 'editor-chat' && editorAvailable && !isMobile
  const codeConversationAvailable = workspaceViewActive && !!editorBindPath && !isMobile
  const useCodeConversation = workspaceLayoutMode === 'code-conversation' && codeConversationAvailable
  const [editorMounted, setEditorMounted] = useState(false)
  const [codeConversationMounted, setCodeConversationMounted] = useState(false)

  useEffect(() => {
    setEditorMounted(false)
    setCodeConversationMounted(false)
  }, [projectId])

  useEffect(() => { if (useEditorChat) setEditorMounted(true) }, [useEditorChat])
  useEffect(() => { if (useCodeConversation) setCodeConversationMounted(true) }, [useCodeConversation])

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280
  const editorMinWidth = 480
  const editorMaxWidth = Math.max(editorMinWidth + 240, viewportWidth - 360)
  const editorDefaultWidth = Math.max(editorMinWidth, Math.min(editorMaxWidth, Math.floor(viewportWidth * 0.6)))

  const [researchState, setResearchState] = useState<any>(null)
  const [teamState, setTeamState] = useState<any>(null)
  const [authorizingTeam, setAuthorizingTeam] = useState(false)
  const [teamNotice, setTeamNotice] = useState('')
  const [showCreateChoice, setShowCreateChoice] = useState(false)
  const [showLeaderModal, setShowLeaderModal] = useState(false)
  const [showNewSession, setShowNewSession] = useState(false)
  const [showTeamSession, setShowTeamSession] = useState(false)
  const [teamModalMode, setTeamModalMode] = useState<'single' | 'team'>('team')
  const [editingSession, setEditingSession] = useState<any>(null)
  const [deletingSession, setDeletingSession] = useState<any>(null)
  const [editingResearch, setEditingResearch] = useState(false)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)

  const project = projects.find((p: any) => p.id === projectId)
  const sessions = useMemo<any[]>(() => sessionsMap[researchId] || [], [sessionsMap, researchId])
  const research = researchState

  useEffect(() => {
    if (!projects.length) api('/api/projects').then(setProjects).catch(() => {})
  }, [])

  useEffect(() => {
    if (project) setCurrentProject(project)
  }, [project?.id])

  useEffect(() => {
    setCurrentIssue(null)
  }, [researchId])

  useEffect(() => {
    if (!researchId) return
    let cancelled = false
    setSessionsLoaded(false)
    api(`/api/researches/${researchId}`).then((r: any) => {
      if (r && !r.error) { setResearchState(r); setCurrentResearch(r) }
    }).catch(() => {})
    api(`/api/researches/${researchId}/sessions`).then((arr: any) => {
      if (cancelled) return
      setSessionsMap(researchId, arr)
    }).catch(() => {}).finally(() => {
      if (!cancelled) setSessionsLoaded(true)
    })
    return () => { cancelled = true }
  }, [researchId])

  useEffect(() => {
    if (!researchId) return
    const poll = pollRecursive(async (signal) => {
      const state = await api(`/api/researches/${researchId}/team`, { signal })
      setTeamState(state)
    }, 5000, 10_000, { startImmediately: true })
    return poll
  }, [researchId])

  // 仿 Issue 的 "?newSession=1": 创建 Research 时勾选"立即创建 Leader"后自动打开 Leader 配置.
  useEffect(() => {
    if (search.get('newLeader') !== '1' || !researchId) return
    const next = new URLSearchParams(search)
    next.delete('newLeader')
    setSearch(next, { replace: true })
    setShowLeaderModal(true)
  }, [search, setSearch, researchId])

  useEffect(() => {
    const cur = useStore.getState().currentSession
    if (!sessionParam) {
      if (cur !== null) { setCurrentSession(null); setCurrentTask(null) }
      return
    }
    if (cur?.session_id === sessionParam) return
    const fromList = sessions.find((s: any) => s.session_id === sessionParam)
    if (fromList) {
      setCurrentSession(fromList)
      setCurrentTask(fromList as any)
      return
    }
    let cancelled = false
    api(`/api/tasks/${sessionParam}`).then((s: any) => {
      if (cancelled) return
      if (s && !s.error && s.session_id === sessionParam) {
        setCurrentSession(s)
        setCurrentTask(s as any)
      } else if (sessionsLoaded) {
        const next = new URLSearchParams(search)
        next.delete('session')
        setSearch(next, { replace: true })
      }
    }).catch(() => {
      if (cancelled) return
      if (sessionsLoaded) {
        const next = new URLSearchParams(search)
        next.delete('session')
        setSearch(next, { replace: true })
      }
    })
    return () => { cancelled = true }
  }, [sessionParam, sessions, sessionsLoaded])

  // 布局按 Research Agent 会话独立保存，切换 Agent 时恢复其上次选择。
  useEffect(() => {
    applySessionWorkspaceLayout(currentSession?.session_id || null)
  }, [currentSession?.session_id])

  // 刷新 sessions 列表. 合并而非直接覆盖: 当前会话的 agent_status 由 ChatArea 2s 轮询
  // 实时维护 (并写回 DB), 这里保留本地值, 避免周期刷新用 DB 滞后值覆盖 -> 当前会话小圆点
  // 闪烁 (尤其点"终止"后的 3s 抑制窗内 DB 仍报 running). 其余会话取后端最新值.
  const refreshSessions = useCallback(() => {
    return api(`/api/researches/${researchId}/sessions`).then((arr: any) => {
      const list = Array.isArray(arr) ? arr : []
      const store = useStore.getState()
      const cur = store.currentSession
      const prevById = new Map((store.sessionsMap[researchId] || []).map((s: any) => [s.session_id, s]))
      const merged = list.map((s: any) => {
        if (cur && s.session_id === cur.session_id) {
          const local = prevById.get(s.session_id)
          if (local && local.agent_status) return { ...s, agent_status: local.agent_status }
        }
        return s
      })
      setSessionsMap(researchId, merged)
    }).catch(() => {})
  }, [researchId, setSessionsMap])

  // 周期刷新 sessions 列表, 让侧栏其它 (非当前) session 的状态点也能实时更新, 而不是只有
  // 点进去后才变. 后端 agent-status-syncer 每 60s 重算 agent_status 写库, 这里 10s 拉一次
  // 列表即可及时拿到. 仅页面可见时轮询, 切走/最小化时停.
  useEffect(() => {
    if (!researchId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = () => {
      if (cancelled) return
      if (document.visibilityState === 'visible') refreshSessions()
      timer = setTimeout(tick, 10000)
    }
    const onVis = () => {
      if (cancelled || document.visibilityState !== 'visible') return
      if (timer) { clearTimeout(timer); timer = null }
      tick()
    }
    document.addEventListener('visibilitychange', onVis)
    timer = setTimeout(tick, 10000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [researchId, refreshSessions])
  const openCreateChoice = () => setShowCreateChoice(true)

  // 团队是否已建立 = 是否存在任何 Assistant; Research 创建本身不再自带 Leader.
  const assistantCount = useMemo(
    () => sessions.filter((s: any) => s.research_role !== 'chief_researcher').length,
    [sessions],
  )
  const hasLeader = useMemo(
    () => sessions.some((s: any) => s.research_role === 'chief_researcher'),
    [sessions],
  )
  // 新建入口统一为一条链路:
  // - 还没有任何 Agent -> 组队方式二选一: AI-Leader 自动组队 / 人工自定义组队
  // - 已有 Leader 还没有 Assistant -> 授权 Leader 创建团队
  // - 团队已建立 (任何模式) -> 只剩一个选项: 直接新建单个 Agent, 复用自定义界面
  const openNewAgent = () => {
    if (assistantCount === 0 && !hasLeader) { openCreateChoice(); return }
    if (assistantCount === 0 && hasLeader) { authorizeChiefTeam(); return }
    setTeamModalMode('single')
    setShowTeamSession(true)
  }
  const newAgentLabel = assistantCount > 0
    ? '新Agent'
    : (hasLeader ? (authorizingTeam ? '授权中' : '创建团队') : '组建团队')

  const goToSession = (sid: string) => {
    const next = new URLSearchParams(search)
    next.set('session', sid)
    next.delete('view')
    setSearch(next, { replace: false })
  }

  const goToOverview = () => {
    const next = new URLSearchParams(search)
    next.delete('session')
    next.delete('view')
    setSearch(next, { replace: false })
  }

  const authorizeChiefTeam = async () => {
    if (authorizingTeam) return
    setAuthorizingTeam(true)
    setTeamNotice('')
    try {
      const result = await api(`/api/researches/${researchId}/team/authorize`, {
        method: 'POST',
        body: JSON.stringify({ request_id: `team-authorize-${Date.now()}` }),
      })
      setTeamNotice('已授权 Chief。Chief 会按讨论方案判断并动态创建团队。')
      setTeamState(await api(`/api/researches/${researchId}/team`))
      if (result?.chief_session_id) goToSession(result.chief_session_id)
    } catch (e: any) {
      setTeamNotice(e?.message || '授权失败')
    } finally {
      setAuthorizingTeam(false)
    }
  }

  const handleDeleteSession = async (notifyOthers: boolean) => {
    if (!deletingSession) return
    const deletedSessionId = deletingSession.session_id
    const resp = await api(`/api/sessions/${deletedSessionId}`, {
      method: 'DELETE',
      body: JSON.stringify({ notify_others: notifyOthers }),
    })
    setSessionsMap(researchId, sessions.filter((s: any) => s.session_id !== deletedSessionId))
    if (currentSession?.session_id === deletedSessionId || sessionParam === deletedSessionId) {
      setCurrentSession(null)
      setCurrentTask(null)
      const next = new URLSearchParams(search)
      next.delete('session')
      setSearch(next, { replace: true })
    }
    setDeletingSession(null)
    refreshSessions()
    if (resp?.message) alert(resp.message)
  }

  const setView = (target: 'graph' | 'blackboard') => {
    const next = new URLSearchParams(search)
    if (currentView === target) next.delete('view')
    else next.set('view', target)
    setSearch(next, { replace: false })
  }

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a: any, b: any) => {
      const ar = a.research_role === 'chief_researcher' ? 0 : 1
      const br = b.research_role === 'chief_researcher' ? 0 : 1
      if (ar !== br) return ar - br
      return new Date(b.last_active).getTime() - new Date(a.last_active).getTime()
    })
  }, [sessions])

  // sidebar Research Agent 分页: 超过 16 个时每页 16; 选中 Agent (activeId) 变化自动翻到它所在页, 保证高亮项始终可见.
  const sidebarPagination = usePagination(sortedSessions, SESSION_SIDEBAR_PAGE_SIZE, {
    activeId: currentSession?.session_id,
    getId: (s: any) => s.session_id,
  })
  // 换页后把列表区滚回顶部; 否则用户滚到底点"下一页", 新页会停在中段 (列表区 scrollTop 不重置),
  // 视觉上像翻页没生效 (带 session 时 sidebar 列表被挤压, 滚动更深, 错位最明显).
  const sessionListRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (sessionListRef.current) sessionListRef.current.scrollTop = 0
  }, [sidebarPagination.page])

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--bg-primary)' }}>
      <TopNav />
      <div className="flex flex-1 min-h-0">
        {/* 普通会话布局保留原 Research 侧栏；进入任一编辑布局时隐藏。 */}
        <div className={(useEditorChat || useCodeConversation) ? 'hidden' : 'contents'}>
        <ResizablePanel
          storageKey="mobius:ui:sidebar:research"
          defaultWidth={288}
          minWidth={200}
          maxWidth={480}
          side="left"
          className="border-r flex flex-col"
          style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
          <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border-color)' }} data-tour="research-header">
            <div className="flex items-start gap-2 mb-2">
              <svg className="w-4 h-4 mt-0.5 flex-shrink-0 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a8 8 0 10-13.856 0M12 6v6l4 2" />
              </svg>
              <div className="flex-1 min-w-0">
                <button onClick={goToOverview}
                  className={`block w-full text-left text-[13px] font-semibold leading-tight hover:text-emerald-400 transition-colors truncate ${research?.status === 'completed' ? 'line-through' : ''}`}
                  style={{ color: research?.status === 'completed' ? 'var(--text-muted)' : 'var(--text-primary)' }}
                  title="返回研究智能体列表">
                  {research?.title || '加载中...'}
                </button>
                {project && (
                  <Link to={`/u/${userParam}/p/${projectId}`}
                    className="text-[11px] hover:text-blue-400 transition-colors truncate" style={{ color: 'var(--text-muted)' }}>
                    ← {project.name}
                  </Link>
                )}
              </div>
              <button onClick={() => setEditingResearch(true)} title="编辑研究"
                className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
              </button>
            </div>
            {research?.description && (
              <p className="text-[11px] leading-relaxed line-clamp-3" style={{ color: 'var(--text-secondary)' }}>{research.description}</p>
            )}
            {research && (
              <div className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
                {research.message_count || 0} 消息 · 活跃 {timeAgo(research.last_active)}
              </div>
            )}
          </div>

          <div className="px-2 py-2 border-b flex flex-col gap-1" style={{ borderColor: 'var(--border-color)' }}>
            <button onClick={() => setView('blackboard')} title="查看当前研究的 Blackboard 内容" data-tour="research-toggle-blackboard"
              className={`w-full px-3 h-9 flex items-center gap-2 rounded-lg text-[12px] font-medium transition-colors ${showBlackboard ? '' : 'hover:bg-[var(--bg-hover)]'}`}
              style={{
                background: showBlackboard ? 'rgba(16,185,129,0.12)' : 'transparent',
                color: showBlackboard ? '#10b981' : 'var(--text-secondary)',
              }}>
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              Blackboard
            </button>
            <button onClick={() => setView('graph')} title="查看研究 Graph" data-tour="research-toggle-graph"
              className={`w-full px-3 h-9 flex items-center gap-2 rounded-lg text-[12px] font-medium transition-colors ${showGraph ? '' : 'hover:bg-[var(--bg-hover)]'}`}
              style={{
                background: showGraph ? 'rgba(16,185,129,0.12)' : 'transparent',
                color: showGraph ? '#10b981' : 'var(--text-secondary)',
              }}>
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
              Research Graph
            </button>
          </div>

          <div className="px-4 py-2.5 flex items-center justify-between border-b" style={{ borderColor: 'var(--border-color)' }}>
            <button onClick={goToOverview}
              className="text-[13px] font-semibold hover:text-emerald-400 transition-colors min-w-0 truncate"
              style={{ color: 'var(--text-muted)' }}>
              Research Agents ({sessions.length})
            </button>
            <button onClick={openNewAgent}
              disabled={authorizingTeam}
              title={research?.mode === 'chief_led' && assistantCount === 0 ? '授权 Chief 创建团队' : (assistantCount === 0 ? '搭建研究团队' : '新建单个研究智能体')} data-tour="research-new-agent"
              className="h-6 px-2 flex items-center gap-1 rounded-md hover:bg-emerald-500/15 text-emerald-400 transition-colors text-[11px] shrink-0">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              {newAgentLabel}
            </button>
          </div>

          <div ref={sessionListRef} className="flex-1 overflow-y-auto px-2 py-1" data-tour="research-agent-list">
            {sortedSessions.length === 0 ? (
              <div className="text-center py-8 text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无研究智能体</div>
            ) : sidebarPagination.pagedItems.map((s: any) => (
              <SessionRow key={s.session_id}
                session={s}
                isSelected={currentSession?.session_id === s.session_id}
                onSelect={(session) => goToSession(session.session_id)}
                onEdit={(session) => setEditingSession(session)}
                onDelete={(session) => setDeletingSession(session)}
              />
            ))}
          </div>
          <PaginationControls
            compact
            page={sidebarPagination.page}
            totalPages={sidebarPagination.totalPages}
            pageStart={sidebarPagination.pageStart}
            pageEnd={sidebarPagination.pageEnd}
            totalItems={sortedSessions.length}
            onPageChange={sidebarPagination.goToPage}
          />
        </ResizablePanel>
        </div>

        {/* VSCode 编辑：首次进入后保活 iframe，切回普通模式只隐藏，避免重新连接。 */}
        {editorMounted && !isMobile && (
          <div className={useEditorChat ? 'contents' : 'hidden'}>
            <ResizablePanel
              storageKey={`mobius:ui:split:editor-chat:${projectId}`}
              defaultWidth={editorDefaultWidth}
              minWidth={editorMinWidth}
              maxWidth={editorMaxWidth}
              side="left"
              className="border-r flex flex-col"
              style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}
            >
              <Suspense fallback={<ResearchWorkspaceLoading label="正在加载 VSCode 编辑器..." />}>
                <EditorPane
                  projectName={project?.name || projectId}
                  bindPath={editorBindPath}
                  vscodeWebUrl={editorVscodeUrl}
                />
              </Suspense>
            </ResizablePanel>
          </div>
        )}

        {/* 原生文件编辑器：保活文件树、当前文件和未保存编辑状态。 */}
        {codeConversationMounted && !isMobile && (
          <div className={useCodeConversation ? 'contents' : 'hidden'}>
            <Suspense
              fallback={
                <div
                  className="flex flex-1 items-center justify-center border-r"
                  style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}
                >
                  <ResearchWorkspaceLoading label="正在加载原生文件编辑器..." />
                </div>
              }
            >
              <CodeConversationPane
                projectId={projectId}
                bindPath={editorBindPath}
                vscodeWebUrl={editorVscodeUrl}
              />
            </Suspense>
          </div>
        )}

        {showGraph ? (
          <main className="flex-1 flex flex-col min-h-0" style={{ background: 'var(--bg-secondary)' }}>
            <div className="flex-shrink-0 px-6 py-3 border-b flex items-center gap-3" style={{ borderColor: 'var(--border-color)' }}>
              <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>研究图谱</span>
              {currentSession && (
                <button onClick={() => goToSession(currentSession.session_id)}
                  className="text-[12px] hover:text-emerald-400 transition-colors" style={{ color: 'var(--text-muted)' }}>
                  ← 返回 Research Agent
                </button>
              )}
            </div>
            <div className="flex-1 min-h-0">
              <ResearchGraph researchId={researchId} />
            </div>
          </main>
        ) : showBlackboard ? (
          <main className="flex-1 flex flex-col min-h-0" style={{ background: 'var(--bg-secondary)' }}>
            <div className="flex-shrink-0 px-6 py-3 border-b flex items-center gap-3" style={{ borderColor: 'var(--border-color)' }}>
              <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>Blackboard</span>
              {currentSession && (
                <button onClick={() => goToSession(currentSession.session_id)}
                  className="text-[12px] hover:text-emerald-400 transition-colors" style={{ color: 'var(--text-muted)' }}>
                  ← 返回 Research Agent
                </button>
              )}
            </div>
            <div className="flex-1 min-h-0">
              <ResearchBlackboard researchId={researchId} />
            </div>
          </main>
        ) : currentSession ? (
          <ChatArea
            layout={(useEditorChat || useCodeConversation) ? 'stacked' : sessionDensity === 'easy' ? 'easy' : 'default'}
            onNewSession={(useEditorChat || useCodeConversation) ? openNewAgent : undefined}
          />
        ) : sessionParam ? (
          <Loading text="正在加载研究智能体..." />
        ) : (
          <ResearchSessionOverview
            sessions={sortedSessions}
            onOpenSession={goToSession}
            onNewSession={openNewAgent}
            onEdit={(s) => setEditingSession(s)}
            onDelete={(s) => setDeletingSession(s)}
            projectId={projectId}
            researchId={researchId}
            research={research}
            teamState={teamState}
            teamNotice={teamNotice}
            authorizingTeam={authorizingTeam}
          />
        )}
      </div>

      {showCreateChoice && <ResearchAgentCreateChoiceModal
        onClose={() => setShowCreateChoice(false)}
        onAiLeader={() => {
          setShowCreateChoice(false)
          // 已有 Leader -> 直接进入授权; 还没有 -> 先装配 Leader.
          if (hasLeader) authorizeChiefTeam()
          else setShowLeaderModal(true)
        }}
        onCustom={() => {
          setShowCreateChoice(false)
          // 人工自定义组队: 切换 mode 后直接打开团队向导.
          api(`/api/researches/${researchId}`, { method: 'PATCH', body: JSON.stringify({ mode: 'custom' }) })
            .then((updated: any) => { if (updated && !updated.error) { setResearchState(updated); setCurrentResearch(updated) } })
            .catch(() => {})
          setTeamModalMode('team')
          setShowTeamSession(true)
        }}
      />}
      {showLeaderModal && research && <NewResearchLeaderModal research={research}
        onClose={() => setShowLeaderModal(false)}
        onCreated={(leaderSession: any, updatedResearch: any) => {
          setShowLeaderModal(false)
          if (updatedResearch) { setResearchState(updatedResearch); setCurrentResearch(updatedResearch) }
          refreshSessions()
          if (leaderSession?.session_id) goToSession(leaderSession.session_id)
        }} />}
      {showNewSession && <NewSessionModal researchId={researchId} projectId={projectId} existingSessions={sessions} entityLabel="研究智能体" onClose={() => setShowNewSession(false)}
        defaultNamePrefix={research?.title || ''}
        defaultDescription={research?.description || ''}
        projectKind={project?.kind}
        onCreated={(s: any) => {
          setShowNewSession(false)
          refreshSessions()
          goToSession(s.session_id)
        }} />}
      {showTeamSession && (
        <Suspense fallback={
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm">
            <div className="rounded-xl border px-5 py-3 text-[13px] shadow-xl" style={{ background: 'var(--modal-bg)', borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>正在加载 Agent 团队菜单...</div>
          </div>
        }>
          <ResearchAgentTeamModal
            researchId={researchId}
            existingSessions={sortedSessions}
            assistantLimit={research?.assistant_limit || 3}
            initialMode={teamModalMode}
            defaultNamePrefix={research?.title || ''}
            defaultDescription={research?.description || ''}
            onClose={() => setShowTeamSession(false)}
            onRefresh={refreshSessions}
            onDone={(s: any) => {
              setShowTeamSession(false)
              refreshSessions()
              if (s?.session_id) goToSession(s.session_id)
            }}
          />
        </Suspense>
      )}
      {editingSession && <RenameSessionModal session={editingSession} entityLabel="研究智能体" onClose={() => setEditingSession(null)}
        onRenamed={(updated: any) => {
          setEditingSession(null)
          refreshSessions()
          if (currentSession && currentSession.session_id === updated.session_id) setCurrentSession({ ...currentSession, name: updated.name })
        }} />}
      {editingResearch && research && <RenameResearchModal research={research} onClose={() => setEditingResearch(false)}
        onRenamed={(updated: any) => {
          setEditingResearch(false)
          setResearchState(updated)
          setCurrentResearch(updated)
        }} />}
      {deletingSession && <DeleteResearchAgentModal
        session={deletingSession}
        onClose={() => setDeletingSession(null)}
        onDelete={handleDeleteSession}
      />}
    </div>
  )
}

function ResearchWorkspaceLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-[160px] w-full flex-col items-center justify-center gap-2" style={{ color: 'var(--text-muted)' }}>
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      <div className="text-[12px]">{label}</div>
    </div>
  )
}

function ResearchSessionOverview({ sessions, onOpenSession, onNewSession, onEdit, onDelete, projectId, researchId, research, teamState, teamNotice, authorizingTeam }: {
  sessions: any[]
  onOpenSession: (sid: string) => void
  onNewSession: () => void
  onEdit: (s: any) => void
  onDelete: (s: any) => void
  projectId: string
  researchId: string
  research: any
  teamState: any
  teamNotice: string
  authorizingTeam: boolean
}) {
  const [view, setView] = useState<'sessions' | 'blackboard' | 'graph'>('sessions')
  const assistantCount = sessions.filter((s: any) => s.research_role !== 'chief_researcher').length
  // 与父级 openNewAgent 同一套文案: 团队未建立时是"建团队", 建立后是"新Agent".
  const newAgentLabel = research?.mode === 'chief_led' && assistantCount === 0
    ? (authorizingTeam ? '授权中' : '创建团队')
    : (assistantCount === 0 ? '搭建团队' : '新Agent')

  return (
    <main className="flex-1 flex flex-col min-h-0" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex-shrink-0 px-6 pt-4 flex items-center gap-1 border-b" style={{ borderColor: 'var(--border-color)' }}>
        {([['sessions', '研究智能体'], ['blackboard', 'Blackboard'], ['graph', '研究 Graph']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setView(key)}
            className="px-3 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors"
            style={{
              color: view === key ? 'var(--text-primary)' : 'var(--text-muted)',
              borderColor: view === key ? '#10b981' : 'transparent',
            }}>
            {label}
          </button>
        ))}
      </div>

      {view === 'graph' ? (
        <div className="flex-1 min-h-0">
          <ResearchGraph researchId={researchId} />
        </div>
      ) : view === 'blackboard' ? (
        <div className="flex-1 min-h-0">
          <ResearchBlackboard researchId={researchId} />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>所有研究智能体</h1>
            <p className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
              共 {sessions.length} 个 Research Agent · 点击进入对话或新建 Research Agent
            </p>
          </div>
          <button onClick={onNewSession} disabled={authorizingTeam}
            className="h-9 px-4 rounded-lg text-[13px] text-white bg-emerald-500 hover:bg-emerald-600 transition-colors flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            {newAgentLabel === '授权中' ? '授权中...' : newAgentLabel}
          </button>
        </div>

        <div className="mb-5 rounded-xl border p-4" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className="rounded-full px-2 py-1 font-medium" style={{ background: research?.mode === 'chief_led' ? 'rgba(16,185,129,.12)' : 'rgba(59,130,246,.12)', color: research?.mode === 'chief_led' ? '#10b981' : '#60a5fa' }}>
              {research?.mode === 'chief_led' ? 'Chief 主导 · AI 组队' : '自定义 · 人工组队'}
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>
              存活 Assistant {teamState?.active_assistant_count ?? sessions.filter((s: any) => s.research_role === 'research_assistant').length}/{teamState?.assistant_limit ?? research?.assistant_limit ?? 3}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>Chief 不占名额</span>
            {teamState?.mutation_in_progress && <span className="text-amber-400">团队变更进行中</span>}
          </div>
          {teamNotice && <div className="mt-2 text-[11px] text-emerald-400">{teamNotice}</div>}
          {Array.isArray(teamState?.actions) && teamState.actions.length > 0 && (
            <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border-color)' }}>
              <div className="mb-2 text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>团队活动</div>
              <div className="space-y-1.5">
                {teamState.actions.slice(0, 6).map((action: any) => (
                  <div key={action.id} className="flex items-start gap-2 text-[11px]">
                    <span className={`mt-0.5 h-2 w-2 rounded-full ${action.status === 'completed' || action.status === 'authorized' ? 'bg-emerald-400' : action.status === 'failed' ? 'bg-red-400' : 'bg-amber-400 animate-pulse'}`} />
                    <span className="w-20 flex-shrink-0" style={{ color: 'var(--text-secondary)' }}>
                      {action.action_type === 'authorize' ? '用户授权' : action.action_type === 'recruit' ? '招募 Agent' : action.action_type === 'remove' ? 'Agent 离队' : action.action_type}
                    </span>
                    <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-muted)' }}>
                      {action.payload?.name || action.target_session_id || action.request_id} · {action.status}
                      {action.error ? ` · ${action.error}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {sessions.length === 0 ? (
          <div className="rounded-2xl border-dashed border-2 p-12 text-center" style={{ borderColor: 'var(--border-color)' }}>
            <div className="text-[14px] mb-3" style={{ color: 'var(--text-muted)' }}>当前研究还没有智能体</div>
            <button onClick={onNewSession}
              className="h-9 px-4 rounded-lg text-[13px] text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/15 transition-colors inline-flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              创建第一个 Research Agent
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {sessions.map((s: any) => {
              const _st = s.agent_status || 'idle'
              const isRunning = _st === 'running'
              const isFailed = _st === 'failed'
              const isCompleted = _st === 'completed'
              const nameMuted = isSessionNameMuted(_st)
              return (
                <div key={s.session_id}
                  onClick={() => onOpenSession(s.session_id)}
                  className="rounded-xl border overflow-hidden flex flex-col group cursor-pointer transition-all hover:border-emerald-500/30"
                  style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-color)' }}>
                  <div className="px-4 py-3 border-b flex items-start gap-2" style={{ borderColor: 'var(--border-color)' }}>
                    <div className="mt-1 flex-shrink-0">
                      <AgentStatusDot agentStatus={s.agent_status} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`text-[14px] font-semibold truncate ${isCompleted ? 'line-through' : ''}`}
                        style={{ color: nameMuted ? 'var(--text-muted)' : 'var(--text-primary)' }}>{s.name}</div>
                      <div className="text-[10px] mt-0.5 flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                        {isFailed && <span className="text-red-400">● 任务失败</span>}
                        {!isFailed && isRunning && <span className="text-green-400">● 执行中</span>}
                        {!isFailed && !isRunning && isCompleted && <span>已完成</span>}
                        {!isFailed && !isRunning && !isCompleted && <span>{s.research_role === 'chief_researcher' ? 'chief_researcher' : 'research_assistant'}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <button onClick={(e) => { e.stopPropagation(); onEdit(s) }} className="p-1 rounded hover:bg-white/10" title="重命名">
                        <svg className="w-3.5 h-3.5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                      </button>
                      {s.research_role !== 'chief_researcher' && (
                        <button onClick={(e) => { e.stopPropagation(); onDelete(s) }} className="p-1 rounded hover:bg-red-500/10" title="删除">
                          <Trash2 className="w-3.5 h-3.5 text-red-400" strokeWidth={1.8} />
                        </button>
                      )}
                    </div>
                  </div>

                  {s.description && (
                    <div className="px-4 py-2.5 text-[12px] leading-relaxed line-clamp-3" style={{ color: 'var(--text-secondary)' }}>
                      {s.description}
                    </div>
                  )}

                  <div className="px-4 py-2.5 mt-auto flex items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    <span>{s.message_count || 0} 消息 · {s.raw_entry_count || 0} 条原始数据</span>
                    <span>活跃 {timeAgo(s.last_active)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {projectId && (
          <div className="mt-6">
            <ProjectFilesCard projectId={projectId} />
          </div>
        )}
      </div>
      </div>
      )}
    </main>
  )
}

function ResearchAgentCreateChoiceModal({ onClose, onAiLeader, onCustom }: {
  onClose: () => void
  onAiLeader: () => void
  onCustom: () => void
}) {
  const { theme } = useStore()
  const isDark = theme !== 'light'
  const optionStyle = {
    background: 'var(--input-bg)',
    borderColor: 'var(--input-border)',
    color: 'var(--text-primary)',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[min(560px,calc(100vw-32px))] rounded-2xl border p-5 shadow-2xl"
        style={{ background: 'var(--modal-bg)', borderColor: 'var(--border-color)' }}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-semibold" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>选择组队方式</h3>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>研究还没有任何 Agent。选择 AI-Leader 自动组队，或人工自定义组队。</p>
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-[12px] hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-muted)' }}>
            关闭
          </button>
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <button onClick={onAiLeader}
            className="min-w-0 rounded-xl border p-4 text-left whitespace-normal transition-colors hover:border-blue-500/40 hover:bg-blue-500/5"
            style={optionStyle}>
            <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
              <Bot className="h-5 w-5" strokeWidth={1.8} />
            </div>
            <div className="min-w-0 whitespace-normal break-words text-[14px] font-semibold">AI-Leader 自动组队</div>
            <div className="mt-1 min-w-0 whitespace-normal break-words text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              先创建一个 AI Leader 与你讨论方案，授权后由它自动招募整个团队。
            </div>
          </button>

          <button onClick={onCustom}
            className="min-w-0 rounded-xl border p-4 text-left whitespace-normal transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/5"
            style={optionStyle}>
            <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
              <Users className="h-5 w-5" strokeWidth={1.8} />
            </div>
            <div className="min-w-0 whitespace-normal break-words text-[14px] font-semibold">人工自定义组队</div>
            <div className="mt-1 min-w-0 whitespace-normal break-words text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              团队成员由你逐个指定创建，不需要 Leader；之后随时可以再补建单个 Agent。
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}

function DeleteResearchAgentModal({ session, onClose, onDelete }: {
  session: any
  onClose: () => void
  onDelete: (notifyOthers: boolean) => Promise<void>
}) {
  const { theme } = useStore()
  const isDark = theme !== 'light'
  const [mode, setMode] = useState<'notify' | 'direct'>('notify')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const agentName = session?.name || session?.session_id || '这个研究智能体'

  const submit = async () => {
    setLoading(true)
    setErr('')
    try {
      await onDelete(mode === 'notify')
    } catch (e: any) {
      setErr(e?.message || '删除失败')
    } finally {
      setLoading(false)
    }
  }

  const optionStyle = (active: boolean) => ({
    background: active ? (isDark ? 'rgba(16,185,129,0.13)' : 'rgba(16,185,129,0.08)') : 'var(--input-bg)',
    borderColor: active ? 'rgba(16,185,129,0.55)' : 'var(--input-border)',
    color: 'var(--text-primary)',
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative w-[420px] max-w-[calc(100vw-32px)] rounded-2xl p-6 shadow-2xl" onClick={e => e.stopPropagation()}
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}>
        <div className="flex items-start gap-3 mb-4">
          <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
            <Trash2 className="w-4 h-4" strokeWidth={1.8} />
          </div>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>删除研究智能体</h3>
            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>
              这会永久删除「{agentName}」的会话记录，并关闭它的后台执行。
            </p>
          </div>
        </div>

        <div className="space-y-2 mb-4">
          <button type="button" disabled={loading} onClick={() => { setMode('notify'); setErr('') }}
            className="w-full rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50"
            style={optionStyle(mode === 'notify')}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium">告知其他智能体</span>
              <span className="h-3.5 w-3.5 rounded-full border" style={{ borderColor: mode === 'notify' ? '#10b981' : 'var(--input-border)', background: mode === 'notify' ? '#10b981' : 'transparent' }} />
            </div>
            <div className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              先由 HR 在黑板（Blackboard）写下该智能体已离开团队，再删除。
            </div>
          </button>
          <button type="button" disabled={loading} onClick={() => { setMode('direct'); setErr('') }}
            className="w-full rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50"
            style={optionStyle(mode === 'direct')}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-medium">直接删除</span>
              <span className="h-3.5 w-3.5 rounded-full border" style={{ borderColor: mode === 'direct' ? '#10b981' : 'var(--input-border)', background: mode === 'direct' ? '#10b981' : 'transparent' }} />
            </div>
            <div className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              不通知 HR，也不写黑板记录，直接删除这个 Research Agent。
            </div>
          </button>
        </div>

        {err && <ErrBanner>{err}</ErrBanner>}

        <div className="flex gap-2">
          <button onClick={onClose} disabled={loading}
            className="flex-1 h-9 rounded-xl text-[13px] bg-[var(--bg-card-hover)] border disabled:opacity-40"
            style={{ color: isDark ? '#9ca3af' : '#64748b', borderColor: 'var(--input-border)' }}>
            取消
          </button>
          <button onClick={submit} disabled={loading}
            className="flex-1 h-9 rounded-xl text-[13px] text-white bg-red-500 hover:bg-red-600 transition-colors disabled:opacity-40">
            {loading ? '删除中...' : (mode === 'notify' ? '写入并删除' : '直接删除')}
          </button>
        </div>
      </div>
    </div>
  )
}
