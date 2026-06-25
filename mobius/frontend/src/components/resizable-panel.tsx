import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { useStore } from '../store'

// 移动端默认断点 (px). 窗口 ≤ 此值即进入「最小移动端」(汉堡菜单 + 抽屉侧栏 +
// 顶栏次要按钮隐藏). 内容密集的页面 (如 ProjectPage) 可通过 useMobileNavBreakpoint(1024)
// 进一步调大, 让平板宽度也进入抽屉/堆叠态.
const DEFAULT_MOBILE_BREAKPOINT = 900

// 读取当前视口是否进入移动端. 断点来自全局 store (mobileNavBreakpoint),
// 这样 TopNav 汉堡按钮的显隐与 ResizablePanel 抽屉态永远用同一个值, 不会错位.
export function useIsMobile() {
  const breakpoint = useStore(s => s.mobileNavBreakpoint)
  const [mobile, setMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(`(max-width: ${breakpoint}px)`).matches
  })
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches)
    // 断点变化 (切换页面) 时立即重算一次, 避免状态停留在旧断点的结果.
    setMobile(mql.matches)
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    // 旧版 Safari 兜底
    mql.addListener(onChange)
    return () => mql.removeListener(onChange)
  }, [breakpoint])
  return mobile
}

// 页面级断点声明. 内容密集的页面在挂载时调大断点, 卸载时还原默认值,
// 保证切回普通页面后不会残留过大的断点.
export function useMobileNavBreakpoint(px: number) {
  const setBreakpoint = useStore(s => s.setMobileNavBreakpoint)
  useEffect(() => {
    setBreakpoint(px)
    return () => setBreakpoint(DEFAULT_MOBILE_BREAKPOINT)
  }, [px, setBreakpoint])
}

// 通用可拖拽宽度面板. 用法:
//   <ResizablePanel storageKey="..." defaultWidth={288} minWidth={200} maxWidth={480} side="left">
//     ...内容...
//   </ResizablePanel>
//
// 行为:
// - 桌面端: 初始宽度从 localStorage 读取 (clamp 到 [min,max]); 否则用 defaultWidth
//   side='left' 时拖拽手柄贴右边, side='right' 时贴左边; mousedown 拖拽, 双击 reset
// - 移动端 (side='left'): 不再占位, 改成从左侧滑入的「抽屉」, 由 TopNav 汉堡按钮触发
//   (store.mobileNavOpen); 点遮罩 / 关闭按钮 / 路由切换都会收起. 主内容因此拿到整屏宽度.
type Side = 'left' | 'right'

type ResizablePanelProps = {
  storageKey: string
  defaultWidth: number
  minWidth: number
  maxWidth: number
  side?: Side
  className?: string
  style?: CSSProperties
  'data-tour'?: string
  children: ReactNode
}

function clampWidth(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

function readStoredWidth(storageKey: string, fallback: number, min: number, max: number) {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return fallback
    const parsed = Number(raw)
    return clampWidth(parsed, min, max)
  } catch (_) {
    return fallback
  }
}

