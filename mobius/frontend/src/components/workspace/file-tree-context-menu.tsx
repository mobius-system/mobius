// FileTreeContextMenu — 文件树右键菜单浮层。
// 职责 (设计文档 §11.2): 定位 + 越界翻转、可见项/禁用态/Tooltip、键盘导航与焦点恢复、
// 点击外部/滚动/resize/Esc 关闭。不直接调 REST/IPC, 不保存剪贴板, 不刷新目录。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type ContextMenuItem =
  | { type: 'separator' }
  | {
      type: 'item'
      key: string
      label: string
      icon?: ReactNode
      onRun: () => void
      disabled?: boolean
      disabledReason?: string
    }

type Props = {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

function firstEnabledIndex(items: ContextMenuItem[]): number {
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.type === 'item' && !it.disabled) return i
  }
  return -1
}

function lastEnabledIndex(items: ContextMenuItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.type === 'item' && !it.disabled) return i
  }
  return -1
}

export function FileTreeContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [activeIndex, setActiveIndex] = useState(() => firstEnabledIndex(items))
  // 打开前的焦点元素; 关闭后归还 (设计文档 §16)。
  const triggerRef = useRef<HTMLElement | null>(null)

  // 定位 + 越界翻转 (向左/向上)。
  useLayoutEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = x
    let top = y
    if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8)
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    if (left < 8) left = 8
    if (top < 8) top = 8
    setPos({ left, top })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y])

  // 聚焦菜单容器; 监听点击外部/滚动/resize 关闭。
  useEffect(() => {
    setActiveIndex(firstEnabledIndex(items))
    const t = window.setTimeout(() => {
      const el = menuRef.current
      if (el) el.focus()
    }, 0)
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const onScroll = () => onClose()
    const onResize = () => onClose()
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 卸载 (关闭) 时归还焦点给打开者。
  useEffect(() => {
    return () => {
      try {
        triggerRef.current?.focus()
      } catch {
        /* 节点可能已卸载 */
      }
    }
  }, [])

  const runItem = (i: number) => {
    const it = items[i]
    if (!it || it.type !== 'item' || it.disabled) return
    onClose()
    it.onRun()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex(cur => {
          for (let k = 1; k <= items.length; k++) {
            const cand = (cur + k) % items.length
            const it = items[cand]
            if (it.type === 'item' && !it.disabled) return cand
          }
          return cur
        })
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex(cur => {
          for (let k = 1; k <= items.length; k++) {
            const cand = ((cur - k) % items.length + items.length) % items.length
            const it = items[cand]
            if (it.type === 'item' && !it.disabled) return cand
          }
          return cur
        })
        break
      case 'Home':
        e.preventDefault()
        setActiveIndex(firstEnabledIndex(items))
        break
      case 'End':
        e.preventDefault()
        setActiveIndex(lastEnabledIndex(items))
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        runItem(activeIndex)
        break
      case 'Escape':
        e.preventDefault()
        onClose()
        break
      case 'Tab':
        // 在菜单内循环, 不让焦点跳出。
        e.preventDefault()
        break
    }
  }

  return (
    <div
      ref={menuRef}
      className="mobius-file-context-menu"
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        left: pos ? pos.left : x,
        top: pos ? pos.top : y,
        zIndex: 60,
      }}
    >
      {items.map((it, i) => {
        if (it.type === 'separator') {
          return <div key={`sep-${i}`} className="mobius-file-context-menu__separator" />
        }
        const disabled = !!it.disabled
        const active = i === activeIndex && !disabled
        return (
          <div
            key={it.key}
            role="menuitem"
            aria-disabled={disabled || undefined}
            title={disabled ? it.disabledReason : undefined}
            className={`mobius-file-context-menu__item${disabled ? ' mobius-file-context-menu__item--disabled' : ''}${active ? ' mobius-file-context-menu__item--active' : ''}`}
            onMouseEnter={() => !disabled && setActiveIndex(i)}
            onClick={() => runItem(i)}
          >
            {it.icon && <span className="mobius-file-context-menu__icon">{it.icon}</span>}
            <span className="mobius-file-context-menu__label">{it.label}</span>
          </div>
        )
      })}
    </div>
  )
}
