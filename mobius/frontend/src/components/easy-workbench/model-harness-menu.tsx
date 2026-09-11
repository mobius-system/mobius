import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  AudioWaveform,
  Braces,
  Check,
  ChevronDown,
  LoaderCircle,
  Radar,
  RefreshCw,
  SquareTerminal,
  Terminal,
  X,
} from 'lucide-react'
import { api, useStore } from '../../store'

// 模型 × Harness 选择面板 — 欢迎页 composer 与「修改模型并继续」共用的极简选择器。
// 层级用 Harness 专属色区分: 图标色块 + 选中模型行着组色, 文案保持克制 (无副标题小字)。

export type ModelOption = {
  key: string
  label?: string
  title?: string
  sub?: string
  backend?: string
  is_default?: boolean
}

// Harness 元信息: 名称 / 图标 / 专属色 (色块低饱和呈现, 与极简模式状态色同一明度语言)。
export const HARNESS_META: Record<string, { id: string; label: string; icon: typeof Terminal; color: string }> = {
  'tmux-claude-code': { id: 'cc', label: 'Claude Code', icon: Terminal, color: '#f59e0b' },
  'tmux-codex': { id: 'codex', label: 'Codex', icon: SquareTerminal, color: '#10b981' },
  'deepseek-harness': { id: 'dsh', label: 'DeepSeek Harness', icon: AudioWaveform, color: '#8b5cf6' },
}

export function harnessMetaFor(backend: string): { id: string; label: string; icon: typeof Terminal; color: string } {
  return HARNESS_META[backend] || { id: backend, label: backend ? String(backend) : '其他', icon: Braces, color: 'var(--text-muted)' }
}

