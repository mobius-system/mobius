import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Crown, LoaderCircle, Users } from 'lucide-react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../store'
import { Loading, timeAgo } from '../components/shell'
import { AgentStatusDot } from '../components/AgentStatusDot'
import {
  navigateToWorkbenchObject,
  sessionNavigation,
} from '../services/easy-workbench/workbench-navigation'
import '../styles/easy-workbench.css'

// 极简版专项团队 (多智能体 Research) 页 — 由 /easy_mode?research= 表达.
// 只保留小白需要的东西: 团队里有谁、各自在干什么、点开即对话.
// Blackboard / Graph / 组队向导等中间态留在专家模式 (ResearchPage).
export default function EasyResearchPage() {
  const params = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const userId = params.user || ''
  const projectId = searchParams.get('project') || ''
  const researchId = searchParams.get('research') || ''

  const [research, setResearch] = useState<any>(null)
  const [sessions, setSessions] = useState<any[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!researchId) return
    let cancelled = false
    setError('')
    Promise.all([
      api(`/api/researches/${encodeURIComponent(researchId)}`).catch(() => null),
      api(`/api/researches/${encodeURIComponent(researchId)}/sessions`).catch(() => []),
    ]).then(([researchValue, sessionValue]) => {
      if (cancelled) return
      if (!researchValue || researchValue.error) {
        setError('找不到这个团队')
        return
      }
      setResearch(researchValue)
      setSessions(Array.isArray(sessionValue) ? sessionValue : [])
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [researchId])

  // Chief 排最前, 其余按最近活跃.
  const members = useMemo(() => {
    return [...sessions].sort((left, right) => {
      const leftChief = left.research_role === 'chief_researcher' ? 0 : 1
      const rightChief = right.research_role === 'chief_researcher' ? 0 : 1
      if (leftChief !== rightChief) return leftChief - rightChief
      return new Date(right.last_active || 0).getTime() - new Date(left.last_active || 0).getTime()
    })
  }, [sessions])

  const runningCount = members.filter(member => member.agent_status === 'running').length
  const projectParam = projectId || (research as any)?.project_id || ''

  const back = () => {
    navigate(`/u/${encodeURIComponent(userId)}/easy_mode`)
  }

  const openMember = (member: any) => {
    if (!member?.session_id) return
    navigateToWorkbenchObject(navigate, sessionNavigation(userId, member.session_id, {
      sourceSurface: 'research',
    }))
  }

  if (!researchId) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center p-6">
        <div className="workbench-panel w-full max-w-md border p-6 text-center" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}>
          <div className="text-[13px]" style={{ color: 'var(--text-primary)' }}>缺少团队参数</div>
          <button type="button" onClick={back} className="workbench-control-md btn-primary mt-4 px-4 text-[12px] font-medium">回到主页</button>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center p-6">
        <div className="workbench-panel w-full max-w-md border p-6 text-center" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}>
          <div className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{error}</div>
          <div className="mt-4 flex justify-center gap-2">
            <button type="button" onClick={() => window.location.reload()} className="workbench-control-md border px-4 text-[12px] hover:bg-[var(--surface-control-hover)]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}>重新加载</button>
            <button type="button" onClick={back} className="workbench-control-md border px-4 text-[12px] hover:bg-[var(--surface-control-hover)]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>回到主页</button>
          </div>
        </div>
      </div>
    )
  }

  if (!loaded) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <Loading text="正在打开团队..." />
      </div>
    )
  }

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <button type="button" onClick={back}
          className="workbench-control-md inline-flex items-center gap-1.5 px-2 text-[12px] hover:bg-[var(--surface-control-hover)]"
          style={{ color: 'var(--text-secondary)' }}>
          <ArrowLeft className="h-3.5 w-3.5" />返回主页
        </button>

        <header className="mt-4">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
            <h1 className="min-w-0 truncate text-[20px] font-semibold" style={{ color: 'var(--text-strong)' }}>
              {research?.title || '专项团队'}
            </h1>
          </div>
          {research?.description && (
            <p className="mt-2 text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{research.description}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            <span>{members.length} 名成员</span>
            {runningCount > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: 'var(--status-running)' }} />
                {runningCount} 项任务进行中
              </span>
            )}
            {research?.last_active && <span>最近活跃 {timeAgo(research.last_active)}</span>}
          </div>
        </header>

        {members.length === 0 ? (
          <div className="workbench-panel mt-8 border border-dashed p-10 text-center" style={{ borderColor: 'var(--border-default)' }}>
            <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>这个团队还没有成员。请到专家模式的团队页组建团队。</div>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {members.map(member => {
              const isChief = member.research_role === 'chief_researcher'
              const status = String(member.agent_status || 'idle')
              const statusLabel = status === 'running' ? '执行中'
                : status === 'failed' ? '失败'
                : status === 'completed' ? '已完成' : '待命'
              return (
                <button key={member.session_id} type="button" onClick={() => openMember(member)}
                  className="workbench-panel group flex min-w-0 flex-col border p-4 text-left transition-colors hover:bg-[var(--surface-control-hover)]"
                  style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}>
                  <div className="flex min-w-0 items-center gap-2">
                    {isChief
                      ? <Crown className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
                      : <span className="h-4 w-4 flex-shrink-0 rounded-full border" style={{ borderColor: 'var(--border-strong)' }} />}
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium" style={{ color: 'var(--text-strong)' }}>
                      {member.name || member.session_id}
                    </span>
                    <AgentStatusDot agentStatus={status} className="flex-shrink-0" />
                  </div>
                  {member.description && (
                    <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{member.description}</p>
                  )}
                  <div className="mt-3 flex items-center justify-between text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    <span>{isChief ? '团队负责人' : '团队成员'} · {statusLabel}</span>
                    <span>活跃 {timeAgo(member.last_active)}</span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
