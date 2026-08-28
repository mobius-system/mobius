import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronLeft, ExternalLink, X } from 'lucide-react'
import { useStore } from '../store'
import { THEME_OPTIONS } from '../theme'
import {
  AimuxGuideModal,
  ChangePasswordModal,
  DesktopDownloadModal,
  MobileDownloadModal,
  TerminalInstallModal,
} from './modals'
import { GuideHelpModal } from './guide-help'
import { CustomThemePalette } from './custom-theme-palette'
import { logUiEvent } from '../services/ui-observability'
import {
  homePath,
  navigateToWorkbench,
  projectNavigation,
  safeWorkbenchReturnTo,
  systemVisualizationNavigation,
  type WorkbenchNavigationTarget,
} from '../services/workbench-navigation'
import {
  checkDesktopDownloadCapability,
  CLIENT_DISTRIBUTION_DOCS_URL,
  detectClientRuntime,
  getDesktopDistributionBridge,
} from '../services/client-distribution'

export type SettingsSection = 'general' | 'context' | 'connections' | 'advanced' | 'admin'

export function SettingsPanel({
  onClose,
  returnFocusRef,
  initialSection = 'general',
}: {
  onClose: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
  initialSection?: SettingsSection
}) {
  const navigate = useNavigate()
  const {
    user, theme, setTheme, assistantBubbleEnabled, toggleAssistantBubble, currentProject,
  } = useStore()
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const [modal, setModal] = useState<'password' | 'aimux' | 'desktop' | 'cli' | 'mobile' | 'help' | 'palette' | null>(null)
  const [connectionGroup, setConnectionGroup] = useState<'devices' | 'clients' | null>(null)
  const [desktopDownloadStatus, setDesktopDownloadStatus] = useState<'idle' | 'checking' | 'available' | 'unavailable'>('idle')
  const [desktopDownloadError, setDesktopDownloadError] = useState('')
  const [desktopDownloadAttempt, setDesktopDownloadAttempt] = useState(0)
  const [desktopActionError, setDesktopActionError] = useState('')
  const [mobileContentOpen, setMobileContentOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const mobileBackRef = useRef<HTMLButtonElement | null>(null)
  const mobileNavRef = useRef<HTMLElement | null>(null)
  const sectionHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const navigationErrorRef = useRef<HTMLDivElement | null>(null)
  const initialFocusRef = useRef<HTMLElement | null>(null)
  const navigationSucceededRef = useRef(false)
  const skipInitialSectionFocusRef = useRef(true)
  const [navigationError, setNavigationError] = useState('')
  const userId = user?.id || ''
  const clientRuntime = detectClientRuntime()

  useEffect(() => {
    initialFocusRef.current = returnFocusRef?.current
      || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      if (navigationSucceededRef.current) return
      const requested = returnFocusRef?.current
      const target = requested?.isConnected ? requested : initialFocusRef.current
      window.requestAnimationFrame(() => { if (target?.isConnected) target.focus() })
    }
  }, [])

  useEffect(() => {
    if (skipInitialSectionFocusRef.current) {
      skipInitialSectionFocusRef.current = false
      return
    }
    window.requestAnimationFrame(() => sectionHeadingRef.current?.focus())
  }, [section])

  useEffect(() => {
    if (navigationError) window.requestAnimationFrame(() => navigationErrorRef.current?.focus())
  }, [navigationError])

  useEffect(() => {
    if (section !== 'connections' || clientRuntime !== 'web') return
    let active = true
    const ctrl = new AbortController()
    const timer = window.setTimeout(() => ctrl.abort(), 8000)
    setDesktopDownloadStatus('checking')
    setDesktopDownloadError('')
    checkDesktopDownloadCapability(ctrl.signal)
      .then(() => {
        if (active) setDesktopDownloadStatus('available')
      })
      .catch(reason => {
        if (!active) return
        setDesktopDownloadStatus('unavailable')
        setDesktopDownloadError(reason instanceof DOMException && reason.name === 'AbortError'
          ? '获取桌面版本信息超时，请稍后重试'
          : reason instanceof Error ? reason.message : '无法确认桌面客户端是否可用')
      })
      .finally(() => window.clearTimeout(timer))
    return () => {
      active = false
      window.clearTimeout(timer)
      ctrl.abort()
    }
  }, [clientRuntime, desktopDownloadAttempt, section])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (modal) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) || []).filter(element => element.getClientRects().length > 0)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || !panelRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !panelRef.current?.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [modal, onClose])

  const go = (destination: string | WorkbenchNavigationTarget, advanced = false) => {
    const path = typeof destination === 'string' ? destination : destination.path
    if (advanced) logUiEvent('advanced_opened', { path })
    setNavigationError('')
    try {
      if (typeof destination === 'string') navigate(destination)
      else navigateToWorkbench(navigate, destination)
      navigationSucceededRef.current = true
      onClose()
    } catch (reason) {
      setNavigationError(reason instanceof Error ? reason.message : '无法打开目标页面')
    }
  }

  const currentReturnTo = typeof window === 'undefined'
    ? ''
    : safeWorkbenchReturnTo(`${window.location.pathname}${window.location.search}${window.location.hash}`)

  const openDesktopStatus = async () => {
    setDesktopActionError('')
    const bridge = getDesktopDistributionBridge()
    if (typeof bridge?.openStatusPanel !== 'function') {
      setDesktopActionError('当前桌面客户端未提供 AIMUX 状态面板，请查看连接文档。')
      return
    }
    try {
      await bridge.openStatusPanel()
    } catch (reason) {
      setDesktopActionError(reason instanceof Error ? reason.message : '无法打开 AIMUX 状态面板')
    }
  }

  const navItems: Array<{ key: SettingsSection; label: string; admin?: boolean }> = [
    { key: 'general', label: '通用 / 外观' },
    { key: 'context', label: '项目与上下文' },
    { key: 'connections', label: '连接与客户端' },
    { key: 'advanced', label: '高级' },
    ...(user?.role === 'admin' ? [{ key: 'admin' as const, label: '管理员', admin: true }] : []),
  ]

  return (
    <div className="settings-panel theme-overlay workbench-layer-modal fixed inset-0 flex items-center justify-center p-3">
      <button type="button" aria-label="关闭设置" className="theme-overlay__scrim absolute inset-0 backdrop-blur-[2px]" onClick={onClose} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="设置"
        className="theme-overlay__panel workbench-modal relative flex h-[min(640px,calc(100vh-24px))] w-[min(960px,calc(100vw-24px))] overflow-hidden border"
        style={{ background: 'var(--surface-right)' }}>
        <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="关闭设置" title="关闭设置"
          className="workbench-control-md absolute right-3 top-3 z-20 flex w-8 items-center justify-center hover:bg-[var(--surface-control-hover)]" style={{ color: 'var(--text-muted)' }}>
          <X className="h-4 w-4" />
        </button>

        <div className={`${mobileContentOpen ? 'hidden' : 'flex'} min-w-0 flex-1 flex-col p-3 sm:hidden`} style={{ background: 'var(--surface-sidebar)' }}>
          <div className="mb-3 px-2 pr-10 text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>设置</div>
          <nav ref={mobileNavRef} className="space-y-1" aria-label="设置分类">
            {navItems.map(item => (
              <button key={item.key} type="button" onClick={() => {
                setSection(item.key)
                setMobileContentOpen(true)
                window.requestAnimationFrame(() => sectionHeadingRef.current?.focus())
              }}
                className="flex h-10 w-full items-center justify-between rounded-[var(--radius-control)] px-3 text-left text-[12px] transition-colors hover:bg-[var(--surface-control-hover)]"
                style={{ color: 'var(--text-secondary)' }}>
                {item.label}<span aria-hidden="true">›</span>
              </button>
            ))}
          </nav>
          <div className="mt-auto border-t pt-3" style={{ borderColor: 'var(--border-default)' }}>
            <button type="button" onClick={() => setModal('help')} className="workbench-control-md w-full px-3 text-left text-[11px] hover:bg-[var(--surface-control-hover)]" style={{ color: 'var(--text-muted)' }}>帮助与使用指南</button>
            <a href="https://github.com/mobius-system/mobius.git" target="_blank" rel="noreferrer" className="workbench-control-md flex items-center gap-1 px-3 text-[11px] hover:bg-[var(--surface-control-hover)]" style={{ color: 'var(--text-muted)' }}>GitHub <ExternalLink className="h-3 w-3" /></a>
          </div>
        </div>

        <nav className="hidden w-40 flex-shrink-0 flex-col border-r p-3 sm:flex" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-sidebar)' }} aria-label="设置分类">
          <div className="mb-3 px-2 text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>设置</div>
          <div className="space-y-1">
            {navItems.map(item => (
              <button key={item.key} type="button" onClick={() => setSection(item.key)} aria-current={section === item.key ? 'page' : undefined}
                className="workbench-control-md w-full px-3 text-left text-[12px] transition-colors hover:bg-[var(--surface-control-hover)]"
                style={{ color: section === item.key ? 'var(--accent-primary)' : 'var(--text-secondary)', background: section === item.key ? 'var(--surface-active)' : undefined }}>
                {item.label}
              </button>
            ))}
          </div>
          <div className="mt-auto border-t pt-3" style={{ borderColor: 'var(--border-default)' }}>
            <button type="button" onClick={() => setModal('help')} className="workbench-control-md w-full px-3 text-left text-[11px] hover:bg-[var(--surface-control-hover)]" style={{ color: 'var(--text-muted)' }}>帮助与使用指南</button>
            <a href="https://github.com/mobius-system/mobius.git" target="_blank" rel="noreferrer" className="workbench-control-md flex items-center gap-1 px-3 text-[11px] hover:bg-[var(--surface-control-hover)]" style={{ color: 'var(--text-muted)' }}>GitHub <ExternalLink className="h-3 w-3" /></a>
          </div>
        </nav>

        <div className={`${mobileContentOpen ? 'block' : 'hidden'} min-w-0 flex-1 overflow-y-auto p-4 pt-14 sm:block sm:p-5 sm:pr-14`} style={{ background: 'var(--surface-right)' }}>
          <button ref={mobileBackRef} type="button" onClick={() => {
            setMobileContentOpen(false)
            window.requestAnimationFrame(() => mobileNavRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
          }}
            className="workbench-control-md mb-4 inline-flex items-center gap-1 px-2 text-[12px] hover:bg-[var(--surface-control-hover)] sm:hidden"
            style={{ color: 'var(--text-secondary)' }}>
            <ChevronLeft className="h-4 w-4" /> 设置分类
          </button>

          {navigationError && (
            <div ref={navigationErrorRef} role="alert" tabIndex={-1} className="workbench-status-danger mb-4 rounded-[var(--radius-control)] border px-3 py-2 text-[12px] outline-none">
              {navigationError}
            </div>
          )}

          {section === 'general' && (
            <section>
              <h2 ref={sectionHeadingRef} tabIndex={-1} className="text-[16px] font-semibold outline-none" style={{ color: 'var(--text-primary)' }}>通用 / 外观</h2>
              <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>浅色、深色与已有主题共享同一套表面、文字和状态语义。</p>
              <div className="mt-5 grid max-w-xl grid-cols-2 gap-2 sm:grid-cols-4">
                {THEME_OPTIONS.map(option => (
                  <button key={option.name} type="button" onClick={() => setTheme(option.name)} title={option.description}
                    className="settings-panel__target flex items-center gap-2 border px-2 text-left text-[12px] transition-colors hover:bg-[var(--surface-control-hover)]"
                    style={{ borderColor: theme === option.name ? 'var(--accent-primary)' : 'var(--border-default)', color: theme === option.name ? 'var(--accent-primary)' : 'var(--text-secondary)', background: theme === option.name ? 'var(--surface-active)' : undefined, borderRadius: 'var(--radius-control)' }}>
                    <span className="flex h-5 w-8 shrink-0 overflow-hidden rounded border" style={{ borderColor: 'var(--border-strong)' }} aria-hidden="true">
                      {option.swatches.map(color => <span key={color} className="flex-1" style={{ background: color }} />)}
                    </span>
                    <span className="truncate">{option.label}</span>
                  </button>
                ))}
              </div>
              <div className="mt-6 max-w-xl border-t pt-4" style={{ borderColor: 'var(--border-default)' }}>
                <button type="button" role="switch" aria-checked={assistantBubbleEnabled} onClick={toggleAssistantBubble} className="flex w-full items-center justify-between rounded-[var(--radius-control)] px-2 py-2.5 text-left hover:bg-[var(--surface-control-hover)]">
                  <span>
                    <span className="block text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>快捷助手</span>
                    <span className="mt-0.5 block text-[10px]" style={{ color: 'var(--text-muted)' }}>只提示跨页的新回复，不代替当前会话的发送、停止或错误反馈；新用户默认关闭。</span>
                  </span>
                  <span className="text-[11px]" style={{ color: assistantBubbleEnabled ? 'var(--accent-primary)' : 'var(--text-muted)' }}>{assistantBubbleEnabled ? '已开启' : '已关闭'}</span>
                </button>
                <button type="button" onClick={() => setModal('password')} className="workbench-control-md mt-2 border px-3 text-[12px] hover:bg-[var(--surface-control-hover)]" style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>修改密码</button>
              </div>
            </section>
          )}

          {section === 'context' && (
            <section>
              <h2 ref={sectionHeadingRef} tabIndex={-1} className="text-[16px] font-semibold outline-none" style={{ color: 'var(--text-primary)' }}>项目与上下文</h2>
              <div className="mt-5 grid max-w-xl">
                <SettingsLink label="全部项目" description="打开完整项目列表、筛选与项目卡片" onClick={() => go(homePath(userId, { view: 'projects' }))} />
                {currentProject?.id && <SettingsLink label="当前项目设置" description={currentProject.name} onClick={() => go(projectNavigation(userId, currentProject.id, { returnTo: currentReturnTo }))} />}
                <SettingsLink label="Memory 管理" description="管理全量 Memory；变更用于后续新会话，不改当前 Session 快照" onClick={() => go(homePath(userId, { view: 'projects', panel: 'memory' }))} />
                <SettingsLink label="Skills 管理" description="管理全量 Skills；变更用于后续新会话，不改当前 Session 快照" onClick={() => go(homePath(userId, { view: 'projects', panel: 'skills' }))} />
              </div>
            </section>
          )}

          {section === 'connections' && (
            <section>
              <h2 ref={sectionHeadingRef} tabIndex={-1} className="text-[16px] font-semibold outline-none" style={{ color: 'var(--text-primary)' }}>连接与客户端</h2>
              <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                按当前运行环境提供连接、下载链接与可复制命令；不会自动下载、安装或执行命令。
              </p>

              {clientRuntime === 'unknown' ? (
                <div data-client-runtime="unknown" className="mt-5 max-w-xl rounded-[var(--radius-panel)] border p-4" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}>
                  <div className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>无法确认当前客户端环境</div>
                  <p className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>为避免展示不适用的操作，这里只保留使用文档。</p>
                  <ClientDocsLink className="mt-3" />
                </div>
              ) : (
                <div data-client-runtime={clientRuntime} className="mt-5 grid max-w-xl gap-3">
                  <div className="flex items-center justify-between px-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    <span>当前环境</span>
                    <span>{clientRuntime === 'desktop' ? 'Mobius Desktop' : 'Web 浏览器'}</span>
                  </div>

                  <DistributionGroup
                    id="settings-device-connections"
                    label="设备连接"
                    description={clientRuntime === 'desktop' ? '查看本机连接状态，或连接其他计算机' : '通过 AIMUX 连接可协作的计算机'}
                    expanded={connectionGroup === 'devices'}
                    onToggle={() => setConnectionGroup(current => current === 'devices' ? null : 'devices')}
                  >
                    {clientRuntime === 'desktop' && typeof getDesktopDistributionBridge()?.openStatusPanel === 'function' && (
                      <SettingsLink label="本机 AIMUX 状态" description="打开桌面客户端提供的连接状态面板" onClick={() => void openDesktopStatus()} />
                    )}
                    <SettingsLink
                      label={clientRuntime === 'desktop' ? '连接其他计算机' : 'AIMUX 连接指引'}
                      description="查看连接步骤并复制命令；不会在当前设备执行"
                      onClick={() => { setDesktopActionError(''); setModal('aimux') }}
                    />
                    {desktopActionError && (
                      <InlineDistributionError>{desktopActionError}</InlineDistributionError>
                    )}
                  </DistributionGroup>

                  <DistributionGroup
                    id="settings-client-distribution"
                    label="客户端与命令行"
                    description={clientRuntime === 'desktop' ? '获取 CLI 命令与客户端文档' : '获取桌面、移动端链接与 CLI 命令'}
                    expanded={connectionGroup === 'clients'}
                    onToggle={() => setConnectionGroup(current => current === 'clients' ? null : 'clients')}
                  >
                    {clientRuntime === 'web' && desktopDownloadStatus === 'available' && (
                      <SettingsLink label="桌面客户端" description="查看已发布版本、校验值与下载链接" onClick={() => setModal('desktop')} />
                    )}
                    {clientRuntime === 'web' && desktopDownloadStatus === 'checking' && (
                      <div role="status" className="px-2 py-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>正在确认桌面客户端版本…</div>
                    )}
                    {clientRuntime === 'web' && desktopDownloadStatus === 'unavailable' && (
                      <InlineDistributionError actionLabel="重试" onAction={() => setDesktopDownloadAttempt(attempt => attempt + 1)}>
                        桌面客户端下载暂不可用：{desktopDownloadError}
                      </InlineDistributionError>
                    )}
                    {clientRuntime === 'web' && (
                      <SettingsLink label="移动端链接" description="查看已配置的 Android 与 TestFlight 链接" onClick={() => setModal('mobile')} />
                    )}
                    <SettingsLink label="CLI 命令" description="按平台查看并复制命令；不会自动执行安装" onClick={() => setModal('cli')} />
                    <ClientDocsLink />
                  </DistributionGroup>
                </div>
              )}
            </section>
          )}

          {section === 'advanced' && (
            <section>
              <h2 ref={sectionHeadingRef} tabIndex={-1} className="text-[16px] font-semibold outline-none" style={{ color: 'var(--text-primary)' }}>高级</h2>
              <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>高级页面和旧路由继续保留，但不占用默认工作台。</p>
              <div className="mt-5 grid max-w-xl">
                {currentProject?.id && <SettingsLink label="使用旧版项目视图" description={`打开「${currentProject.name}」的项目详情与高级管理`} onClick={() => go(projectNavigation(userId, currentProject.id, { returnTo: currentReturnTo }), true)} />}
                <SettingsLink label="系统可视化" description="全屏打开会话集群视图，返回后仍在当前页面" onClick={() => go(systemVisualizationNavigation(userId, 'cluster', { returnTo: currentReturnTo }), true)} />
                <SettingsLink label="旧项目总览" description="全屏打开保留的系统总览，返回后仍在当前页面" onClick={() => go(systemVisualizationNavigation(userId, 'overview', { returnTo: currentReturnTo }), true)} />
                <SettingsLink label="连接 / 导入向导" description="打开 Welcome 的本地连接与导入流程" onClick={() => go('/welcome', true)} />
                <SettingsLink label="主题工坊" description="高级外观编辑" onClick={() => { logUiEvent('advanced_opened', { target: 'theme_palette' }); setModal('palette') }} />
              </div>
            </section>
          )}

          {section === 'admin' && user?.role === 'admin' && (
            <section>
              <h2 ref={sectionHeadingRef} tabIndex={-1} className="text-[16px] font-semibold outline-none" style={{ color: 'var(--text-primary)' }}>管理员</h2>
              <div className="mt-5 max-w-xl">
                <SettingsLink label="打开管理中心" description="用户、运行监控、系统配置与模型接入" onClick={() => { onClose(); window.openAdminOverlay?.() }} />
              </div>
            </section>
          )}
        </div>
      </div>

      {modal === 'password' && <ChangePasswordModal onClose={() => setModal(null)} />}
      {modal === 'aimux' && <AimuxGuideModal onClose={() => setModal(null)} />}
      {modal === 'desktop' && <DesktopDownloadModal onClose={() => setModal(null)} />}
      {modal === 'cli' && <TerminalInstallModal onClose={() => setModal(null)} />}
      {modal === 'mobile' && <MobileDownloadModal onClose={() => setModal(null)} />}
      {modal === 'help' && <GuideHelpModal onClose={() => setModal(null)} />}
      {modal === 'palette' && <CustomThemePalette onClose={() => setModal(null)} />}
    </div>
  )
}

