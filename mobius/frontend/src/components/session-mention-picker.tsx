import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeftRight, AtSign, Bot, Check, Search, X } from 'lucide-react'
import { api } from '../store'

export type SessionMentionMode = 'read_only' | 'bidirectional'

export type SessionMentionSelection = {
  sessionId: string
  name: string
  mode: SessionMentionMode
  projectName?: string
  scopeType?: 'issue' | 'research' | null
  scopeTitle?: string
  contextAt?: string | null
}

type SessionMentionCandidate = {
  session_id: string
  name: string
  description?: string
  model?: string | null
  model_label?: string | null
  backend?: string | null
  project_name?: string
  issue_title?: string
  research_title?: string
  scope_type?: 'issue' | 'research'
  last_active?: string | null
  group?: 'same_scope' | 'same_project' | 'other_project'
  can_communicate?: boolean
}

function candidateGroupLabel(group?: SessionMentionCandidate['group']) {
  if (group === 'same_scope') return '同一任务'
  if (group === 'same_project') return '同一项目'
  return '其他项目'
}

function trailingMention(value: string): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]{0,100})$/.exec(String(value || ''))
  if (!match) return null
  return {
    start: match.index + match[1].length,
    query: match[2] || '',
  }
}

export function sessionMentionPayload(items: SessionMentionSelection[]) {
  return items.map((item) => ({
    kind: 'agent',
    session_id: item.sessionId,
    mode: item.mode,
  }))
}

