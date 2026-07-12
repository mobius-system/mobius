// 桌面端 aimux 反向连接状态徽标（顶栏，搜索按钮左侧）。
// 取代旧版 Electron 主进程注入的浮动 overlay (desktop/electron/lib/status-overlay.ts)：
// 把"aimux 状态 overlay"从 Electron 侧移到前端，仅在检测到 Electron 桌面端时才加载/显示。
// 状态来源不变：preload 暴露的 window.mobiusDesktop.getAimuxStatus()/onAimuxStatus()（IPC 不变）。
// 点击打开 aimux 状态面板 (openStatusPanel)。
import { memo, useEffect, useState } from 'react'

type AimuxState = 'stopped' | 'starting' | 'connected' | 'failed' | 'disabled'

interface AimuxStatusPayload {
  state?: AimuxState
  detail?: string
}

interface DesktopBridge {
  isDesktop?: boolean
  getAimuxStatus?: () => Promise<AimuxStatusPayload>
  onAimuxStatus?: (cb: (s: AimuxStatusPayload) => void) => (() => void) | undefined
  openStatusPanel?: () => void
}

function getDesktopBridge(): DesktopBridge | undefined {
  return typeof window !== 'undefined'
    ? (window as { mobiusDesktop?: DesktopBridge }).mobiusDesktop
    : undefined
}

// 颜色与文案：与旧 Electron 徽标 (status-overlay.ts) 保持一致。
const META: Record<AimuxState, { color: string; label: string; pulse?: boolean }> = {
  starting: { color: '#f5a623', label: 'aimux 连接中', pulse: true },
  connected: { color: '#34c759', label: 'aimux 已连接' },
  failed: { color: '#ff3b30', label: 'aimux 已断开' },
  stopped: { color: '#9b9b9b', label: 'aimux 未连接' },
  disabled: { color: '#9b9b9b', label: 'aimux 已关闭' },
}

function AimuxStatusBadgeInner() {
  const md = getDesktopBridge()
  const [state, setState] = useState<AimuxState | null>(null)
  const [detail, setDetail] = useState<string | undefined>(undefined)

  // 仅在桌面端订阅状态：浏览器里 window.mobiusDesktop 不存在 → effect 直接 return，零开销、零显示。
  useEffect(() => {
    if (!md?.isDesktop || !md.getAimuxStatus) return
    let cancelled = false
    md.getAimuxStatus()
      .then((s) => { if (!cancelled) { setState(s?.state ?? 'stopped'); setDetail(s?.detail) } })
      .catch(() => {})
    const off = md.onAimuxStatus?.((s) => { setState(s?.state ?? 'stopped'); setDetail(s?.detail) })
    return () => { cancelled = true; off?.() }
  }, [md])

  // 非 Electron 或尚未拿到状态 → 不渲染、不占位。
  if (!md?.isDesktop || !state) return null

  const meta = META[state] ?? META.stopped
  const title = detail ? `${meta.label} · ${detail}` : `${meta.label}（点击查看详情）`

  return (
    <button
      type="button"
      onClick={() => md?.openStatusPanel?.()}
      title={title}
      aria-label={meta.label}
      data-tour="top-aimux-status"
      className="mobius-aimux-status h-8 flex shrink-0 items-center gap-1.5 rounded-lg px-2 border hover:bg-[var(--bg-card-hover)] transition-colors"
      style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color)' }}
    >
      <span className="relative inline-flex h-2 w-2 items-center justify-center">
        <span
          className={meta.pulse ? 'animate-pulse' : ''}
          style={{ width: 8, height: 8, borderRadius: 9999, background: meta.color, boxShadow: `0 0 4px ${meta.color}99` }}
        />
      </span>
      <span className="text-[12px] font-medium">{meta.label}</span>
    </button>
  )
}

export const AimuxStatusBadge = memo(AimuxStatusBadgeInner)
