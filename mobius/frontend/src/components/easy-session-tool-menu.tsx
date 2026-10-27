// =====================================================================
// 简易模式会话页: 输入框左侧的「会话工具」按钮 (issue 2026-10-13 改造).
// 点击展开小弹窗, 包含 9 类工具 (3 个子菜单 + 6 个直执行):
//   ▸ 子菜单: 切换会话 / 语言
//   ▸ 直执行: 文件改动 / Bash 命令 / 终端 / 知识 / 注入 Skill/Memory/Git
// 附件上传 (Paperclip) 已移至输入框右侧独立按钮.
// =====================================================================
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BookMarked, Check, Database, Eye, FileDiff, GitBranch, Library, Laptop, Loader2, MonitorCheck, Puzzle, RotateCcw, Server, SquareTerminal, Wrench } from 'lucide-react'
import { api } from '../store'
import { useRemoteDeviceNames } from '../services/remote-device-names'

export type EasySessionLite = {
  session_id: string
  name?: string
  issue_id?: string | null
  project_id?: string | null
  project_name?: string | null
  issue_title?: string | null
  message_count?: number
}

export type EasyToolMenuProps = {
  isDark: boolean
  /** 近期会话列表, 用于「切换会话」子菜单 */
  recentSessions?: EasySessionLite[]
  /** 当前会话 id, 高亮 */
  currentSessionId?: string
  /** 切换会话回调 */
  onSwitchSession?: (sessionId: string) => void
  /** 当前语言 ('zh' | 'en') */
  language?: 'zh' | 'en'
  /** 切换语言回调 */
  onChangeLanguage?: (next: 'zh' | 'en') => void
  /** 打开 skill 注入弹窗 */
  onInjectSkill?: () => void
  /** 打开 memory 注入弹窗 */
  onInjectMemory?: () => void
  /** 打开 git 注入弹窗 (查看当前项目 Git 仓库) */
  onInjectGit?: () => void
  /** 打开文件改动弹窗 */
  onOpenFileChanges?: () => void
  /** 打开 Bash 命令弹窗 */
  onOpenBashCommands?: () => void
  /** 打开输入回放弹窗 */
  onOpenInputReplay?: () => void
  /** 打开终端 */
  onOpenTerminal?: () => void
  /** 打开可合作计算机弹窗 */
  onOpenCooperablePc?: () => void
  /** 切换会话绑定的协作设备 (aimux 反连注册的机器) */
  onSwitchDevice?: (deviceId: string) => Promise<void>
  /** 当前会话已绑定的协作设备 (空 = 尚未绑定) */
  currentDeviceId?: string | null
  /** 打开知识编辑器 */
  onOpenKnowledge?: () => void
  /** 切换 JSONL 时间与序号显示 */
  onToggleJsonlMeta?: () => void
  /** 当前是否显示 JSONL 时间与序号 (用于切换图标/文案) */
  showJsonlMeta?: boolean
  /** 发送项目知识沉淀指令 */
  onSendProjectKnowledge?: () => void
  /** 是否正在发送项目知识 (禁用按钮) */
  projectKnowledgeSending?: boolean
  /** 当前 jsonl 条目数 (控制按钮禁用) */
  jsonlEntryCount?: number
  /** 是否已连接 (控制项目知识发送按钮) */
  connectionReady?: boolean
  /** 是否有当前会话 (用于禁用 Skill/Memory/Git 按钮) */
  hasSession?: boolean
  /** 是否有当前项目 (用于禁用 Git 按钮) */
  hasProject?: boolean
  /** 自定义触发按钮 (默认 Wrench 图标) */
  trigger?: ReactNode
}

const PANEL_MAX_WIDTH = 320
const PANEL_MIN_WIDTH = 260
const VIEWPORT_MARGIN = 8

/**
 * 设备连接状态 → 中文. 之前直接把 broker 的枚举值 (connected/disconnected) 打进
 * 菜单里, 跟整屏中文对不上.
 */
function deviceConnText(status?: string): string {
  if (status === 'connected') return '已连接'
  if (status === 'disconnected') return '已断开'
  return '状态未知'
}

/** 平台 → 中文系统名 (darwin/win32/linux 是 aimux 报的原始值). */
function platformLabel(platform?: string): string {
  if (platform === 'darwin') return 'macOS'
  if (platform === 'win32') return 'Windows'
  if (platform === 'linux') return 'Linux'
  return platform || '未知平台'
}

