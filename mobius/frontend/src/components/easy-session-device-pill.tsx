import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Cpu, Laptop, Loader2, Monitor, Server, Smartphone } from 'lucide-react'
import { api } from '../store'
import { useRemoteDeviceNames } from '../services/remote-device-names'

/**
 * 输入框里的「运行设备」切换 (issue 2026-10-28).
 *
 * 会话跑在哪台机器上, 跟模型一样是这个会话的属性, 所以放在输入框里跟模型 pill 并排,
 * 切换逻辑也照着模型 pill 写.
 *
 * 触发按钮只画图标, 不写设备名: 设备名 (cozy_valley / desktop-mac-abc123) 又长又难看,
 * 而输入框这一行的宽度紧张 —— 名字写在这里会把旁边的模型 pill 挤窄 (前面刚修过一次).
 * 名字留到展开后的列表里, 那儿有整行的宽度, 也可以显示 per-user 别名.
 *
 * 「中枢」(莫比乌斯自己的云端) 也是一个选项: 会话可以只在中枢上跑, 不绑任何设备.
 */

export type EasySessionDevice = {
  name: string
  status?: string
  platform?: string
  gui?: { available?: boolean } | null
}

/** 设备平台 → 图标. aimux 报的是 platform.system().lower(): darwin / windows / linux. */
function DeviceIcon({ platform, className }: { platform?: string; className?: string }) {
  if (platform === 'darwin') return <Laptop className={className} strokeWidth={1.75} />
  if (platform === 'win32' || platform === 'windows') return <Monitor className={className} strokeWidth={1.75} />
  if (platform === 'android' || platform === 'ios') return <Smartphone className={className} strokeWidth={1.75} />
  if (platform === 'linux') return <Cpu className={className} strokeWidth={1.75} />
  return <Cpu className={className} strokeWidth={1.75} />
}

