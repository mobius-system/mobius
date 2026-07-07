import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { MoreHorizontal } from 'lucide-react'
import { ProjectTabButton } from './ProjectTabs'

export type OverflowTab = {
  key: string
  label: ReactNode
  active?: boolean
  disabled?: boolean
  title?: string
  dataTour?: string
}

type Props = {
  tabs: OverflowTab[]
  onSelect: (key: string) => void
  className?: string
  style?: CSSProperties
}

// 两个元素之间的间距 (Tailwind gap-1 = 0.25rem = 4px).
const GAP = 4

/**
 * 横向 Tab 条, 空间不足时把溢出的 tab 收进右侧「⋯」下拉菜单, 而不是换行.
 *
 * 做法 (成熟前端常用模式):
 *  - 用一个不可见的「测量层」渲染所有 tab 的副本 + ⋯ 按钮, 读 offsetWidth 拿到每个 tab 的真实自然宽度
 *    (display:none 会把 offsetWidth 归零, 所以必须用独立测量层而非隐藏真实 tab).
 *  - ResizeObserver 监听可用宽度变化 (窗口缩放 / 兄弟元素增减), 实时重算「哪几个 tab 放得下」.
 *  - 放不下时, 从左到右贪心放进可视区, 剩余进 ⋯ 菜单; 当前激活 tab 始终强制留在可视区 (必要时挤掉末尾的 tab).
 *  - ⋯ 菜单: 点外部 / Esc / 选中某项 自动关闭.
 *
 * 仅用于 ProjectSettingsPanel (项目设置那一组 tab). ProjectItemsPanel 等仍用原 ProjectTabList, 不受影响.
 */
