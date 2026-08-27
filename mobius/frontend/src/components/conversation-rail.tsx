import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquare, Plus, Search, X } from 'lucide-react'
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

function statusMeta(item: ConversationRailItem) {
  if (item.agent_status === 'failed' || item.status === 'failed') return { label: '失败', color: '#f87171' }
  if (item.agent_status === 'running') return { label: '进行中', color: '#38bdf8' }
  if (item.agent_status === 'pending' || item.agent_status === 'waiting') return { label: '等待', color: '#f59e0b' }
  if (item.agent_status === 'completed' || item.status === 'completed') return { label: '完成', color: '#4ade80' }
  return null
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
  const [drawerOpen, setDrawerOpen] = useState(false)
  const drawerSearchRef = useRef<HTMLInputElement | null>(null)
  const drawerTriggerRef = useRef<HTMLElement | null>(null)

  const closeDrawer = () => {
    setDrawerOpen(false)
    window.requestAnimationFrame(() => drawerTriggerRef.current?.focus())
  }

  useEffect(() => {
    const openDrawer = () => {
      drawerTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setDrawerOpen(true)
      window.requestAnimationFrame(() => drawerSearchRef.current?.focus())
    }
    window.addEventListener('mobius:open-history', openDrawer)
    return () => window.removeEventListener('mobius:open-history', openDrawer)
  }, [])

  useEffect(() => {
    if (!drawerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeDrawer()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [drawerOpen])

  useEffect(() => {
    const wideViewport = window.matchMedia('(min-width: 1280px)')
    const syncDrawer = () => {
      if (wideViewport.matches) setDrawerOpen(false)
    }
    wideViewport.addEventListener('change', syncDrawer)
    return () => wideViewport.removeEventListener('change', syncDrawer)
  }, [])

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
    setDrawerOpen(false)
    navigate(path)
  }

  const renderRail = (drawer = false) => (
    <aside
      className={`flex h-full w-[272px] flex-shrink-0 flex-col border-r ${drawer ? 'relative z-10 max-w-[calc(100vw-32px)] shadow-lg' : ''}`}
      style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }}
      aria-label="最近会话"
    >
      {drawer && (
        <div className="flex h-10 items-center justify-between border-b px-3" style={{ borderColor: 'var(--border-color)' }}>
          <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>历史会话</span>
          <button type="button" onClick={closeDrawer} aria-label="关闭历史会话"
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-secondary)' }}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="space-y-2 border-b p-3" style={{ borderColor: 'var(--border-color)' }}>
        <button type="button" onClick={() => { setDrawerOpen(false); onNewConversation() }}
          className="flex h-8 w-full items-center justify-center gap-2 rounded-md border text-[12px] font-medium transition-colors hover:bg-[var(--bg-hover)]"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-primary)' }}>
          <Plus className="h-4 w-4" /> 新会话
        </button>
        <label className="relative block">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
          <input ref={drawer ? drawerSearchRef : undefined} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索会话"
            className="h-8 w-full rounded-md pl-8 pr-3 text-[12px] outline-none focus:border-blue-500/40"
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
                const status = statusMeta(item)
                return (
                  <button key={item.session_id} type="button" onClick={() => openConversation(item)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ background: active ? 'var(--bg-active)' : undefined }} aria-current={active ? 'page' : undefined}>
                    <MessageSquare className="h-3.5 w-3.5 flex-shrink-0" style={{ color: active ? 'var(--accent-primary)' : 'var(--text-muted)' }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{item.name || '未命名会话'}</span>
                      <span className="mt-0.5 block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{item.project_name || '未命名项目'}</span>
                    </span>
                    {status && (
                      <span className="flex flex-shrink-0 items-center gap-1 text-[9px]" style={{ color: status.color }}>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: status.color }} />
                        {status.label}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </aside>
  )

  return (
    <>
      <div className="hidden h-full xl:block">{renderRail()}</div>
      {drawerOpen && (
        <div className="fixed inset-x-0 bottom-0 top-[52px] z-[60] xl:hidden" role="dialog" aria-modal="true" aria-label="历史会话">
          <button type="button" className="absolute inset-0 bg-black/35" onClick={closeDrawer} aria-label="关闭历史会话" />
          {renderRail(true)}
        </div>
      )}
    </>
  )
}
