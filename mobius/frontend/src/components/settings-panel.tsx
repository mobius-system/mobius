import { useEffect, useRef, useState, type RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ExternalLink, X } from 'lucide-react'
import { useStore } from '../store'
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

type SettingsSection = 'general' | 'context' | 'connections' | 'advanced' | 'admin'

export function SettingsPanel({ onClose, returnFocusRef }: { onClose: () => void; returnFocusRef?: RefObject<HTMLElement | null> }) {
  const navigate = useNavigate()
  const {
    user, theme, setTheme, assistantBubbleEnabled, toggleAssistantBubble, currentProject,
  } = useStore()
  const [section, setSection] = useState<SettingsSection>('general')
  const [modal, setModal] = useState<'password' | 'aimux' | 'desktop' | 'cli' | 'mobile' | 'help' | 'palette' | null>(null)
  const [mobileContentOpen, setMobileContentOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const mobileBackRef = useRef<HTMLButtonElement | null>(null)
  const mobileNavRef = useRef<HTMLElement | null>(null)
  const initialFocusRef = useRef<HTMLElement | null>(null)
  const userId = user?.id || ''

  useEffect(() => {
    initialFocusRef.current = returnFocusRef?.current
      || (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      const target = returnFocusRef?.current || initialFocusRef.current
      window.requestAnimationFrame(() => target?.focus())
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (modal) return
      if (event.key === 'Escape') {
        event.preventDefault()
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
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [modal, onClose])

  const go = (path: string, advanced = false) => {
    if (advanced) logUiEvent('advanced_opened', { path })
    onClose()
    navigate(path)
  }

  const navItems: Array<{ key: SettingsSection; label: string; admin?: boolean }> = [
    { key: 'general', label: '通用 / 外观' },
    { key: 'context', label: '项目与上下文' },
    { key: 'connections', label: '连接与客户端' },
    { key: 'advanced', label: '高级' },
    ...(user?.role === 'admin' ? [{ key: 'admin' as const, label: '管理员', admin: true }] : []),
  ]

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3">
      <button type="button" aria-label="关闭设置" className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" onClick={onClose} />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="设置"
        className="relative flex h-[min(640px,calc(100vh-24px))] w-[min(960px,calc(100vw-24px))] overflow-hidden rounded-lg border shadow-lg"
        style={{ background: 'var(--modal-bg)', borderColor: 'var(--border-color)' }}>
        <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="关闭设置" title="关闭设置"
          className="absolute right-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-muted)' }}>
          <X className="h-4 w-4" />
        </button>

        <div className={`${mobileContentOpen ? 'hidden' : 'flex'} min-w-0 flex-1 flex-col p-3 sm:hidden`} style={{ background: 'var(--bg-primary)' }}>
          <div className="mb-3 px-2 pr-10 text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>设置</div>
          <nav ref={mobileNavRef} className="space-y-1" aria-label="设置分类">
            {navItems.map(item => (
              <button key={item.key} type="button" onClick={() => {
                setSection(item.key)
                setMobileContentOpen(true)
                window.requestAnimationFrame(() => mobileBackRef.current?.focus())
              }}
                className="flex h-10 w-full items-center justify-between rounded-md px-3 text-left text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
                style={{ color: 'var(--text-secondary)' }}>
                {item.label}<span aria-hidden="true">›</span>
              </button>
            ))}
          </nav>
          <div className="mt-auto border-t pt-3" style={{ borderColor: 'var(--border-color)' }}>
            <button type="button" onClick={() => setModal('help')} className="h-8 w-full rounded-md px-3 text-left text-[11px] hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-muted)' }}>帮助与使用指南</button>
            <a href="https://github.com/mobius-system/mobius.git" target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1 rounded-md px-3 text-[11px] hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-muted)' }}>GitHub <ExternalLink className="h-3 w-3" /></a>
          </div>
        </div>

        <nav className="hidden w-40 flex-shrink-0 flex-col border-r p-3 sm:flex" style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)' }} aria-label="设置分类">
          <div className="mb-3 px-2 text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>设置</div>
          <div className="space-y-1">
            {navItems.map(item => (
              <button key={item.key} type="button" onClick={() => setSection(item.key)} aria-current={section === item.key ? 'page' : undefined}
                className="h-8 w-full rounded-md px-3 text-left text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
                style={{ color: section === item.key ? 'var(--accent-primary)' : 'var(--text-secondary)', background: section === item.key ? 'var(--bg-active)' : undefined }}>
                {item.label}
              </button>
            ))}
          </div>
          <div className="mt-auto border-t pt-3" style={{ borderColor: 'var(--border-color)' }}>
            <button type="button" onClick={() => setModal('help')} className="h-8 w-full rounded-md px-3 text-left text-[11px] hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-muted)' }}>帮助与使用指南</button>
            <a href="https://github.com/mobius-system/mobius.git" target="_blank" rel="noreferrer" className="flex h-8 items-center gap-1 rounded-md px-3 text-[11px] hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-muted)' }}>GitHub <ExternalLink className="h-3 w-3" /></a>
          </div>
        </nav>

        <div className={`${mobileContentOpen ? 'block' : 'hidden'} min-w-0 flex-1 overflow-y-auto p-4 pt-14 sm:block sm:p-5 sm:pr-14`}>
          <button ref={mobileBackRef} type="button" onClick={() => {
            setMobileContentOpen(false)
            window.requestAnimationFrame(() => mobileNavRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
          }}
            className="mb-4 inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] hover:bg-[var(--bg-hover)] sm:hidden"
            style={{ color: 'var(--text-secondary)' }}>
            <ChevronLeft className="h-4 w-4" /> 设置分类
          </button>

          {section === 'general' && (
            <section>
              <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>通用 / 外观</h2>
              <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>默认工作台只保留浅色和深色。</p>
              <div className="mt-5 grid max-w-sm grid-cols-2 gap-2">
                {(['light', 'dark'] as const).map(value => (
                  <button key={value} type="button" onClick={() => setTheme(value)}
                    className="h-8 rounded-md border text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
                    style={{ borderColor: theme === value ? 'var(--accent-primary)' : 'var(--border-color)', color: theme === value ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>
                    {value === 'light' ? '浅色' : '深色'}
                  </button>
                ))}
              </div>
              <div className="mt-6 max-w-xl border-t pt-4" style={{ borderColor: 'var(--border-color)' }}>
                <button type="button" onClick={toggleAssistantBubble} className="flex w-full items-center justify-between rounded-md px-2 py-2.5 text-left hover:bg-[var(--bg-hover)]">
                  <span>
                    <span className="block text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>快捷助手</span>
                    <span className="mt-0.5 block text-[10px]" style={{ color: 'var(--text-muted)' }}>这是全局快捷入口，不是当前项目会话；新用户默认关闭。</span>
                  </span>
                  <span className="text-[11px]" style={{ color: assistantBubbleEnabled ? 'var(--accent-primary)' : 'var(--text-muted)' }}>{assistantBubbleEnabled ? '已开启' : '已关闭'}</span>
                </button>
                <button type="button" onClick={() => setModal('password')} className="mt-2 h-8 rounded-md border px-3 text-[12px] hover:bg-[var(--bg-hover)]" style={{ borderColor: 'var(--border-color)', color: 'var(--text-secondary)' }}>修改密码</button>
              </div>
            </section>
          )}

          {section === 'context' && (
            <section>
              <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>项目与上下文</h2>
              <div className="mt-5 grid max-w-xl">
                <SettingsLink label="全部项目" description="打开完整项目列表、筛选与项目卡片" onClick={() => go(`/u/${userId}?view=projects`)} />
                {currentProject?.id && <SettingsLink label="当前项目设置" description={currentProject.name} onClick={() => go(`/u/${userId}/p/${currentProject.id}`)} />}
                <SettingsLink label="Memory 管理" description="打开原有个人 Memory 管理" onClick={() => go(`/u/${userId}?view=projects&panel=memory`)} />
                <SettingsLink label="Skills 管理" description="打开原有个人 Skills 管理" onClick={() => go(`/u/${userId}?view=projects&panel=skills`)} />
              </div>
            </section>
          )}

          {section === 'connections' && (
            <section>
              <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>连接与客户端</h2>
              <div className="mt-5 grid max-w-xl">
                <SettingsLink label="AIMUX" description="连接与设备指引" onClick={() => setModal('aimux')} />
                <SettingsLink label="桌面客户端" description="下载桌面版本" onClick={() => setModal('desktop')} />
                <SettingsLink label="CLI" description="安装命令行客户端" onClick={() => setModal('cli')} />
                <SettingsLink label="移动端" description="下载移动客户端" onClick={() => setModal('mobile')} />
              </div>
            </section>
          )}

          {section === 'advanced' && (
            <section>
              <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>高级</h2>
              <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>高级页面和旧路由继续保留，但不占用默认工作台。</p>
              <div className="mt-5 grid max-w-xl">
                {currentProject?.id && <SettingsLink label="使用旧版项目视图" description={`打开「${currentProject.name}」的项目详情与高级管理`} onClick={() => go(`/u/${userId}/p/${currentProject.id}`, true)} />}
                <SettingsLink label="系统可视化" description="打开会话集群视图" onClick={() => go(`/u/${userId}/mobius_overview_cluster`, true)} />
                <SettingsLink label="旧项目总览" description="保留的系统总览路由" onClick={() => go(`/u/${userId}/mobius_overview`, true)} />
                <SettingsLink label="连接 / 导入向导" description="打开 Welcome 的本地连接与导入流程" onClick={() => go('/welcome', true)} />
                <SettingsLink label="主题工坊" description="高级外观编辑" onClick={() => { logUiEvent('advanced_opened', { target: 'theme_palette' }); setModal('palette') }} />
              </div>
            </section>
          )}

          {section === 'admin' && user?.role === 'admin' && (
            <section>
              <h2 className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>管理员</h2>
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
    <button type="button" onClick={onClick} className="border-b px-2 py-3 text-left transition-colors hover:bg-[var(--bg-hover)]" style={{ borderColor: 'var(--border-color)' }}>
      <span className="block text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
      <span className="mt-1 block text-[10px]" style={{ color: 'var(--text-muted)' }}>{description}</span>
    </button>
  )
}
