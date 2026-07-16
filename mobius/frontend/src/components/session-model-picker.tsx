// =====================================================================
// 共享 Session 模型选择器 (grid 卡片) — 复刻 NewSessionModal 的模型选择逻辑.
//
// 对齐传统 NewSessionModal (modals.tsx) 的三件事, 修复顶栏快捷旧 ModelSelect 的缺陷:
//   1. 默认值由父组件控制 (进 useState 初始值, 不靠 effect 异步回落 → 无草稿锁死/时序竞态).
//   2. 拉 /api/sessions/prompt-stats 显示每个模型的 "个人 5h N/M 次" 管理员配额.
//   3. 超额模型 disabled (usage.blocked), 标红 "已达限额 · 暂不可选".
// 传统与顶栏快捷共用此组件, 行为统一.
// =====================================================================
import { useEffect, useMemo, useState } from 'react'
import { api } from '../store'
import { AlertTriangle, ChevronDown } from 'lucide-react'

type SessionModelOption = {
  key: string
  value?: string
  model?: string
  label: string
  title: string
  sub: string
  backend: string
  imported?: boolean
  use_proxy?: 0 | 1 | boolean | null
}

// 模型 → 后端渠道 (对照 /api/sessions/prompt-stats 的渠道桶)
type PromptBackendKey = 'codex' | 'claude_code'
function promptBackendKeyForOption(opt?: SessionModelOption | null): PromptBackendKey {
  return opt?.backend === 'tmux-codex' ? 'codex' : 'claude_code'
}
const PROMPT_BACKEND_LABEL: Record<PromptBackendKey, string> = {
  codex: 'Codex',
  claude_code: 'Claude Code',
}

type LimitUsageState = {
  count: number
  limit: number | null
  remaining: number | null
  blocked: boolean
}
type ModelUsageLimit = {
  key: string
  count: number
  limit: number | null
  remaining: number | null
  blocked: boolean
  window_hours: number
  usage?: {
    tmuxWindows?: LimitUsageState & { warning?: boolean }
  }
}
type ModelUsageLimits = {
  models: Record<string, ModelUsageLimit>
}
type PromptStats = {
  codex: number
  claude_code: number
  codex_5min?: number
  claude_code_5min?: number
  codex_2min: number
  claude_code_2min: number
  active_windows_by_backend?: Partial<Record<PromptBackendKey, number>>
  model_usage_limits?: ModelUsageLimits
}

// API 完全失败时的最小兜底 (仅保证能选到内置模型, 无配额信息)
const FALLBACK_OPTIONS: SessionModelOption[] = [
  { key: 'codex', label: 'GPT-5.5', title: 'GPT-5.5', sub: 'Codex · 强力', backend: 'tmux-codex' },
  { key: 'opus', label: 'Opus', title: 'Opus', sub: 'Claude Code · 强力', backend: 'tmux-claude-code' },
]
const MODEL_PICKER_COLLAPSED_ROWS = 3

function useResponsiveModelColumns() {
  const [columns, setColumns] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches ? 3 : 2
  ))
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(min-width: 640px)')
    const update = () => setColumns(mq.matches ? 3 : 2)
    update()
    mq.addEventListener?.('change', update)
    return () => mq.removeEventListener?.('change', update)
  }, [])
  return columns
}

