import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

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
      data-block-key={blockKey}
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
  scrollToKey,
  scrollOffset = 0,
  onScrollToKeyDone,
}: {
  blocks: TBlock[]
  renderBlock: (block: TBlock) => ReactNode
  minBlocks?: number
  overscanPx?: number
  estimatedHeight?: number
  // 跳转到指定 block (按 block.key 匹配). 设置后, 列表滚动让该 block 顶部贴在
  // scrollOffset (通常是 sticky header 高度) 之下; 到位后调 onScrollToKeyDone 清除.
  scrollToKey?: string | null
  scrollOffset?: number
  onScrollToKeyDone?: () => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  // scrollToKey 的滚动用 root: 两条渲染路径 (虚拟/非虚拟) 都挂这个 ref, 使跳转逻辑统一.
  // 注意: 这与 rootRef 不同 -- rootRef 只在虚拟路径挂, 让滚动监听 effect 在非虚拟路径因
  // rootRef.current===null 而 bail, 避免非虚拟路径每次滚动都 setScrollState 重渲染.
  const scrollRootRef = useRef<HTMLDivElement | null>(null)
  const heightsRef = useRef<Map<string, number>>(new Map())
  const [scrollState, setScrollState] = useState({ top: 0, height: 800 })
  const [heightVersion, setHeightVersion] = useState(0)
  // onScrollToKeyDone 存进 ref, 避免 scrollToKey effect 把它列入依赖导致每次渲染重跑.
  const onScrollToKeyDoneRef = useRef(onScrollToKeyDone)
  onScrollToKeyDoneRef.current = onScrollToKeyDone

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

  // 虚拟路径的根节点同时挂 rootRef (滚动监听用) 和 scrollRootRef (跳转查询用).
  const setRootRef = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el
    scrollRootRef.current = el
  }, [])

  // 内容尺寸版本: 卡片 (代码块/差异/图片) 异步渲染会持续改变内容高度, 单次滚动会落点过时.
  // 用 ResizeObserver 盯 scrollRoot, 高度一变就 bump contentVersion, 驱动跳转 effect 重滚,
  // 把目标 block 重新钉到 sticky header 下方, 直到内容稳定. (非虚拟路径没有 MeasuredVirtualBlock,
  // heightVersion 不会 bump, 必须靠这个 contentVersion 才能在非虚拟路径自校正.)
  const [contentVersion, setContentVersion] = useState(0)
  useEffect(() => {
    const root = scrollRootRef.current
    if (!root) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setContentVersion(v => v + 1))
    })
    ro.observe(root)
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf) }
  }, [])

  // 跳转到 scrollToKey 指定的 block. 内容仍在渲染时 block 位置会漂移, 因此每次 contentVersion/
  // heightVersion 变化都重滚一次 (instant), 把 block 顶部钉到 scrollOffset (sticky header 高度) 之下.
  // 虚拟化下目标可能尚未渲染: 先用 layout 估算位置滚过去让它进视口, 下一轮重滚即可走 DOM 精确分支.
  useEffect(() => {
    if (!scrollToKey) return
    const root = scrollRootRef.current
    if (!root) return
    const scrollParent = findScrollParent(root)
    if (!scrollParent) return
    const sel = `[data-block-key="${scrollToKey.replace(/["\\]/g, '\\$&')}"]`
    const node = root.querySelector<HTMLElement>(sel)
    const parentTop = scrollParent.getBoundingClientRect().top
    const headerOffset = scrollOffset ?? 0
    let desired: number
    if (node) {
      desired = node.getBoundingClientRect().top - parentTop + scrollParent.scrollTop - headerOffset
    } else {
      const index = blocks.findIndex(b => b.key === scrollToKey)
      if (index < 0) { onScrollToKeyDoneRef.current?.(); return }
      desired = root.getBoundingClientRect().top - parentTop + scrollParent.scrollTop + (layout.starts[index] ?? 0) - headerOffset
    }
    desired = Math.max(0, desired)
    if (Math.abs(scrollParent.scrollTop - desired) > 2) {
      scrollParent.scrollTo({ top: desired, behavior: 'auto' })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToKey, contentVersion, heightVersion, scrollOffset, blocks, layout])

  // 内容稳定 800ms 后视为到位, 清掉 scrollToKey 停止自校正. 每次 contentVersion/heightVersion 变都重置计时.
  useEffect(() => {
    if (!scrollToKey) return
    const tm = setTimeout(() => { onScrollToKeyDoneRef.current?.() }, 800)
    return () => clearTimeout(tm)
  }, [scrollToKey, contentVersion, heightVersion])

  // 兜底硬上限: 无论内容是否稳定, 3s 后强制结束 (防活流式会话无限追位).
  useEffect(() => {
    if (!scrollToKey) return
    const tm = setTimeout(() => { onScrollToKeyDoneRef.current?.() }, 3000)
    return () => clearTimeout(tm)
  }, [scrollToKey])

  if (blocks.length <= minBlocks) {
    // 兜底 (非虚拟化) 路径: 每个 block 包一层带 data-block-key 的 div, 供 scrollToKey 查询.
    return (
      <div ref={scrollRootRef}>
        {blocks.map(b => (
          <div key={b.key} data-block-key={b.key}>
            {renderBlock(b)}
          </div>
        ))}
      </div>
    )
  }

  const visibleBlocks = blocks.slice(visibleRange.start, visibleRange.end)
  return (
    <div ref={setRootRef} className="relative" style={{ height: `${layout.total}px` }}>
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
