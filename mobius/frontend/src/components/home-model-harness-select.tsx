import { useEffect, useMemo, useRef, useState } from 'react'
import { Brain } from 'lucide-react'
import { api } from '../store'
import { fetchGlobalDefaultModel, resolveDefaultModelKey } from '../services/global-default-model'

type HomeModelOption = {
  key: string
  label?: string
  title?: string
  sub?: string
  backend?: string
  is_default?: boolean
}

function harnessLabel(option: HomeModelOption) {
  if (option.backend === 'tmux-codex') return 'Codex'
  if (option.backend === 'tmux-claude-code') return 'Claude Code'
  if (option.backend === 'deepseek-harness') return 'DeepSeek Harness'
  return String(option.sub || option.backend || '').trim()
}

function optionLabel(option: HomeModelOption) {
  const model = String(option.title || option.label || option.key).trim()
  const harness = harnessLabel(option)
  return harness ? `${model} · ${harness}` : model
}

export function HomeModelHarnessSelect({
  projectId,
  lastRememberedModel,
  projectDefaultModel,
  value,
  onChange,
  disabled = false,
}: {
  projectId: string
  lastRememberedModel?: string
  projectDefaultModel?: string | null
  value: string
  onChange: (model: string) => void
  disabled?: boolean
}) {
  const [options, setOptions] = useState<HomeModelOption[]>([])
  const [optionsLoaded, setOptionsLoaded] = useState(false)
  const [optionsError, setOptionsError] = useState('')
  const [globalDefaultModel, setGlobalDefaultModel] = useState('')
  const userTouchedProjectRef = useRef('')

  useEffect(() => {
    let cancelled = false
    api('/api/sessions/model-options')
      .then((result: any) => {
        if (cancelled) return
        setOptions(Array.isArray(result) ? result : [])
        setOptionsError('')
      })
      .catch((reason: any) => {
        if (cancelled) return
        setOptions([])
        setOptionsError(reason?.message || '模型与 Harness 组合加载失败')
      })
      .finally(() => { if (!cancelled) setOptionsLoaded(true) })
    fetchGlobalDefaultModel().then((model) => {
      if (!cancelled) setGlobalDefaultModel(model)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!projectId || options.length === 0) return
    if (userTouchedProjectRef.current === projectId && options.some(option => option.key === value)) return
    const preferred = resolveDefaultModelKey({ scopeLastModel: lastRememberedModel, projectDefaultModel, globalDefaultModel })
    const next = options.find(option => option.key === preferred)
      || options.find(option => option.is_default)
      || options[0]
    if (next?.key && next.key !== value) onChange(next.key)
  }, [globalDefaultModel, lastRememberedModel, onChange, options, projectDefaultModel, projectId, value])

  const selectedLabel = useMemo(
    () => options.find(option => option.key === value),
    [options, value],
  )
  const unavailable = optionsLoaded && options.length === 0

  return (
    <label
      data-home-model-harness-select
      className="workbench-control-md flex min-w-0 items-center gap-2 px-2.5 text-[11px]"
      style={{
        color: optionsError ? 'var(--status-danger)' : 'var(--text-muted)',
        background: 'var(--surface-control)',
        borderColor: optionsError ? 'var(--status-danger)' : 'transparent',
      }}
      title={optionsError || (selectedLabel ? `当前组合：${optionLabel(selectedLabel)}` : '选择模型与 Harness 组合')}
    >
      <Brain className="h-3.5 w-3.5 flex-shrink-0" />
      <select
        value={value}
        onChange={event => {
          userTouchedProjectRef.current = projectId
          onChange(event.target.value)
        }}
        disabled={disabled || !optionsLoaded || options.length === 0}
        aria-label="模型与 Harness 组合"
        className="h-full max-w-[260px] truncate bg-transparent text-[12px] outline-none disabled:cursor-not-allowed"
        style={{ color: optionsError ? 'var(--status-danger)' : 'var(--text-secondary)' }}
      >
        {!value && (
          <option value="" disabled>
            {!optionsLoaded ? '正在加载模型组合…' : optionsError || (unavailable ? '暂无可用模型组合' : '请选择模型组合')}
          </option>
        )}
        {options.map(option => (
          <option key={option.key} value={option.key}>{optionLabel(option)}</option>
        ))}
      </select>
    </label>
  )
}
