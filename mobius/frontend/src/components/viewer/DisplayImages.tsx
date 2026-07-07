/**
 * viewer/DisplayImages.tsx — display_images / 附件图片派生的图像卡片 + 放大弹窗.
 *
 * 从 jsonl-view.tsx 拆出. 紧跟在 Bash(display_images) 卡片之后, 默认展开.
 * 行号渲染成 "↳#N" 表示"由第 N 条 entry 派生", 而非真实 jsonl 行.
 * 单张图片: URL 直出; 绝对路径走后端 /api/download (与 FileManager 同款, token 走 query).
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { resolveMediaSrc } from '../jsonl-vscode-link'
import { IMAGES_THEME } from './themes'

function displayImageSrc(src: string): { isUrl: boolean; finalSrc: string } {
  const isUrl = /^https?:\/\//i.test(src)
  // finalSrc 与 markdown 内嵌图片走同一条改写规则 (resolveMediaSrc), 保证
  // display_images 卡片和 ![](/home/...) 图片行为一致.
  return { isUrl, finalSrc: resolveMediaSrc(src) }
}

// 单张图片: URL 直出; 绝对路径走后端 /api/download (与 FileManager 同款, token 走 query).
function DisplayImageItem({ src, onOpen }: { src: string; onOpen: (src: string) => void }) {
  const [err, setErr] = useState(false)
  const { isUrl, finalSrc } = displayImageSrc(src)
  return (
    <figure className="m-0 flex flex-col gap-1">
      {err ? (
        <div className="flex items-center justify-center h-32 rounded border border-dashed border-[var(--border-color)] bg-[var(--prose-bg)] text-[11px] text-[var(--text-muted)] px-3 text-center">
          图片加载失败 / 无法访问
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(src)}
          className="group block w-full h-44 cursor-zoom-in overflow-hidden rounded border border-[var(--border-color)] bg-[var(--prose-bg)] focus:outline-none focus:ring-2 focus:ring-teal-400/60"
          title="点击放大查看"
          data-testid="display-image-thumb">
          <img
            src={finalSrc}
            alt={src}
            loading="lazy"
            onError={() => setErr(true)}
            className="h-full w-full object-contain transition-transform duration-150 group-hover:scale-[1.02]"
          />
        </button>
      )}
      <figcaption className="text-[10px] font-mono text-[var(--text-muted)] break-all select-text">
        {isUrl ? 'URL · ' : '本地 · '}{src}
      </figcaption>
    </figure>
  )
}

function DisplayImagePreviewModal({ src, onClose }: { src: string; onClose: () => void }) {
  const { isUrl, finalSrc } = displayImageSrc(src)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="display_images 放大图"
      data-testid="display-image-modal">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" />
      <div
        className="relative flex max-h-[92vh] w-full max-w-[96vw] flex-col overflow-hidden rounded-2xl shadow-2xl"
        style={{ background: 'var(--modal-bg)', border: '1px solid var(--border-color)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b px-4 py-2.5" style={{ borderColor: 'var(--border-color)' }}>
          <span className="min-w-0 flex-1 truncate text-[12px] font-mono" style={{ color: 'var(--text-secondary)' }}>
            {isUrl ? 'URL' : '本地文件'} · {src}
          </span>
          <a
            href={finalSrc}
            target="_blank"
            rel="noreferrer"
            className="h-7 rounded-xl border px-2.5 py-1 text-[11px] transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color-strong)' }}>
            打开原图
          </a>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-xl border text-[18px] leading-none transition-colors hover:bg-[var(--bg-card-hover)]"
            style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-color-strong)' }}
            aria-label="关闭放大图"
            title="关闭">
            ×
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/20 p-3">
          <img
            src={finalSrc}
            alt={src}
            className="max-h-[calc(92vh-92px)] max-w-full object-contain"
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function DisplayImagesCard({ images, lineNo, sourceLabel = 'display_images' }: { images: string[]; lineNo?: number; sourceLabel?: string }) {
  const [open, setOpen] = useState<boolean>(true)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const theme = IMAGES_THEME
  return (
    <>
      <details
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        className={`mb-2 rounded-lg border card-enter ${theme.border} ${theme.bg}`}>
        <summary className="cursor-pointer px-3 py-1.5 flex items-center gap-2 text-[12px] select-text">
          {typeof lineNo === 'number' && <span className="text-[10px] text-[var(--text-muted)] font-mono flex-shrink-0">↳#{lineNo}</span>}
          <span className={`w-1.5 h-1.5 rounded-full ${theme.dot} flex-shrink-0`}></span>
          <span className={`font-mono font-semibold ${theme.text} flex-shrink-0`}>{theme.label}</span>
          <span className="text-[11px] text-[var(--text-muted)] truncate flex-1">{sourceLabel} · {images.length} 张</span>
        </summary>
        <div className="px-3 pb-3 pt-1 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          {images.map((src, i) => <DisplayImageItem key={i + '·' + src} src={src} onOpen={setPreviewSrc} />)}
        </div>
      </details>
      {previewSrc && <DisplayImagePreviewModal src={previewSrc} onClose={() => setPreviewSrc(null)} />}
    </>
  )
}
