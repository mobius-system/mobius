import { useCallback } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useStore } from '../store'
import { EasyWorkbenchHome } from '../components/easy-workbench/easy-workbench-home'
import { EasyResearchHome } from '../components/easy-workbench/easy-research-home'
import { EasyCreationHome } from '../components/easy-workbench/easy-creation-home'
import { WorkbenchShell } from '../components/easy-workbench/workbench-shell'
import type { ConversationRailItem } from '../components/easy-workbench/conversation-rail'
import EasyWorkPage from './EasyWorkPage'
import EasyResearchPage from './EasyResearchPage'
import { homePath } from '../services/easy-workbench/workbench-navigation'
import '../styles/easy-workbench.css'

// 简易模式完全由 /easy_mode 路由本身表达, 不再依赖 localStorage 里的模式偏好,
// 也就不需要"存储驱动"的自动重定向 (那是导航循环与草稿丢失的根源).
// 模式切换只会由 LayoutModeSwitch / TopNav 开关发起显式跳转.
export default function EasyModePage() {
  const params = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const {
    currentProject,
    currentSession,
    setCurrentSession,
    setCurrentTask,
  } = useStore()
  const userId = params.user || ''
  const activeSessionId = searchParams.get('session') || ''
  const activeResearchId = searchParams.get('research') || ''
  const activeView = searchParams.get('view') || ''
  const sessionProjectId = currentSession?.session_id === activeSessionId
    ? String((currentSession as any)?.project_id || '')
    : ''
  const projectId = sessionProjectId || searchParams.get('project') || currentProject?.id || ''
  const topbarTitle = activeSessionId
    ? (currentSession?.session_id === activeSessionId ? currentSession.name || 'Session' : 'Session')
    : activeResearchId
      ? '专项团队'
      : activeView === 'research'
        ? '专项团队'
        : activeView === 'creation'
          ? '我的创作'
          : 'Home'

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
      {activeSessionId ? <EasyWorkPage /> : activeResearchId ? <EasyResearchPage /> : activeView === 'research' ? <EasyResearchHome /> : activeView === 'creation' ? <EasyCreationHome /> : <EasyWorkbenchHome />}
    </WorkbenchShell>
  )
}
