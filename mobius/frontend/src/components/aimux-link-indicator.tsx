// 桌面端 aimux 连接状态动画指示器。
// 仅当 (1) Electron 桌面端 (window.mobiusDesktop.isDesktop) 且 (2) 当前 session 由
// PC client 创建 (含有效 pc_client_metadata.aimux_id) 时渲染; 否则返回 null, 不占位。
// connected: 服务器↔笔记本 双向数据包流动; 其他状态: 中间断开 + 火花。
// aimux 状态经 preload 暴露的 getAimuxStatus()/onAimuxStatus() 取得, 无需改桌面端。
import { memo, useEffect, useState } from 'react'
import { Server, Laptop } from 'lucide-react'

type AimuxState = 'stopped' | 'starting' | 'connected' | 'failed'

interface PcClientMeta {
  work_mode?: string
  aimux_id?: string
  local_path?: string
}

/** pc_client_metadata 在 DB 是 JSON 字符串, 详情端点返回字符串, 列表端点补列后也是字符串。 */
function parsePcMeta(raw: unknown): PcClientMeta | null {
  if (!raw) return null
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw
    return obj && typeof obj === 'object' ? (obj as PcClientMeta) : null
  } catch {
    return null
  }
}

/** "由 PC client 创建" = 有效 pc_client_metadata 且带 aimux_id。 */
export function isPcClientSession(session: unknown): boolean {
  const meta = parsePcMeta((session as { pc_client_metadata?: unknown })?.pc_client_metadata)
  return !!meta?.aimux_id
}

function getDesktopBridge(): { isDesktop?: boolean; getAimuxStatus?: () => Promise<{ state?: AimuxState }>; onAimuxStatus?: (cb: (s: { state?: AimuxState }) => void) => (() => void) | undefined; openStatusPanel?: () => void } | undefined {
  return typeof window !== 'undefined' ? (window as { mobiusDesktop?: any }).mobiusDesktop : undefined
}

function useAimuxDesktopStatus(session: unknown) {
  const md = getDesktopBridge()
  const enabled = !!md?.isDesktop && isPcClientSession(session)
  const [state, setState] = useState<AimuxState | null>(null)

  useEffect(() => {
    if (!enabled || !md?.getAimuxStatus) {
      setState(null)
      return
    }
    let cancelled = false
    let off: (() => void) | undefined
    md.getAimuxStatus!()
      .then((s: { state?: AimuxState }) => { if (!cancelled) setState(s?.state ?? 'stopped') })
      .catch(() => {})
    off = md.onAimuxStatus?.((s: { state?: AimuxState }) => setState(s?.state ?? 'stopped'))
    return () => {
      cancelled = true
      off?.()
    }
  }, [enabled, md])

  return { enabled, state }
}

type Tone = 'green' | 'amber' | 'red' | 'gray'
const TONE: Record<Tone, { wire: string; packet: string; icon: string; glow: string }> = {
  green: { wire: 'bg-green-400/70',  packet: 'bg-green-300', icon: 'text-green-400', glow: 'rgba(52,199,89,0.55)' },
  amber: { wire: 'bg-amber-400/40',  packet: 'bg-amber-300', icon: 'text-amber-400', glow: 'rgba(245,166,35,0.4)' },
  red:   { wire: 'bg-red-400/40',    packet: 'bg-red-300',   icon: 'text-red-400',   glow: 'rgba(255,59,48,0.4)' },
  gray:  { wire: 'bg-gray-500/30',   packet: 'bg-gray-400',  icon: 'text-gray-400',  glow: 'rgba(156,156,156,0.3)' },
}

const WIRE = 30 // 网线像素宽度, 同步设为 --aimux-wire-len

function AimuxLinkIndicatorInner({ session }: { session: unknown }) {
  const { enabled, state } = useAimuxDesktopStatus(session)
  if (!enabled || !state) return null

  const connected = state === 'connected'
  const tone: Tone = connected ? 'green' : state === 'starting' ? 'amber' : state === 'failed' ? 'red' : 'gray'
  const t = TONE[tone]
  const label = connected
    ? 'aimux 已连接 · 数据双向传输'
    : state === 'starting' ? 'aimux 连接中 · 正在建立连接'
    : state === 'failed' ? 'aimux 连接失败 · 链路已断开'
    : 'aimux 已断开'

  const openPanel = () => getDesktopBridge()?.openStatusPanel?.()

  // 几何用 inline 像素定位 (避免 transform 居中与 keyframe 的 transform 冲突)。
  // 网线容器高 8px: 线体 2px 居中 (top=3), 数据包 3px (top=2.5), 火花 4px (top=2)。
  const half = WIRE / 2 - 3 // 断开时单段宽度 (中间留 6px 缺口)

  return (
    <span
      role="button"
      tabIndex={0}
      title={label}
      onClick={openPanel}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel() } }}
      className="aimux-link-indicator flex-shrink-0 inline-flex items-center gap-1 cursor-pointer select-none"
      style={{ ['--aimux-wire-len' as string]: `${WIRE}px` } as React.CSSProperties}
    >
      <Server className={`w-3.5 h-3.5 ${t.icon}`} strokeWidth={1.75} />
      <span className="relative inline-block align-middle" style={{ width: WIRE, height: 8 }}>
        {connected ? (
          <>
            <span
              className={`absolute left-0 rounded-full ${t.wire}`}
              style={{ top: 3, width: WIRE, height: 2, boxShadow: `0 0 4px ${t.glow}` }}
            />
            <span className={`aimux-packet-right absolute rounded-full ${t.packet}`} style={{ top: 2.5, left: 0, width: 3, height: 3 }} />
            <span className={`aimux-packet-left absolute rounded-full ${t.packet}`} style={{ top: 2.5, left: 0, width: 3, height: 3 }} />
          </>
        ) : (
          <>
            <span className={`absolute rounded-full ${t.wire}`} style={{ top: 3, left: 0, width: half, height: 2, opacity: 0.6 }} />
            <span className={`absolute rounded-full ${t.wire}`} style={{ top: 3, right: 0, width: half, height: 2, opacity: 0.6 }} />
            <span className={`aimux-spark absolute rounded-full ${t.packet}`} style={{ top: 2, left: WIRE / 2 - 2, width: 4, height: 4 }} />
          </>
        )}
      </span>
      <Laptop className={`w-3.5 h-3.5 ${t.icon}`} strokeWidth={1.75} />
    </span>
  )
}

export const AimuxLinkIndicator = memo(AimuxLinkIndicatorInner)
