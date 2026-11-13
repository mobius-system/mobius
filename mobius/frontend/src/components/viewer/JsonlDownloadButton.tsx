/**
 * viewer/JsonlDownloadButton.tsx — 文件卡片头部的单文件下载按钮.
 *
 * 与 JsonlCopyButton 同款 jsonl-icon-button 样式. 点击直接触发浏览器下载
 * GET /api/download?path=<绝对路径>&token=<cc-token> — 后端 downloadAuth
 * 鉴权只服务用户可读路径 (与图片渲染同一套机制).
 */
import { Download } from 'lucide-react'

/** 构造受鉴权的单文件下载 URL (token 走 query, 与 resolveMediaSrc 同款). */
export function fileDownloadUrl(filePath: string): string {
  const token = typeof window !== 'undefined' ? (localStorage.getItem('cc-token') || '') : ''
  return `/api/download?path=${encodeURIComponent(filePath)}${token ? `&token=${encodeURIComponent(token)}` : ''}`
}

export function JsonlDownloadButton({ filePath, title = '下载文件' }: { filePath: string; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className="jsonl-icon-button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        window.open(fileDownloadUrl(filePath), '_blank')
      }}
    >
      <Download className="h-2.5 w-2.5" strokeWidth={1.9} aria-hidden="true" />
    </button>
  )
}