export function EasySessionToolMenu(props: EasyToolMenuProps) {
  const { isDark } = props
  // 设备用 per-user 别名显示 (跨设备面板里改的名字, 这儿也要看得到同一个名字).
  const { formatName } = useRemoteDeviceNames()
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  // 协作设备列表: 展开菜单时按需拉一次 (broker 内存表, ~20ms).
  const [devices, setDevices] = useState<Array<{ name: string; status?: string; platform?: string }>>([])
  const [devicesLoading, setDevicesLoading] = useState(false)
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)
  const [deviceError, setDeviceError] = useState('')

  const loadDevices = useCallback(async (signal?: AbortSignal) => {
    setDevicesLoading(true)
    try {
      const data: any = await api('/aimux_bridge/api/remotes', { signal })
      setDevices(Array.isArray(data?.remotes) ? data.remotes : [])
      setDeviceError('')
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      setDeviceError(e?.message || '协作设备列表不可用')
    } finally {
      if (!signal?.aborted) setDevicesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open || !props.onSwitchDevice) return
    const controller = new AbortController()
    void loadDevices(controller.signal)
    return () => controller.abort()
  }, [open, props.onSwitchDevice, loadDevices])

  const pickDevice = async (deviceId: string) => {
    if (!props.onSwitchDevice) return
    setSwitchingTo(deviceId)
    setDeviceError('')
    try {
      await props.onSwitchDevice(deviceId)
      setOpen(false)
    } catch (e: any) {
      setDeviceError(e?.message || '切换协作设备失败')
    } finally {
      setSwitchingTo(null)
    }
  }

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const el = buttonRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const width = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2))
      setPos({
        left: Math.min(Math.max(VIEWPORT_MARGIN, rect.left), Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)),
        bottom: Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.top + VIEWPORT_MARGIN),
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

  useLayoutEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onClickOutside = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (buttonRef.current?.contains(t)) return
      if (popupRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClickOutside)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClickOutside)
    }
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="会话工具"
        title="会话工具"
        data-testid="easy-session-tool-trigger"
        className="easy-icon-btn inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--bg-card-hover)]"
        style={{ color: isDark ? '#d1d5db' : '#374151' }}
      >
        {props.trigger ?? <Wrench className="h-[18px] w-[18px]" strokeWidth={2} />}
      </button>
      {open && pos && createPortal(
        <div
          ref={popupRef}
          role="menu"
          aria-label="会话工具"
          data-testid="easy-session-tool-menu"
          className="easy-popover-in fixed z-[96] flex flex-col overflow-hidden rounded-2xl shadow-2xl"
          style={{
            left: pos.left,
            bottom: pos.bottom,
            width: pos.width,
            background: 'var(--modal-bg)',
            border: '1px solid var(--border-color)',
            boxShadow: '0 18px 48px -12px rgba(0,0,0,0.5)',
          } as CSSProperties}
          onMouseDown={e => e.stopPropagation()}
        >
          <header className="flex flex-shrink-0 items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--border-color)' }}>
            <span className="min-w-0 truncate text-[length:var(--fs-md)] font-semibold" style={{ color: 'var(--text-primary)' }}>会话工具</span>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {/* 4. 文件改动 (沿用 AdvancedSessionActions onOpenFileChanges) */}
            {props.onOpenFileChanges ? (
              <ToolItem
                icon={<FileDiff className="h-3.5 w-3.5" strokeWidth={2} />}
                label="文件改动"
                tooltip="查看当前会话对工作区的文件改动"
                disabled={!props.hasSession}
                onClick={() => { setOpen(false); props.onOpenFileChanges?.() }}
                isDark={isDark}
              />
            ) : null}
            {/* 5. Bash 命令 (沿用 onOpenBashCommands) */}
            {props.onOpenBashCommands ? (
              <ToolItem
                icon={<SquareTerminal className="h-3.5 w-3.5" strokeWidth={2} />}
                label="Bash 命令"
                tooltip="查看当前会话执行过的 Bash 命令"
                disabled={!props.hasSession}
                onClick={() => { setOpen(false); props.onOpenBashCommands?.() }}
                isDark={isDark}
              />
            ) : null}
            {/* 6. 终端 (沿用 onOpenTerminal) */}
            {props.onOpenTerminal ? (
              <ToolItem
                icon={<Server className="h-3.5 w-3.5" strokeWidth={2} />}
                label="终端"
                tooltip="打开终端面板"
                onClick={() => { setOpen(false); props.onOpenTerminal?.() }}
                isDark={isDark}
              />
            ) : null}
            {/* 7. 知识 (沿用 onOpenKnowledge) — 需要项目+任务 */}
            {props.onOpenKnowledge ? (
              <ToolItem
                icon={<BookMarked className="h-3.5 w-3.5" strokeWidth={2} />}
                label="项目知识"
                tooltip={props.hasProject ? '编辑当前项目知识库' : '需要先选择项目'}
                disabled={!props.hasProject}
                onClick={() => { setOpen(false); props.onOpenKnowledge?.() }}
                isDark={isDark}
              />
            ) : null}
            {/* 7.1 输入回放 (沿用 onOpenInputReplay) */}
            {props.onOpenInputReplay ? (
              <ToolItem
                icon={<RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />}
                label="回放输入"
                tooltip="回放当前会话历史输入"
                disabled={!props.hasSession}
                onClick={() => { setOpen(false); props.onOpenInputReplay?.() }}
                isDark={isDark}
              />
            ) : null}
            {/* 7.2 可合作计算机 (沿用 onOpenCooperablePc) */}
            {props.onOpenCooperablePc ? (
              <ToolItem
                icon={<MonitorCheck className="h-3.5 w-3.5" strokeWidth={2} />}
                label="可合作计算机"
                tooltip="声明可合作计算机 (勾选 aimux remote, 生成声明直接发给当前 agent)"
                disabled={!props.hasSession}
                onClick={() => { setOpen(false); props.onOpenCooperablePc?.() }}
                isDark={isDark}
              />
            ) : null}
            {/* 7.3 协作设备: 指定本会话在哪台机器上工作.
                顶栏那个设备图标只在「会话已经绑定了设备」时才渲染 (aimux-link-indicator
                里 if (!aimuxId) return null), 所以没绑定的会话在哪儿都找不到入口.
                这里是那个入口 —— 跨设备面板上写的「用「切换协作设备」指定在哪台机器上工作」
                说的就是它. */}
            {props.onSwitchDevice ? (
              <div className="easy-tool-subgroup">
                <div className="easy-tool-subgroup__header">
                  <span>协作设备</span>
                  {props.currentDeviceId && (
                    <span className="ml-auto truncate" style={{ color: 'var(--accent-primary)' }}>
                      {formatName(props.currentDeviceId)}
                    </span>
                  )}
                </div>
                {devicesLoading ? (
                  <div className="easy-tool-subgroup__empty">正在读取设备…</div>
                ) : devices.length === 0 ? (
                  <div className="easy-tool-subgroup__empty">
                    暂无协作设备。在目标机器上运行 aimux reverse connect 后自动出现。
                  </div>
                ) : (
                  <div className="flex flex-col">
                    {devices.map(device => {
                      const isCurrent = props.currentDeviceId === device.name
                      const busy = switchingTo === device.name
                      return (
                        <button
                          key={device.name}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isCurrent}
                          disabled={!!switchingTo || !props.hasSession}
                          onClick={() => { if (!isCurrent) void pickDevice(device.name) }}
                          className={`aimux-mode-menu__item ${isCurrent ? 'aimux-mode-menu__item--active' : ''}`}
                          style={busy ? { opacity: .6 } : undefined}
                        >
                          <span className="aimux-mode-menu__icon">
                            <Laptop className="w-3.5 h-3.5" strokeWidth={1.75} />
                          </span>
                          <span className="aimux-mode-menu__text">
                            <span className="aimux-mode-menu__label" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                              {formatName(device.name)}
                            </span>
                            <span className="aimux-mode-menu__desc" style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                              {deviceConnText(device.status)} · {platformLabel(device.platform)}
                            </span>
                          </span>
                          {busy && <Loader2 className="w-3.5 h-3.5 flex-shrink-0 animate-spin" style={{ color: 'var(--text-muted)' }} />}
                          {isCurrent && !busy && <Check className="aimux-mode-menu__check w-3.5 h-3.5" strokeWidth={2} />}
                        </button>
                      )
                    })}
                  </div>
                )}
                {!props.hasSession && (
                  <div className="easy-tool-subgroup__empty">需要先打开一个会话</div>
                )}
                {deviceError && (
                  <div className="px-2 py-1.5 text-[length:var(--fs-xs)]" style={{ color: '#ef4444' }}>{deviceError}</div>
                )}
              </div>
            ) : null}
            {/* 7.4 JSONL 时间与序号显示切换 (toggle) */}
            {props.onToggleJsonlMeta ? (
              <ToolItem
                icon={<Eye className="h-3.5 w-3.5" strokeWidth={2} />}
                label={props.showJsonlMeta ? '隐藏时间与序号' : '显示时间与序号'}
                tooltip={props.showJsonlMeta ? '隐藏 JSONL 卡片标题里的序号与时间前缀' : '在 JSONL 卡片标题里显示 #序号 与时间前缀'}
                disabled={(props.jsonlEntryCount ?? 0) === 0}
                onClick={() => { props.onToggleJsonlMeta?.() }}
                isDark={isDark}
              />
            ) : null}
            {/* 7.4 项目知识沉淀到记忆 (沿用 onSendProjectKnowledge) */}
            {props.onSendProjectKnowledge ? (
              <ToolItem
                icon={<Database className="h-3.5 w-3.5" strokeWidth={2} />}
                label="项目知识沉淀到记忆"
                tooltip={props.projectKnowledgeSending ? '正在发送项目知识沉淀指令...' : '请智能体整理并更新项目级与任务级可复用知识'}
                disabled={props.projectKnowledgeSending || (props.jsonlEntryCount ?? 0) === 0 || !props.connectionReady}
                onClick={() => { props.onSendProjectKnowledge?.() }}
                isDark={isDark}
              />
            ) : null}
            <div className="my-1 border-t" style={{ borderColor: 'var(--border-color)' }} />
            {/* 8. 注入 Skill — 沿用 AdvancedSessionActions 的禁用规则: !hasSession 禁用 */}
            {props.onInjectSkill ? (
              <ToolItem
                icon={<Puzzle className="h-3.5 w-3.5" strokeWidth={2} />}
                label="注入 Skill"
                tooltip={props.hasSession ? '向当前会话注入 Skill' : '需要先打开一个会话'}
                disabled={!props.hasSession}
                onClick={() => { setOpen(false); props.onInjectSkill?.() }}
                isDark={isDark}
              />
            ) : null}
            {/* 6. 注入 Memory — 沿用 AdvancedSessionActions 的禁用规则: !hasSession 禁用 */}
            {props.onInjectMemory ? (
              <ToolItem
                icon={<Library className="h-3.5 w-3.5" strokeWidth={2} />}
                label="注入 Memory"
                tooltip={props.hasSession ? '向当前会话注入 Memory' : '需要先打开一个会话'}
                disabled={!props.hasSession}
                onClick={() => { setOpen(false); props.onInjectMemory?.() }}
                isDark={isDark}
              />
            ) : null}
            {/* 11. 注入 Git — 沿用 AdvancedSessionActions 的禁用规则: !hasSession || !hasProject 禁用 */}
            {props.onInjectGit ? (
              <ToolItem
                icon={<GitBranch className="h-3.5 w-3.5" strokeWidth={2} />}
                label="注入 Git"
                tooltip={props.hasSession && props.hasProject ? '查看当前项目 Git 仓库' : '需要先打开一个会话并选择项目'}
                disabled={!props.hasSession || !props.hasProject}
                onClick={() => { setOpen(false); props.onInjectGit?.() }}
                isDark={isDark}
              />
            ) : null}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

function ToolItem({ icon, label, subLabel, onClick, isDark, tooltip, disabled }: {
  icon: ReactNode
  label: string
  subLabel?: string
  onClick: () => void
  isDark: boolean
  tooltip?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={tooltip || label}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[length:var(--fs-sm)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      style={{ color: 'var(--text-primary)' }}
    >
      <span className="flex-shrink-0" style={{ color: isDark ? '#9ca3af' : '#64748b' }}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {subLabel ? <span className="text-[10px] flex-shrink-0 px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-card-hover)', color: 'var(--text-muted)' }}>{subLabel}</span> : null}
    </button>
  )
}