function SettingsLink({ label, description, onClick }: { label: string; description: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="settings-panel__target border-b px-2 py-3 text-left transition-colors hover:bg-[var(--surface-control-hover)]" style={{ borderColor: 'var(--border-default)' }}>
      <span className="block text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
      <span className="mt-1 block text-[10px]" style={{ color: 'var(--text-muted)' }}>{description}</span>
    </button>
  )
}

function DistributionGroup({
  id,
  label,
  description,
  expanded,
  onToggle,
  children,
}: {
  id: string
  label: string
  description: string
  expanded: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-panel)] border" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}>
      <button type="button" aria-expanded={expanded} aria-controls={id} onClick={onToggle}
        className="settings-panel__target flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--surface-control-hover)]">
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
          <span className="mt-1 block text-[10px]" style={{ color: 'var(--text-muted)' }}>{description}</span>
        </span>
        <ChevronDown className={`h-4 w-4 flex-none transition-transform ${expanded ? 'rotate-180' : ''}`} style={{ color: 'var(--text-muted)' }} aria-hidden="true" />
      </button>
      {expanded && (
        <div id={id} className="border-t px-2 pb-2" style={{ borderColor: 'var(--border-default)' }}>
          {children}
        </div>
      )}
    </div>
  )
}

function ClientDocsLink({ className = '' }: { className?: string }) {
  return (
    <a href={CLIENT_DISTRIBUTION_DOCS_URL} target="_blank" rel="noreferrer"
      className={`settings-panel__target flex items-center gap-1 px-2 py-3 text-[11px] hover:bg-[var(--surface-control-hover)] ${className}`}
      style={{ color: 'var(--text-secondary)' }}>
      客户端与连接文档 <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  )
}

function InlineDistributionError({
  children,
  actionLabel,
  onAction,
}: {
  children: ReactNode
  actionLabel?: string
  onAction?: () => void
}) {
  return (
    <div role="alert" className="workbench-status-danger m-2 flex items-start justify-between gap-3 rounded-[var(--radius-control)] border px-3 py-2 text-[11px]">
      <span>{children}</span>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction} className="flex-none underline underline-offset-2">{actionLabel}</button>
      )}
    </div>
  )
}
