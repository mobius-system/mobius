// 桌面端多 tab 卡片栏（实验版 0.0.12）。
// 仅桌面端渲染（isDesktop 自退场，web 端零影响）；挂 App.tsx 根，每个 tab 页面都渲染一份（壳 TabManager 状态镜像）。
// 卡片 = 一个独立 webContents (WebContentsView)；新建/关闭/切换/拖拽排序经 mobiusDesktop 桥 IPC 通知壳。
// 视觉复用 UserPage 项目卡片语言（rounded-xl + var(--bg-primary) + 蓝色激活边框）。
import { useEffect, useState, type DragEvent } from 'react'
import { Plus, X } from 'lucide-react'

type TabInfo = { id: string; url: string; title?: string }

type TabBridge = {
  isDesktop?: boolean
  newTab?: (opts?: { url?: string }) => Promise<unknown>
  closeTab?: (id: string) => Promise<unknown>
  switchTab?: (id: string) => Promise<unknown>
  reorderTabs?: (ids: string[]) => Promise<unknown>
  getTabs?: () => Promise<TabInfo[]>
  getActiveTabId?: () => Promise<string | null>
  onTabsChanged?: (cb: (tabs: TabInfo[], activeId: string | null) => void) => (() => void) | undefined
}

function getBridge(): TabBridge | undefined {
  return typeof window !== 'undefined' ? (window as { mobiusDesktop?: TabBridge }).mobiusDesktop : undefined
}

// title 缺失时从 url 末段推导简短显示名。
function shortLabel(tab: TabInfo): string {
  const t = (tab.title || '').trim()
  if (t) return t
  const segs = tab.url.replace(/[?#].*$/, '').split('/').filter(Boolean)
  return decodeURIComponent(segs[segs.length - 1] || '页面')
}

export function DesktopTabBar() {
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)

  useEffect(() => {
    const b = getBridge()
    if (!b?.getTabs) return
    let alive = true
    b.getTabs().then((t) => { if (alive) setTabs(t) }).catch(() => {})
    b.getActiveTabId?.().then((id) => { if (alive) setActiveId(id) }).catch(() => {})
    const off = b.onTabsChanged?.((t, id) => { setTabs(t); setActiveId(id) })
    return () => { alive = false; off?.() }
  }, [])

  const md = getBridge()
  // 仅桌面端渲染（web 端 mobiusDesktop 不存在 → return null，零影响）。
  if (!md?.isDesktop) return null
  // 始终显示卡片栏（含「+」新建入口）。早期"仅 1 tab 隐藏"会让用户看不到「+」无法新建 → 死循环，故常驻。

  const onDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) { setDragId(null); return }
    const fromIdx = tabs.findIndex((t) => t.id === dragId)
    const toIdx = tabs.findIndex((t) => t.id === targetId)
    if (fromIdx < 0 || toIdx < 0) { setDragId(null); return }
    const next = [...tabs]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    setTabs(next)
    md.reorderTabs?.(next.map((t) => t.id)).catch(() => {})
    setDragId(null)
  }

  return (
    <div
      className="fixed bottom-4 left-4 z-[60] flex max-w-[calc(100vw-32px)] items-center gap-1 rounded-xl border p-1.5 shadow-lg"
      style={{ background: 'color-mix(in srgb, var(--bg-primary) 92%, transparent)', borderColor: 'var(--border-color)' }}
    >
      {tabs.map((t) => {
        const active = t.id === activeId
        return (
          <div
            key={t.id}
            draggable
            onDragStart={() => setDragId(t.id)}
            onDragOver={(e: DragEvent) => e.preventDefault()}
            onDrop={() => onDrop(t.id)}
            onClick={() => md.switchTab?.(t.id).catch(() => {})}
            className={`group flex max-w-[180px] cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 transition-all ${active ? 'border-blue-500 bg-[var(--bg-hover)]' : 'border-transparent hover:border-[var(--border-color)]'}`}
            title={shortLabel(t)}
          >
            <span
              className="truncate text-xs font-medium"
              style={{ color: active ? 'var(--text-primary)' : 'var(--text-muted)', maxWidth: 140 }}
            >
              {shortLabel(t)}
            </span>
            <button
              type="button"
              aria-label="关闭标签页"
              title="关闭标签页"
              onClick={(e) => { e.stopPropagation(); md.closeTab?.(t.id).catch(() => {}) }}
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)]"
              style={{ color: 'var(--text-muted)' }}
            >
              <X className="h-3 w-3" strokeWidth={2.5} />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        aria-label="新建标签页"
        title="新建标签页"
        onClick={() => md.newTab?.().catch(() => {})}
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
        style={{ color: 'var(--text-muted)' }}
      >
        <Plus className="h-4 w-4" strokeWidth={2.5} />
      </button>
    </div>
  )
}