export function EasySessionDevicePill({
  isDark,
  deviceId,
  onChange,
  disabled,
  variant = 'icon',
}: {
  isDark: boolean
  /** 当前绑定的设备 id; 空串 = 跑在中枢上 */
  deviceId: string
  /** 切换运行设备; 传空串表示回到中枢 */
  onChange: (deviceId: string) => Promise<void> | void
  disabled?: boolean
  /**
   * icon = 只画图标 (执行页: 那一行右边已经站着模型 pill 和四个动作键, 名字写不下);
   * chip = 带文字的胶囊 (欢迎页: 那一行是「我们有哪些能力」的清单, 文字要说清楚这是啥).
   */
  variant?: 'icon' | 'chip'
}) {
  const { formatName } = useRemoteDeviceNames()
  const [open, setOpen] = useState(false)
  const [devices, setDevices] = useState<EasySessionDevice[]>([])
  const [loading, setLoading] = useState(false)
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)
  const [error, setError] = useState('')
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null)

  const loadDevices = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    try {
      const data: any = await api('/aimux_bridge/api/remotes', { signal })
      setDevices(Array.isArray(data?.remotes) ? data.remotes.filter((d: any) => d?.name) : [])
      setError('')
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      setError(e?.message || '读取协作设备失败')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  // 展开时才拉 (broker 内存表, ~20ms), 收起用 abort 掐掉在途请求.
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void loadDevices(controller.signal)
    return () => controller.abort()
  }, [open, loadDevices])

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const el = buttonRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const width = Math.min(300, Math.max(240, window.innerWidth - 16))
      setPos({
        left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8)),
        bottom: Math.max(8, window.innerHeight - rect.top + 8),
        width,
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    const onClickOutside = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (buttonRef.current?.contains(target)) return
      if (popupRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClickOutside)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClickOutside)
    }
  }, [open])

  const pick = async (nextId: string) => {
    if (nextId === deviceId) return
    setSwitchingTo(nextId)
    setError('')
    try {
      await onChange(nextId)
      setOpen(false)
    } catch (e: any) {
      setError(e?.message || '切换运行设备失败')
    } finally {
      setSwitchingTo(null)
    }
  }

  // 当前设备: 绑定了就是那台, 没绑就是中枢.
  const current = devices.find(d => d.name === deviceId)
  const currentLabel = deviceId ? (deviceId ? formatName(deviceId) : deviceId) : '中枢'
  const currentPlatform = current?.platform

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="切换运行设备"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={`运行设备: ${currentLabel}`}
        onClick={() => setOpen(v => !v)}
        className={variant === 'chip'
          ? 'easy-device-chip inline-flex h-7 min-w-0 max-w-[220px] flex-shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[length:var(--fs-sm)] transition-colors hover:bg-[var(--bg-card-hover)] disabled:cursor-not-allowed disabled:opacity-50'
          : 'easy-icon-btn easy-icon-btn--device inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50'}
        style={variant === 'chip'
          ? {
              borderColor: deviceId ? 'rgba(59,130,246,0.72)' : 'var(--input-border)',
              color: deviceId ? '#60a5fa' : (isDark ? '#d1d5db' : '#374151'),
            }
          : {
              /* 图标形态: 选中设备后变蓝 (与「选中变蓝」同一套语义), 否则中性. */
              color: deviceId ? '#60a5fa' : (isDark ? '#e5e7eb' : '#1f2937'),
              background: open ? 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' : 'transparent',
            }}
      >
        {deviceId
          ? <DeviceIcon platform={currentPlatform} className="h-[16px] w-[16px] flex-shrink-0" />
          : <Server className="h-[16px] w-[16px] flex-shrink-0" strokeWidth={1.75} />}
        {variant === 'chip' && (
          <span className="min-w-0 truncate">
            <span style={{ color: 'var(--text-muted)' }}>运行中枢 </span>
            {currentLabel}
          </span>
        )}
        {variant === 'chip' && <span className="flex-shrink-0 text-[length:var(--fs-xs)]" style={{ color: 'var(--text-muted)' }}>▾</span>}
      </button>
      {open && pos && createPortal(
        <div
          ref={popupRef}
          role="menu"
          aria-label="切换运行设备"
          data-testid="easy-session-device-picker"
          className="easy-popover-in fixed z-[96] flex flex-col overflow-hidden rounded-2xl shadow-2xl"
          style={{
            left: pos.left,
            bottom: pos.bottom,
            width: pos.width,
            background: 'var(--modal-bg)',
            border: '1px solid var(--border-color)',
            boxShadow: '0 18px 48px -12px rgba(0,0,0,0.5)',
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          <header className="flex flex-shrink-0 items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--border-color)' }}>
            <span className="text-[length:var(--fs-md)] font-semibold" style={{ color: 'var(--text-primary)' }}>运行设备</span>
            <span className="text-[length:var(--fs-xs)]" style={{ color: 'var(--text-muted)' }}>智能体在哪台机器上干活</span>
          </header>
          <div className="min-h-0 max-h-[320px] overflow-y-auto py-1">
            {loading && devices.length === 0 ? (
              <div className="easy-list-empty">
                <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.8} />
                <span>正在读取设备…</span>
              </div>
            ) : (
              <>
                {/* 中枢: 莫比乌斯自己的云端, 不绑设备 */}
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!deviceId}
                  disabled={!!switchingTo}
                  onClick={() => { void pick('') }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
                  style={{ background: !deviceId ? 'rgba(59,130,246,0.12)' : undefined }}
                >
                  <Server className="h-4 w-4 flex-shrink-0" strokeWidth={1.75} style={{ color: 'var(--text-secondary)' }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[length:var(--fs-md)] font-medium" style={{ color: 'var(--text-primary)' }}>中枢</span>
                    <span className="block truncate text-[length:var(--fs-xs)]" style={{ color: 'var(--text-muted)' }}>莫比乌斯自己的云端</span>
                  </span>
                  {!deviceId && <Check className="h-4 w-4 flex-shrink-0" strokeWidth={2} style={{ color: 'var(--accent-primary)' }} />}
                </button>
                {devices.length > 0 && <div className="my-1 border-t" style={{ borderColor: 'var(--border-color)' }} />}
                {devices.map(device => {
                  const isCurrent = device.name === deviceId
                  const busy = switchingTo === device.name
                  const connected = device.status === 'connected'
                  return (
                    <button
                      key={device.name}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isCurrent}
                      disabled={!!switchingTo}
                      onClick={() => { void pick(device.name) }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
                      style={{ background: isCurrent ? 'rgba(59,130,246,0.12)' : undefined }}
                    >
                      <DeviceIcon platform={device.platform} className="h-4 w-4 flex-shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[length:var(--fs-md)] font-medium" style={{ color: 'var(--text-primary)' }}>
                          {formatName(device.name)}
                        </span>
                        <span className="block truncate text-[length:var(--fs-xs)]" style={{ color: 'var(--text-muted)' }}>
                          {connected ? '在线' : '离线'} · {device.platform || '未知平台'}
                        </span>
                      </span>
                      {busy && <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" style={{ color: 'var(--text-muted)' }} />}
                      {isCurrent && !busy && <Check className="h-4 w-4 flex-shrink-0" strokeWidth={2} style={{ color: 'var(--accent-primary)' }} />}
                    </button>
                  )
                })}
                {devices.length === 0 && !loading && (
                  <div className="easy-list-empty">
                    <Cpu className="h-5 w-5" strokeWidth={1.8} />
                    <span>暂无协作设备</span>
                    <span style={{ fontSize: 'var(--fs-xs)' }}>在目标机器上运行 aimux reverse connect 后自动出现。</span>
                  </div>
                )}
              </>
            )}
          </div>
          {error && (
            <div className="border-t px-3 py-2 text-[length:var(--fs-sm)]" style={{ borderColor: 'var(--border-color)', color: '#ef4444' }}>
              {error}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
