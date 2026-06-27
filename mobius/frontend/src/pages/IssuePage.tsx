import { useState, useEffect, useMemo } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, MessageSquarePlus, Sparkles } from 'lucide-react'
import { useStore, api } from '../store'
import { TopNav, timeAgo } from '../components/shell'
import { ResizablePanel } from '../components/resizable-panel'
import {
  NewSessionModal, RenameSessionModal, RenameIssueModal, ConfirmModal,
} from '../components/modals'
import { ChatArea, SessionRow, isSessionNameMuted } from '../components/chat'
import { AgentStatusDot } from '../components/AgentStatusDot'
import { ProjectFilesCard } from '../components/project-files'
import { Loading } from '../components/shell'
import { TruncatedText } from '../components/truncated-text'
import { isGuidedDemoSession, patchGuidedDemoSessionCompleted } from '../services/guided-demo'
import { LOGO_REVIEW_PROJECT_ID, LOGO_REVIEW_SESSION_NAME } from '../services/logo-review-demo'

const GUIDED_DEMO_TOUR_EVENT = 'imac:guided-demo-tour:start'
const SESSION_OVERVIEW_PAGE_SIZE = 15

// =====================================================================
// Issue 处理页 /u/:user/p/:project/i/:issue?session=<id>
// 左侧 sidebar：当前 issue 元数据 + sessions 清单（顶部"+ 新会话"）
// 右侧：?session=<id> 时是 ChatArea；否则是 SessionOverview
// =====================================================================
export default function IssuePage() {
  const params = useParams()
  const [search, setSearch] = useSearchParams()
  const { projects, setProjects, setCurrentProject, setCurrentIssue,
          issuesMap, setIssuesMap, sessionsMap, setSessionsMap, currentSession, setCurrentSession, setCurrentTask } = useStore()
  const userParam = params.user || ''
  const projectId = params.project || ''
  const issueId = params.issue || ''
  const sessionParam = search.get('session') || ''
  const autoOpenNewSession = search.get('newSession') === '1'

  const [issueState, setIssueState] = useState<any>(null)
  // 优先用从 ProjectPage 缓存的 issuesMap 命中；命中不上才等 GET /api/issues/:id 回来
  const issue = useMemo(() => {
    const cached = (issuesMap[projectId] || []).find((i: any) => i.id === issueId)
    return cached || issueState
  }, [issuesMap, projectId, issueId, issueState])
  const [showNewSession, setShowNewSession] = useState(false)
  const [editingSession, setEditingSession] = useState<any>(null)
  const [editingIssue, setEditingIssue] = useState(false)
  const [deletingSession, setDeletingSession] = useState<any>(null)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)

  useEffect(() => {
    if (!autoOpenNewSession || !issue) return
    setShowNewSession(true)
    const next = new URLSearchParams(search)
    next.delete('newSession')
    setSearch(next, { replace: true })
  }, [autoOpenNewSession, issue, search, setSearch])

  // 必须 useMemo，否则每次渲染都生成新 [] 引用，会让下面 sessionParam 同步 effect 死循环
  const sessions = useMemo<any[]>(() => sessionsMap[issueId] || [], [sessionsMap, issueId])
  const project = projects.find((p: any) => p.id === projectId)
  const selectedSession = currentSession?.session_id === sessionParam ? currentSession : null
  const issueSummary = ((issue?.description || issue?.title || '') as string).trim()
  const selectedSessionName = ((selectedSession?.name || '') as string).trim()
  const selectedSessionPurpose = ((selectedSession?.description || '') as string).trim()

  useEffect(() => {
    if (!projects.length) api('/api/projects').then(setProjects).catch(() => {})
  }, [])

  useEffect(() => {
    if (project) setCurrentProject(project)
  }, [project?.id])

  useEffect(() => {
    if (!issueId) return
    let cancelled = false
    setSessionsLoaded(false)
    api(`/api/issues/${issueId}`).then((iss: any) => {
      if (iss && !iss.error) { setIssueState(iss); setCurrentIssue(iss) }
    }).catch(() => {})
    api(`/api/issues/${issueId}/sessions`).then((arr: any) => {
      if (cancelled) return
      setSessionsMap(issueId, arr)
    }).catch(() => {}).finally(() => {
      if (!cancelled) setSessionsLoaded(true)
    })
    return () => { cancelled = true }
  }, [issueId])

  // URL ?session= 是唯一选中真理源：有则进入对话，无则清空展示概览.
  // 优先级:
  //   1. sessions 列表已有该 ID → 直接 setCurrentSession
  //   2. 列表尚未到 / 没该 ID → 走 GET /api/tasks/:id 单条命中, 不等列表
  //      (这样刷新带 ?session=xxx 时秒进对话, 不再先闪 SessionOverview)
  //   3. /api/tasks/:id 也 404 → 清掉 ?session= 参数, 回退概览
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
    // 列表里没命中: 直接拉单条 (不阻塞渲染 Loading)
    let cancelled = false
    api(`/api/tasks/${sessionParam}`).then((s: any) => {
      if (cancelled) return
      if (s && !s.error && s.session_id === sessionParam) {
        setCurrentSession(s)
        setCurrentTask(s as any)
      } else if (sessionsLoaded) {
        // 列表已到但里面也没这条 → 真失效, 清参数
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

  const refreshSessions = () => api(`/api/issues/${issueId}/sessions`).then((arr: any) => setSessionsMap(issueId, arr)).catch(() => {})

  const toggleIssueStar = (iss: any) => {
    if (!iss) return
    const next = !iss.starred
    // 乐观更新本地
    setIssueState((prev: any) => prev ? { ...prev, starred: next ? 1 : 0 } : prev)
    const cur = useStore.getState().currentIssue as any
    if (cur && cur.id === iss.id) setCurrentIssue({ ...cur, starred: next ? 1 : 0 } as any)
    // 同时更新 ProjectPage 传下来的缓存
    setIssuesMap(projectId, (issuesMap[projectId] || []).map((i: any) => i.id === iss.id ? { ...i, starred: next ? 1 : 0 } : i))
    api(`/api/issues/${iss.id}/star`, { method: 'PATCH', body: JSON.stringify({ starred: next }) })
      .then((updated: any) => { if (updated && !updated.error) { setIssueState(updated); setCurrentIssue(updated) } })
      .catch(() => {})
  }

  const goToSession = (sid: string) => {
    const next = new URLSearchParams(search)
    next.set('session', sid)
    setSearch(next, { replace: false })
  }

  const goToOverview = () => {
    const next = new URLSearchParams(search)
    next.delete('session')
    setSearch(next, { replace: false })
  }

  const onSelectSession = (s: any) => goToSession(s.session_id)

  // 引导式 Demo 旧路径依赖手动点 [完成] 推进 tour. 现在 [完成] 已移除, 改成
  // session list 刷新时检测 job_accomplished=true (running.flag 已删) 的 demo
  // session, 自动写入 sessionCompletedAt 推进 tour. 防抖: useEffect 依赖 sessions,
  // patchGuidedDemoSessionCompleted 内部按 sessionId 落到对应 demo state, 重复
  // patch 同一时间戳无副作用.
  useEffect(() => {
    sessions.forEach((s: any) => {
      if (s?.job_accomplished === true && isGuidedDemoSession(s.session_id)) {
        patchGuidedDemoSessionCompleted(s.session_id)
        window.dispatchEvent(new CustomEvent(GUIDED_DEMO_TOUR_EVENT, { detail: { force: false } }))
      }
    })
  }, [sessions])

  const handleDeleteSession = async () => {
    if (!deletingSession) return
    const deletedSessionId = deletingSession.session_id
    let resp: any = null
    try {
      resp = await api(`/api/sessions/${deletedSessionId}`, { method: 'DELETE' })
    } catch (e: any) { alert(e?.message || '删除失败'); return }
    setSessionsMap(issueId, sessions.filter((s: any) => s.session_id !== deletedSessionId))
    if (currentSession?.session_id === deletedSessionId || sessionParam === deletedSessionId) {
      setCurrentSession(null); setCurrentTask(null)
      const next = new URLSearchParams(search)
      next.delete('session')
      setSearch(next, { replace: true })
    }
    setDeletingSession(null)
    refreshSessions()
    // 抛出提醒: 后端检测到并清理了该 session 的后台 claude code 时, 弹窗告知用户.
    if (resp?.message) alert(resp.message)
  }

  const sortedSessions = useMemo(() => {
    return [...sessions].sort((a: any, b: any) => {
      const aActive = a.status === 'active' ? 0 : 1
      const bActive = b.status === 'active' ? 0 : 1
      if (aActive !== bActive) return aActive - bActive
      return new Date(b.last_active).getTime() - new Date(a.last_active).getTime()
    })
  }, [sessions])

  return (
    <div className="flex flex-col h-screen" style={{ background: 'var(--bg-primary)' }}>
      <TopNav />
      <div className="flex flex-1 min-h-0">
        {/* 左侧 sidebar */}
        <ResizablePanel
          storageKey="mobius:ui:sidebar:issue-sessions"
          defaultWidth={288}
          minWidth={200}
          maxWidth={480}
          side="left"
          className="border-r flex flex-col"
          style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}>
          {/* Issue 元数据 */}
          <div data-tour="issue-created-summary" className="px-4 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
            <div className="flex items-start gap-2 mb-2">
              {!!issue?.starred && <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: '#f59e0b' }} fill="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>}
              {!!issue?.pinned && <svg className="w-3 h-3 mt-1 flex-shrink-0" style={{ color: '#38bdf8' }} fill="currentColor" viewBox="0 0 24 24"><path d="M16 3l5 5-3 1-2 4-3 1-3-3-3 1-2-2 6-6-1-3 3-3-3-2 4-1z" /></svg>}
              <svg className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: issue?.status === 'completed' ? '#22c55e' : '#60a5fa' }}
                fill={issue?.status === 'completed' ? '#22c55e' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
              <div className="flex-1 min-w-0">
                <button onClick={goToOverview}
                  data-tour="issue-overview-link"
                  className={`block text-left text-[13px] font-semibold leading-tight hover:text-blue-400 transition-colors ${issue?.status === 'completed' ? 'line-through' : ''}`}
                  style={{ color: issue?.status === 'completed' ? 'var(--text-muted)' : 'var(--text-primary)' }}
                  title="返回Session列表">
                  {issue?.title || '加载中...'}
                </button>
                {project && (
                  <Link to={`/u/${userParam}/p/${projectId}`}
                    data-tour="project-back-link"
                    className="text-[11px] hover:text-blue-400 transition-colors" style={{ color: 'var(--text-muted)' }}>
                    ← {project.name}
                  </Link>
                )}
              </div>
              <button onClick={() => toggleIssueStar(issue)} title={issue?.starred ? '取消收藏' : '收藏'}
                className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors flex-shrink-0" style={{ color: issue?.starred ? '#f59e0b' : 'var(--text-muted)' }}>
                <svg className="w-3.5 h-3.5" fill={issue?.starred ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" /></svg>
              </button>
              <button onClick={() => setEditingIssue(true)} title="编辑 Issue"
                className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
              </button>
            </div>
            {selectedSession ? (
              <div className="space-y-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                <div>
                  <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Issue现状</div>
                  <TruncatedText text={issueSummary || '暂无描述'} lines={2} />
                </div>
                <div>
                  <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Session名称</div>
                  <TruncatedText text={selectedSessionName || '未命名Session'} lines={1} />
                </div>
                <div>
                  <div className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Session目的</div>
                  <TruncatedText text={selectedSessionPurpose || '未填写'} lines={2} />
                </div>
              </div>
            ) : issue?.description && (
              <TruncatedText
                text={issue.description}
                lines={3}
                className="text-[11px] leading-relaxed"
              />
            )}
            {issue && (
              <div className="text-[10px] mt-2" style={{ color: 'var(--text-muted)' }}>
                {issue.message_count || 0} 消息 · 活跃 {timeAgo(issue.last_active)}
              </div>
            )}
          </div>

          {/* Sessions 标题 + 新建按钮（同一行） */}
          <div className="px-3 py-2.5 border-b flex items-center justify-between gap-2"
               style={{ borderColor: 'var(--border-color)' }}>
            <div className="flex items-center gap-2 min-w-0">
              <button onClick={goToOverview}
                className="text-[12px] font-semibold hover:text-blue-400 transition-colors flex-shrink-0"
                style={{ color: 'var(--text-muted)' }}
                title="返回Session列表">
                Sessions
              </button>
              <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium flex-shrink-0"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--border-color)', background: 'var(--bg-card)' }}>
                {sessions.length} 个
              </span>
            </div>
            <button onClick={() => setShowNewSession(true)} title="新建Session"
              data-tour="issue-sidebar-new-session"
              className="btn-primary group flex h-8 flex-shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-semibold shadow-md shadow-black/10 transition-all">
              <MessageSquarePlus className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2} />
              <span className="whitespace-nowrap">新建 Session</span>
              <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-current/10">
                <Sparkles className="h-2.5 w-2.5" strokeWidth={2} />
              </span>
            </button>
          </div>

          {/* Sessions 列表 */}
          <div className="flex-1 overflow-y-auto px-2 py-1">
            {sortedSessions.length === 0 ? (
              <button onClick={() => setShowNewSession(true)}
                className="mt-2 w-full rounded-xl border border-dashed px-3 py-5 text-center transition-colors hover:border-blue-500/35 hover:bg-blue-500/5"
                style={{ borderColor: 'var(--border-color)' }}>
                <MessageSquarePlus className="mx-auto mb-2 h-5 w-5 text-blue-400" strokeWidth={1.8} />
                <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>创建第一个 Session</div>
                <div className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  为当前 Issue 开启一次智能体执行
                </div>
              </button>
            ) : sortedSessions.map((s: any) => (
              <SessionRow key={s.session_id}
                session={s}
                isSelected={currentSession?.session_id === s.session_id}
                onSelect={onSelectSession}
                onEdit={(s) => setEditingSession(s)}
                onDelete={(s) => setDeletingSession(s)}
              />
            ))}

          </div>
        </ResizablePanel>

        {/* 右侧:
              - 已选中 session → ChatArea
              - URL 有 ?session 但 currentSession 还没对上 (拉取中) → Loading, 不闪 SessionOverview
              - 否则 → SessionOverview */}
        {currentSession ? (
          <ChatArea />
        ) : sessionParam ? (
          <Loading text="正在加载会话..." />
        ) : (
          <SessionOverview
            sessions={sortedSessions}
            issueId={issueId}
            onOpenSession={goToSession}
            onNewSession={() => setShowNewSession(true)}
            onEdit={(s) => setEditingSession(s)}
            onDelete={(s) => setDeletingSession(s)}
            projectId={projectId}
          />
        )}
      </div>

      {showNewSession && <NewSessionModal issueId={issueId} onClose={() => setShowNewSession(false)}
        defaultNamePrefix={issue?.title || ''}
        defaultDescription={issue?.description || ''}
        defaultModel={project?.default_model ?? null}
        projectKind={project?.kind}
        onCreated={(s: any) => {
          setShowNewSession(false)
          refreshSessions()
          goToSession(s.session_id)
        }} />}
      {editingSession && <RenameSessionModal session={editingSession} onClose={() => setEditingSession(null)}
        onRenamed={(updated: any) => {
          setEditingSession(null)
          refreshSessions()
          if (currentSession && currentSession.session_id === updated.session_id) setCurrentSession({ ...currentSession, name: updated.name })
        }} />}
      {editingIssue && issue && <RenameIssueModal issue={issue} onClose={() => setEditingIssue(false)}
        onRenamed={(updated: any) => {
          setEditingIssue(false)
          setIssueState(updated)
          setCurrentIssue(updated)
        }} />}
      {deletingSession && <ConfirmModal
        title="删除Session"
        message={`确定删除Session「${deletingSession.name}」？删除后将立即永久删除，不再保留。`}
        onConfirm={handleDeleteSession}
        onClose={() => setDeletingSession(null)}
        confirmText="删除"
        confirmClass="bg-red-500 hover:bg-red-600" />}
    </div>
  )
}

