import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

type ResizeSide = 'left' | 'right'

type WorkbenchPaneResizeOptions = {
  storageKey: string
  cssVariable: '--rail-width' | '--tool-drawer-width' | '--file-tree-width'
  defaultWidth: number
  minWidth: number
  maxWidth: number
  side: ResizeSide
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
  const dragRef = useRef<{ startX: number; startWidth: number; currentWidth: number } | null>(null)
  const moveRef = useRef<(event: PointerEvent) => void>()
  const upRef = useRef<() => void>()

  useLayoutEffect(() => {
    writeWidth(options.cssVariable, width)
  }, [options.cssVariable, width])

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
    const next = clamp(candidate, options.minWidth, options.maxWidth)
    drag.currentWidth = next
    writeWidth(options.cssVariable, next)
  }, [options.cssVariable, options.maxWidth, options.minWidth, options.side])

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startWidth: width, currentWidth: width }
    moveRef.current = handleMove
    upRef.current = finishDrag
    document.body.classList.add('mobius-resizing')
    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', finishDrag)
    document.addEventListener('pointercancel', finishDrag)
  }, [finishDrag, handleMove, width])

  const reset = useCallback(() => {
    writeWidth(options.cssVariable, options.defaultWidth)
    setWidth(options.defaultWidth)
    persistWidth(options.storageKey, options.defaultWidth)
  }, [options.cssVariable, options.defaultWidth, options.storageKey])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 32 : 16
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = width + (options.side === 'right' ? step : -step)
    if (event.key === 'ArrowRight') next = width + (options.side === 'left' ? step : -step)
    if (event.key === 'Home') next = options.minWidth
    if (event.key === 'End') next = options.maxWidth
    if (next === null) return
    event.preventDefault()
    const clamped = clamp(next, options.minWidth, options.maxWidth)
    writeWidth(options.cssVariable, clamped)
    setWidth(clamped)
    persistWidth(options.storageKey, clamped)
  }, [options.cssVariable, options.maxWidth, options.minWidth, options.side, width])

  useEffect(() => () => {
    if (moveRef.current) document.removeEventListener('pointermove', moveRef.current)
    if (upRef.current) document.removeEventListener('pointerup', upRef.current)
    if (upRef.current) document.removeEventListener('pointercancel', upRef.current)
    if (dragRef.current) document.body.classList.remove('mobius-resizing')
  }, [])

  return { width, handlePointerDown, handleDoubleClick: reset, handleKeyDown }
}