export function SessionMentionPicker({
  value,
  onValueChange,
  selected,
  onSelectedChange,
  currentSessionId,
  projectId,
  issueId,
  researchId,
  disabled = false,
}: {
  value: string
  onValueChange: (value: string) => void
  selected: SessionMentionSelection[]
  onSelectedChange: (items: SessionMentionSelection[]) => void
  currentSessionId?: string
  projectId?: string
  issueId?: string
  researchId?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SessionMentionMode>('read_only')
  const [targets, setTargets] = useState<SessionMentionCandidate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [panelPosition, setPanelPosition] = useState({ left: 16, top: 80 })
  const typedMentionRef = useRef<{ start: number; query: string } | null>(null)
  const suppressValueRef = useRef('')
  const hasScope = !!(currentSessionId || issueId || researchId)

  const baseUrl = useMemo(() => {
    const params = new URLSearchParams()
    if (currentSessionId) params.set('session_id', currentSessionId)
    if (projectId) params.set('project_id', projectId)
    if (issueId) params.set('issue_id', issueId)
    if (researchId) params.set('research_id', researchId)
    return hasScope ? `/api/sessions/mention-targets?${params.toString()}` : ''
  }, [currentSessionId, hasScope, issueId, projectId, researchId])

  useEffect(() => {
    if (disabled || !hasScope) return
    if (suppressValueRef.current === value) {
      suppressValueRef.current = ''
      return
    }
    const mention = trailingMention(value)
    if (!mention) return
    typedMentionRef.current = mention
    setQuery(mention.query)
    setOpen(true)
  }, [disabled, hasScope, value])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && rootRef.current?.contains(target)) return
      if (target && panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const panelWidth = Math.min(520, Math.max(280, window.innerWidth - 32))
      const left = Math.max(16, Math.min(rect.left, window.innerWidth - panelWidth - 16))
      const estimatedHeight = 410
      const belowTop = rect.bottom + 8
      const top = belowTop + estimatedHeight <= window.innerHeight
        ? belowTop
        : Math.max(16, rect.top - estimatedHeight - 8)
      setPanelPosition({ left, top })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  const loadTargets = useCallback(async () => {
    if (!open || !baseUrl) return
    setLoading(true)
    setError('')
    try {
      const suffix = query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''
      const data = await api(`${baseUrl}${suffix}`)
      setTargets(Array.isArray(data?.targets) ? data.targets : [])
    } catch (e: any) {
      setTargets([])
      setError(e?.message || '加载 Session 列表失败')
    } finally {
      setLoading(false)
    }
  }, [baseUrl, open, query])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => { void loadTargets() }, query.trim() ? 160 : 0)
    return () => window.clearTimeout(timer)
  }, [loadTargets, open, query])

  const choose = (target: SessionMentionCandidate) => {
    const effectiveMode: SessionMentionMode = mode === 'bidirectional' && target.can_communicate === false
      ? 'read_only'
      : mode
    const nextSelection: SessionMentionSelection = {
      sessionId: target.session_id,
      name: target.name || target.session_id,
      mode: effectiveMode,
      projectName: target.project_name,
      scopeType: target.scope_type || null,
      scopeTitle: target.scope_type === 'research' ? target.research_title : target.issue_title,
      contextAt: target.last_active || null,
    }
    const existingIndex = selected.findIndex((item) => item.sessionId === target.session_id)
    onSelectedChange(existingIndex < 0
      ? [...selected, nextSelection]
      : selected.map((item, index) => index === existingIndex ? nextSelection : item))

    const label = `@${target.name || target.session_id}`
    const typed = typedMentionRef.current
    const nextValue = typed
      ? `${value.slice(0, typed.start)}${label} `
      : `${value}${value && !/\s$/.test(value) ? ' ' : ''}${label} `
    suppressValueRef.current = nextValue
    typedMentionRef.current = null
    onValueChange(nextValue)
    setQuery('')
  }

  const remove = (sessionId: string) => {
    onSelectedChange(selected.filter((item) => item.sessionId !== sessionId))
  }

  return (
    <div ref={rootRef} className="relative" data-testid="session-mention-picker">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled || !hasScope}
          onClick={() => {
            typedMentionRef.current = null
            setQuery('')
            setOpen((current) => !current)
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] transition-colors hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-45"
          style={{ borderColor: 'var(--input-border)', color: 'var(--text-secondary)', background: 'var(--input-bg)' }}
          title={hasScope ? '引用或联系其他 Session；也可以直接在描述末尾输入 @' : '请先选择目标任务或研究'}
        >
          <AtSign className="h-3.5 w-3.5" strokeWidth={1.9} />
          关联 Session
        </button>
        {selected.map((item) => (
          <div
            key={item.sessionId}
            className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]"
            style={{ borderColor: 'rgba(59,130,246,0.26)', background: 'rgba(59,130,246,0.08)', color: 'var(--text-primary)' }}
          >
            <Bot className="h-3 w-3 flex-shrink-0 text-blue-400" strokeWidth={1.8} />
            <span className="max-w-44 truncate">@{item.name}</span>
            <span className="rounded border px-1 py-0.5 text-[9px]" style={{ borderColor: 'rgba(59,130,246,0.22)', color: 'var(--text-muted)' }}>
              {item.mode === 'bidirectional' ? '双向' : '只读'}
            </span>
            <button type="button" onClick={() => remove(item.sessionId)} aria-label={`移除 Session ${item.name}`}
              className="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      {open && typeof document !== 'undefined' && createPortal((
        <div
          ref={panelRef}
          className="fixed z-[120] w-[520px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border shadow-2xl"
          style={{ left: panelPosition.left, top: panelPosition.top, background: 'var(--menu-bg)', borderColor: 'var(--border-color)' }}
        >
          <div className="border-b p-3" style={{ borderColor: 'var(--border-color)' }}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>选择其他 Session</div>
              <div className="flex rounded-lg border p-0.5" style={{ borderColor: 'var(--input-border)', background: 'var(--input-bg)' }}>
                <button type="button" onClick={() => setMode('read_only')}
                  className="rounded-md px-2 py-1 text-[10px] transition-colors"
                  style={{ background: mode === 'read_only' ? 'rgba(59,130,246,0.16)' : 'transparent', color: mode === 'read_only' ? '#60a5fa' : 'var(--text-muted)' }}>
                  只读引用
                </button>
                <button type="button" onClick={() => setMode('bidirectional')}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10px] transition-colors"
                  style={{ background: mode === 'bidirectional' ? 'rgba(16,185,129,0.16)' : 'transparent', color: mode === 'bidirectional' ? '#34d399' : 'var(--text-muted)' }}>
                  <ArrowLeftRight className="h-3 w-3" />开启交流
                </button>
              </div>
            </div>
            <label className="flex h-9 items-center gap-2 rounded-lg border px-2.5" style={{ borderColor: 'var(--input-border)', background: 'var(--input-bg)' }}>
              <Search className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
              <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索会话、Session ID、项目、Issue、Research、模型或消息关键词"
                className="min-w-0 flex-1 border-0 bg-transparent text-[11px] outline-none" style={{ color: 'var(--text-primary)' }} />
            </label>
          </div>
          <div className="max-h-72 overflow-y-auto p-2">
            {loading && <div className="px-3 py-8 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>正在搜索 Session…</div>}
            {!loading && error && <div className="px-3 py-6 text-center text-[11px] text-red-400">{error}</div>}
            {!loading && !error && targets.length === 0 && (
              <div className="px-3 py-8 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>没有找到可引用的 Session</div>
            )}
            {!loading && !error && targets.map((target) => {
              const picked = selected.find((item) => item.sessionId === target.session_id)
              const communicationUnavailable = mode === 'bidirectional' && target.can_communicate === false
              const scopeTitle = target.scope_type === 'research' ? target.research_title : target.issue_title
              return (
                <button
                  key={target.session_id}
                  type="button"
                  onClick={() => choose(target)}
                  className="mb-1 flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors hover:bg-[var(--bg-card-hover)]"
                  style={{ borderColor: picked ? 'rgba(59,130,246,0.35)' : 'transparent', background: picked ? 'rgba(59,130,246,0.08)' : 'transparent' }}
                >
                  <Bot className="mt-0.5 h-4 w-4 flex-shrink-0" style={{ color: picked ? '#60a5fa' : 'var(--text-muted)' }} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{target.name || target.session_id}</span>
                      <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[9px]" style={{ background: 'var(--bg-card-hover)', color: 'var(--text-muted)' }}>{candidateGroupLabel(target.group)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {target.project_name || '未命名项目'}{scopeTitle ? ` / ${scopeTitle}` : ''} · session={target.session_id}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px]" style={{ color: communicationUnavailable ? '#f59e0b' : 'var(--text-muted)' }}>
                      {[target.model_label || target.model, target.backend, communicationUnavailable ? '仅可只读引用' : ''].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  {picked && <Check className="mt-1 h-3.5 w-3.5 flex-shrink-0 text-blue-400" />}
                </button>
              )
            })}
          </div>
          <div className="border-t px-3 py-2 text-[10px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
            外部 Session 内容按不可信资料处理；创建后的首条人类消息成功发送时才会消费这些关联。
          </div>
        </div>
      ), document.body)}
    </div>
  )
}