// 拉取模型组合 (欢迎页与继续弹窗共用; reload 供扫描接入后刷新)。
export function useModelHarnessOptions() {
  const [options, setOptions] = useState<ModelOption[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const reload = useCallback(() => {
    api('/api/sessions/model-options')
      .then((result: any) => {
        setOptions(Array.isArray(result) ? result : [])
        setError('')
      })
      .catch((reason: any) => {
        setOptions([])
        setError(reason?.message || '模型与 Harness 组合加载失败')
      })
      .finally(() => setLoaded(true))
  }, [])
  useEffect(() => { reload() }, [reload])
  return { options, loaded, error, reload }
}

// 按 backend 分组; 组顺序 = 模型显示顺序中 backend 首次出现的顺序 (尊重管理员排序)。
export function useHarnessGroups(options: ModelOption[]) {
  return useMemo(() => {
    const order: string[] = []
    const map = new Map<string, ModelOption[]>()
    for (const option of options) {
      const backend = option.backend || ''
      if (!map.has(backend)) { map.set(backend, []); order.push(backend) }
      map.get(backend)!.push(option)
    }
    return order.map(backend => ({ backend, meta: harnessMetaFor(backend), models: map.get(backend) || [] }))
  }, [options])
}

// ── 扫描结果类型 (POST /api/admin/model-access/scan-harnesses) ──
type ScanFoundItem = {
  file: string
  key?: string
  channel?: string
  label_hint?: string
  model_hint?: string
  base_url_hint?: string
  env_key_hint?: string
  has_api_key?: boolean
  imported: boolean
  importable: boolean
  reason?: string
}
type ScanResult = {
  scanned_at: string
  claude_code: { dir: string; items: ScanFoundItem[] }
  codex: { dir: string; items: ScanFoundItem[] }
  deepseek_harness: {
    runtime_available: boolean
    runtime_version: string
    configured: { key: string; label: string; model: string; enabled: boolean }[]
  }
}

export function ModelHarnessMenu({
  options,
  optionsError = '',
  value,
  onPick,
  initialBackend = '',
  showScan = false,
  maxHeightClass = 'max-h-[min(340px,50vh)]',
  onImported,
}: {
  options: ModelOption[]
  optionsError?: string
  value: string
  onPick: (option: ModelOption) => void
  initialBackend?: string
  showScan?: boolean
  maxHeightClass?: string
  onImported?: () => void
}) {
  const role = useStore(state => state.user?.role)
  const canScan = showScan && (role === 'admin' || role === 'developer')
  const groups = useHarnessGroups(options)
  const [activeHarness, setActiveHarness] = useState(initialBackend || groups[0]?.backend || '')
  const [view, setView] = useState<'select' | 'scan'>('select')
  const [scanning, setScanning] = useState(false)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [scanError, setScanError] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [importOutcome, setImportOutcome] = useState<{ ok: number; failed: { file: string; error: string }[] } | null>(null)
  const activeHarnessTouched = useRef(false)

  useEffect(() => {
    if (!activeHarnessTouched.current && groups.length > 0) {
      setActiveHarness(initialBackend || groups[0]?.backend || '')
    }
  }, [groups, initialBackend])

  const runScan = useCallback(async () => {
    setScanning(true)
    setScanError('')
    setImportOutcome(null)
    try {
      const result: any = await api('/api/admin/model-access/scan-harnesses', { method: 'POST', body: JSON.stringify({}) })
      setScan(result)
    } catch (reason: any) {
      setScanError(reason?.message || '扫描失败')
    } finally {
      setScanning(false)
    }
  }, [])

  const toggleChecked = (harness: string, file: string) => {
    const id = `${harness}|${file}`
    setChecked(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const importChecked = async () => {
    if (checked.size === 0 || importing) return
    setImporting(true)
    setImportOutcome(null)
    try {
      const items = Array.from(checked).map(id => {
        const separator = id.indexOf('|')
        return { harness: id.slice(0, separator), file: id.slice(separator + 1) }
      })
      const result: any = await api('/api/admin/model-access/scan-harnesses', { method: 'POST', body: JSON.stringify({ import: items }) })
      const rows: any[] = Array.isArray(result?.results) ? result.results : []
      const failed = rows.filter(row => !row.ok).map(row => ({ file: row.file, error: row.error || '导入失败' }))
      setImportOutcome({ ok: rows.length - failed.length, failed })
      setChecked(new Set())
      onImported?.()
      if (failed.length === 0) {
        window.setTimeout(() => setView('select'), 900)
      }
    } catch (reason: any) {
      setImportOutcome({ ok: 0, failed: [{ file: '', error: reason?.message || '接入失败' }] })
    } finally {
      setImporting(false)
    }
  }

  const newFoundCount = scan
    ? scan.claude_code.items.filter(i => !i.imported && i.importable).length
      + scan.codex.items.filter(i => !i.imported && i.importable).length
    : 0

  if (view === 'scan') {
    return (
      <>
        <div className="flex items-center gap-2 border-b px-2.5 py-2" style={{ borderColor: 'var(--border-default)' }}>
          <button
            type="button"
            onClick={() => setView('select')}
            aria-label="返回模型选择"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] transition-colors hover:bg-[var(--surface-control-hover)]"
            style={{ color: 'var(--text-secondary)' }}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>扫描本机 Harness</span>
          <button
            type="button"
            onClick={() => void runScan()}
            disabled={scanning}
            aria-label="重新扫描"
            title="重新扫描"
            className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] transition-colors hover:bg-[var(--surface-control-hover)] disabled:opacity-50"
            style={{ color: 'var(--text-secondary)' }}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${scanning ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {scanning ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10">
            <div className="mh-scan-radar inline-flex h-11 w-11 items-center justify-center rounded-full border" style={{ borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)', background: 'var(--surface-control)' }}>
              <Radar className="h-5 w-5" />
            </div>
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>正在扫描 ~/.claude 与 ~/.codex …</span>
          </div>
        ) : scanError ? (
          <div className="px-4 py-8 text-center">
            <p className="text-[12px]" style={{ color: 'var(--status-danger)' }}>{scanError}</p>
            <button type="button" onClick={() => void runScan()} className="workbench-control-md btn-primary mt-3 px-3 text-[12px]">重试</button>
          </div>
        ) : !scan ? (
          <div className="px-4 py-8 text-center">
            <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              扫描本机已安装的 Claude Code 配置、Codex 渠道与 DeepSeek Harness 运行时，发现的新模型可一键接入。
            </p>
            <button type="button" onClick={() => void runScan()} className="workbench-control-md btn-primary mt-3 px-3 text-[12px] font-medium">
              <span className="inline-flex items-center gap-1.5"><Radar className="h-3.5 w-3.5" />开始扫描</span>
            </button>
          </div>
        ) : (
          <>
            <div className={`${maxHeightClass} overflow-y-auto p-2`}>
              <ScanSection
                title="Claude Code"
                hint={`配置目录 ${scan.claude_code.dir}`}
                items={scan.claude_code.items}
                harness="claude-code"
                checked={checked}
                onToggle={toggleChecked}
                primaryText={(item) => item.label_hint || item.key || item.file}
                secondaryText={(item) => [item.model_hint, item.base_url_hint && !item.base_url_hint.includes('anthropic.com') ? '自定义网关' : ''].filter(Boolean).join(' · ')}
              />
              <ScanSection
                title="Codex"
                hint={`配置目录 ${scan.codex.dir}`}
                items={scan.codex.items}
                harness="codex"
                checked={checked}
                onToggle={toggleChecked}
                primaryText={(item) => item.label_hint || item.channel || item.file}
                secondaryText={(item) => [item.model_hint, item.env_key_hint, item.has_api_key ? '含密钥' : ''].filter(Boolean).join(' · ')}
              />
              {/* DeepSeek Harness: 无本机凭据文件可扫, 展示运行时与已接入模型状态 */}
              <div className="mt-1 rounded-[10px] border p-2" style={{ borderColor: 'var(--border-default)' }}>
                <div className="flex items-center gap-2 px-1 py-1">
                  <AudioWaveform className="h-3.5 w-3.5 flex-shrink-0" style={{ color: HARNESS_META['deepseek-harness'].color }} />
                  <span className="flex-1 text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>DeepSeek Harness</span>
                  <span className="flex items-center gap-1 text-[10px]" style={{ color: scan.deepseek_harness.runtime_available ? 'var(--status-success)' : 'var(--text-muted)' }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: scan.deepseek_harness.runtime_available ? 'var(--status-success)' : 'var(--text-muted)' }} />
                    {scan.deepseek_harness.runtime_available ? `运行时就绪 · v${scan.deepseek_harness.runtime_version}` : '未安装'}
                  </span>
                </div>
                {scan.deepseek_harness.configured.length > 0 ? (
                  <div className="mt-1 space-y-0.5">
                    {scan.deepseek_harness.configured.map(row => (
                      <div key={row.key} className="flex items-center gap-2 px-2 py-1 text-[11px]">
                        <Check className="h-3 w-3 flex-shrink-0" style={{ color: 'var(--status-success)' }} />
                        <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-secondary)' }}>{row.label || row.key}</span>
                        <span className="flex-shrink-0 text-[9px]" style={{ color: 'var(--text-muted)' }}>{row.model}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="px-2 pb-1 pt-0.5 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    凭据需在「管理中心 → 模型接入」录入 DeepSeek API Key 后接入。
                  </p>
                )}
              </div>
            </div>

            {importOutcome && (
              <div className="border-t px-3 py-1.5 text-[10px]" style={{ borderColor: 'var(--border-default)', color: importOutcome.failed.length ? 'var(--status-danger)' : 'var(--status-success)' }}>
                {importOutcome.ok > 0 && `已接入 ${importOutcome.ok} 个模型`}
                {importOutcome.ok > 0 && importOutcome.failed.length > 0 && ' · '}
                {importOutcome.failed.length > 0 && importOutcome.failed.map(f => `${f.file || ''}: ${f.error}`).join('；')}
              </div>
            )}

            <div className="flex items-center justify-between gap-2 border-t px-3 py-2" style={{ borderColor: 'var(--border-default)' }}>
              <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                {newFoundCount > 0 ? `发现 ${newFoundCount} 个未接入配置` : '没有发现新配置'}
              </span>
              <button
                type="button"
                onClick={() => void importChecked()}
                disabled={checked.size === 0 || importing}
                className="workbench-control-md btn-primary inline-flex items-center gap-1.5 px-3 text-[11px] font-medium disabled:opacity-50"
              >
                {importing ? <LoaderCircle className="h-3 w-3 animate-spin" /> : null}
                {importing ? '接入中…' : `接入所选 (${checked.size})`}
              </button>
            </div>
          </>
        )}
      </>
    )
  }

  return (
    <>
      <div className={`${maxHeightClass} overflow-y-auto p-1.5`}>
        {groups.map(group => {
          const active = activeHarness === group.backend
          const Icon = group.meta.icon
          return (
            <div
              key={group.backend}
              className={`model-harness-group ${active ? 'model-harness-group--active' : ''}`}
              onMouseEnter={() => { activeHarnessTouched.current = true; setActiveHarness(group.backend) }}
            >
              <div className="flex min-h-[34px] items-center gap-2 rounded-[8px] px-2.5 py-1.5 transition-colors" style={{ background: active ? 'var(--surface-control)' : 'transparent' }}>
                {/* Harness 专属色块: 图标嵌低饱和底色, 与模型层拉开层级 */}
                <span className="inline-flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-[5px]" style={{ background: `color-mix(in srgb, ${group.meta.color} 15%, transparent)` }}>
                  <Icon className="h-3 w-3" style={{ color: group.meta.color }} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{group.meta.label}</span>
                <span className="flex-shrink-0 rounded-full px-1.5 py-0.5 text-[9px] tabular-nums" style={{ background: 'var(--surface-control)', color: 'var(--text-muted)' }}>{group.models.length}</span>
                <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200 ${active ? 'rotate-180' : ''}`} style={{ color: 'var(--text-muted)' }} />
              </div>
              <div className="model-harness-group__body">
                <div className="overflow-hidden">
                  <div className="pb-1 pl-6 pr-1 pt-0.5">
                    {group.models.map((option, index) => {
                      const selected = option.key === value
                      return (
                        <button
                          key={option.key}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          onClick={() => onPick(option)}
                          className="model-harness-option flex min-h-[30px] w-full items-center gap-2 rounded-[8px] px-2 py-1 text-left transition-colors hover:bg-[var(--surface-control-hover)]"
                          style={{ animationDelay: `${Math.min(index, 8) * 24}ms` }}
                        >
                          <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: selected ? group.meta.color : 'var(--text-primary)', fontWeight: selected ? 600 : 400 }}>
                            {option.title || option.label || option.key}
                          </span>
                          {selected
                            ? <Check className="h-3.5 w-3.5 flex-shrink-0" style={{ color: group.meta.color }} strokeWidth={2.5} />
                            : option.is_default ? <span className="flex-shrink-0 text-[9px]" style={{ color: 'var(--text-muted)' }}>默认</span> : null}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
        {groups.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>{optionsError || '暂无可用模型组合'}</div>
        )}
      </div>
      {canScan && (
        <button
          type="button"
          onClick={() => { setView('scan'); void runScan() }}
          className="flex w-full items-center gap-2 border-t px-3 py-2 text-[11px] transition-colors hover:bg-[var(--surface-control-hover)]"
          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
        >
          <Radar className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
          <span className="flex-1 text-left">扫描本机 Harness</span>
          <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>CC · Codex · DeepSeek</span>
        </button>
      )}
    </>
  )
}

// 扫描结果分组卡: 一类 Harness 一张卡, 新发现可勾选接入, 已接入打勾置灰。
function ScanSection({
  title,
  hint,
  items,
  harness,
  checked,
  onToggle,
  primaryText,
  secondaryText,
}: {
  title: string
  hint: string
  items: ScanFoundItem[]
  harness: string
  checked: Set<string>
  onToggle: (harness: string, file: string) => void
  primaryText: (item: ScanFoundItem) => string
  secondaryText: (item: ScanFoundItem) => string
}) {
  const newCount = items.filter(item => !item.imported && item.importable).length
  return (
    <div className="mb-1 rounded-[10px] border p-2" style={{ borderColor: 'var(--border-default)' }}>
      <div className="flex items-center gap-2 px-1 py-1">
        <span className="flex-1 text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>{title}</span>
        {newCount > 0
          ? <span className="rounded-full px-1.5 py-0.5 text-[9px]" style={{ background: 'color-mix(in srgb, var(--accent-primary) 14%, transparent)', color: 'var(--accent-primary)' }}>{newCount} 个新发现</span>
          : <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>全部已接入</span>}
      </div>
      <p className="px-2 pb-1 text-[9px]" style={{ color: 'var(--text-muted)' }}>{hint}</p>
      <div className="space-y-0.5">
        {items.map(item => {
          const id = `${harness}|${item.file}`
          const isChecked = checked.has(id)
          const disabled = item.imported || !item.importable
          return (
            <label
              key={item.file}
              className={`flex min-h-[30px] items-center gap-2 rounded-[8px] px-2 py-1 ${disabled ? 'opacity-55' : 'cursor-pointer transition-colors hover:bg-[var(--surface-control-hover)]'}`}
              title={disabled ? (item.imported ? '已接入' : item.reason) : item.file}
            >
              <input
                type="checkbox"
                checked={item.imported ? true : isChecked}
                disabled={disabled}
                onChange={() => onToggle(harness, item.file)}
                className="h-3 w-3 flex-shrink-0 accent-[var(--accent-primary)]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>{primaryText(item)}</span>
                <span className="block truncate text-[9px]" style={{ color: 'var(--text-muted)' }}>
                  {secondaryText(item) || item.file}
                </span>
              </span>
              <span className="flex-shrink-0 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                {item.imported ? '已接入' : item.importable ? '新发现' : '不可接入'}
              </span>
            </label>
          )
        })}
        {items.length === 0 && (
          <p className="px-2 py-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>未发现配置文件</p>
        )}
      </div>
    </div>
  )
}

// 「修改模型并继续」轻量弹窗: 选一次 Harness+模型 → 从当前会话新建 Session 继续。
// 与专家模式 NewSessionModal 同一后端链路 (continue_from_session_id), 但只暴露模型选择。
export function EasyContinueModelModal({
  issueId,
  researchId,
  fromSessionId,
  sessionName,
  sessionDescription = '',
  currentModel = '',
  onClose,
  onCreated,
}: {
  issueId?: string
  researchId?: string
  fromSessionId: string
  sessionName: string
  sessionDescription?: string
  currentModel?: string
  onClose: () => void
  onCreated: (created: any) => void
}) {
  const { options, loaded, error, reload } = useModelHarnessOptions()
  const groups = useHarnessGroups(options)
  const initialBackend = useMemo(
    () => options.find(option => option.key === currentModel)?.backend || groups[0]?.backend || '',
    [options, currentModel, groups],
  )
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const pickAndContinue = async (option: ModelOption) => {
    if (submitting) return
    if (option.key === currentModel) {
      // 选了当前同一组合: 直接提示无需更换, 不创建重复会话。
      setSubmitError('当前会话已在用该模型 · Harness 组合，请选择其它组合')
      return
    }
    setSubmitting(true)
    setSubmitError('')
    try {
      const endpoint = researchId
        ? `/api/researches/${researchId}/sessions`
        : `/api/issues/${issueId}/sessions`
      if (!researchId && !issueId) throw new Error('缺少会话上下文')
      const created: any = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          name: sessionName,
          description: sessionDescription,
          model: option.key,
          language: 'zh',
          continue_from_session_id: fromSessionId,
        }),
      })
      if (created?.error) { setSubmitError(created.error); return }
      onCreated(created)
    } catch (reason: any) {
      setSubmitError(reason?.message || '创建会话失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4" style={{ background: 'var(--surface-scrim)' }} role="dialog" aria-modal="true" aria-label="修改模型并继续">
      <button type="button" className="absolute inset-0" aria-label="关闭" onClick={onClose} />
      <div className="relative w-full max-w-[380px] overflow-hidden border" style={{ borderRadius: 'var(--radius-panel, 14px)', background: 'var(--surface-overlay)', borderColor: 'var(--border-strong)', boxShadow: 'var(--shadow-overlay)' }}>
        <div className="flex items-center gap-2 border-b px-3 py-2.5" style={{ borderColor: 'var(--border-default)' }}>
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>修改模型并继续</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] transition-colors hover:bg-[var(--surface-control-hover)]"
            style={{ color: 'var(--text-muted)' }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <p className="px-3 pb-1 pt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          选择新的 Harness 与模型，将从「{sessionName}」继续（新建 Session）
        </p>
        {!loaded ? (
          <div className="flex items-center justify-center gap-2 px-4 py-10 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            <LoaderCircle className="h-4 w-4 animate-spin" /> 正在加载模型组合…
          </div>
        ) : (
          <ModelHarnessMenu
            options={options}
            optionsError={error}
            value={currentModel}
            onPick={option => void pickAndContinue(option)}
            initialBackend={initialBackend}
            showScan
            maxHeightClass="max-h-[min(360px,55vh)]"
            onImported={reload}
          />
        )}
        {submitting && (
          <div className="flex items-center gap-2 border-t px-3 py-1.5 text-[10px]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}>
            <LoaderCircle className="h-3 w-3 animate-spin" /> 正在创建续接会话…
          </div>
        )}
        {submitError && !submitting && (
          <div className="border-t px-3 py-1.5 text-[10px]" style={{ borderColor: 'var(--border-default)', color: 'var(--status-danger)' }}>{submitError}</div>
        )}
      </div>
    </div>
  )
}
