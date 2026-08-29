import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, useStore } from '../store'
import { ChatArea } from '../components/easy-workbench/easy-chat'
import { Loading } from '../components/shell'
import { homePath } from '../services/easy-workbench/workbench-navigation'

export default function EasyWorkPage() {
  const params = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const sessionId = searchParams.get('session') || ''
  const userId = params.user || ''
  const {
    projects,
    setProjects,
    currentSession,
    setCurrentProject,
    setCurrentIssue,
    setCurrentResearch,
    setCurrentSession,
    setCurrentTask,
  } = useStore()
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    setError('')
    api(`/api/tasks/${encodeURIComponent(sessionId)}`)
      .then(async (session: any) => {
        if (cancelled) return
        if (!session?.session_id) throw new Error('无法打开这个会话')

        const projectId = String(session.project_id || '')
        const researchId = String(session.research_id || '')
        const issueId = String(session.issue_id || '')
        const isResearch = session.scope_type === 'research' || !!researchId
        setCurrentSession(session)
        setCurrentTask(session)

        let projectList = projects
        if (!projectList.length || !projectList.some((project: any) => project.id === projectId)) {
          try {
            const value = await api('/api/projects?all=true')
            projectList = Array.isArray(value) ? value : (value?.projects || [])
            if (!cancelled) setProjects(projectList)
          } catch {}
        }
        if (cancelled) return
        setCurrentProject(projectList.find((project: any) => project.id === projectId) || null)

        if (isResearch && researchId) {
          setCurrentIssue(null)
          api(`/api/researches/${encodeURIComponent(researchId)}`)
            .then((research: any) => { if (!cancelled && !research?.error) setCurrentResearch(research) })
            .catch(() => {})
        } else if (issueId) {
          setCurrentResearch(null)
          api(`/api/issues/${encodeURIComponent(issueId)}`)
            .then((issue: any) => { if (!cancelled && !issue?.error) setCurrentIssue(issue) })
            .catch(() => {})
        }
      })
      .catch((reason: any) => {
        if (cancelled) return
        if (useStore.getState().currentSession?.session_id === sessionId) {
          setCurrentSession(null)
          setCurrentTask(null)
        }
        setError(reason?.message || '无法打开这个会话')
      })
    return () => { cancelled = true }
  }, [retryKey, sessionId])

  const activeSessionLoaded = currentSession?.session_id === sessionId

  return (
    <div className="workbench-session-chat min-h-0 min-w-0 flex-1" data-workbench-chat-host>
      {activeSessionLoaded ? (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden" data-workbench-chat-instance="primary">
          <ChatArea layout="easy" chrome="shell" />
        </div>
      ) : error ? (
        <div className="flex min-w-0 flex-1 items-center justify-center p-6" style={{ background: 'var(--surface-raised)' }}>
          <div className="max-w-md text-center">
            <AlertTriangle className="mx-auto h-6 w-6" style={{ color: 'var(--status-danger)' }} />
            <div className="mt-3 text-[13px]" style={{ color: 'var(--text-primary)' }}>{error}</div>
            <div className="mt-4 flex justify-center gap-2">
              <button type="button" onClick={() => setRetryKey(key => key + 1)} className="workbench-control-md border px-4 text-[12px] hover:bg-[var(--surface-control-hover)]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}>重试加载</button>
              <button type="button" onClick={() => navigate(homePath(userId))} className="workbench-control-md border px-4 text-[12px] hover:bg-[var(--surface-control-hover)]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>回到主页</button>
            </div>
          </div>
        </div>
      ) : (
        <Loading text="正在还原会话上下文..." />
      )}
    </div>
  )
}
