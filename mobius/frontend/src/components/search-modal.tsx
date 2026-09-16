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
import { api, useStore } from '../store'
import {
  Search, X, ChevronRight, Folder, CircleDot, FlaskConical,
  MessagesSquare, Loader2, AlertCircle, FileSearch, ArrowUpRight, Copy, Zap,
} from 'lucide-react'
import { useLayoutMode } from '../services/layout-mode'
import { buildEasyModeUrlFromContext } from '../services/easy-route-state'
import {
  EMPTY_PROJECT_HIERARCHY_SEARCH,
  hierarchyHitLabel,
  hierarchyHitUrl,
  type ProjectHierarchyGroup,
  type ProjectHierarchySearchResponse,
} from '../services/project-hierarchy-search'
import { SearchModeToggle, type SearchMode } from './search-mode-toggle'

type Fragment = { role: string; snippet: string; timestamp: string | null; uuid?: string | null }
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

type SelectedSearchFragment = { result: SearchResult; fragment: Fragment }
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

// 把片段按关键词切开, 命中段包 <mark>. 与后端 buildMatcher 同口径:
// 大小写敏感 / 全字匹配 (全字用 \w 词边界, CJK 视为边界).
function Highlight({ text, query, caseSensitive, wholeWord }: { text: string; query: string; caseSensitive: boolean; wholeWord: boolean }) {
  const parts = useMemo(() => {
    const q = query.trim()
    if (!q) return [text]
    let re: RegExp
    try {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const flags = caseSensitive ? 'g' : 'gi'
      re = wholeWord ? new RegExp(`(?<![\\w])${escaped}(?![\\w])`, flags) : new RegExp(escaped, flags)
    } catch {
      return [text]
    }
    const out: Array<{ s: string; hit: boolean }> = []
    let last = 0
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ s: text.slice(last, m.index), hit: false })
      out.push({ s: m[0], hit: true })
      last = m.index + m[0].length
      if (m[0].length === 0) re.lastIndex++ // 防止零宽匹配死循环
    }
    if (last < text.length) out.push({ s: text.slice(last), hit: false })
    return out.map((p, k) => (p.hit
      ? <mark key={k} className="rounded px-0.5" style={{ background: 'rgba(250,204,21,0.45)', color: 'inherit' }}>{p.s}</mark>
      : <span key={k}>{p.s}</span>))
  }, [text, query, caseSensitive, wholeWord])
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

// 时间范围过滤选项: 默认仅扫描 7 天内活跃的会话以加速搜索 (后端按 last_active 过滤候选集).
type RangeKey = '1d' | '7d' | '30d' | 'all'
const RANGE_OPTIONS: Array<{ value: RangeKey; label: string }> = [
  { value: '1d', label: '1天内' },
  { value: '7d', label: '7天内' },
  { value: '30d', label: '1个月内' },
  { value: 'all', label: '全部' },
]

