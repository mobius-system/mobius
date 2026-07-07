import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export type VirtualListBlock = { key: string }

const DEFAULT_MIN_BLOCKS = 80
const DEFAULT_OVERSCAN_PX = 900
const DEFAULT_ESTIMATED_HEIGHT = 42

function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  let cur = node?.parentElement || null
  while (cur && cur !== document.body && cur !== document.documentElement) {
    const style = window.getComputedStyle(cur)
    const overflowY = style.overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return cur
    cur = cur.parentElement
  }
  return document.scrollingElement as HTMLElement | null
}

function scrollRelativeTop(root: HTMLElement, scrollParent: HTMLElement): number {
  const rootRect = root.getBoundingClientRect()
  const parentRect = scrollParent.getBoundingClientRect()
  const rootTopInScroll = rootRect.top - parentRect.top + scrollParent.scrollTop
  return Math.max(0, scrollParent.scrollTop - rootTopInScroll)
}

function MeasuredVirtualBlock({
  blockKey,
  top,
  onSize,
  children,
}: {
  blockKey: string
  top: number
  onSize: (key: string, height: number) => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => {
      const height = node.getBoundingClientRect().height
      if (height > 0) onSize(blockKey, height)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [blockKey, onSize])

  return (
    <div
      ref={ref}
      className="absolute left-0 right-0"
      style={{ transform: `translateY(${top}px)` }}
    >
      {children}
    </div>
  )
}

export function VirtualizedBlockList<TBlock extends VirtualListBlock>({
  blocks,
  renderBlock,
  minBlocks = DEFAULT_MIN_BLOCKS,
  overscanPx = DEFAULT_OVERSCAN_PX,
  estimatedHeight = DEFAULT_ESTIMATED_HEIGHT,
}: {
  blocks: TBlock[]
  renderBlock: (block: TBlock) => ReactNode
  minBlocks?: number
  overscanPx?: number
  estimatedHeight?: number
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const heightsRef = useRef<Map<string, number>>(new Map())
  const [scrollState, setScrollState] = useState({ top: 0, height: 800 })
  const [heightVersion, setHeightVersion] = useState(0)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const scrollParent = findScrollParent(root)
    if (!scrollParent) return
    let raf = 0
    const update = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        setScrollState({
          top: scrollRelativeTop(root, scrollParent),
          height: scrollParent.clientHeight || 800,
        })
      })
    }
    update()
    scrollParent.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      scrollParent.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [blocks.length])

  const onSize = useCallback((key: string, height: number) => {
    const rounded = Math.ceil(height)
    if (!Number.isFinite(rounded) || rounded <= 0) return
    const prev = heightsRef.current.get(key)
    if (prev === rounded) return
    heightsRef.current.set(key, rounded)
    setHeightVersion(v => v + 1)
  }, [])

  const layout = useMemo(() => {
    let total = 0
    const starts: number[] = []
    const heights: number[] = []
    for (const block of blocks) {
      starts.push(total)
      const height = heightsRef.current.get(block.key) || estimatedHeight
      heights.push(height)
      total += height
    }
    return { starts, heights, total }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, estimatedHeight, heightVersion])

  const visibleRange = useMemo(() => {
    if (blocks.length <= minBlocks) return { start: 0, end: blocks.length }
    const from = Math.max(0, scrollState.top - overscanPx)
    const to = scrollState.top + scrollState.height + overscanPx
    let start = 0
    while (start < blocks.length && layout.starts[start] + layout.heights[start] < from) start++
    let end = start
    while (end < blocks.length && layout.starts[end] < to) end++
    return {
      start: Math.max(0, start - 3),
      end: Math.min(blocks.length, end + 3),
    }
  }, [blocks.length, layout, minBlocks, overscanPx, scrollState.height, scrollState.top])

  if (blocks.length <= minBlocks) {
    // 兜底 (非虚拟化) 路径: block 自带 key 字段, 这里补上 React key, 避免列表子元素缺 key 告警.
    // (虚拟化路径用 <MeasuredVirtualBlock key={block.key}> 包裹, 已有 key, 无此问题.)
    return <>{blocks.map(b => <Fragment key={b.key}>{renderBlock(b)}</Fragment>)}</>
  }

  const visibleBlocks = blocks.slice(visibleRange.start, visibleRange.end)
  return (
    <div ref={rootRef} className="relative" style={{ height: `${layout.total}px` }}>
      {visibleBlocks.map((block, idx) => {
        const absoluteIndex = visibleRange.start + idx
        return (
          <MeasuredVirtualBlock
            key={block.key}
            blockKey={block.key}
            top={layout.starts[absoluteIndex] || 0}
            onSize={onSize}
          >
            {renderBlock(block)}
          </MeasuredVirtualBlock>
        )
      })}
    </div>
  )
}