export function ResizablePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  side = 'left',
  className,
  style,
  'data-tour': dataTour,
  children,
}: ResizablePanelProps) {
  const [width, setWidth] = useState<number>(() => readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth))
  const isMobile = useIsMobile()
  const mobileNavOpen = useStore(s => s.mobileNavOpen)
  const setMobileNavOpen = useStore(s => s.setMobileNavOpen)
  const dragStateRef = useRef<{
    startX: number
    startWidth: number
    raf: number | null
    lastPersist: number
    pendingPersist: number | null
  } | null>(null)

  // storageKey 变化时重新读取 (例如切换页面但仍想保留各自的偏好)
  useEffect(() => {
    setWidth(readStoredWidth(storageKey, defaultWidth, minWidth, maxWidth))
    // 故意不把 defaultWidth/min/max 放进 deps, 避免父组件每次 render 都 reset
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  // 路由变化 (例如在抽屉里点了一个项目) 时自动收起抽屉.
  const location = useLocation()
  useEffect(() => {
    setMobileNavOpen(false)
  }, [location.pathname, setMobileNavOpen])

  // Esc 键收起抽屉
  useEffect(() => {
    if (!mobileNavOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileNavOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mobileNavOpen, setMobileNavOpen])

  const persistWidth = useCallback((next: number) => {
    try {
      localStorage.setItem(storageKey, String(next))
    } catch (_) {
      /* localStorage 可能不可用 (隐私模式 / 配额满) — 静默忽略 */
    }
  }, [storageKey])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const drag = dragStateRef.current
    if (!drag) return
    e.preventDefault()
    const delta = e.clientX - drag.startX
    // side='left': 拖向右 (delta>0) 增宽; side='right': 拖向左 (delta<0) 增宽
    const candidate = side === 'left' ? drag.startWidth + delta : drag.startWidth - delta
    const next = clampWidth(candidate, minWidth, maxWidth)
    if (drag.raf !== null) cancelAnimationFrame(drag.raf)
    drag.raf = requestAnimationFrame(() => {
      setWidth(next)
      const now = Date.now()
      if (now - drag.lastPersist > 100) {
        persistWidth(next)
        drag.lastPersist = now
      } else if (drag.pendingPersist === null) {
        drag.pendingPersist = window.setTimeout(() => {
          persistWidth(next)
          if (dragStateRef.current) dragStateRef.current.pendingPersist = null
        }, 150) as unknown as number
      }
    })
  }, [minWidth, maxWidth, side, persistWidth])

  const handleMouseUp = useCallback(() => {
    const drag = dragStateRef.current
    if (!drag) return
    if (drag.raf !== null) cancelAnimationFrame(drag.raf)
    if (drag.pendingPersist !== null) {
      clearTimeout(drag.pendingPersist)
      // 收尾再 persist 一次, 保证最后的宽度落地
      setWidth((w) => { persistWidth(w); return w })
    }
    dragStateRef.current = null
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', handleMouseUp)
    document.body.classList.remove('mobius-resizing')
  }, [handleMouseMove, persistWidth])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragStateRef.current = {
      startX: e.clientX,
      startWidth: width,
      raf: null,
      lastPersist: 0,
      pendingPersist: null,
    }
    document.body.classList.add('mobius-resizing')
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [width, handleMouseMove, handleMouseUp])

  const handleDoubleClick = useCallback(() => {
    setWidth(defaultWidth)
    persistWidth(defaultWidth)
  }, [defaultWidth, persistWidth])

  // 卸载时清理 (避免拖到一半组件被卸载残留监听器)
  useEffect(() => {
    return () => {
      if (dragStateRef.current) {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.classList.remove('mobius-resizing')
      }
    }
  }, [handleMouseMove, handleMouseUp])

  // ===== 移动端 + 左侧栏: 渲染成从左滑入的抽屉 (portal 到 body, 避免被父级 overflow/transform 裁切) =====
  if (isMobile && side === 'left') {
    const drawer = (
      <>
        {mobileNavOpen && (
          <div
            className="mobius-drawer-backdrop"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
        )}
        <aside
          data-tour={dataTour}
          className={[
            'mobius-resizable',
            'mobius-drawer',
            mobileNavOpen ? 'mobius-drawer--open' : '',
            className || '',
          ].filter(Boolean).join(' ')}
          style={{ width: 'min(340px, 86vw)', ...style }}
          aria-hidden={!mobileNavOpen}
        >
          <button
            type="button"
            className="mobius-drawer-close"
            onClick={() => setMobileNavOpen(false)}
            aria-label="关闭侧栏"
            title="关闭"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          {children}
        </aside>
      </>
    )
    return createPortal(drawer, document.body)
  }

  // ===== 桌面端 / 右侧栏: 原本的可拖拽固定宽度面板 =====
  const handleStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    [side === 'left' ? 'right' : 'left']: -2,
    width: 4,
    cursor: 'col-resize',
    zIndex: 10,
    transition: 'background-color .15s ease',
  }
  const handleClass = 'mobius-resizable-handle'
  return (
    <aside
      data-tour={dataTour}
      className={['mobius-resizable', className || ''].filter(Boolean).join(' ')}
      style={{
        width,
        minWidth,
        maxWidth,
        flexShrink: 0,
        position: 'relative',
        ...style,
      }}
    >
      {children}
      <div
        className={handleClass}
        style={handleStyle}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        title="拖拽调整宽度 · 双击恢复默认"
      />
    </aside>
  )
}