export function ProjectOverflowTabs({ tabs, onSelect, className = '', style }: Props) {
  const barRef = useRef<HTMLDivElement>(null)
  const measureTabEls = useRef<Map<string, HTMLButtonElement>>(new Map())
  const measureMoreRef = useRef<HTMLButtonElement>(null)
  const moreWrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 初始全部可见, useLayoutEffect 在首帧绘制前修正 (无闪烁).
  const [visibleKeys, setVisibleKeys] = useState<string[]>(tabs.map(t => t.key))
  const [menuOpen, setMenuOpen] = useState(false)

  // 把最新闭包放进 ref, 让 ResizeObserver 只订阅一次, 但每次都能读到最新 tabs/逻辑.
  const computeRef = useRef<() => void>(() => {})
  computeRef.current = () => {
    const bar = barRef.current
    const allKeys = tabs.map(t => t.key)
    if (!bar || tabs.length === 0) { setVisibleKeys(allKeys); return }
    const avail = bar.clientWidth
    if (avail === 0) { setVisibleKeys(allKeys); return } // 还没布局, 等下一次 ResizeObserver 回调
    const w = (key: string) => (measureTabEls.current.get(key)?.offsetWidth ?? 0) + GAP
    // 全部放得下 → 不需要 ⋯
    const totalAll = allKeys.reduce((s, k) => s + w(k), 0) - GAP
    if (totalAll <= avail) { setVisibleKeys(allKeys); return }
    // 需要收起: 给 ⋯ 按钮预留宽度
    const moreW = (measureMoreRef.current?.offsetWidth ?? 40) + GAP
    const budget = avail - moreW
    const activeKey = tabs.find(t => t.active && !t.disabled)?.key
    // 从左到右贪心, 只要还放得下就放进可视区
    const acc: string[] = []
    let used = 0
    for (const k of allKeys) {
      const cw = w(k)
      if (used + cw > budget) break
      acc.push(k); used += cw
    }
    // 激活 tab 必须留在可视区: 若它被挤到溢出里, 从可视区末尾腾出位置把它换进来
    if (activeKey && !acc.includes(activeKey)) {
      const aw = w(activeKey)
      while (acc.length > 0 && used + aw > budget) {
        const dropped = acc.pop()!
        used -= w(dropped)
      }
      if (used + aw <= budget) acc.push(activeKey)
      // 极端窄屏: 连激活 tab 单独都放不下 → 留在 ⋯ 菜单里, 可视区至少保留第一个 tab
    }
    setVisibleKeys(acc.length > 0 ? acc : [allKeys[0]])
  }

  // 首次计算 + 订阅尺寸变化 (只订阅一次)
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    computeRef.current()
    const ro = new ResizeObserver(() => computeRef.current())
    ro.observe(bar)
    return () => ro.disconnect()
    // 故意空依赖: 订阅一次, 闭包走 computeRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // tabs 变化 (如「小莫预设」条件出现/消失) 时重算
  useLayoutEffect(() => { computeRef.current() }, [tabs])

  // 菜单关闭: 点外部 / Esc
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t)) return
      if (moreWrapRef.current?.contains(t)) return
      setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const visibleSet = new Set(visibleKeys)
  const overflowTabs = tabs.filter(t => !visibleSet.has(t.key))
  const hasOverflow = overflowTabs.length > 0
  const activeInOverflow = overflowTabs.some(t => t.active && !t.disabled)

  return (
    <div
      className={`flex items-center rounded-lg border p-1 ${className}`}
      style={{ borderColor: 'var(--border-color)', background: 'var(--bg-primary)', ...style }}
    >
      <div ref={barRef} className="flex min-w-0 flex-1 items-center gap-1">
        {tabs.filter(t => visibleSet.has(t.key)).map(t => (
          <ProjectTabButton
            key={t.key}
            active={t.active}
            disabled={t.disabled}
            title={t.title}
            data-tour={t.dataTour}
            onClick={() => onSelect(t.key)}
            className="shrink-0 whitespace-nowrap"
          >
            {t.label}
          </ProjectTabButton>
        ))}
        {hasOverflow && (
          <div ref={moreWrapRef} className="relative ml-auto shrink-0">
            <button
              type="button"
              onClick={() => setMenuOpen(o => !o)}
              title="更多"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] transition-colors ${
                activeInOverflow ? 'bg-blue-500/15 text-blue-400' : 'hover:bg-[var(--bg-card-hover)]'
              }`}
              style={!activeInOverflow ? { color: 'var(--text-muted)' } : undefined}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <div
                ref={menuRef}
                role="menu"
                className="absolute right-0 top-8 z-50 min-w-[148px] rounded-lg border p-1 shadow-xl"
                style={{ background: 'var(--modal-bg)', borderColor: 'var(--border-color)' }}
              >
                {overflowTabs.map(t => (
                  <button
                    key={t.key}
                    type="button"
                    role="menuitem"
                    disabled={t.disabled}
                    title={t.title}
                    onClick={() => { onSelect(t.key); setMenuOpen(false) }}
                    className={`inline-flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      t.active ? 'bg-blue-500/15 text-blue-400' : 'hover:bg-[var(--bg-card-hover)]'
                    }`}
                    style={!t.active ? { color: 'var(--text-secondary)' } : undefined}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 测量层: 所有 tab + ⋯ 按钮的不可见副本, 仅供 offsetWidth 读真实宽度. class 镜像可视 tab 的尺寸 (h-7/px-3/text-[12px]) 和 ⋯ 按钮 (h-7/px-2). */}
      <div
        aria-hidden
        className="pointer-events-none absolute flex items-center gap-1"
        style={{ left: -99999, top: -99999, visibility: 'hidden' }}
      >
        {tabs.map(t => (
          <button
            key={t.key}
            type="button"
            tabIndex={-1}
            ref={el => {
              if (el) measureTabEls.current.set(t.key, el)
              else measureTabEls.current.delete(t.key)
            }}
            className="h-7 shrink-0 rounded-md px-3 text-[12px] whitespace-nowrap"
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          tabIndex={-1}
          ref={measureMoreRef}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] whitespace-nowrap"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
