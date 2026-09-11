import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { fetchGlobalDefaultModel, resolveDefaultModelKey } from '../../services/global-default-model'
import { ModelHarnessMenu, harnessMetaFor, useModelHarnessOptions } from './model-harness-menu'

const LAST_SELECTION_STORAGE_PREFIX = 'mobius:home-model-harness:last:'

function readLastSelection(userId: string): string {
  if (!userId || typeof localStorage === 'undefined') return ''
  try {
    const raw = localStorage.getItem(LAST_SELECTION_STORAGE_PREFIX + userId)
    return typeof raw === 'string' && raw.trim() ? raw.trim() : ''
  } catch {
    return ''
  }
}

function writeLastSelection(userId: string, modelKey: string) {
  if (!userId || !modelKey || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(LAST_SELECTION_STORAGE_PREFIX + userId, modelKey)
  } catch {
    // localStorage 不可用时仅保留当前页面内的选择。
  }
}

// 欢迎页 composer 的模型入口: 触发按钮 + 默认值三级解析 (上次所选 > 项目默认 > 全局默认)。
// 面板本体 (Harness 分组 · hover 手风琴 · 扫描) 复用 ModelHarnessMenu。
export function HomeModelHarnessSelect({
  projectId,
  userId,
  lastRememberedModel,
  projectDefaultModel,
  value,
  onChange,
  disabled = false,
}: {
  projectId: string
  userId?: string
  lastRememberedModel?: string
  projectDefaultModel?: string | null
  value: string
  onChange: (model: string) => void
  disabled?: boolean
}) {
  const { options, loaded, error, reload } = useModelHarnessOptions()
  const [globalDefaultModel, setGlobalDefaultModel] = useState('')
  const userTouchedProjectRef = useRef('')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchGlobalDefaultModel().then((model) => {
      if (!cancelled) setGlobalDefaultModel(model)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!projectId || options.length === 0) return
    if (userTouchedProjectRef.current === projectId && options.some(option => option.key === value)) return
    const userRememberedModel = readLastSelection(userId || '')
    const preferred = resolveDefaultModelKey({ scopeLastModel: userRememberedModel || lastRememberedModel, projectDefaultModel, globalDefaultModel })
    const fallbackPreferred = resolveDefaultModelKey({ projectDefaultModel, globalDefaultModel })
    const next = options.find(option => option.key === preferred)
      || options.find(option => option.key === fallbackPreferred)
      || options.find(option => option.is_default)
      || options[0]
    if (next?.key && next.key !== value) onChange(next.key)
  }, [globalDefaultModel, lastRememberedModel, onChange, options, projectDefaultModel, projectId, userId, value])

  const selectedOption = useMemo(
    () => options.find(option => option.key === value),
    [options, value],
  )
  const initialBackend = selectedOption?.backend || ''

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const pickModel = (option: { key: string }) => {
    userTouchedProjectRef.current = projectId
    writeLastSelection(userId || '', option.key)
    onChange(option.key)
    setOpen(false)
  }

  const selectedLabel = selectedOption
    ? `${selectedOption.title || selectedOption.label || selectedOption.key} · ${harnessMetaFor(selectedOption.backend || '').label}`
    : ''

  return (
    <div ref={containerRef} data-home-model-harness-select className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen(state => !state)}
        disabled={disabled || !loaded || options.length === 0}
        aria-haspopup="menu"
        aria-expanded={open}
        title={error || (selectedLabel ? `当前组合：${selectedLabel}` : '选择模型与 Harness 组合')}
        className="workbench-control-md flex min-w-0 max-w-[280px] items-center gap-2 px-2.5 text-[12px] transition-colors hover:bg-[var(--surface-control-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        style={{
          color: error ? 'var(--status-danger)' : 'var(--text-secondary)',
          background: 'var(--surface-control)',
          borderColor: error ? 'var(--status-danger)' : 'transparent',
        }}
      >
        {/* 图标用当前选中模型所属 Harness 的专属色, 与面板层级呼应 */}
        <Brain className="h-3.5 w-3.5 flex-shrink-0" style={selectedOption ? { color: harnessMetaFor(selectedOption.backend || '').color } : undefined} />
        <span className="min-w-0 flex-1 truncate text-left">
          {!loaded ? '正在加载模型组合…' : selectedLabel || (error || '选择模型组合')}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="选择模型与 Harness"
          className="model-harness-popover absolute left-0 top-[calc(100%+8px)] z-40 w-[348px] max-w-[calc(100vw-48px)] overflow-hidden rounded-[12px] border"
          style={{ background: 'var(--surface-overlay)', borderColor: 'var(--border-strong)', boxShadow: 'var(--shadow-overlay)' }}
        >
          <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
            <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Harness · 模型</span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>悬停切换 · 单击选定</span>
          </div>
          <ModelHarnessMenu
            options={options}
            optionsError={error}
            value={value}
            onPick={pickModel}
            initialBackend={initialBackend}
            showScan
            onImported={reload}
          />
        </div>
      )}
    </div>
  )
}
