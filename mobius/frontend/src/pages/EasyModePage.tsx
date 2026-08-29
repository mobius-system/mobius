import { useCallback, useEffect } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useStore } from '../store'
import { EasyWorkbenchHome } from '../components/easy-workbench/easy-workbench-home'
import { WorkbenchShell } from '../components/easy-workbench/workbench-shell'
import type { ConversationRailItem } from '../components/easy-workbench/conversation-rail'
import EasyWorkPage from './EasyWorkPage'
import {
  buildNormalModeTargetUrl,
  setLayoutMode,
  useLayoutMode,
} from '../services/layout-mode'
import { homePath } from '../services/easy-workbench/workbench-navigation'
import '../styles/easy-workbench.css'

export default function EasyModePage() {
  const params = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const layoutMode = useLayoutMode()
  const {
    currentProject,
    currentSession,
    setCurrentSession,
    setCurrentTask,
  } = useStore()
  const userId = params.user || ''
  const activeSessionId = searchParams.get('session') || ''
  const sessionProjectId = currentSession?.session_id === activeSessionId
    ? String((currentSession as any)?.project_id || '')
    : ''
  const projectId = sessionProjectId || searchParams.get('project') || currentProject?.id || ''
  const topbarTitle = activeSessionId
    ? (currentSession?.session_id === activeSessionId ? currentSession.name || 'Session' : 'Session')
    : 'Home'

  useEffect(() => {
    if (layoutMode === null) setLayoutMode('easy_mode')
  }, [layoutMode])

  useEffect(() => {
    if (layoutMode !== 'normal_mode') return
    const session = currentSession?.session_id === activeSessionId ? currentSession : null
    navigate(buildNormalModeTargetUrl({
      user: userId,
      projectId: session?.project_id || projectId || undefined,
      issueId: session?.issue_id,
      researchId: session?.research_id,
      scopeType: session?.scope_type ?? null,
      sessionId: activeSessionId || undefined,
    }), { replace: true })
  }, [activeSessionId, currentSession, layoutMode, navigate, projectId, userId])

  const startNewConversation = useCallback(() => {
    navigate(homePath(userId, { projectId: projectId || undefined }))
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('mobius:new-conversation')), 80)
  }, [navigate, projectId, userId])

  const openConversation = useCallback((session: ConversationRailItem) => {
    if (useStore.getState().currentSession?.session_id === session.session_id) return
    setCurrentSession(session as any)
    setCurrentTask(session as any)
  }, [setCurrentSession, setCurrentTask])

  return (
    <WorkbenchShell
      userId={userId}
      activeSessionId={activeSessionId}
      projectId={projectId}
      onNewConversation={startNewConversation}
      onOpenConversation={openConversation}
      topbarTitle={topbarTitle}
    >
      {activeSessionId ? <EasyWorkPage /> : <EasyWorkbenchHome />}
    </WorkbenchShell>
  )
}
