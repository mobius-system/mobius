import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { ErrBanner } from './modals'
import { timeAgoPrecise } from './shell'

interface DeliveryState {
  status?: string
  target_session_ids?: string[]
  delivered_to_session_ids?: string[]
  attempt_count?: number
  last_attempt_at?: string | null
  last_error?: string | null
}

interface BlackboardRecord {
  id?: string
  research_id?: string
  author?: string
  content?: string
  created_at?: string
  delivered?: boolean
  delivered_at?: string | null
  delivery?: DeliveryState
  metadata?: Record<string, any>
}

interface ParsedEntry {
  lineNo: number
  rawLine: string
  record?: BlackboardRecord
  error?: string
}

const REFRESH_INTERVAL_MS = 4000
const ORDER_KEY = 'rg-blackboard-order'

function loadDescending(): boolean {
  try {
    const v = localStorage.getItem(ORDER_KEY)
    return v === null ? true : v === 'desc'
  } catch {
    return true
  }
}

function parseEntries(text: string): ParsedEntry[] {
  const lines = (text || '').split('\n')
  const out: ParsedEntry[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (!raw || !raw.trim()) continue
    try {
      const record = JSON.parse(raw)
      if (record && typeof record === 'object') out.push({ lineNo: i + 1, rawLine: raw, record })
      else out.push({ lineNo: i + 1, rawLine: raw, error: 'not_object' })
    } catch (e: any) {
      out.push({ lineNo: i + 1, rawLine: raw, error: e?.message || 'parse_error' })
    }
  }
  return out
}

