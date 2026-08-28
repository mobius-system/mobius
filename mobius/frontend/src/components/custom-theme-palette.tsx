import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Check, Palette as PaletteIcon, Plus, Trash2, RotateCcw, Pencil, X, AlertTriangle } from 'lucide-react'
import { useStore } from '../store'
import { THEME_OPTIONS, type ThemeName } from '../theme'
import {
  PALETTE_VARIABLES,
  type CustomTheme,
  applyCustomThemeToRoot,
  customThemeSwatches,
  generateCustomThemeId,
  getBaseOption,
  loadActiveCustomThemeId,
  loadCustomThemes,
  saveActiveCustomThemeId,
  saveCustomThemes,
} from '../services/custom-themes'

type EditState = {
  id: string | null
  name: string
  base: ThemeName
  overrides: Record<string, string>
}

function makeEmptyEdit(base: ThemeName): EditState {
  return { id: null, name: '', base, overrides: {} }
}

function editFromCustom(c: CustomTheme): EditState {
  return { id: c.id, name: c.name, base: c.base, overrides: { ...c.overrides } }
}

function normalizeHex(input: string): string | null {
  if (!input) return null
  const v = input.trim()
  // 已经是 #rgb / #rrggbb / #rgba / #rrggbbaa
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return v.toLowerCase()
  return null
}

// 颜色输入框使用的合成色 picker (原生 <input type="color"> 不支持 alpha).
// 我们用原生的 hex 颜色但允许用户输入 alpha=00..ff 后缀.
function colorInputValue(input: string): string {
  const v = normalizeHex(input)
  // 原生 <input type=color> 只接受 #rrggbb, 没有 alpha. 把 #rrggbbaa 截成前 7 位
  if (v && v.length === 9) return v.slice(0, 7)
  return v || '#000000'
}

type Props = {
  onClose: () => void
  // 关闭时是否需要保留当前已应用的覆写 — 默认保留 (调色盘内部已经实时预览).
  onApplied?: (active: CustomTheme | null) => void
}

