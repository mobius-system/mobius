import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

type ResizeSide = 'left' | 'right'

type WorkbenchPaneResizeOptions = {
  storageKey: string
  cssVariable: '--rail-width' | '--tool-drawer-width' | '--file-tree-width'
  defaultWidth: number
  minWidth: number
  maxWidth: number
  side: ResizeSide
  /** 动态上限 (如右栏最宽不超过中栏)。缺省回退静态 maxWidth。 */
  getMaxWidth?: () => number
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)))
}

function readWidth(options: WorkbenchPaneResizeOptions) {
  try {
    const raw = window.localStorage.getItem(options.storageKey)
    const parsed = raw === null ? options.defaultWidth : Number(raw)
    return Number.isFinite(parsed) ? clamp(parsed, options.minWidth, options.maxWidth) : options.defaultWidth
  } catch {
    return options.defaultWidth
  }
}

function shellElement() {
  return document.querySelector<HTMLElement>('[data-workbench-shell]')
}

function writeWidth(cssVariable: WorkbenchPaneResizeOptions['cssVariable'], width: number) {
  shellElement()?.style.setProperty(cssVariable, `${width}px`)
}

function persistWidth(storageKey: string, width: number) {
  try { window.localStorage.setItem(storageKey, String(width)) } catch { /* optional preference */ }
}

/** Workbench shell 分栏宽度控制。拖动期间只写 CSS 变量，避免重渲染重型会话内容。 */
export function useWorkbenchPaneResize(options: WorkbenchPaneResizeOptions) {
  const [width, setWidth] = useState(() => readWidth(options))
  const [maxWidth, setMaxWidth] = useState(() => options.maxWidth)
  const dragRef = useRef<{ startX: number; startWidth: number; currentWidth: number } | null>(null)
  const lastPressRef = useRef<{ x: number; time: number } | null>(null)
  const moveRef = useRef<(event: PointerEvent) => void>()
  const upRef = useRef<() => void>()

  // 动态上限: 视口/工作区尺寸变化时收紧 (不放宽已收窄的持久值, 需要时重新拖拽即可)。
  const resolveMaxWidth = useCallback(() => {
    const measured = options.getMaxWidth?.()
    if (measured === undefined || !Number.isFinite(measured)) return options.maxWidth
    return Math.max(options.minWidth, Math.floor(measured))
  }, [options.getMaxWidth, options.maxWidth, options.minWidth])

  useLayoutEffect(() => {
    writeWidth(options.cssVariable, width)
  }, [options.cssVariable, width])

  useLayoutEffect(() => {
    const sync = () => {
      const next = resolveMaxWidth()
      setMaxWidth(previous => previous === next ? previous : next)
      setWidth(previous => previous > next ? next : previous)
    }
    sync()
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [resolveMaxWidth])

  const finishDrag = useCallback(() => {
    const drag = dragRef.current
    if (!drag) return
    const finalWidth = drag.currentWidth
    dragRef.current = null
    if (moveRef.current) document.removeEventListener('pointermove', moveRef.current)
    if (upRef.current) document.removeEventListener('pointerup', upRef.current)
    if (upRef.current) document.removeEventListener('pointercancel', upRef.current)
    document.body.classList.remove('mobius-resizing')
    setWidth(finalWidth)
    persistWidth(options.storageKey, finalWidth)
  }, [options.storageKey])

  const handleMove = useCallback((event: PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    event.preventDefault()
    const delta = event.clientX - drag.startX
    const candidate = options.side === 'left'
      ? drag.startWidth + delta
      : drag.startWidth - delta
    const next = clamp(candidate, options.minWidth, resolveMaxWidth())
    drag.currentWidth = next
    writeWidth(options.cssVariable, next)
  }, [options.cssVariable, options.minWidth, options.side, resolveMaxWidth])

  const reset = useCallback(() => {
    writeWidth(options.cssVariable, options.defaultWidth)
    setWidth(options.defaultWidth)
    persistWidth(options.storageKey, options.defaultWidth)
  }, [options.cssVariable, options.defaultWidth, options.storageKey])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    // pointerdown 上 preventDefault 会吞掉兼容鼠标事件, onDoubleClick 不可靠;
    // 这里按"两次按下间隔<400ms 且位置几乎不变"自行判定双击 → 恢复默认宽度。
    const last = lastPressRef.current
    lastPressRef.current = { x: event.clientX, time: event.timeStamp }
    if (last && event.timeStamp - last.time < 400 && Math.abs(event.clientX - last.x) < 6) {
      lastPressRef.current = null
      reset()
      return
    }
    dragRef.current = { startX: event.clientX, startWidth: width, currentWidth: width }
    moveRef.current = handleMove
    upRef.current = finishDrag
    document.body.classList.add('mobius-resizing')
    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', finishDrag)
    document.addEventListener('pointercancel', finishDrag)
  }, [finishDrag, handleMove, reset, width])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 32 : 16
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = width + (options.side === 'right' ? step : -step)
    if (event.key === 'ArrowRight') next = width + (options.side === 'left' ? step : -step)
    if (event.key === 'Home') next = options.minWidth
    if (event.key === 'End') next = resolveMaxWidth()
    if (next === null) return
    event.preventDefault()
    const clamped = clamp(next, options.minWidth, resolveMaxWidth())
    writeWidth(options.cssVariable, clamped)
    setWidth(clamped)
    persistWidth(options.storageKey, clamped)
  }, [options.cssVariable, options.minWidth, options.side, resolveMaxWidth, width])

  useEffect(() => () => {
    if (moveRef.current) document.removeEventListener('pointermove', moveRef.current)
    if (upRef.current) document.removeEventListener('pointerup', upRef.current)
    if (upRef.current) document.removeEventListener('pointercancel', upRef.current)
    if (dragRef.current) document.body.classList.remove('mobius-resizing')
  }, [])

  return { width, maxWidth, handlePointerDown, handleDoubleClick: reset, handleKeyDown }
}
