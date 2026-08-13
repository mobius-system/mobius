import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, MonitorPlay, RefreshCw } from 'lucide-react'
import { api } from '../store'
import { pollRecursive } from '../services/polling'
import { openPortPreview, type DevPortEntry } from './project-files'

// kind → 中文标签. 仅当端口条目没有自定义 label 时使用.
const KIND_LABELS: Record<string, string> = {
  frontend: '前端',
  backend: '后端',
  api: 'API',
  server: '服务',
  db: '数据库',
  database: '数据库',
  admin: '后台',
  auth: '认证',
  proxy: '代理',
  web: 'Web',
  other: '其他',
}

function entryLabel(entry: DevPortEntry): string {
  const label = (entry.label || '').trim()
  if (label) return label
  const k = (entry.kind || '').trim().toLowerCase()
  return KIND_LABELS[k] || (k ? k : '端口')
}

type DevPortsBarProps = {
  projectId?: string | null
  className?: string
}

/**
 * 端口预览栏: 当项目注册了开发端口时, 在会话输入区上方常驻一排可点 chip.
 * 点击即打开该端口的预览 (桌面端 AIMUX forward / Web 端 code-server proxy).
 *
 * 解决"AI 起了 dev server 报告端口, 但用户在界面里无处可点、看不到渲染结果"的痛点.
 * 端口列表由 AI 启动服务后写入 .mobius/port_forward/ports.json, 本组件低频轮询拉取,
 * 因此 AI 一注册端口, chip 会自动浮现, 无需用户手动刷新.
 */
export function DevPortsBar({ projectId, className }: DevPortsBarProps) {
  const [ports, setPorts] = useState<DevPortEntry[]>([])
  const [vscodeWebUrl, setVscodeWebUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [openingPort, setOpeningPort] = useState<number | null>(null)
  const desktopBridge: any = typeof window !== 'undefined' ? (window as any).mobiusDesktop : undefined

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!projectId) {
      setPorts([])
      setVscodeWebUrl('')
      return
    }
    try {
      const [files, data] = await Promise.all([
        api(`/api/projects/${projectId}/files?path=/`, signal ? { signal } : undefined),
        api(`/api/projects/${projectId}/dev-ports`, signal ? { signal } : undefined),
      ])
      if (signal?.aborted) return
      setVscodeWebUrl(files?.vscode_web_url || '')
      const next = Array.isArray(data?.ports) ? data.ports as DevPortEntry[] : []
      // 按 port 去重 + 排序 (稳定 chip 顺序, 避免 AI 重复写入时跳动).
      const seen = new Set<number>()
      const deduped = next.filter((p) => {
        if (typeof p?.port !== 'number' || seen.has(p.port)) return false
        seen.add(p.port)
        return true
      }).sort((a, b) => a.port - b.port)
      setPorts(deduped)
      setError('')
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      // 首次加载失败才报错; 轮询中的失败静默 (pollRecursive 已吞).
      if (ports.length === 0) setError(e?.message || '加载端口失败')
    }
  }, [projectId, ports.length])

  // 首次加载 + 切换项目重新加载.
  useEffect(() => {
    if (!projectId) {
      setPorts([])
      setError('')
      return
    }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [projectId, load])

  // 低频轮询: AI 可能在会话进行中随时启动新服务并注册端口, 每 12s 拉一次让 chip 自动浮现.
  // 用 pollRecursive 而非 setInterval (慢网下避免请求雪球). signal 透传给 api().
  useEffect(() => {
    if (!projectId) return
    const stop = pollRecursive((signal) => { void load(signal) }, 12_000, 10_000)
    return stop
  }, [projectId, load])

  const handleOpen = useCallback(async (port: number) => {
    setOpeningPort(port)
    setError('')
    try {
      const r = await openPortPreview(port, { vscodeWebUrl, desktopBridge })
      if (!r.ok) setError(r.error || '打开端口失败')
    } finally {
      setOpeningPort(null)
    }
  }, [vscodeWebUrl, desktopBridge])

  const handleManualRefresh = useCallback(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  // 无端口且不在加载中: 不占位 (保持输入区整洁).
  if (!projectId || (ports.length === 0 && !loading && !error)) return null

  return (
    <div
      className={`dev-ports-bar flex items-center gap-1.5 flex-wrap px-1 py-1 ${className || ''}`}
      data-testid="dev-ports-bar"
    >
      <span className="inline-flex items-center gap-1 text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>
        <MonitorPlay className="w-3.5 h-3.5" />
        端口预览
      </span>
      {loading && ports.length === 0 && (
        <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          加载中
        </span>
      )}
      {ports.map((p) => {
        const isOpening = openingPort === p.port
        return (
          <button
            key={p.port}
            type="button"
            onClick={() => handleOpen(p.port)}
            disabled={isOpening}
            title={`${entryLabel(p)} · :${p.port} · 点击打开预览`}
            className="inline-flex items-center gap-1 h-7 px-2.5 rounded-xl border border-emerald-500/25 bg-emerald-500/8 text-emerald-300 text-[11px] font-mono whitespace-nowrap transition-colors hover:bg-emerald-500/20 hover:border-emerald-500/45 disabled:opacity-55 disabled:cursor-wait"
          >
            {isOpening
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <ExternalLink className="w-3 h-3" />}
            <span className="font-sans">{entryLabel(p)}</span>
            <span className="opacity-70">:{p.port}</span>
          </button>
        )
      })}
      <button
        type="button"
        onClick={handleManualRefresh}
        disabled={loading}
        title="刷新端口列表"
        className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-[var(--border-color)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-50"
      >
        <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
      </button>
      {error && (
        <span className="text-[11px] text-red-300 truncate max-w-[60%]" title={error}>{error}</span>
      )}
    </div>
  )
}