export function CustomThemePalette({ onClose, onApplied }: Props) {
  const { theme } = useStore()
  const isDark = theme !== 'light'
  const [themesMap, setThemesMap] = useState<Record<string, CustomTheme>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [mode, setMode] = useState<'list' | 'edit'>('list')
  const [edit, setEdit] = useState<EditState>(() => makeEmptyEdit(theme))
  const [err, setErr] = useState('')
  // 暂存的"未保存预览" 覆写 — 关闭面板时如果没保存就清掉
  const previewAppliedRef = useRef(false)

  // 首次挂载: 从 localStorage 加载所有自定义主题 + 激活 id
  useEffect(() => {
    const map = loadCustomThemes()
    const active = loadActiveCustomThemeId()
    setThemesMap(map)
    setActiveId(active && map[active] ? active : null)
  }, [])

  const themes = useMemo(
    () => Object.values(themesMap).sort((a, b) => b.updatedAt - a.updatedAt),
    [themesMap],
  )
  const activeTheme = activeId ? themesMap[activeId] : null

  // 把"激活主题"或"编辑中的实时预览"反映到 :root.style.
  // 优先级: 处于 edit 模式时, 预览编辑状态; 否则预览激活的 saved theme.
  useEffect(() => {
    if (mode === 'edit') {
      const live: CustomTheme = {
        id: edit.id || 'preview',
        name: edit.name || '预览',
        base: edit.base,
        overrides: edit.overrides,
        createdAt: 0,
        updatedAt: 0,
      }
      applyCustomThemeToRoot(live)
      previewAppliedRef.current = true
    } else if (activeTheme) {
      applyCustomThemeToRoot(activeTheme)
      previewAppliedRef.current = true
    } else {
      applyCustomThemeToRoot(null)
      previewAppliedRef.current = false
    }
  }, [mode, edit, activeTheme])

  // 卸载时: 如果当前处于"未保存的预览"状态, 把 DOM 覆写清回激活主题 / 基础
  useEffect(() => {
    return () => {
      if (!previewAppliedRef.current) return
      const active = loadActiveCustomThemeId()
      const map = loadCustomThemes()
      const t = active && map[active] ? map[active] : null
      applyCustomThemeToRoot(t)
      previewAppliedRef.current = false
    }
  }, [])

  const persist = useCallback((next: Record<string, CustomTheme>, nextActive: string | null) => {
    saveCustomThemes(next)
    saveActiveCustomThemeId(nextActive)
    setThemesMap(next)
    setActiveId(nextActive)
    onApplied?.(nextActive ? next[nextActive] : null)
  }, [onApplied])

  const handleNew = () => {
    setEdit(makeEmptyEdit(theme))
    setErr('')
    setMode('edit')
  }

  const handleEdit = (t: CustomTheme) => {
    setEdit(editFromCustom(t))
    setErr('')
    setMode('edit')
  }

  const handleDelete = (t: CustomTheme) => {
    if (!window.confirm(`确定删除自定义主题「${t.name}」?`)) return
    const next = { ...themesMap }
    delete next[t.id]
    const nextActive = activeId === t.id ? null : activeId
    persist(next, nextActive)
  }

  const handleApply = (t: CustomTheme) => {
    // 切到 base + 切到自定义覆写
    useStore.setState({ theme: t.base })
    persist({ ...themesMap }, t.id)
    setMode('list')
  }

  const handleResetToBase = () => {
    persist({ ...themesMap }, null)
  }

  const handleSave = () => {
    const name = edit.name.trim()
    if (!name) { setErr('请填写主题名称'); return }
    const overrides: Record<string, string> = {}
    for (const v of PALETTE_VARIABLES) {
      const value = normalizeHex(edit.overrides[v.key] || '')
      if (value) overrides[v.key] = value
    }
    const now = Date.now()
    const id = edit.id || generateCustomThemeId()
    const existing = edit.id ? themesMap[edit.id] : undefined
    const next: CustomTheme = {
      id,
      name,
      base: edit.base,
      overrides,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    const nextMap = { ...themesMap, [id]: next }
    useStore.setState({ theme: edit.base })
    persist(nextMap, id)
    setMode('list')
  }

  const handleCancelEdit = () => {
    setMode('list')
    setErr('')
  }

  const handleSetBase = (b: ThemeName) => {
    setEdit(prev => ({ ...prev, base: b, overrides: {} }))
  }

  const handleOverride = (key: string, value: string) => {
    setEdit(prev => ({ ...prev, overrides: { ...prev.overrides, [key]: value } }))
  }

  const handleClearOverride = (key: string) => {
    setEdit(prev => {
      const next = { ...prev.overrides }
      delete next[key]
      return { ...prev, overrides: next }
    })
  }

  // === 渲染 ===

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative w-[640px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-64px)] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-2">
            <PaletteIcon className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
            <h3 className="text-[14px] font-semibold" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>
              {mode === 'list' ? '自定义主题' : (edit.id ? '编辑主题' : '新建主题')}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-muted)' }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {mode === 'list' ? (
            <ListView
              themes={themes}
              activeId={activeId}
              onApply={handleApply}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onReset={handleResetToBase}
              isDark={isDark}
            />
          ) : (
            <EditView
              edit={edit}
              isDark={isDark}
              err={err}
              onSetBase={handleSetBase}
              onSetName={(v) => setEdit(prev => ({ ...prev, name: v }))}
              onOverride={handleOverride}
              onClearOverride={handleClearOverride}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border-color)' }}>
          {mode === 'list' ? (
            <>
              <div className="flex-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {activeTheme
                  ? <>当前: <span style={{ color: 'var(--text-primary)' }}>{activeTheme.name}</span> · 基于「{getBaseOption(activeTheme.base).label}」</>
                  : '当前未启用自定义主题, 跟随下方基础主题。'}
              </div>
              <button
                type="button"
                onClick={handleNew}
                className="h-8 px-3 rounded-lg text-[12px] font-medium flex items-center gap-1.5 transition-colors"
                style={{ background: 'var(--accent-primary)', color: '#0b1220' }}
              >
                <Plus className="w-3.5 h-3.5" />
                新建主题
              </button>
            </>
          ) : (
            <>
              {err && (
                <div className="flex-1 flex items-center gap-1.5 text-[11px] text-red-300">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {err}
                </div>
              )}
              {!err && <div className="flex-1" />}
              <button
                type="button"
                onClick={handleCancelEdit}
                className="h-8 px-3 rounded-lg text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--text-secondary)', border: '1px solid var(--input-border)' }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="h-8 px-3 rounded-lg text-[12px] font-medium transition-colors"
                style={{ background: 'var(--accent-primary)', color: '#0b1220' }}
              >
                保存
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// =====================================================================
// 列表视图
// =====================================================================
function ListView({
  themes,
  activeId,
  onApply,
  onEdit,
  onDelete,
  onReset,
  isDark,
}: {
  themes: CustomTheme[]
  activeId: string | null
  onApply: (t: CustomTheme) => void
  onEdit: (t: CustomTheme) => void
  onDelete: (t: CustomTheme) => void
  onReset: () => void
  isDark: boolean
}) {
  return (
    <div className="p-5 space-y-4">
      {activeId && (
        <button
          type="button"
          onClick={onReset}
          className="w-full rounded-xl px-3 py-2 text-[12px] flex items-center gap-2 transition-colors border"
          style={{ background: 'var(--input-bg)', borderColor: 'var(--input-border)', color: isDark ? '#94a3b8' : '#475569' }}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          停用当前自定义主题, 回到基础主题
        </button>
      )}

      {themes.length === 0 ? (
        <div className="py-10 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
          还没有保存的自定义主题。点击下方"新建主题"开始调色。
        </div>
      ) : (
        <ul className="space-y-1.5">
          {themes.map(t => {
            const [bg, accent] = customThemeSwatches(t)
            const selected = t.id === activeId
            return (
              <li
                key={t.id}
                className="rounded-xl p-2.5 flex items-center gap-2.5 transition-colors"
                style={{
                  background: selected ? 'var(--bg-active)' : 'var(--input-bg)',
                  border: '1px solid',
                  borderColor: selected ? 'var(--accent-primary)' : 'var(--input-border)',
                }}
              >
                <span className="flex h-7 w-12 shrink-0 overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-color-strong)' }}>
                  <span className="flex-1" style={{ background: bg }} />
                  <span className="flex-1" style={{ background: accent }} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold truncate" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>{t.name}</div>
                  <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                    基于「{getBaseOption(t.base).label}」 · {Object.keys(t.overrides).length} 个覆写
                  </div>
                </div>
                {selected ? (
                  <span className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium"
                    style={{ background: 'var(--accent-primary)', color: '#0b1220' }}>
                    <Check className="w-3 h-3" />使用中
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onApply(t)}
                    className="h-7 px-2.5 rounded-md text-[12px] font-medium transition-colors"
                    style={{ background: 'var(--accent-primary)', color: '#0b1220' }}
                  >
                    使用
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onEdit(t)}
                  aria-label="编辑"
                  title="编辑"
                  className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(t)}
                  aria-label="删除"
                  title="删除"
                  className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-red-500/15"
                  style={{ color: '#f87171' }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// =====================================================================
// 编辑视图
// =====================================================================
function EditView({
  edit,
  isDark,
  err,
  onSetBase,
  onSetName,
  onOverride,
  onClearOverride,
}: {
  edit: EditState
  isDark: boolean
  err: string
  onSetBase: (b: ThemeName) => void
  onSetName: (v: string) => void
  onOverride: (key: string, value: string) => void
  onClearOverride: (key: string) => void
}) {
  // 实时预览的当前值: 已覆写就用覆写值, 否则用 base 当前在 DOM 的值
  const readVar = (key: string): string => {
    if (edit.overrides[key]) return edit.overrides[key]
    if (typeof document !== 'undefined') {
      const v = getComputedStyle(document.documentElement).getPropertyValue(key).trim()
      if (v) return v
    }
    return ''
  }

  return (
    <div className="p-5 space-y-4">
      {/* 名称 */}
      <div>
        <label className="block text-[11px] font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>主题名称</label>
        <input
          type="text"
          value={edit.name}
          onChange={e => onSetName(e.target.value)}
          placeholder="例如: 我的深紫"
          maxLength={24}
          className="w-full h-9 px-3 rounded-lg text-[13px] focus:outline-none focus:border-[var(--accent-primary)]"
          style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)', color: isDark ? '#f1f5f9' : '#1e293b' }}
        />
      </div>

      {/* 基础主题选择 */}
      <div>
        <label className="block text-[11px] font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>基于基础主题</label>
        <div className="grid grid-cols-7 gap-1.5">
          {THEME_OPTIONS.map(opt => {
            const selected = opt.name === edit.base
            return (
              <button
                key={opt.name}
                type="button"
                onClick={() => onSetBase(opt.name)}
                className="rounded-lg p-1.5 flex flex-col items-center gap-1 transition-colors"
                style={{
                  background: selected ? 'var(--bg-active)' : 'var(--input-bg)',
                  border: '1px solid',
                  borderColor: selected ? 'var(--accent-primary)' : 'var(--input-border)',
                }}
              >
                <span className="flex h-4 w-7 overflow-hidden rounded border" style={{ borderColor: 'var(--border-color-strong)' }}>
                  {opt.swatches.map((c, i) => <span key={i} className="flex-1" style={{ background: c }} />)}
                </span>
                <span className="text-[10px] truncate w-full text-center" style={{ color: selected ? 'var(--text-primary)' : 'var(--text-muted)' }}>{opt.label}</span>
              </button>
            )
          })}
        </div>
        <div className="mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          切换基础主题会清空当前覆写, 因为不同 base 的"非颜色"装饰 (渐变、阴影) 差异较大, 一起混用效果通常不理想。
        </div>
      </div>

      {/* 颜色覆写 */}
      <div>
        <label className="block text-[11px] font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>颜色覆写</label>
        <div className="space-y-1.5">
          {PALETTE_VARIABLES.map(v => {
            const current = readVar(v.key)
            const overridden = !!edit.overrides[v.key]
            const pickerValue = colorInputValue(current)
            return (
              <div
                key={v.key}
                className="rounded-lg px-2.5 py-2 flex items-center gap-2.5"
                style={{ background: 'var(--input-bg)', border: '1px solid var(--input-border)' }}
              >
                <input
                  type="color"
                  value={pickerValue}
                  onChange={e => onOverride(v.key, e.target.value)}
                  className="h-7 w-9 rounded cursor-pointer border-0 p-0 bg-transparent"
                  style={{ background: 'transparent' }}
                  aria-label={v.label}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium truncate" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>
                    {v.label}
                    {overridden && <span className="ml-1.5 text-[10px] font-normal" style={{ color: 'var(--accent-primary)' }}>已覆写</span>}
                  </div>
                  <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{v.description}</div>
                </div>
                <input
                  type="text"
                  value={current}
                  onChange={e => onOverride(v.key, e.target.value)}
                  className="w-[110px] h-7 px-2 rounded-md text-[11px] font-mono focus:outline-none focus:border-[var(--accent-primary)]"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--input-border)', color: isDark ? '#cbd5e1' : '#334155' }}
                  placeholder="#rrggbb"
                />
                {overridden && (
                  <button
                    type="button"
                    onClick={() => onClearOverride(v.key)}
                    title="还原为 base 主题值"
                    className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {/* 还原全部 */}
        {Object.keys(edit.overrides).length > 0 && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => {
                for (const v of PALETTE_VARIABLES) onClearOverride(v.key)
              }}
              className="h-7 px-2.5 rounded-md text-[11px] flex items-center gap-1.5 transition-colors hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--text-secondary)', border: '1px solid var(--input-border)' }}
            >
              <RotateCcw className="w-3 h-3" />
              清空所有覆写
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
