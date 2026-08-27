import { useEffect, useMemo, useState } from 'react'
import { MessageSquare, Plus, Search } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '../store'
import { logUiEvent } from '../services/ui-observability'

export type ConversationRailItem = {
  session_id: string
  name?: string
  project_id?: string | null
  project_name?: string | null
  issue_id?: string | null
  issue_title?: string | null
  research_id?: string | null
  research_title?: string | null
  scope_type?: 'issue' | 'research'
  agent_status?: string
  status?: string
  last_active?: string
}

type ConversationGroup = '今天' | '昨天' | '更早'

function groupFor(dateValue?: string): ConversationGroup {
  const date = dateValue ? new Date(dateValue) : null
  if (!date || Number.isNaN(date.getTime())) return '更早'
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startValue = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((startToday - startValue) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  return '更早'
}

function statusLabel(item: ConversationRailItem) {
  if (item.agent_status === 'running' || item.agent_status === 'pending') return '进行中'
  if (item.agent_status === 'waiting') return '等待'
  if (item.agent_status === 'failed' || item.status === 'failed') return '失败'
  return ''
}

export function conversationPath(userId: string, item: ConversationRailItem) {
  if (!item.session_id) return ''
  return `/u/${userId}/s/${encodeURIComponent(item.session_id)}`
}

export function ConversationRail({
  userId,
  activeSessionId,
  projectId,
  onNewConversation,
  onOpenConversation,
  refreshKey,
}: {
  userId: string
  activeSessionId?: string | null
  projectId?: string | null
  onNewConversation: () => void
  onOpenConversation?: (item: ConversationRailItem) => void
  refreshKey?: number
}) {
  const navigate = useNavigate()
  const [items, setItems] = useState<ConversationRailItem[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    api('/api/tasks/recent?limit=100')
      .then((result: any) => {
        if (cancelled) return
        setItems(Array.isArray(result) ? result : [])
      })
      .catch((reason: any) => {
        if (!cancelled) setError(reason?.message || '历史会话加载失败')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [refreshKey, userId])

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return items.filter(item => {
      if (projectId && item.project_id !== projectId) return false
      if (!normalized) return true
      return [item.name, item.project_name, item.session_id]
        .some(value => String(value || '').toLowerCase().includes(normalized))
    })
  }, [items, projectId, query])

  const grouped = useMemo(() => {
    const groups: Record<ConversationGroup, ConversationRailItem[]> = { 今天: [], 昨天: [], 更早: [] }
    visibleItems.forEach(item => groups[groupFor(item.last_active)].push(item))
    return (['今天', '昨天', '更早'] as ConversationGroup[]).map(label => ({ label, items: groups[label] })).filter(group => group.items.length)
  }, [visibleItems])

  const openConversation = (item: ConversationRailItem) => {
    const path = conversationPath(userId, item)
    if (!path) return
    logUiEvent('history_opened', { session_id: item.session_id, project_id: item.project_id })
    onOpenConversation?.(item)
    navigate(path)
  }

  return (
    <aside className="flex h-full w-[272px] flex-shrink-0 flex-col border-r" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }} aria-label="最近会话">
      <div className="space-y-2 border-b p-3" style={{ borderColor: 'var(--border-color)' }}>
        <button type="button" onClick={onNewConversation}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border text-[13px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
          <Plus className="h-4 w-4" /> 新会话
        </button>
        <label className="relative block">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索会话"
            className="h-9 w-full rounded-lg pl-8 pr-3 text-[12px] outline-none focus:border-blue-500/40"
            style={{ color: 'var(--text-primary)', background: 'var(--input-bg)', border: '1px solid var(--input-border)' }} />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {loading ? (
          <div className="px-2 py-5 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>加载中…</div>
        ) : error ? (
          <div className="px-2 py-5 text-center text-[12px]" style={{ color: '#f87171' }}>{error}</div>
        ) : grouped.length === 0 ? (
          <div className="px-2 py-5 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>暂无会话</div>
        ) : grouped.map(group => (
          <section key={group.label} className="mb-4">
            <h2 className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{group.label}</h2>
            <div className="space-y-0.5">
              {group.items.map(item => {
                const active = item.session_id === activeSessionId
                const status = statusLabel(item)
                return (
                  <button key={item.session_id} type="button" onClick={() => openConversation(item)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ background: active ? 'var(--bg-active)' : undefined }} aria-current={active ? 'page' : undefined}>
                    <MessageSquare className="h-3.5 w-3.5 flex-shrink-0" style={{ color: active ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{item.name || '未命名会话'}</span>
                      <span className="mt-0.5 block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{item.project_name || '未命名项目'}</span>
                    </span>
                    {status && <span className="flex-shrink-0 text-[9px]" style={{ color: status === '失败' ? '#f87171' : '#f59e0b' }}>{status}</span>}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </aside>
  )
}
