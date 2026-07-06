import { useEffect, useMemo, useState } from 'react'

// =====================================================================
// 通用分页: usePagination (状态+切片+选中项跨页定位) + PaginationControls (控件)
// 复用于: UserPage 项目卡片列表 (常规模式), IssuePage/ResearchPage 会话 sidebar (compact 模式).
// 样式复刻已有的 ProjectSidebar 紧凑控件 + SessionOverviewPagination 常规控件.
// =====================================================================

export function usePagination<T>(items: T[], pageSize: number, opts?: {
  activeId?: string | null
  getId?: (item: T) => string
}) {
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pageStart = items.length === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const pageEnd = Math.min(currentPage * pageSize, items.length)

  // 列表收缩 (删除/筛选/换页) 后夹紧到合法页, 避免停在空白页.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  // 选中项 (activeId) 变化时自动翻到它所在的页, 保证 sidebar 高亮项始终可见.
  // 依赖放 [activeId, items.length]: 用户手动翻页 (setPage) 不改这两者, 不会被打断;
  // 同时覆盖 "activeId 先到位 / items 后到齐" 的时序竞态 (length 0→N 时重跑一次定位).
  useEffect(() => {
    const id = opts?.activeId
    const getId = opts?.getId
    if (!id || !getId) return
    const idx = items.findIndex((it) => getId(it) === id)
    if (idx < 0) return
    const targetPage = Math.floor(idx / pageSize) + 1
    setPage((cur) => (cur === targetPage ? cur : targetPage))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts?.activeId, items.length])

  const pagedItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return items.slice(start, start + pageSize)
  }, [items, currentPage, pageSize])

  const goToPage = (next: number) => setPage(Math.min(Math.max(next, 1), totalPages))
  const reset = () => setPage(1)

  return { page: currentPage, totalPages, pageStart, pageEnd, pagedItems, setPage, goToPage, reset }
}

type PaginationControlsProps = {
  page: number
  totalPages: number
  pageStart: number
  pageEnd: number
  totalItems: number
  onPageChange: (page: number) => void
  /** sidebar 窄列用 compact; 主区宽列用常规 (多一行 "第 X/Y 页"). */
  compact?: boolean
}

export function PaginationControls({
  page,
  totalPages,
  pageStart,
  pageEnd,
  totalItems,
  onPageChange,
  compact = false,
}: PaginationControlsProps) {
  if (totalItems === 0 || totalPages <= 1) return null
  const goTo = (n: number) => onPageChange(Math.min(Math.max(n, 1), totalPages))

  if (compact) {
    return (
      <div className="px-3 py-2 border-t flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-color)' }}>
        <button
          type="button"
          onClick={() => goTo(page - 1)}
          disabled={page <= 1}
          className="h-8 sm:h-7 px-2 rounded-md border text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
        >
          上一页
        </button>
        <span className="text-[11px] tabular-nums flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
          {pageStart}-{pageEnd} / {totalItems}
        </span>
        <button
          type="button"
          onClick={() => goTo(page + 1)}
          disabled={page >= totalPages}
          className="h-8 sm:h-7 px-2 rounded-md border text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
        >
          下一页
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
        显示 {pageStart}-{pageEnd} / {totalItems} 个 · 第 {page} / {totalPages} 页
      </span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => goTo(page - 1)}
          disabled={page <= 1}
          className="h-8 px-2.5 rounded-md border text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
        >
          上一页
        </button>
        <button
          type="button"
          onClick={() => goTo(page + 1)}
          disabled={page >= totalPages}
          className="h-8 px-2.5 rounded-md border text-[11px] transition-colors hover:bg-[var(--bg-card-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ borderColor: 'var(--border-color)', color: 'var(--text-muted)' }}
        >
          下一页
        </button>
      </div>
    </div>
  )
}
