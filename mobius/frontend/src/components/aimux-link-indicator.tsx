// 桌面端 aimux 连接状态动画指示器 + 工作模式切换下拉菜单。
// 仅当 (1) Electron 桌面端 (window.mobiusDesktop.isDesktop) 且 (2) 当前 session 由
// PC client 创建 (含有效 pc_client_metadata.aimux_id) 时渲染; 否则返回 null, 不占位。
// connected: 服务器↔笔记本 双向数据包流动; 其他状态: 中间断开 + 火花。
// 点击控件 → 弹出下拉菜单, 选择一种工作模式 → 经 onSend 向当前 session 发一条
// 授权/限制 aimux 连接的指令 (aimuxId 取自 session 的 pc_client_metadata.aimux_id,
// 兜底 getBootData().aimuxIdentifier; 可操作路径取自 getProjectLocalPath(projectId))。
// 当前选中模式按 session 记到 localStorage, 下次打开菜单时高亮回显。
// aimux 状态经 preload 暴露的 getAimuxStatus()/onAimuxStatus() 取得, 无需改桌面端。
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Server, Laptop, ArrowLeftRight, Check } from 'lucide-react'

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

function getDesktopBridge(): {
  isDesktop?: boolean
  getAimuxStatus?: () => Promise<{ state?: AimuxState }>
  onAimuxStatus?: (cb: (s: { state?: AimuxState }) => void) => (() => void) | undefined
  openStatusPanel?: () => void
  getBootData?: () => Promise<{ aimuxIdentifier?: string }>
  getProjectLocalPath?: (projectId: string) => Promise<string | null>
} | undefined {
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

// ── 工作模式切换 ┐
type AimuxMode = 'central' | 'pc' | 'dual'

const MODE_ITEMS: { key: AimuxMode; label: string; desc: string }[] = [
  { key: 'central', label: '仅在中枢工作',         desc: '不连接本机 aimux' },
  { key: 'pc',      label: '仅在此电脑上工作',     desc: '所有工作走 aimux' },
  { key: 'dual',    label: '中枢 + 本机双侧工作',  desc: '本地先改, 再同步到本机' },
]

function sessionAimuxId(session: unknown): string {
  const meta = parsePcMeta((session as { pc_client_metadata?: unknown })?.pc_client_metadata)
  return meta?.aimux_id || ''
}

// pathClause: 有本机路径 → 反引号包裹的路径; 无 → 描述性占位。三种模式文案共用。
function buildPathClause(localPath: string | null): string {
  const trimmed = typeof localPath === 'string' ? localPath.trim() : ''
  return trimmed ? `\`${trimmed}\`` : '用户的默认登录目录'
}

function buildModeMessage(mode: AimuxMode, aimuxId: string, pathClause: string): string {
  if (mode === 'central') {
    return `【注意！从现在开始，不要使用aimux连接到以下远程对象： ${aimuxId}】`
  }
  if (mode === 'pc') {
    return `【注意！从现在开始，使用aimux连接到以下远程对象执行所有工作，尽量不修改本地的代码，但可以先在本地临时路径/tmp下先生成代码再同步到${aimuxId}目标设备上。设备 ${aimuxId}，路径${pathClause}】`
  }
  return `【注意！从现在开始，你现在被授权使用aimux连接到以下远程对象： ${aimuxId}，可操作远程路径${pathClause}，当你需要修改代码时，先修改本地的代码，然后把代码都要同步到${aimuxId}上，除非用户反对你这样做。当用户需要你运行代码时，遵循一样的规则，可操作远程路径 ${pathClause}。】`
}

function modeStorageKey(sessionId: string) { return `mobius:aimux-mode:${sessionId}` }
function readMode(sessionId: string): AimuxMode | null {
  if (typeof window === 'undefined' || !sessionId) return null
  try {
    const v = window.localStorage.getItem(modeStorageKey(sessionId))
    return v === 'central' || v === 'pc' || v === 'dual' ? v : null
  } catch { return null }
}
function writeMode(sessionId: string, mode: AimuxMode) {
  if (typeof window === 'undefined' || !sessionId) return
  try { window.localStorage.setItem(modeStorageKey(sessionId), mode) } catch {}
}
// └──────────────┘

function AimuxLinkIndicatorInner({
  session,
  sessionId,
  projectId,
  onSend,
}: {
  session: unknown
  sessionId?: string
  projectId?: string
  onSend?: (content: string) => void
}) {
  const { enabled, state } = useAimuxDesktopStatus(session)
  const md = getDesktopBridge()
  const hasMenu = !!onSend && !!sessionId
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeMode, setActiveMode] = useState<AimuxMode | null>(() => readMode(sessionId || ''))
  const [firing, setFiring] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)

  // 切换 session 时按新 sessionId 重读本地记录
  useEffect(() => { setActiveMode(readMode(sessionId || '')) }, [sessionId])

  // 点外部 / Esc 关菜单
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const chooseMode = useCallback(async (mode: AimuxMode) => {
    setMenuOpen(false)
    if (!onSend || !sessionId) return
    // aimuxId 优先取 session 元数据 (本控件仅在 pc_client session 渲染, 恒有); 兜底本机 identifier
    let aimuxId = sessionAimuxId(session)
    if (!aimuxId) {
      try { aimuxId = (await md?.getBootData?.())?.aimuxIdentifier || '' } catch {}
    }
    let localPath: string | null = null
    try { if (projectId) localPath = (await md?.getProjectLocalPath?.(projectId)) ?? null } catch {}
    if (!aimuxId) {
      console.warn('[AimuxLinkIndicator] 无法获取本机 aimux 标识符, 已取消发送')
      return
    }
    setActiveMode(mode)
    writeMode(sessionId, mode)
    setFiring(true)
    window.setTimeout(() => setFiring(false), 1000)
    onSend(buildModeMessage(mode, aimuxId, buildPathClause(localPath)))
  }, [md, onSend, projectId, session, sessionId])

  if (!enabled || !state) return null

  const connected = state === 'connected'
  const tone: Tone = connected ? 'green' : state === 'starting' ? 'amber' : state === 'failed' ? 'red' : 'gray'
  const t = TONE[tone]
  const label = connected
    ? 'aimux 已连接 · 数据双向传输'
    : state === 'starting' ? 'aimux 连接中 · 正在建立连接'
    : state === 'failed' ? 'aimux 连接失败 · 链路已断开'
    : 'aimux 已断开'

  const openPanel = () => md?.openStatusPanel?.()
  const onTriggerClick = () => { if (hasMenu) setMenuOpen((v) => !v); else openPanel() }
  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (hasMenu) setMenuOpen((v) => !v); else openPanel()
    }
  }

  // 几何用 inline 像素定位 (避免 transform 居中与 keyframe 的 transform 冲突)。
  // 网线容器高 8px: 线体 2px 居中 (top=3), 数据包 3px (top=2.5), 火花 4px (top=2)。
  const half = WIRE / 2 - 3 // 断开时单段宽度 (中间留 6px 缺口)

  return (
    <span className="aimux-link-indicator-wrap relative inline-flex" ref={wrapRef}>
      <span
        role="button"
        tabIndex={0}
        aria-expanded={hasMenu ? menuOpen : undefined}
        aria-haspopup={hasMenu ? 'menu' : undefined}
        title={hasMenu ? `${label}（点击切换工作模式）` : label}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKey}
        className={`aimux-link-indicator flex-shrink-0 inline-flex items-center gap-1 cursor-pointer select-none rounded-md ${firing ? 'aimux-link-indicator--firing' : ''}`}
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

      {hasMenu && menuOpen && (
        <div
          role="menu"
          aria-label="aimux 工作模式"
          className="aimux-mode-menu absolute right-0 top-full z-50 mt-1.5 min-w-[224px] origin-top-right"
        >
          <div className="aimux-mode-menu__header" title={label}>
            <span className={`aimux-mode-menu__dot aimux-mode-menu__dot--${tone}`} />
            <span className="truncate">{label}</span>
          </div>
          <div className="aimux-mode-menu__list">
            {MODE_ITEMS.map((m) => {
              const active = activeMode === m.key
              return (
                <button
                  key={m.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => chooseMode(m.key)}
                  className={`aimux-mode-menu__item ${active ? 'aimux-mode-menu__item--active' : ''}`}
                >
                  <span className="aimux-mode-menu__icon">
                    {m.key === 'central' ? <Server className="w-3.5 h-3.5" strokeWidth={1.75} />
                      : m.key === 'pc' ? <Laptop className="w-3.5 h-3.5" strokeWidth={1.75} />
                      : <ArrowLeftRight className="w-3.5 h-3.5" strokeWidth={1.75} />}
                  </span>
                  <span className="aimux-mode-menu__text">
                    <span className="aimux-mode-menu__label">{m.label}</span>
                    <span className="aimux-mode-menu__desc">{m.desc}</span>
                  </span>
                  {active && <Check className="aimux-mode-menu__check w-3.5 h-3.5" strokeWidth={2} />}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </span>
  )
}

export const AimuxLinkIndicator = memo(AimuxLinkIndicatorInner)
