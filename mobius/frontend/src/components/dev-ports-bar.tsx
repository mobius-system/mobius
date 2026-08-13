import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, MonitorPlay, Plus, RefreshCw, X } from 'lucide-react'
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
 * 端口来源二选一: ① AI 启动服务后按协议写入 ports.json, 本组件低频轮询自动浮现;
 * ② 用户点 "+" 手动登记 (AI 用自然语言报告了端口、但没写文件时, 即时可用).
 */
export function DevPortsBar({ projectId, className }: DevPortsBarProps) {
  const [ports, setPorts] = useState<DevPortEntry[]>([])
  const [vscodeWebUrl, setVscodeWebUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [openingPort, setOpeningPort] = useState<number | null>(null)
  const [removingPort, setRemovingPort] = useState<number | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [addPort, setAddPort] = useState('')
  const [addLabel, setAddLabel] = useState('')
  const [adding, setAdding] = useState(false)
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
      const seen = new Set<number>()
      const deduped = (Array.isArray(data?.ports) ? data.ports as DevPortEntry[] : [])
        .filter((p) => {
          if (typeof p?.port !== 'number' || seen.has(p.port)) return false
          seen.add(p.port)
          return true
        }).sort((a, b) => a.port - b.port)
      setPorts(deduped)
      setError('')
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      if (ports.length === 0) setError(e?.message || '加载端口失败')
    }
  }, [projectId, ports.length])

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

  const handleAdd = useCallback(async () => {
    const portText = addPort.trim()
    if (!/^\d{1,5}$/.test(portText)) {
      setError('请输入 1-65535 的端口号')
      return
    }
    const port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('请输入 1-65535 的端口号')
      return
    }
    setAdding(true)
    setError('')
    try {
      await api(`/api/projects/${projectId}/dev-ports`, {
        method: 'POST',
        body: JSON.stringify({ port, label: addLabel.trim().slice(0, 40) }),
      })
      setAddPort('')
      setAddLabel('')
      setShowAddForm(false)
      await load()
    } catch (e: any) {
      setError(e?.message || '添加端口失败')
    } finally {
      setAdding(false)
    }
  }, [projectId, addPort, addLabel, load])

  const handleRemove = useCallback(async (port: number) => {
    setRemovingPort(port)
    setError('')
    try {
      await api(`/api/projects/${projectId}/dev-ports/${port}`, { method: 'DELETE' })
      await load()
    } catch (e: any) {
      setError(e?.message || '删除端口失败')
    } finally {
      setRemovingPort(null)
    }
  }, [projectId, load])

  const handleManualRefresh = useCallback(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load])

  // 无端口、不在加载、无错误、未展开添加表单: 不占位 (保持输入区整洁).
  if (!projectId || (ports.length === 0 && !loading && !error && !showAddForm)) return null

  const inputCls = 'h-7 px-2 rounded-md border bg-[var(--bg-primary)] text-[12px] font-mono outline-none focus:border-emerald-500/60'
  const inputStyle = { borderColor: 'var(--border-color)', color: 'var(--text-primary)' }

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
        const isRemoving = removingPort === p.port
        return (
          <div key={p.port} className="group relative inline-flex">
            <button
              type="button"
              onClick={() => handleOpen(p.port)}
              disabled={isOpening}
              title={`${entryLabel(p)} · :${p.port} · 点击打开预览`}
              className="inline-flex items-center gap-1 h-7 pl-2.5 pr-2 rounded-xl border border-emerald-500/25 bg-emerald-500/8 text-emerald-300 text-[11px] font-mono whitespace-nowrap transition-colors hover:bg-emerald-500/20 hover:border-emerald-500/45 disabled:opacity-55 disabled:cursor-wait"
            >
              {isOpening
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <ExternalLink className="w-3 h-3" />}
              <span className="font-sans">{entryLabel(p)}</span>
              <span className="opacity-70">:{p.port}</span>
            </button>
            <button
              type="button"
              onClick={() => handleRemove(p.port)}
              disabled={isRemoving}
              title="移除该端口"
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full border border-[var(--border-color)] bg-[var(--bg-primary)] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/20 hover:border-red-500/50 hover:text-red-300 disabled:opacity-50"
              style={{ color: 'var(--text-muted)' }}
            >
              {isRemoving ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <X className="w-2.5 h-2.5" />}
            </button>
          </div>
        )
      })}

      {/* 手动添加端口 (AI 用自然语言报告了端口但没写文件时, 即时登记) */}
      {showAddForm ? (
        <form
          className="inline-flex items-center gap-1 h-7 px-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/5"
          onSubmit={(e) => { e.preventDefault(); void handleAdd() }}
        >
          <input
            autoFocus
            inputMode="numeric"
            value={addPort}
            disabled={adding}
            onChange={(e) => { setAddPort(e.target.value); setError('') }}
            placeholder="端口"
            className={inputCls}
            style={inputStyle}
          />
          <input
            value={addLabel}
            disabled={adding}
            onChange={(e) => { setAddLabel(e.target.value); setError('') }}
            placeholder="标签(可选)"
            className={`${inputCls} font-sans w-[88px]`}
            style={inputStyle}
          />
          <button
            type="submit"
            disabled={adding}
            title="添加"
            className="h-7 px-2 rounded-md bg-emerald-500 text-white text-[11px] inline-flex items-center justify-center hover:bg-emerald-600 disabled:opacity-60"
          >
            {adding ? <Loader2 className="w-3 h-3 animate-spin" /> : '添加'}
          </button>
          <button
            type="button"
            disabled={adding}
            onClick={() => { setShowAddForm(false); setAddPort(''); setAddLabel(''); setError('') }}
            title="取消"
            className="h-7 w-6 rounded-md border border-[var(--border-color)] inline-flex items-center justify-center hover:bg-[var(--bg-card-hover)] disabled:opacity-50"
            style={{ color: 'var(--text-muted)' }}
          >
            <X className="w-3 h-3" />
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowAddForm(true)}
          title="手动登记一个端口"
          className="inline-flex items-center gap-0.5 h-7 px-2 rounded-xl border border-dashed border-[var(--border-color)] text-[var(--text-muted)] text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-secondary)]"
        >
          <Plus className="w-3 h-3" />
          端口
        </button>
      )}

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
