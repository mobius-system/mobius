import { useEffect, useMemo, useState } from 'react'
import { Archive, Download, File, Folder, RefreshCw } from 'lucide-react'
import { api, HIDDEN_FOLDER_NAME } from '../../store'

type PackageEntry = {
  name: string
  type: 'dir' | 'file' | 'symlink' | 'other'
  size: number
  modified?: string
  default_selected?: boolean
}

type PackageItemsResponse = {
  bind_path: string
  package_dir: string
  excluded_path: string
  warning_threshold: number
  entries: PackageEntry[]
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

function formatModified(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function entryTypeLabel(type: PackageEntry['type']) {
  if (type === 'dir') return '文件夹'
  if (type === 'file') return '文件'
  if (type === 'symlink') return '符号链接'
  return '其他'
}

function parseDownloadName(disposition: string | null) {
  if (!disposition) return ''
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try { return decodeURIComponent(utf8Match[1]) } catch {}
  }
  const match = disposition.match(/filename="?([^";]+)"?/i)
  return match?.[1] || ''
}

export function ProjectPackagePanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<PackageItemsResponse | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const selectedEntries = useMemo(
    () => (data?.entries || []).filter((entry) => selected.has(entry.name)),
    [data?.entries, selected],
  )
  const selectedSize = selectedEntries.reduce((sum, entry) => sum + (entry.size || 0), 0)
  const allSelected = !!data?.entries?.length && selected.size === data.entries.length

  const loadEntries = async () => {
    if (!projectId) return
    setLoading(true)
    setError('')
    setMessage('')
    try {
      const next = await api(`/api/projects/${projectId}/package/items`)
      const entries = Array.isArray(next?.entries) ? next.entries : []
      setData({ ...next, entries })
      setSelected(new Set(entries.filter((entry: PackageEntry) => entry.default_selected !== false).map((entry: PackageEntry) => entry.name)))
    } catch (e: any) {
      setError(e?.message || '读取可打包文件失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadEntries()
  }, [projectId])

  const toggleEntry = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const toggleAll = () => {
    if (!data?.entries?.length) return
    setSelected(allSelected ? new Set() : new Set(data.entries.map((entry) => entry.name)))
  }

  const downloadPackage = async () => {
    if (!projectId || downloading) return
    const names = Array.from(selected)
    if (names.length === 0) {
      setError('请至少选择一个文件或文件夹')
      return
    }
    setDownloading(true)
    setError('')
    setMessage('')
    try {
      const estimate = await api(`/api/projects/${projectId}/package/estimate`, {
        method: 'POST',
        body: JSON.stringify({ names }),
      })
      const totalSize = Number(estimate?.total_size || 0)
      const proceed = window.confirm(`将打包 ${names.length} 个表层条目，文件总大小约 ${formatBytes(totalSize)}。压缩包会保存到项目目录的 ${HIDDEN_FOLDER_NAME}/package_zip 下。是否继续？`)
      if (!proceed) return
      if (totalSize > Number(estimate?.warning_threshold || 500 * 1024 * 1024)) {
        const proceedLarge = window.confirm(`本次打包超过 ${formatBytes(Number(estimate.warning_threshold || 500 * 1024 * 1024))}，生成和下载可能较慢。确认继续打包下载？`)
        if (!proceedLarge) return
      }

      const token = localStorage.getItem('cc-token')
      const res = await fetch(`/api/projects/${projectId}/package/download`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ names }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => null)
        throw new Error(err?.error || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = parseDownloadName(res.headers.get('Content-Disposition')) || `project-package-${Date.now()}.zip`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setMessage(`已生成并开始下载压缩包，大小 ${formatBytes(blob.size)}。`)
      loadEntries()
    } catch (e: any) {
      setError(e?.message || '打包下载失败')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-medium" style={{ color: 'var(--text-primary)' }}>打包下载</h3>
            {selected.size > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-full border border-blue-500/25 bg-blue-500/10 text-blue-400">
                已选 {selected.size} 项 · {formatBytes(selectedSize)}
              </span>
            )}
          </div>
          <div className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-muted)' }}>
            只显示项目绑定目录下的表层文件和文件夹。{HIDDEN_FOLDER_NAME} 默认不选（莫比乌斯的工作缓存路径）；如果选择{HIDDEN_FOLDER_NAME}，系统仍会跳过 {HIDDEN_FOLDER_NAME}/package_zip。
          </div>
        </div>
        <button
          type="button"
          onClick={loadEntries}
          disabled={loading || downloading}
          className="h-8 px-3 rounded-lg text-[12px] bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors border border-blue-500/20 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.8} />
          刷新
        </button>
      </div>

      {data?.bind_path && (
        <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }} title={data.bind_path}>
          绑定目录：{data.bind_path}
        </div>
      )}

      {error && (
        <div className="text-[12px] px-3 py-2 rounded-lg border border-red-500/25 bg-red-500/10 text-red-400">
          {error}
        </div>
      )}
      {message && (
        <div className="text-[12px] px-3 py-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 text-emerald-400">
          {message}
        </div>
      )}

      <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
        <div className="flex items-center gap-3 px-3 py-2 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <label className="flex items-center gap-2 text-[12px] cursor-pointer select-none" style={{ color: 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              disabled={loading || downloading || !data?.entries?.length}
              className="w-4 h-4 accent-blue-500 cursor-pointer disabled:cursor-not-allowed"
            />
            全选
          </label>
          <div className="flex-1" />
          <button
            type="button"
            onClick={downloadPackage}
            disabled={loading || downloading || selected.size === 0}
            className="h-8 px-3 rounded-lg text-[12px] bg-emerald-500/15 text-emerald-500 hover:bg-emerald-500/25 transition-colors border border-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            {downloading ? <Archive className="h-3.5 w-3.5 animate-pulse" strokeWidth={1.8} /> : <Download className="h-3.5 w-3.5" strokeWidth={1.8} />}
            {downloading ? '打包中...' : '下载'}
          </button>
        </div>

        {loading && !data ? (
          <div className="text-[12px] px-3 py-8 text-center" style={{ color: 'var(--text-muted)' }}>
            正在读取项目目录...
          </div>
        ) : !data?.entries?.length ? (
          <div className="text-[12px] px-3 py-8 text-center" style={{ color: 'var(--text-muted)' }}>
            项目绑定目录下暂无可打包条目
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--border-color)' }}>
            {data.entries.map((entry) => {
              const checked = selected.has(entry.name)
              const Icon = entry.type === 'dir' ? Folder : File
              return (
                <label
                  key={entry.name}
                  className="grid grid-cols-[1.25rem_1rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors hover:bg-[var(--bg-card-hover)]"
                  style={{ color: 'var(--text-primary)' }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleEntry(entry.name)}
                    disabled={downloading}
                    className="w-4 h-4 accent-blue-500 cursor-pointer disabled:cursor-not-allowed"
                  />
                  <Icon className="h-4 w-4 text-blue-400" strokeWidth={1.8} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[13px] truncate" title={entry.name}>{entry.name}</span>
                      {entry.name === HIDDEN_FOLDER_NAME && (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-amber-500/25 bg-amber-500/10 text-amber-500">
                          莫比乌斯的工作缓存路径
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] flex flex-wrap items-center gap-x-2 gap-y-1" style={{ color: 'var(--text-muted)' }}>
                      <span>{entryTypeLabel(entry.type)}</span>
                      <span>·</span>
                      <span>{formatBytes(entry.size || 0)}</span>
                      {formatModified(entry.modified) && <span>· {formatModified(entry.modified)}</span>}
                    </div>
                  </div>
                  <div className="text-[11px] font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {formatBytes(entry.size || 0)}
                  </div>
                </label>
              )
            })}
          </div>
        )}
      </div>

      <div className="text-[11px] leading-5 rounded-lg border px-3 py-2" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-color)', background: 'var(--bg-secondary)' }}>
        压缩包会保存在 {data?.package_dir || `${HIDDEN_FOLDER_NAME}/package_zip`}。该目录永远不会被写入新的压缩包，避免把历史压缩包重复套进去。
      </div>
    </div>
  )
}