export function SearchModal({
  onClose,
  onNavigate,
  initialQuery = '',
  initialMode = 'deep',
}: {
  onClose: () => void
  onNavigate: (path: string) => void
  initialQuery?: string
  initialMode?: SearchMode
}) {
  const { theme, user } = useStore()
  const layoutMode = useLayoutMode()
  const dark = theme !== 'light'
  const [q, setQ] = useState(initialQuery)
  const [mode, setMode] = useState<SearchMode>(initialMode)
  const [results, setResults] = useState<SearchResult[]>([])
  const [quickResults, setQuickResults] = useState<ProjectHierarchySearchResponse>(EMPTY_PROJECT_HIERARCHY_SEARCH)
  const [loading, setLoading] = useState(false)
  const [quickLoading, setQuickLoading] = useState(false)
  const [err, setErr] = useState('')
  const [meta, setMeta] = useState<{ scanned?: number; candidates?: number; truncated?: boolean } | null>(null)
  const [searched, setSearched] = useState(false) // 是否已发起过搜索 (区分初始空态 vs 无结果)
  const [range, setRange] = useState<RangeKey>('7d')
  const rangeLabel = RANGE_OPTIONS.find(o => o.value === range)?.label || '7天内'
  const reqId = useRef(0)
  const quickReqId = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const quickAbortRef = useRef<AbortController | null>(null)
  // 匹配选项: caseSensitive 区分大小写, wholeWord 全字匹配 (与后端 /api/search 的 case/word 参数同口径).
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  // 搜索结果先打开命中预览，用户确认后才离开当前搜索弹窗进入会话。
  // 这既让上下文可复制，也避免点击整张结果卡时误跳到非预期片段。
  const [selectedFragment, setSelectedFragment] = useState<SelectedSearchFragment | null>(null)
  // 最新匹配选项的 ref: Enter 键 / 流式回调里读到最新值, 避免闭包陈旧.
  const optsRef = useRef({ caseSensitive, wholeWord, range })
  optsRef.current = { caseSensitive, wholeWord, range }
  const isQuick = mode === 'quick'
  const isLoading = isQuick ? quickLoading : loading

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // 流式搜索: GET /api/search?stream=1 走 SSE, result 事件随扫描完成逐条下发, 前端增量渲染.
  // 不能用 EventSource (无法带 Authorization 头), 改用 fetch + ReadableStream 手解 SSE 帧.
  const runSearch = (term: string, rangeArg: RangeKey = optsRef.current.range, cs: boolean = optsRef.current.caseSensitive, ww: boolean = optsRef.current.wholeWord) => {
    const t = term.trim()
    if (t.length < 2) {
      abortRef.current?.abort()
      setResults([]); setMeta(null); setLoading(false); setErr(''); setSearched(false)
      return
    }
    const id = ++reqId.current
    // 取消上一个在途请求 (新查询 / 改选项 / 关弹窗都会触发).
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoading(true); setErr(''); setResults([]); setSearched(true); setMeta(null)
    const params = new URLSearchParams({ q: t, limit: '50', range: rangeArg, stream: '1' })
    if (cs) params.set('case', '1')
    if (ww) params.set('word', '1')
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('cc-token') : null
    fetch(`/api/search?${params.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: ctrl.signal,
    }).then((res) => {
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      const handleFrame = (event: string, payload: any) => {
        if (id !== reqId.current) return // 陈旧响应丢弃
        if (event === 'result') {
          setResults(prev => [...prev, payload as SearchResult])
        } else if (event === 'start') {
          setMeta({ candidates: payload?.candidate_sessions })
        } else if (event === 'done') {
          setMeta({ scanned: payload?.scanned_sessions, candidates: payload?.candidate_sessions, truncated: !!payload?.truncated })
          setLoading(false)
        } else if (event === 'error') {
          setErr(payload?.error || '搜索失败'); setLoading(false)
        }
      }
      const dispatch = () => {
        // SSE 帧以空行 (\n\n) 分隔; 每帧内 event:/data: 行. data 行可能多行 (payload 含换行时).
        let sep: number
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          let event = 'message'
          const dataLines: string[] = []
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
          }
          if (dataLines.length === 0) continue // 注释帧 / keepalive
          let payload: any
          try { payload = JSON.parse(dataLines.join('\n')) } catch { continue }
          handleFrame(event, payload)
        }
      }
      const pump = (): Promise<void> => reader.read().then(({ done, value }) => {
        if (done) { if (id === reqId.current) setLoading(false); return }
        buf += dec.decode(value, { stream: true })
        dispatch()
        return pump()
      })
      return pump()
    }).catch((e: any) => {
      if (e?.name === 'AbortError') return
      if (id !== reqId.current) return
      setErr(e?.message || '搜索失败'); setLoading(false)
    })
  }

  // 快速搜索复用用户主页的层级搜索: 只查项目/任务/研究/会话元数据, 不扫描 JSONL 正文.
  const runQuickSearch = (term: string) => {
    const t = term.trim()
    if (t.length < 1) {
      quickAbortRef.current?.abort()
      setQuickResults(EMPTY_PROJECT_HIERARCHY_SEARCH)
      setQuickLoading(false)
      setSearched(false)
      return
    }
    const id = ++quickReqId.current
    quickAbortRef.current?.abort()
    const ctrl = new AbortController()
    quickAbortRef.current = ctrl
    setQuickLoading(true)
    setErr('')
    setSearched(true)
    api(`/api/projects/hierarchy-search?q=${encodeURIComponent(t.slice(0, 200))}`, { signal: ctrl.signal })
      .then((payload: ProjectHierarchySearchResponse) => {
        if (id !== quickReqId.current) return
        setQuickResults(payload || EMPTY_PROJECT_HIERARCHY_SEARCH)
      })
      .catch((e: any) => {
        if (e?.name === 'AbortError') return
        if (id !== quickReqId.current) return
        setErr(e?.message || '搜索失败')
      })
      .finally(() => {
        if (id === quickReqId.current && !ctrl.signal.aborted) setQuickLoading(false)
      })
  }

  // 从主页内嵌搜索框打开时，复用传入的关键词直接启动对应搜索模式。
  useEffect(() => {
    const term = initialQuery.trim()
    if (!term) return
    if (initialMode === 'quick') runQuickSearch(term)
    else runSearch(term)
    // SearchModal 每次打开都会重新挂载，初始关键词只需执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onType = (v: string) => {
    setQ(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      if (mode === 'quick') runQuickSearch(v)
      else runSearch(v)
    }, mode === 'quick' ? 300 : 450)
  }
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    abortRef.current?.abort()
    quickAbortRef.current?.abort()
  }, [])

  // 切换模式后保留关键词并立即走新模式的搜索链路。
  useEffect(() => {
    setSelectedFragment(null)
    abortRef.current?.abort()
    quickAbortRef.current?.abort()
    setLoading(false)
    setQuickLoading(false)
    if (q.trim()) {
      if (mode === 'quick') runQuickSearch(q)
      else runSearch(q)
    } else {
      setResults([])
      setQuickResults(EMPTY_PROJECT_HIERARCHY_SEARCH)
      setSearched(false)
      setErr('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // 切换时间范围 / 大小写 / 全字: 用当前关键词立即重搜 (显式动作, 不防抖; 空关键词不触发).
  useEffect(() => {
    if (mode === 'quick' || q.trim().length < 2) return
    runSearch(q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, caseSensitive, wholeWord])

  // 次级预览确认后 → 进入该 Session 并跳到指定命中片段所属的卡片.
  // 优先用片段 uuid (claude entry.uuid / codex entry.id), 缺失则用 timestamp 区间兜底 (见 JsonlView).
  // 极简模式下改跳极简工作台 (research → research 区带 agent), 由 easy-route-state 统一构造。
  const openSession = (r: SearchResult, frag?: Fragment) => {
    const first = frag || r.fragments[0]
    // Keep all hits for the destination session so the session footer can offer
    // previous/next navigation after the URL's one-shot match parameters are cleared.
    try {
      localStorage.setItem(`mobius:search-hits:${r.session_id}`, JSON.stringify(r.fragments))
    } catch {}
    const extra = (() => {
      if (!first) return ''
      const parts: string[] = []
      if (first.uuid) parts.push(`match=${encodeURIComponent(first.uuid)}`)
      if (first.timestamp) parts.push(`ts=${encodeURIComponent(first.timestamp)}`)
      return parts.length ? parts.join('&') : ''
    })()
    let targetUrl: string
    if (layoutMode === 'easy_mode') {
      const base = buildEasyModeUrlFromContext({
          user: user?.id || '',
          projectId: r.project_id,
          sessionId: r.session_id,
          researchId: r.research_id,
          scopeType: r.scope_type,
        })
      targetUrl = extra ? `${base}${base.includes('?') ? '&' : '?'}${extra}` : base
    } else {
      const base = `/u/${user?.id}/p/${r.project_id}`
      const mid = r.scope_type === 'research' ? `/r/${r.research_id}` : `/i/${r.issue_id}`
      targetUrl = `${base}${mid}?session=${r.session_id}${extra ? `&${extra}` : ''}`
    }
    const isDesktop = typeof window !== 'undefined' && !!(window as { mobiusDesktop?: { isDesktop?: boolean } }).mobiusDesktop?.isDesktop
    if (isDesktop) onNavigate(targetUrl)
    else window.open(targetUrl, '_blank', 'noopener,noreferrer')
    onClose()
  }

  const openFragmentPreview = (r: SearchResult, frag?: Fragment) => {
    const target = frag || r.fragments[0]
    if (target) setSelectedFragment({ result: r, fragment: target })
  }

  const openQuickResult = (group: ProjectHierarchyGroup, hit?: ProjectHierarchyGroup['matches'][number]) => {
    const project = group.project || {}
    const target = hit
      ? hierarchyHitUrl(project, hit)
      : `/u/${encodeURIComponent(project.created_by || user?.id || '')}/p/${encodeURIComponent(project.id || '')}`
    onNavigate(target)
    onClose()
  }

  const clearSearch = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    abortRef.current?.abort()
    quickAbortRef.current?.abort()
    setQ('')
    setResults([])
    setQuickResults(EMPTY_PROJECT_HIERARCHY_SEARCH)
    setMeta(null)
    setSearched(false)
    setErr('')
    inputRef.current?.focus()
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center pt-[8vh] px-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full flex flex-col rounded-2xl shadow-2xl max-h-[calc(100vh-16vh-32px)]"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)', maxWidth: 'min(680px, calc(100vw - 32px))' }}>
        {/* 头部: 关键词输入 + 搜索模式切换。模式在同一弹窗内切换，关键词保持不变。 */}
        <div className="shrink-0 border-b px-4 py-3" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Search className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
            <input
              ref={inputRef}
              value={q}
              onChange={e => onType(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { if (debounceRef.current) clearTimeout(debounceRef.current); isQuick ? runQuickSearch(q) : runSearch(q) } }}
              placeholder={isQuick ? '快速搜索项目、任务或会话…' : '深度搜索所有会话内容…'}
              className="min-w-0 flex-1 bg-transparent text-[13px] focus:outline-none placeholder:!text-[var(--placeholder-color)]"
              style={{ color: dark ? '#f1f5f9' : '#1e293b' }}
            />
            {isLoading && <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" style={{ color: 'var(--text-muted)' }} />}
            <div className="ml-auto flex flex-shrink-0 flex-wrap items-center justify-end gap-1.5">
              <SearchModeToggle mode={mode} onChange={setMode} />
              {!isQuick && <>
                {/* 匹配选项: 大小写敏感 (Aa) / 全字匹配 (W). */}
                <button type="button" onClick={() => setCaseSensitive(v => !v)} title="区分大小写" aria-pressed={caseSensitive}
                  className="h-7 w-7 flex-shrink-0 rounded-md border text-[11px] font-semibold transition-colors"
                  style={{ color: caseSensitive ? 'var(--accent-primary, #60a5fa)' : 'var(--text-muted)', borderColor: caseSensitive ? 'var(--accent-primary, #60a5fa)' : 'var(--border-color)', background: caseSensitive ? 'rgba(96,165,250,0.12)' : 'transparent' }}>Aa</button>
                <button type="button" onClick={() => setWholeWord(v => !v)} title="全字匹配" aria-pressed={wholeWord}
                  className="h-7 w-7 flex-shrink-0 rounded-md border text-[11px] font-semibold transition-colors"
                  style={{ color: wholeWord ? 'var(--accent-primary, #60a5fa)' : 'var(--text-muted)', borderColor: wholeWord ? 'var(--accent-primary, #60a5fa)' : 'var(--border-color)', background: wholeWord ? 'rgba(96,165,250,0.12)' : 'transparent' }}>W</button>
                <select value={range} onChange={e => setRange(e.target.value as RangeKey)} title="时间范围"
                  className="h-7 flex-shrink-0 rounded-lg border px-1.5 text-[11px] cursor-pointer focus:outline-none"
                  style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color)', background: 'var(--modal-bg)' }}>
                  {RANGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </>}
            </div>
            {q && !isLoading && (
              <button type="button" onClick={clearSearch} title="清空关键词" aria-label="清空关键词"
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
                <X className="h-4 w-4" />
              </button>
            )}
            <button type="button" onClick={onClose} title="关闭 (Esc)" aria-label="关闭搜索"
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
              <X className="h-4 w-4" />
            </button>
          </div>
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
              {isQuick ? <Zap className="h-7 w-7" style={{ color: '#fbbf24' }} /> : <FileSearch className="h-7 w-7" style={{ color: 'var(--text-muted)' }} />}
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{isQuick ? '输入关键词快速定位项目、任务或会话' : '输入关键词搜索会话内容'}</p>
              <p className="text-[10px]" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>{isQuick ? '仅匹配名称与描述，响应更快' : `${range === 'all' ? '扫描全部会话' : `仅扫描 ${rangeLabel}内活跃的会话`}，命中片段会高亮显示`}</p>
            </div>
          ) : isQuick ? (
            quickResults.projects.length === 0 ? (
              <div className="px-4 py-10 flex flex-col items-center gap-2 text-center">
                <Search className="h-6 w-6" style={{ color: 'var(--text-muted)' }} />
                <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>未找到匹配的项目、任务或会话</p>
              </div>
            ) : (
              <div className="py-1.5">
                {quickResults.projects.map(group => <QuickSearchGroup key={String(group.project?.id)} group={group} query={q} dark={dark} onOpen={openQuickResult} />)}
              </div>
            )
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
                  <button key={r.session_id} type="button" onClick={() => openFragmentPreview(r)}
                    data-search-result={r.session_id}
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
                    {/* 命中片段: 先打开上下文预览；stopPropagation 避免改选成结果卡的首片段. */}
                    <div className="space-y-1">
                      {r.fragments.map((f, i) => {
                        const rm = roleMeta(f.role)
                        return (
                          <div
                            key={i}
                            onClick={(e) => { e.stopPropagation(); openFragmentPreview(r, f) }}
                            data-search-fragment={`${r.session_id}:${i}`}
                            title="查看命中上下文"
                            className="flex items-start gap-2 rounded -mx-1 px-1 py-0.5 cursor-pointer hover:bg-[var(--bg-hover)]"
                          >
                            <span className="flex-shrink-0 text-[9px] px-1.5 py-0.5 rounded mt-0.5" style={{ color: rm.color, background: rm.bg }}>{rm.label}</span>
                            <p className="text-[12px] leading-relaxed break-all" style={{ color: dark ? '#cbd5e1' : '#334155' }}>
                              <Highlight text={f.snippet} query={q} caseSensitive={caseSensitive} wholeWord={wholeWord} />
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
        {!isQuick && (meta || searched) && (
          <div className="shrink-0 px-4 py-2 border-t flex items-center justify-between text-[10px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
            <span>
              {loading && results.length === 0 ? '正在搜索…' : ''}
              {searched && results.length > 0 ? `命中 ${results.length} 个会话${loading ? '…' : ''}` : ''}
              {meta?.scanned != null ? ` · 扫描 ${meta.scanned}${meta.candidates != null ? `/${meta.candidates}` : ''} 个会话` : ''}
              {` · 范围: ${rangeLabel}`}
              {caseSensitive || wholeWord ? ` · ${[caseSensitive ? '区分大小写' : '', wholeWord ? '全字匹配' : ''].filter(Boolean).join(' / ')}` : ''}
            </span>
            {meta?.truncated && <span style={{ color: '#f59e0b' }}>部分结果 (已达时间上限, 可缩小时间范围或换词)</span>}
          </div>
        )}
        {isQuick && searched && (
          <div className="shrink-0 border-t px-4 py-2 text-[10px]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}>
            {quickLoading ? '正在快速搜索…' : `匹配 ${quickResults.project_count} 个项目 · ${quickResults.match_count} 条结果`}
            {quickResults.truncated ? ' · 结果较多，仅显示最相关项' : ''}
          </div>
        )}
      </div>

      {selectedFragment && (
        <SearchFragmentPreviewModal
          result={selectedFragment.result}
          fragment={selectedFragment.fragment}
          query={q}
          caseSensitive={caseSensitive}
          wholeWord={wholeWord}
          dark={dark}
          onBack={() => setSelectedFragment(null)}
          onViewInSession={() => openSession(selectedFragment.result, selectedFragment.fragment)}
        />
      )}
    </div>
  )
}

function QuickSearchGroup({
  group,
  query,
  dark,
  onOpen,
}: {
  group: ProjectHierarchyGroup
  query: string
  dark: boolean
  onOpen: (group: ProjectHierarchyGroup, hit?: ProjectHierarchyGroup['matches'][number]) => void
}) {
  const project = group.project || {}
  const visibleMatches = group.matches.slice(0, 8)
  return (
    <div className="border-b px-4 py-2.5 last:border-b-0" style={{ borderColor: 'var(--border-color)' }} data-quick-search-result={project.id}>
      <button type="button" onClick={() => onOpen(group)} className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-[var(--bg-card-hover)]">
        <Folder className="h-3.5 w-3.5 flex-shrink-0" style={{ color: '#60a5fa' }} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: dark ? '#e2e8f0' : '#1e293b' }}>{project.name || '(未命名项目)'}</span>
        <span className="flex-shrink-0 text-[10px]" style={{ color: 'var(--text-muted)' }}>{group.total_matches ? `${group.total_matches} 条匹配` : '项目匹配'}</span>
        <ChevronRight className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
      </button>
      {visibleMatches.length > 0 && (
        <div className="ml-5 mt-1 space-y-0.5 border-l pl-2" style={{ borderColor: 'var(--border-color)' }}>
          {visibleMatches.map(hit => {
            const isResearch = hit.kind === 'research' || hit.kind === 'research_agent'
            const Icon = hit.kind === 'issue' ? CircleDot : isResearch ? FlaskConical : MessagesSquare
            return (
              <button key={`${hit.kind}:${hit.id}`} type="button" onClick={() => onOpen(group, hit)}
                className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[var(--bg-card-hover)]"
                title={`${hierarchyHitLabel(hit.kind)}：${hit.title}`}>
                <Icon className="h-3 w-3 flex-shrink-0" style={{ color: isResearch ? '#10b981' : hit.kind === 'issue' ? '#60a5fa' : '#a855f7' }} />
                <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: 'var(--text-secondary)' }}>{hit.title || '(未命名)'}</span>
                <span className="flex-shrink-0 rounded px-1 py-0.5 text-[9px]" style={{ color: 'var(--text-muted)', background: 'rgba(148,163,184,0.10)' }}>{hierarchyHitLabel(hit.kind)}</span>
              </button>
            )
          })}
        </div>
      )}
      {visibleMatches.length < group.total_matches && (
        <div className="ml-7 mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>还有 {group.total_matches - visibleMatches.length} 条匹配</div>
      )}
      {group.project_match && group.project_matched_fields.length > 0 && (
        <div className="ml-7 mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>项目{group.project_matched_fields.includes('description') ? '描述' : '名称'}命中“{query}”</div>
      )}
    </div>
  )
}

// 搜索二级弹窗：服务于“先看上下文、再确认跳转”的流程。
// 文本不是 button/input，也不加 user-select:none，因此浏览器原生支持框选并复制其中任意一段。
function SearchFragmentPreviewModal({
  result,
  fragment,
  query,
  caseSensitive,
  wholeWord,
  dark,
  onBack,
  onViewInSession,
}: {
  result: SearchResult
  fragment: Fragment
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  dark: boolean
  onBack: () => void
  onViewInSession: () => void
}) {
  const isResearch = result.scope_type === 'research'
  const ScopeIcon = isResearch ? FlaskConical : CircleDot
  const rm = roleMeta(fragment.role)
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="搜索命中预览" data-search-fragment-preview>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onBack} />
      <div
        className="relative flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl shadow-2xl"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)', maxHeight: 'min(620px, calc(100vh - 32px))' }}
      >
        <div className="flex items-start justify-between gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--border-color)' }}>
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold" style={{ color: dark ? '#f1f5f9' : '#1e293b' }}>
              <FileSearch className="h-4 w-4 flex-shrink-0 text-blue-400" />
              <span>命中片段预览</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span className="truncate max-w-[150px]">{result.project_name || '(未命名项目)'}</span>
              <ChevronRight className="h-3 w-3 flex-shrink-0" />
              <ScopeIcon className="h-3 w-3 flex-shrink-0" style={{ color: isResearch ? '#10b981' : '#60a5fa' }} />
              <span className="truncate max-w-[180px]">{isResearch ? (result.research_title || '(研究)') : (result.issue_title || '(任务)')}</span>
              <ChevronRight className="h-3 w-3 flex-shrink-0" />
              <span className="truncate max-w-[220px]">{result.session_name || '(未命名会话)'}</span>
            </div>
          </div>
          <button type="button" onClick={onBack} title="返回搜索结果" aria-label="返回搜索结果" className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-muted)' }}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto px-5 py-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[10px] rounded px-1.5 py-0.5" style={{ color: rm.color, background: rm.bg }}>{rm.label}</span>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>命中位置前后的上下文 · 可直接框选复制</span>
          </div>
          <div className="select-text whitespace-pre-wrap break-words rounded-xl border px-4 py-3 text-[13px] leading-7" style={{ color: dark ? '#e2e8f0' : '#1e293b', borderColor: 'var(--border-color)', background: dark ? 'rgba(15,23,42,0.35)' : 'rgba(248,250,252,0.75)' }}>
            <Highlight text={fragment.snippet} query={query} caseSensitive={caseSensitive} wholeWord={wholeWord} />
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <Copy className="h-3 w-3" />
            <span>选择文字后可使用系统复制快捷键。</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t px-5 py-3" style={{ borderColor: 'var(--border-color)' }}>
          <button type="button" onClick={onBack} className="rounded-lg px-3 py-1.5 text-[12px] hover:bg-[var(--bg-card-hover)]" style={{ color: 'var(--text-secondary)' }}>返回搜索结果</button>
          <button type="button" onClick={onViewInSession} data-search-view-session className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-blue-400">
            <span>在会话中查看</span>
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