// =====================================================================
// SessionOverview — 没有选中 session 时的右侧主区
// 展示 session 卡片网格 + 新建会话按钮
// =====================================================================
function SessionOverview({ sessions, issueId, onOpenSession, onNewSession, onEdit, onDelete, projectId }: {
  sessions: any[]
  issueId: string
  onOpenSession: (sid: string) => void
  onNewSession: () => void
  onEdit: (s: any) => void
  onDelete: (s: any) => void
  projectId: string
}) {
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(sessions.length / SESSION_OVERVIEW_PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const showPagination = sessions.length > SESSION_OVERVIEW_PAGE_SIZE
  const pageStart = sessions.length === 0 ? 0 : (currentPage - 1) * SESSION_OVERVIEW_PAGE_SIZE + 1
  const pageEnd = Math.min(currentPage * SESSION_OVERVIEW_PAGE_SIZE, sessions.length)
  const pagedSessions = useMemo(() => {
    const start = (currentPage - 1) * SESSION_OVERVIEW_PAGE_SIZE
    return sessions.slice(start, start + SESSION_OVERVIEW_PAGE_SIZE)
  }, [sessions, currentPage])

  useEffect(() => {
    setPage(1)
  }, [issueId])

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const goToPage = (nextPage: number) => {
    setPage(Math.min(Math.max(nextPage, 1), totalPages))
  }

  return (
    <main className="flex-1 overflow-y-auto" style={{ background: 'var(--bg-secondary)' }}>
      <div className="max-w-5xl mx-auto p-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>所有Session</h1>
            <p className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
              {showPagination
                ? `共 ${sessions.length} 个Session · 当前显示 ${pageStart}-${pageEnd} 个`
                : `共 ${sessions.length} 个Session · 点击进入对话或新建Session`}
            </p>
          </div>
        </div>

        {sessions.length === 0 ? (
          <div className="rounded-2xl border-dashed border-2 p-12 text-center" style={{ borderColor: 'var(--border-color)' }}>
            <div className="text-[14px] mb-3" style={{ color: 'var(--text-muted)' }}>当前 Issue 还没有Session</div>
            <button onClick={onNewSession}
              data-tour="issue-empty-create-session"
              className="h-10 px-4 rounded-xl text-[13px] btn-primary transition-colors inline-flex items-center gap-2 shadow-lg shadow-black/10">
              <MessageSquarePlus className="h-4 w-4" strokeWidth={2} />
              创建第一个Session
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {showPagination && (
              <SessionOverviewPagination
                page={currentPage}
                totalPages={totalPages}
                pageStart={pageStart}
                pageEnd={pageEnd}
                totalItems={sessions.length}
                onPageChange={goToPage}
              />
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {pagedSessions.map((s: any) => {
                // session 状态完全由 agent_status 决定 (单一真相源: 后端 agent-status-syncer
                // 周期重算写入, 与 GET /api/sessions/:id/status 共用判定). 前端只读 agent_status,
                // 不再二次判定 job_failed / job_accomplished / sessions_v2.status.
                const _st = s.agent_status || 'idle'
                const isFailed = _st === 'failed'
                const isRunning = _st === 'running'
                const isCompleted = _st === 'completed'
                const nameMuted = isSessionNameMuted(_st)
                const isLogoReviewSessionCard = projectId === LOGO_REVIEW_PROJECT_ID
                  && String(s.name || '').includes(LOGO_REVIEW_SESSION_NAME)
                const isGuidedOrReviewSession = isGuidedDemoSession(s.session_id) || isLogoReviewSessionCard
                return (
                  <div key={s.session_id}
                    data-tour={isGuidedDemoSession(s.session_id) ? 'session-card' : isLogoReviewSessionCard ? 'logo-review-session-card' : undefined}
                    onClick={() => onOpenSession(s.session_id)}
                    className="rounded-xl border overflow-hidden flex flex-col group cursor-pointer transition-all hover:border-blue-500/30"
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
                          {!isFailed && !isRunning && !isCompleted && <span>{s.status === 'active' ? '活跃' : s.status}</span>}
                        </div>
                      </div>
                      <div className={`flex items-center gap-0.5 transition-opacity flex-shrink-0 ${isGuidedOrReviewSession ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                        <button onClick={(e) => { e.stopPropagation(); onEdit(s) }} className="p-1 rounded hover:bg-white/10" title="重命名">
                          <svg className="w-3.5 h-3.5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); onDelete(s) }} className="p-1 rounded hover:bg-red-500/10" title="删除">
                          <svg className="w-3.5 h-3.5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
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
            {showPagination && (
              <SessionOverviewPagination
                page={currentPage}
                totalPages={totalPages}
                pageStart={pageStart}
                pageEnd={pageEnd}
                totalItems={sessions.length}
                onPageChange={goToPage}
                compact
              />
            )}
          </div>
        )}

        {projectId && (
          <div className="mt-6">
            <ProjectFilesCard projectId={projectId} />
          </div>
        )}
      </div>
    </main>
  )
}

function SessionOverviewPagination({
  page,
  totalPages,
  pageStart,
  pageEnd,
  totalItems,
  onPageChange,
  compact = false,
}: {
  page: number
  totalPages: number
  pageStart: number
  pageEnd: number
  totalItems: number
  onPageChange: (page: number) => void
  compact?: boolean
}) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 ${compact ? 'pt-1' : ''}`}>
      <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
        显示 {pageStart}-{pageEnd} / {totalItems} 个Session<span className="hidden md:inline"> · 第 {page} / {totalPages} 页</span>
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={1.8} />
          上一页
        </button>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
        >
          下一页
          <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )
}
