// font-settings-modal.tsx — 外观菜单「字体设置」弹窗: 七档字体大小的实时调节器.
//
// 档位 px 的唯一定义在 src/font-tiers.css; 本弹窗只是把调节结果以 :root 内联
// 覆写 + localStorage 持久化的方式叠加在默认值之上 (见 services/font-tiers.ts).
import { useEffect, useState } from 'react'
import { Type as TypeIcon, RotateCcw, X } from 'lucide-react'
import { useStore } from '../store'
import {
  FONT_TIERS,
  FONT_TIER_MIN_PX,
  FONT_TIER_MAX_PX,
  type FontTierValues,
  effectiveFontTierValues,
  applyFontTierValues,
  saveFontTierOverrides,
  resetFontTierOverrides,
  clampFontTierPx,
} from '../services/font-tiers'

export function FontSettingsModal({ onClose }: { onClose: () => void }) {
  const { theme } = useStore()
  const isDark = theme !== 'light'
  // 打开时以"当前生效值"起步 (含已保存覆写), 拖动即实时预览
  const [values, setValues] = useState<FontTierValues>(() => effectiveFontTierValues())

  // 每次数值变化立即刷到 :root — 弹窗本身就是实时预览
  useEffect(() => {
    applyFontTierValues(values)
  }, [values])

  const handleSave = () => {
    saveFontTierOverrides(values)
    onClose()
  }

  // 关闭不保存: 回滚到打开前持久化的生效值
  const handleCancel = () => {
    applyFontTierValues(effectiveFontTierValues())
    onClose()
  }

  // 恢复默认: 清掉 localStorage 覆写, 界面回到 font-tiers.css 的默认档
  const handleReset = () => {
    resetFontTierOverrides()
    const next = effectiveFontTierValues()
    setValues(next)
    applyFontTierValues(next)
  }

  const setValue = (key: keyof FontTierValues, raw: number) => {
    const px = clampFontTierPx(raw)
    setValues(prev => ({ ...prev, [key]: px }))
  }

  // 整体偏移滑杆: 相对拖动, 把本次增量同时加到全部档位上 (各档独立 clamp).
  // 偏移不单独持久化 — 松手即并入七档绝对值, 存储仍是单一事实来源.
  const [offset, setOffset] = useState(0)
  const applyOffset = (next: number) => {
    const delta = next - offset
    setOffset(next)
    setValues(prev => {
      const out = { ...prev }
      for (const t of FONT_TIERS) out[t.key] = clampFontTierPx(prev[t.key] + delta)
      return out
    })
  }

  const inputBorder = '1px solid var(--input-border)'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={handleCancel} />
      <div
        className="relative w-[520px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-64px)] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex items-center gap-2">
            <TypeIcon className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} />
            <h3 className="text-[length:var(--fs-xl)] font-semibold" style={{ color: isDark ? '#f1f5f9' : '#1e293b' }}>
              字体设置
            </h3>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            aria-label="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-muted)' }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body: 七档调节行 */}
        <div className="flex-1 overflow-auto px-5 py-4 space-y-2">
          <div className="mb-3 text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>
            全站字体分七个档位，拖动滑杆实时预览；保存后写入浏览器，下次打开自动生效。
          </div>
          {FONT_TIERS.map(tier => {
            const px = values[tier.key]
            return (
              <div
                key={tier.key}
                className="rounded-lg px-3 py-2 flex items-center gap-3"
                style={{ background: 'var(--input-bg)', border: inputBorder }}
              >
                <span className="w-9 shrink-0 text-[length:var(--fs-sm)] font-medium" style={{ color: 'var(--text-primary)' }}>
                  {tier.label}
                </span>
                <input
                  type="range"
                  min={FONT_TIER_MIN_PX}
                  max={FONT_TIER_MAX_PX}
                  step={0.5}
                  value={px}
                  onChange={e => setValue(tier.key, Number(e.target.value))}
                  aria-label={`${tier.label} 字号`}
                  className="flex-1 h-1.5 cursor-pointer"
                  style={{ accentColor: 'var(--accent-primary)' }}
                />
                <input
                  type="number"
                  min={FONT_TIER_MIN_PX}
                  max={FONT_TIER_MAX_PX}
                  step={0.5}
                  value={px}
                  onChange={e => setValue(tier.key, Number(e.target.value))}
                  aria-label={`${tier.label} 字号数值`}
                  className="w-16 h-7 shrink-0 px-2 rounded-md text-center tabular-nums focus:outline-none focus:border-[var(--accent-primary)]"
                  style={{ background: 'var(--bg-primary)', border: inputBorder, color: isDark ? '#cbd5e1' : '#334155', fontSize: 'var(--fs-sm)' }}
                />
                {/* 档位实际渲染效果预览 — 字号本身跟随当前值 */}
                <span className="w-28 shrink-0 truncate text-right" style={{ color: 'var(--text-secondary)', fontSize: px }}>
                  永远的朋友 Aa
                </span>
              </div>
            )
          })}

          {/* 整体偏移: 拖一下, 七个档位一起变大/变小 */}
          <div
            className="rounded-lg px-3 py-2.5 flex items-center gap-3"
            style={{ background: 'var(--bg-active)', border: '1px solid var(--accent-primary)' }}
          >
            <span className="w-9 shrink-0 text-[length:var(--fs-sm)] font-medium" style={{ color: 'var(--text-primary)' }}>
              整体
            </span>
            <input
              type="range"
              min={-5}
              max={8}
              step={0.5}
              value={offset}
              onChange={e => applyOffset(Number(e.target.value))}
              aria-label="整体偏移"
              className="flex-1 h-1.5 cursor-pointer"
              style={{ accentColor: 'var(--accent-primary)' }}
            />
            <span
              className="w-16 h-7 shrink-0 flex items-center justify-center rounded-md tabular-nums"
              style={{ background: 'var(--bg-primary)', border: inputBorder, color: 'var(--text-primary)', fontSize: 'var(--fs-sm)' }}
            >
              {offset > 0 ? `+${offset}` : offset}px
            </span>
            <span className="w-28 shrink-0 truncate text-right text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>
              全部档位同时增减
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3 border-t" style={{ borderColor: 'var(--border-color)' }}>
          <div className="flex-1 text-[length:var(--fs-sm)]" style={{ color: 'var(--text-muted)' }}>
            默认 9–15px · 可调 {FONT_TIER_MIN_PX}–{FONT_TIER_MAX_PX}px · 保存到浏览器
          </div>
          <button
            type="button"
            onClick={handleReset}
            className="h-8 px-3 rounded-lg text-[length:var(--fs-md)] flex items-center gap-1.5 transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-secondary)', border: inputBorder }}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            恢复默认
          </button>
          <button
            type="button"
            onClick={handleCancel}
            className="h-8 px-3 rounded-lg text-[length:var(--fs-md)] transition-colors hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-secondary)', border: inputBorder }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="h-8 px-3 rounded-lg text-[length:var(--fs-md)] font-medium transition-colors"
            style={{ background: 'var(--accent-primary)', color: '#0b1220' }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
