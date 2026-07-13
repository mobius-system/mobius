// 桌面端自绘窗口控制按钮 (最小化 / 最大化-还原 / 关闭)。
// 仅 Windows/Linux 渲染: 这些平台用 titleBarStyle:hidden 隐藏了原生标题栏,
// 而 titleBarOverlay 的原生按钮符号在本环境 (未签名 exe + 高 DPI) 不渲染 (只剩背景色块), 故前端自绘。
// macOS 用系统交通灯 (titleBarStyle:hiddenInset), 此组件由 shell 的 IS_MAC_PLATFORM 判断不挂载。
// 主题自适应: 图标色 var(--text-primary), hover 用 var(--bg-hover), 关闭键 hover 红 (#e81123)。
import { useEffect, useState } from 'react'
import type { CSSProperties, MouseEvent } from 'react'

type Bridge = {
  isDesktop?: boolean
  syncReload?: () => Promise<unknown>
  windowMinimize?: () => Promise<unknown>
  windowToggleMaximize?: () => Promise<{ maximized?: boolean } | unknown>
  windowClose?: () => Promise<unknown>
  windowIsMaximized?: () => Promise<boolean>
  onMaximizeChange?: (cb: (m: boolean) => void) => (() => void) | undefined
}

function getBridge(): Bridge | undefined {
  return typeof window !== 'undefined' ? (window as { mobiusDesktop?: Bridge }).mobiusDesktop : undefined
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    const md = getBridge()
    if (!md?.windowIsMaximized) return
    md.windowIsMaximized().then((m) => setMaximized(!!m)).catch(() => {})
    const off = md.onMaximizeChange?.((m) => setMaximized(m))
    return () => { off?.() }
  }, [])
  const md = getBridge()
  if (!md?.windowMinimize) return null

  const btnBase: CSSProperties = {
    width: 38,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-primary)',
    transition: 'background 0.12s',
    height: '100%',
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
  }
  const enterHover = (e: MouseEvent<HTMLElement>, bg: string) => { e.currentTarget.style.background = bg }
  const leaveHover = (e: MouseEvent<HTMLElement>) => { e.currentTarget.style.background = 'transparent' }

  return (
    <div className="flex items-stretch flex-shrink-0 no-drag" style={{ height: 48, marginLeft: 4, marginRight: -14 }}>
      <button type="button" title="刷新" aria-label="刷新页面"
        style={btnBase}
        onMouseEnter={(e) => enterHover(e, 'var(--bg-hover)')} onMouseLeave={leaveHover}
        onClick={() => md.syncReload?.().catch(() => {})}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-2.6-6.4" />
          <path d="M21 3v5h-5" />
        </svg>
      </button>
      <button type="button" title="最小化" aria-label="最小化"
        style={btnBase}
        onMouseEnter={(e) => enterHover(e, 'var(--bg-hover)')} onMouseLeave={leaveHover}
        onClick={() => md.windowMinimize?.().catch(() => {})}>
        <svg width="10" height="10" viewBox="0 0 11 11"><rect y="4.6" width="11" height="1.8" fill="currentColor" /></svg>
      </button>
      <button type="button" title={maximized ? '还原' : '最大化'} aria-label={maximized ? '还原' : '最大化'}
        style={btnBase}
        onMouseEnter={(e) => enterHover(e, 'var(--bg-hover)')} onMouseLeave={leaveHover}
        onClick={() => md.windowToggleMaximize?.().then((r) => {
          if (r && typeof r === 'object' && 'maximized' in r) setMaximized(!!(r as { maximized: boolean }).maximized)
        }).catch(() => {})}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 11 11">
            <rect x="1" y="3.2" width="6.4" height="6.4" fill="none" stroke="currentColor" strokeWidth="1" />
            <path d="M3.2 3.2 V1 H9.6 V7.4 H7.4" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 11 11"><rect x="0.7" y="0.7" width="9.6" height="9.6" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
        )}
      </button>
      <button type="button" title="关闭" aria-label="关闭"
        style={btnBase}
        onMouseEnter={(e) => { enterHover(e, '#e81123'); e.currentTarget.style.color = '#fff' }}
        onMouseLeave={(e) => { leaveHover(e); e.currentTarget.style.color = 'var(--text-primary)' }}
        onClick={() => md.windowClose?.().catch(() => {})}>
        <svg width="10" height="10" viewBox="0 0 11 11"><path d="M0.5 0.5 L10.5 10.5 M10.5 0.5 L0.5 10.5" stroke="currentColor" strokeWidth="1.1" /></svg>
      </button>
    </div>
  )
}

// 全屏独立页 (如 /welcome 欢迎向导) 的极简桌面顶栏: 唯一拖拽区 + 自绘窗口按钮。
// 这些页面不走 shell 的 TopNav (拖拽区 + WindowControls 都挂在 TopNav 上), 此处补齐 ——
// 否则 Win/Linux 上窗口拖不动、也没有最小化/关闭按钮 (用户报: 欢迎页没关闭按钮、无法拖动)。
// web 端 / macOS 整体不渲染 (macOS 用系统交通灯 hiddenInset, 顶栏原生区域仍可拖; web 无窗口概念)。
// px-5 对齐 shell TopNav, 让 WindowControls 的 marginRight:-14 把关闭键贴到距右边缘 ~6px (与主界面一致)。
export function DesktopTitleBar() {
  const md = getBridge()
  const isDesktop = !!md?.isDesktop
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
  if (!isDesktop || isMac) return null
  return (
    <div className="fixed left-0 right-0 top-0 z-50 flex h-12 items-stretch px-5">
      {/* 唯一拖拽区: 独立空白 spacer, 无交互子元素 → drag 区不会吞按钮点击 (与 shell TopNav 同策略) */}
      <div className="mobius-desktop-drag flex-1 self-stretch" aria-hidden="true" />
      <WindowControls />
    </div>
  )
}
