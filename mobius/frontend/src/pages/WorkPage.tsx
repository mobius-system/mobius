import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { api, useStore } from '../store'
import { TopNav } from '../components/shell'
import { ConversationRail } from '../components/conversation-rail'
import { ChatArea } from '../components/chat'
import { Loading } from '../components/shell'

type SessionContext = {
  projectId: string
  issueId?: string
  researchId?: string
  scopeType: 'issue' | 'research'
}

export default function WorkPage() {
  const params = useParams()
  const navigate = useNavigate()
  const {
    projects, setProjects, currentSession, setCurrentProject, setCurrentIssue,
    setCurrentResearch, setCurrentSession, setCurrentTask,
  } = useStore()
  const userId = params.user || ''
  const sessionId = params.session || ''
  const [context, setContext] = useState<SessionContext | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    setError('')
    setContext(null)
    api(`/api/tasks/${encodeURIComponent(sessionId)}`)
      .then(async (session: any) => {
        if (cancelled) return
        if (!session?.session_id) throw new Error('无法打开这个会话')
        const projectId = String(session.project_id || '')
        const researchId = String(session.research_id || '')
        const issueId = String(session.issue_id || '')
        const scopeType: 'issue' | 'research' = session.scope_type === 'research' || !!researchId ? 'research' : 'issue'
        setCurrentSession(session)
        setCurrentTask(session)
        setContext({
          projectId,
          issueId: scopeType === 'issue' ? issueId : undefined,
          researchId: scopeType === 'research' ? researchId : undefined,
          scopeType,
        })

        let projectList = projects
        if (!projectList.length || !projectList.some((project: any) => project.id === projectId)) {
          try {
            const value = await api('/api/projects')
            projectList = Array.isArray(value) ? value : (value?.projects || [])
            if (!cancelled) setProjects(projectList)
          } catch {}
        }
        if (cancelled) return
        setCurrentProject(projectList.find((project: any) => project.id === projectId) || null)

        if (scopeType === 'research' && researchId) {
          setCurrentIssue(null)
          api(`/api/researches/${researchId}`).then((research: any) => {
            if (!cancelled && !research?.error) setCurrentResearch(research)
          }).catch(() => {})
        } else if (issueId) {
          setCurrentResearch(null)
          api(`/api/issues/${issueId}`).then((issue: any) => {
            if (!cancelled && !issue?.error) setCurrentIssue(issue)
          }).catch(() => {})
        }
      })
      .catch((reason: any) => {
        if (!cancelled) setError(reason?.message || '无法打开这个会话')
      })
    return () => { cancelled = true }
  }, [sessionId])

  const startNewConversation = () => {
    const projectQuery = context?.projectId ? `?project=${encodeURIComponent(context.projectId)}` : ''
    navigate(`/u/${userId}${projectQuery}`)
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('mobius:new-conversation')), 80)
  }

  const activeSessionLoaded = currentSession?.session_id === sessionId

  return (
    <div className="flex h-screen flex-col" style={{ background: 'var(--bg-primary)' }}>
      <TopNav showHistory />
      <div className="flex min-h-0 flex-1">
        <ConversationRail
          userId={userId}
          activeSessionId={sessionId}
          projectId={context?.projectId}
          onNewConversation={startNewConversation}
        />
        {error ? (
          <main className="flex min-w-0 flex-1 items-center justify-center p-6" style={{ background: 'var(--bg-secondary)' }}>
            <div className="max-w-md text-center">
              <AlertTriangle className="mx-auto h-6 w-6" style={{ color: '#f87171' }} />
              <div className="mt-3 text-[13px]" style={{ color: 'var(--text-primary)' }}>{error}</div>
              <button type="button" onClick={() => navigate(`/u/${userId}`)} className="mt-4 rounded-lg border px-4 py-2 text-[12px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>回到主页</button>
            </div>
          </main>
        ) : activeSessionLoaded ? (
          <ChatArea layout="easy" />
        ) : (
          <Loading text="正在还原会话上下文..." />
        )}
      </div>
    </div>
  )
}
