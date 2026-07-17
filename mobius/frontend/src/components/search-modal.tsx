// =====================================================================
// 全局会话搜索弹窗 — 顶栏搜索按钮触发
//
// 输入关键词 → GET /api/search → 展示命中的每个 session:
//   项目 › Issue/Research › Session  +  命中片段 (关键词高亮)
// 点结果卡 → SPA 内进入该 Session.
//
// 搜索为用户主动触发 (非轮询); 前端 450ms 防抖 + 最短 2 字符, 避免抖打的后端压力.
// =====================================================================
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, api } from '../store'
import {
  Search, X, ChevronRight, Folder, CircleDot, FlaskConical,
  MessagesSquare, Loader2, AlertCircle, FileSearch,
} from 'lucide-react'

type Fragment = { role: string; snippet: string; timestamp: string | null }
type SearchResult = {
  session_id: string
  session_name: string
  project_id: string
  project_name: string
  issue_id: string | null
  issue_title: string | null
  research_id: string | null
  research_title: string | null
  scope_type: 'issue' | 'research'
  last_active: string
  model: string
  fragments: Fragment[]
}

const ROLE_META: Record<string, { label: string; color: string; bg: string }> = {
  user: { label: '用户', color: '#60a5fa', bg: 'rgba(59,130,246,0.15)' },
  assistant: { label: '助手', color: '#10b981', bg: 'rgba(16,185,129,0.15)' },
  tool: { label: '工具', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
  thinking: { label: '思考', color: '#a855f7', bg: 'rgba(168,85,247,0.15)' },
  error: { label: '错误', color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
  system: { label: '系统', color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' },
}
function roleMeta(role: string) {
  return ROLE_META[role] || { label: role || '消息', color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' }
}

// 把片段按关键词 (大小写无关) 切开, 命中段包 <mark>.
function Highlight({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    const q = query.trim()
    if (!q) return [text]
    const lo = text.toLowerCase()
    const ql = q.toLowerCase()
    const out: Array<{ s: string; hit: boolean }> = []
    let i = 0
    while (i < text.length) {
      const idx = lo.indexOf(ql, i)
      if (idx < 0) { out.push({ s: text.slice(i), hit: false }); break }
      if (idx > i) out.push({ s: text.slice(i, idx), hit: false })
      out.push({ s: text.slice(idx, idx + ql.length), hit: true })
      i = idx + ql.length
    }
    return out.map((p, k) => (p.hit ? <mark key={k} className="rounded px-0.5" style={{ background: 'rgba(250,204,21,0.45)', color: 'inherit' }}>{p.s}</mark> : <span key={k}>{p.s}</span>))
  }, [text, query])
  return <>{parts}</>
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ''
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

// 时间范围过滤选项: 默认仅扫描 7 天内创建的会话以加速搜索 (后端按 created_at 过滤候选集).
type RangeKey = '1d' | '7d' | '30d' | 'all'
const RANGE_OPTIONS: Array<{ value: RangeKey; label: string }> = [
  { value: '1d', label: '1天内' },
  { value: '7d', label: '7天内' },
  { value: '30d', label: '1个月内' },
  { value: 'all', label: '全部' },
]

export function SearchModal({ onClose, onNavigate }: { onClose: () => void; onNavigate: (path: string) => void }) {
  const { theme, user } = useStore()
  const dark = theme !== 'light'
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [meta, setMeta] = useState<{ scanned?: number; candidates?: number; truncated?: boolean } | null>(null)
  const [searched, setSearched] = useState(false) // 是否已发起过搜索 (区分初始空态 vs 无结果)
  const [range, setRange] = useState<RangeKey>('7d')
  const rangeLabel = RANGE_OPTIONS.find(o => o.value === range)?.label || '7天内'
  const reqId = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const runSearch = (term: string, rangeArg: RangeKey = range) => {
    const t = term.trim()
    if (t.length < 2) { setResults([]); setMeta(null); setLoading(false); setErr(''); setSearched(false); return }
    const id = ++reqId.current
    setLoading(true); setErr('')
    api(`/api/search?q=${encodeURIComponent(t)}&limit=50&range=${rangeArg}`).then((r: any) => {
      if (id !== reqId.current) return
      setResults(Array.isArray(r?.results) ? r.results : [])
      setMeta({ scanned: r?.scanned_sessions, candidates: r?.candidate_sessions, truncated: !!r?.truncated })
      setSearched(true)
    }).catch((e: any) => { if (id !== reqId.current) return; setErr(e?.message || '搜索失败'); setResults([]) })
      .finally(() => { if (id === reqId.current) setLoading(false) })
  }

  const onType = (v: string) => {
    setQ(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(v), 450)
  }
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current) }, [])

  // 切换时间范围: 用当前关键词立即重搜 (范围切换是显式动作, 不防抖; 空关键词不触发).
  useEffect(() => {
    if (q.trim().length < 2) return
    runSearch(q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])

  const openSession = (r: SearchResult) => {
    const base = `/u/${user?.id}/p/${r.project_id}`
    const mid = r.scope_type === 'research' ? `/r/${r.research_id}` : `/i/${r.issue_id}`
    onNavigate(`${base}${mid}?session=${r.session_id}`)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center pt-[8vh] px-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full flex flex-col rounded-2xl shadow-2xl max-h-[calc(100vh-16vh-32px)]"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)', maxWidth: 'min(680px, calc(100vw - 32px))' }}>
        {/* 头部: 关键词输入 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b shrink-0" style={{ borderColor: 'var(--border-color)' }}>
          <Search className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => onType(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { if (debounceRef.current) clearTimeout(debounceRef.current); runSearch(q) } }}
            placeholder="搜索所有会话内容 (项目 → 任务/研究 → 会话 → 命中片段)…"
            className="flex-1 bg-transparent text-[13px] focus:outline-none placeholder:!text-[var(--placeholder-color)]"
            style={{ color: dark ? '#f1f5f9' : '#1e293b' }}
          />
          {/* 时间范围过滤 (默认 7 天内创建的会话): 缩小候选集加速扫描 */}
          <select
            value={range}
            onChange={e => setRange(e.target.value as RangeKey)}
            title="时间范围"
            className="flex-shrink-0 rounded-lg border text-[11px] px-1.5 py-1 cursor-pointer focus:outline-none"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color)', background: 'var(--modal-bg)' }}
          >
            {RANGE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {loading && <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" style={{ color: 'var(--text-muted)' }} />}
          {q && !loading && (
            <button type="button" onClick={() => { setQ(''); setResults([]); setMeta(null); setSearched(false); inputRef.current?.focus() }}
              className="flex-shrink-0 rounded hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
              <X className="w-4 h-4" />
            </button>
          )}
          <button type="button" onClick={onClose} title="关闭 (Esc)"
            className="flex-shrink-0 rounded hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 结果区 */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {err ? (
            <div className="px-4 py-8 flex flex-col items-center gap-2 text-center">
              <AlertCircle className="w-6 h-6" style={{ color: '#ef4444' }} />
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{err}</p>
            </div>
          ) : !searched ? (
            <div className="px-4 py-10 flex flex-col items-center gap-2 text-center">
              <FileSearch className="w-7 h-7" style={{ color: 'var(--text-muted)' }} />
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>输入关键词搜索会话内容</p>
              <p className="text-[10px]" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>{range === 'all' ? '扫描全部会话' : `仅扫描 ${rangeLabel}创建的会话`}，命中片段会高亮显示</p>
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-10 flex flex-col items-center gap-2 text-center">
              <Search className="w-6 h-6" style={{ color: 'var(--text-muted)' }} />
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>未找到匹配的会话</p>
            </div>
          ) : (
            <div className="py-1.5">
              {results.map(r => {
                const isResearch = r.scope_type === 'research'
                const ScopeIcon = isResearch ? FlaskConical : CircleDot
                return (
                  <button key={r.session_id} type="button" onClick={() => openSession(r)}
                    className="w-full text-left px-4 py-2.5 transition-colors hover:bg-[var(--bg-card-hover)] border-b"
                    style={{ borderColor: 'var(--border-color)' }}>
                    {/* 面包屑: 项目 › Issue/Research › Session */}
                    <div className="flex items-center gap-1 mb-1.5 flex-wrap text-[11px]">
                      <span className="inline-flex items-center gap-1 truncate" style={{ color: 'var(--text-secondary)' }}>
                        <Folder className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                        <span className="truncate max-w-[160px]">{r.project_name || '(未命名项目)'}</span>
                      </span>
                      <ChevronRight className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                      <span className="inline-flex items-center gap-1 truncate" style={{ color: 'var(--text-secondary)' }}>
                        <ScopeIcon className="w-3 h-3 flex-shrink-0" style={{ color: isResearch ? '#10b981' : '#60a5fa' }} />
                        <span className="truncate max-w-[180px]">{isResearch ? (r.research_title || '(研究)') : (r.issue_title || '(任务)')}</span>
                      </span>
                      <ChevronRight className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                      <span className="inline-flex items-center gap-1 truncate font-medium" style={{ color: dark ? '#e2e8f0' : '#1e293b' }}>
                        <MessagesSquare className="w-3 h-3 flex-shrink-0" style={{ color: '#a855f7' }} />
                        <span className="truncate max-w-[200px]">{r.session_name || '(未命名会话)'}</span>
                      </span>
                      <span className="ml-auto pl-2 flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{relativeTime(r.last_active)}</span>
                    </div>
                    {/* 命中片段 */}
                    <div className="space-y-1">
                      {r.fragments.map((f, i) => {
                        const rm = roleMeta(f.role)
                        return (
                          <div key={i} className="flex items-start gap-2">
                            <span className="flex-shrink-0 text-[9px] px-1.5 py-0.5 rounded mt-0.5" style={{ color: rm.color, background: rm.bg }}>{rm.label}</span>
                            <p className="text-[12px] leading-relaxed break-all" style={{ color: dark ? '#cbd5e1' : '#334155' }}>
                              <Highlight text={f.snippet} query={q} />
                            </p>
                          </div>
                        )
                      })}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 底部: 扫描统计 */}
        {(meta || searched) && (
          <div className="shrink-0 px-4 py-2 border-t flex items-center justify-between text-[10px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
            <span>
              {searched && results.length > 0 ? `命中 ${results.length} 个会话` : ''}
              {meta?.scanned != null ? ` · 扫描 ${meta.scanned}${meta.candidates != null ? `/${meta.candidates}` : ''} 个会话` : ''}
              {` · 范围: ${rangeLabel}`}
            </span>
            {meta?.truncated && <span style={{ color: '#f59e0b' }}>部分结果 (已达时间上限, 可缩小时间范围或换词)</span>}
          </div>
        )}
      </div>
    </div>
  )
}