export function SessionModelPicker({ value, onChange, dark, quotaEnabled = true }: {
  value: string
  onChange: (key: string) => void
  dark: boolean
  /** preset 模式不禁用超额模型 (对齐传统 isPresetMode 行为); 默认启用配额拦截 */
  quotaEnabled?: boolean
}) {
  const [options, setOptions] = useState<SessionModelOption[]>(FALLBACK_OPTIONS)
  const [stats, setStats] = useState<PromptStats | null>(null)
  const [manuallyExpanded, setManuallyExpanded] = useState(false)
  const responsiveColumns = useResponsiveModelColumns()

  useEffect(() => {
    let alive = true
    api('/api/sessions/model-options').then((arr: any) => {
      if (!alive || !Array.isArray(arr) || arr.length === 0) return
      setOptions(arr as SessionModelOption[])
    }).catch(() => { /* 保留 FALLBACK_OPTIONS */ })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    let alive = true
    api('/api/sessions/prompt-stats').then((s: any) => { if (alive) setStats(s as PromptStats) })
      .catch(() => { /* 失败就不显示配额徽标, 不影响创建流程 */ })
    return () => { alive = false }
  }, [])

  const selected = options.find(o => o.key === value) || null
  const collapsedVisibleCount = responsiveColumns * MODEL_PICKER_COLLAPSED_ROWS
  const selectedIndex = useMemo(() => options.findIndex(o => o.key === value), [options, value])
  const hasCollapsedOverflow = options.length > collapsedVisibleCount
  const expandedForSelection = selectedIndex >= collapsedVisibleCount
  const modelGridExpanded = manuallyExpanded || expandedForSelection || !hasCollapsedOverflow
  const hiddenModelCount = Math.max(0, options.length - collapsedVisibleCount)
  const selectedBackendKey = promptBackendKeyForOption(selected)
  const selectedUsage = stats?.model_usage_limits?.models?.[value] || null
  const selectedTmux = selectedUsage?.usage?.tmuxWindows || null
  const selectedTmuxWarning = !!selectedTmux?.warning
  const selectedActiveWindowCount = Number(stats?.active_windows_by_backend?.[selectedBackendKey] || 0)
  const selectedBackendLabel = PROMPT_BACKEND_LABEL[selectedBackendKey]

  return (
    <div>
      <div className="text-[12px] mb-1.5" style={{ color: dark ? '#9ca3af' : '#64748b' }}>模型（创建后不可更改）</div>
      <div
        className={`grid grid-cols-2 gap-2 overflow-hidden transition-[max-height] duration-200 sm:grid-cols-3 ${modelGridExpanded ? 'max-h-none' : 'max-h-[13.5rem]'}`}
      >
        {options.map(opt => {
          const active = value === opt.key
          const backendKey = promptBackendKeyForOption(opt)
          const count5h = stats ? (stats as any)[backendKey] : null
          const count5min = stats ? ((stats as any)[`${backendKey}_5min`] ?? (stats as any)[`${backendKey}_2min`] ?? 0) : null
          const usage = stats?.model_usage_limits?.models?.[opt.key] || null
          const quotaBlocked = quotaEnabled && !!usage?.blocked
          const tmuxUsage = usage?.usage?.tmuxWindows
          const tmuxWarning = !!tmuxUsage?.warning
          const quotaTitle = usage?.limit != null
            ? `单用户 5 小时 ${usage.count}/${usage.limit} 次${usage.blocked ? ', 已达管理员限额' : `, 剩余 ${usage.remaining} 次`}`
            : '提问硬限制按管理员配置检查，未配置项不限'
          const tmuxTitle = tmuxUsage?.limit != null
            ? `tmux 窗口 ${tmuxUsage.count}/${tmuxUsage.limit}${tmuxWarning ? ', 已达软提醒阈值' : ''}`
            : 'tmux 窗口未配置限制'
          const badgeTitle = quotaBlocked
            ? `${opt.title} ${quotaTitle}, 暂不可选`
            : `${opt.title} 渠道最近 5 小时 ${count5h} 次提问 / 5 分钟 ${count5min} 次; ${quotaTitle}; ${tmuxTitle}`
          return (
            <button key={opt.key} type="button" disabled={quotaBlocked} title={badgeTitle} onClick={() => onChange(opt.key)}
              className="relative min-h-16 rounded-xl text-left px-3 py-2 transition-colors disabled:cursor-not-allowed"
              style={{
                background: active ? 'rgba(59,130,246,0.12)' : quotaBlocked ? 'rgba(239,68,68,0.08)' : 'var(--input-bg)',
                border: `1px solid ${active ? '#3b82f6' : quotaBlocked ? 'rgba(239,68,68,0.32)' : 'var(--input-border)'}`,
                color: dark ? '#f1f5f9' : '#1e293b',
                opacity: quotaBlocked ? 0.58 : 1,
              }}>
              <div className="text-[13px] font-medium truncate">{opt.title || opt.label}</div>
              <div className="text-[11px] flex items-baseline gap-1.5 min-w-0" style={{ color: dark ? '#9ca3af' : '#64748b' }}>
                <span className="truncate">{opt.sub}</span>
                {!quotaBlocked && usage?.limit != null && (
                  <span className="font-medium whitespace-nowrap" style={{ color: dark ? '#93c5fd' : '#2563eb' }}>
                    个人5h {usage.count}/{usage.limit} 次
                  </span>
                )}
                {!quotaBlocked && tmuxWarning && (
                  <span className="font-medium whitespace-nowrap" style={{ color: '#f59e0b' }}>
                    tmux {tmuxUsage?.count}/{tmuxUsage?.limit}
                  </span>
                )}
                {quotaBlocked && (
                  <span className="font-medium whitespace-nowrap" style={{ color: '#ef4444' }}>
                    已达限额 · 暂不可选
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>
      {hasCollapsedOverflow && !expandedForSelection && (
        <button type="button" onClick={() => setManuallyExpanded(v => !v)}
          className="mt-2 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
          style={{
            borderColor: 'var(--input-border)',
            color: dark ? '#9ca3af' : '#64748b',
            background: 'var(--input-bg)',
          }}>
          <span>{manuallyExpanded ? '收起模型' : `展开剩余 ${hiddenModelCount} 个模型`}</span>
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${manuallyExpanded ? 'rotate-180' : ''}`} />
        </button>
      )}
      {selectedUsage?.limit != null && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px]"
          style={{
            background: selectedUsage.blocked ? 'rgba(239,68,68,0.08)' : 'rgba(59,130,246,0.08)',
            borderColor: selectedUsage.blocked ? 'rgba(239,68,68,0.32)' : 'rgba(59,130,246,0.25)',
            color: selectedUsage.blocked ? '#ef4444' : (dark ? '#93c5fd' : '#1d4ed8'),
          }}>
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>
            管理员模型限额: 最近 {selectedUsage.window_hours} 小时单用户提问 {selectedUsage.count}/{selectedUsage.limit} 次
            {selectedUsage.blocked ? '，已达限制，请切换模型或稍后再创建。' : `，剩余 ${selectedUsage.remaining} 次。`}
          </span>
        </div>
      )}
      {stats && (
        <div className="mt-2 text-[12px] font-medium" style={{ color: selectedTmuxWarning ? '#f59e0b' : '#16a34a' }}>
          {selectedTmux?.limit != null
            ? selectedTmuxWarning
              ? `${selected?.label || selectedBackendLabel} tmux 窗口达到软提醒阈值（当前 ${selectedTmux.count} / ${selectedTmux.limit}），仍可创建。`
              : `${selected?.label || selectedBackendLabel} tmux 窗口正常（当前 ${selectedTmux.count} / ${selectedTmux.limit}）`
            : `${selectedBackendLabel} 活跃后台窗口 ${selectedActiveWindowCount}`}
        </div>
      )}
    </div>
  )
}