function statusBadge(record: BlackboardRecord): { label: string; cls: string } {
  const status = record.delivery?.status || (record.delivered ? 'delivered' : 'pending')
  if (record.delivered || status === 'delivered') return { label: '已投递', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' }
  if (status === 'pending') return { label: '待投递', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' }
  if (record.delivery?.last_error) return { label: '失败', cls: 'bg-red-500/15 text-red-300 border-red-500/40' }
  return { label: status, cls: 'bg-slate-500/15 text-slate-300 border-slate-500/40' }
}

function fetchBlackboardText(researchId: string): Promise<string> {
  const token = localStorage.getItem('cc-token') || ''
  return fetch(`/api/research-blackboard/${encodeURIComponent(researchId)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).then(async (res) => {
    if (res.status === 404) {
      const msg = await res.text().catch(() => '')
      throw new Error(msg || 'Blackboard 未找到')
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  })
}

export default function ResearchBlackboard({ researchId }: { researchId: string }) {
  const [entries, setEntries] = useState<ParsedEntry[]>([])
  const [state, setState] = useState<{ loading: boolean; error: string | null; lastUpdated: number | null }>({
    loading: true, error: null, lastUpdated: null,
  })
  const [filter, setFilter] = useState<'all' | 'pending' | 'delivered'>('all')
  const [descending, setDescending] = useState<boolean>(() => loadDescending())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [autoRefresh, setAutoRefresh] = useState(true)
  const autoRefreshRef = useRef(autoRefresh)
  autoRefreshRef.current = autoRefresh

  const fetchBlackboard = useCallback((silent: boolean) => {
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }))
    fetchBlackboardText(researchId)
      .then((text) => {
        const parsed = parseEntries(text)
        setEntries(parsed)
        setState({ loading: false, error: null, lastUpdated: Date.now() })
      })
      .catch((e: any) => {
        setState((s) => ({ loading: false, error: e?.message || '加载失败', lastUpdated: s.lastUpdated }))
      })
  }, [researchId])

  useEffect(() => { fetchBlackboard(false) }, [fetchBlackboard])

  useEffect(() => {
    if (!autoRefresh) return
    const t = window.setInterval(() => {
      if (autoRefreshRef.current && !document.hidden) fetchBlackboard(true)
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(t)
  }, [autoRefresh, fetchBlackboard])

  const filtered = useMemo(() => {
    const base = filter === 'all'
      ? entries
      : entries.filter((e) => {
          if (!e.record || e.error) return false
          const delivered = e.record.delivered || e.record.delivery?.status === 'delivered'
          return filter === 'delivered' ? delivered : !delivered
        })
    return descending ? [...base].reverse() : base
  }, [entries, filter, descending])

  const toggleOrder = () => {
    setDescending((prev) => {
      const next = !prev
      try { localStorage.setItem(ORDER_KEY, next ? 'desc' : 'asc') } catch {}
      return next
    })
  }

  const stats = useMemo(() => {
    let delivered = 0
    let pending = 0
    let bad = 0
    for (const e of entries) {
      if (!e.record || e.error) { bad += 1; continue }
      if (e.record.delivered || e.record.delivery?.status === 'delivered') delivered += 1
      else pending += 1
    }
    return { total: entries.length, delivered, pending, bad }
  }, [entries])

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  return (
    <div className="flex flex-col h-full min-h-0" style={{ background: 'var(--bg-primary)' }}>
      <div className="px-3 py-2 border-b flex items-center gap-2 flex-shrink-0" style={{ borderColor: 'var(--border-color)' }}>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
            <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            Blackboard
          </div>
          <div className="text-[10px] mt-0.5 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
            <span>{stats.total} 条</span>
            {stats.delivered > 0 && <span className="text-emerald-400">· {stats.delivered} 已投递</span>}
            {stats.pending > 0 && <span className="text-amber-400">· {stats.pending} 待投递</span>}
            {stats.bad > 0 && <span className="text-red-400">· {stats.bad} 异常</span>}
          </div>
        </div>
        <label className="flex items-center gap-1 text-[10px] cursor-pointer" style={{ color: 'var(--text-muted)' }} title="开启后每 4 秒自动刷新">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="accent-emerald-500" />
          自动
        </label>
        <button onClick={() => fetchBlackboard(false)} title="立即刷新"
          className="h-6 px-2 rounded text-[10px] border transition-colors hover:bg-[var(--bg-hover)]"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
          刷新
        </button>
      </div>

      <div className="px-3 py-2 border-b flex items-center gap-1 flex-shrink-0" style={{ borderColor: 'var(--border-color)' }}>
        {(['all', 'pending', 'delivered'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className="px-2 h-6 rounded text-[10px] border transition-colors"
            style={{
              borderColor: filter === f ? '#10b981' : 'var(--border-color)',
              color: filter === f ? '#10b981' : 'var(--text-secondary)',
              background: filter === f ? 'rgba(16,185,129,0.1)' : 'transparent',
            }}>
            {{ all: '全部', pending: '待投递', delivered: '已投递' }[f]}
          </button>
        ))}
        <button onClick={toggleOrder} title={descending ? '当前: 最新在上 (倒序) — 点击切换为正序' : '当前: 最早在上 (正序) — 点击切换为倒序'}
          className="ml-auto px-2 h-6 rounded text-[10px] border transition-colors flex items-center gap-1 hover:bg-[var(--bg-hover)]"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>
          <span>{descending ? '↓ 倒序' : '↑ 正序'}</span>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {state.loading && entries.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[12px]" style={{ color: 'var(--text-muted)' }}>正在加载...</div>
        ) : state.error ? (
          <div className="p-3"><ErrBanner>{state.error}</ErrBanner></div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-4 text-center gap-2">
            <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {entries.length === 0 ? '当前 Research 尚无 Blackboard 记录' : '当前筛选下无记录'}
            </div>
            <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              文件位置: <code>.imac/blackboard/{researchId}/blackboard.jsonl</code>
            </div>
          </div>
        ) : (
          <div className="p-2 flex flex-col gap-2">
            {filtered.map((entry, idx) => {
              if (entry.error || !entry.record) {
                return (
                  <div key={`err-${entry.lineNo}`} className="rounded-2xl border p-2 text-[11px]"
                    style={{ background: 'var(--bg-secondary)', borderColor: 'rgba(239,68,68,0.4)', color: '#f87171' }}>
                    <div className="font-mono text-[10px] mb-1">行 {entry.lineNo} · 解析失败: {entry.error}</div>
                    <div className="font-mono break-all" style={{ color: 'var(--text-muted)' }}>{entry.rawLine.slice(0, 200)}</div>
                  </div>
                )
              }
              const r = entry.record
              const key = r.id || `${entry.lineNo}-${idx}`
              const badge = statusBadge(r)
              const isOpen = expanded.has(key)
              const hasMeta = r.metadata && Object.keys(r.metadata).length > 0
              const targetIds = r.delivery?.target_session_ids || []
              const deliveredIds = r.delivery?.delivered_to_session_ids || []
              return (
                <div key={key} className="rounded-2xl border overflow-hidden"
                  style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-color)' }}>
                  <div className="px-2.5 py-1.5 flex items-center gap-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary)' }} title={r.author}>
                        {r.author || 'anonymous'}
                      </div>
                      <div className="text-[10px]" style={{ color: 'var(--text-muted)' }} title={r.created_at}>
                        {r.created_at ? timeAgoPrecise(r.created_at) : '—'}
                      </div>
                    </div>
                    <span className={`px-1.5 py-0.5 rounded border text-[9px] leading-none ${badge.cls}`}>{badge.label}</span>
                  </div>
                  <div className="px-2.5 py-2 text-[11px] leading-relaxed prose-graph break-words" style={{ color: 'var(--text-secondary)' }}>
                    <ReactMarkdown
                      components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}
                    >
                      {r.content || '_(无正文)_'}
                    </ReactMarkdown>
                  </div>
                  {(targetIds.length > 0 || hasMeta || r.delivery?.last_error) && (
                    <button onClick={() => toggleExpand(key)}
                      className="w-full px-2.5 py-1 text-[10px] flex items-center justify-between border-t hover:bg-[var(--bg-hover)] transition-colors"
                      style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
                      <span>
                        {isOpen ? '▾ 收起' : '▸ 详情'}
                        {targetIds.length > 0 && ` · 目标 ${deliveredIds.length}/${targetIds.length}`}
                        {hasMeta && ` · metadata`}
                        {r.delivery?.last_error && <span className="text-red-400 ml-1">· 错误</span>}
                      </span>
                      <span>{r.delivery?.attempt_count ? `${r.delivery.attempt_count} 次尝试` : ''}</span>
                    </button>
                  )}
                  {isOpen && (
                    <div className="px-2.5 py-2 border-t text-[10px] flex flex-col gap-1.5" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
                      {targetIds.length > 0 && (
                        <div>
                          <div className="font-semibold mb-0.5" style={{ color: 'var(--text-secondary)' }}>投递目标:</div>
                          <ul className="space-y-0.5">
                            {targetIds.map((sid) => (
                              <li key={sid} className="font-mono break-all">
                                <span className={deliveredIds.includes(sid) ? 'text-emerald-400' : 'text-amber-400'}>
                                  {deliveredIds.includes(sid) ? '✓' : '○'}
                                </span>{' '}
                                {sid}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {r.delivery?.last_attempt_at && (
                        <div>最近一次尝试: <span style={{ color: 'var(--text-secondary)' }}>{r.delivery.last_attempt_at}</span></div>
                      )}
                      {r.delivery?.last_error && (
                        <div className="text-red-400 break-all">错误: {r.delivery.last_error}</div>
                      )}
                      {hasMeta && (
                        <div>
                          <div className="font-semibold mb-0.5" style={{ color: 'var(--text-secondary)' }}>metadata:</div>
                          <pre className="font-mono text-[10px] whitespace-pre-wrap break-all p-1.5 rounded"
                            style={{ background: 'var(--bg-primary)', color: 'var(--text-secondary)' }}>
                            {JSON.stringify(r.metadata, null, 2)}
                          </pre>
                        </div>
                      )}
                      {r.id && <div className="font-mono">id: {r.id}</div>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {state.lastUpdated && (
        <div className="px-3 py-1.5 border-t text-[10px] flex-shrink-0 flex items-center justify-between"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
          <span>上次刷新 {timeAgoPrecise(new Date(state.lastUpdated).toISOString())}</span>
          {state.loading && <span className="text-emerald-400">刷新中…</span>}
        </div>
      )}
    </div>
  )
}
