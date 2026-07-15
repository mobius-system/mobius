/**
 * viewer/DisplayImages.tsx — display_images / 附件图片派生的图像卡片 + 放大弹窗.
 *
 * 从 jsonl-view.tsx 拆出. 紧跟在 Bash(display_images) 卡片之后, 默认展开.
 * 行号渲染成 "↳#N" 表示"由第 N 条 entry 派生", 而非真实 jsonl 行.
 * 单张图片: URL 直出; 绝对路径走后端 /api/download (与 FileManager 同款, token 走 query).
 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { resolveMediaSrc } from '../jsonl-vscode-link'
import { IMAGES_THEME } from './themes'

function displayImageSrc(src: string): { isUrl: boolean; finalSrc: string } {
  const isUrl = /^https?:\/\//i.test(src)
  // finalSrc 与 markdown 内嵌图片走同一条改写规则 (resolveMediaSrc), 保证
  // display_images 卡片和 ![](/home/...) 图片行为一致.
  return { isUrl, finalSrc: resolveMediaSrc(src) }
}

// 把图片源描述成 (标签, 显示文本). 对 base64 data url 只给短标签 (内嵌图片 · mime),
// 不把十几万字符的 base64 拼进 UI (放大弹窗 header / 缩略图 caption 都会因此爆掉).
export function describeImageSrc(src: string): { label: string; display: string } {
  if (src.startsWith('data:')) {
    const mime = (src.match(/^data:([^;,]+)/) || [])[1] || 'image'
    return { label: '内嵌图片', display: mime }
  }
  const isUrl = /^https?:\/\//i.test(src)
  return { label: isUrl ? 'URL' : '本地文件', display: src }
}

// 单张图片: 外链/本地都经 resolveMediaSrc 改写 (外链走 /api/proxy-media 代理).
// 加载失败时不再只剩死占位: 探测一次代理源拿到 HTTP 状态/原因, 并保留「打开原图」
// 外链入口 (指向原始 src, 绕开代理直接在新标签打开), 让用户至少能手动看到图.
function DisplayImageItem({ src, onOpen }: { src: string; onOpen: (src: string) => void }) {
  const [err, setErr] = useState(false)
  const [reason, setReason] = useState('')
  const { isUrl, finalSrc } = displayImageSrc(src)

  // onError 后探测一次最终 src, 把失败原因 (HTTP 状态 / 代理报错) 显给用户.
  // 非 2xx 才读响应体 (错误 JSON 很小); 2xx 仍渲染失败说明是解码/格式问题, 立即
  // 取消响应体, 不为读原因而重复下载整张图.
  const handleError = useCallback(() => {
    setErr(true)
    fetch(finalSrc)
      .then(async (r) => {
        if (!r.ok) {
          let msg = `HTTP ${r.status}`
          try {
            const text = await r.text()
            try { const j = JSON.parse(text); if (j && j.error) msg += ` · ${j.error}` }
            catch { if (text) msg += ` · ${text.slice(0, 120)}` }
          } catch { /* 非 JSON / 无 body */ }
          setReason(msg)
        } else {
          try { await r.body?.cancel() } catch { /* ignore */ }
          setReason('图片无法解码或格式不支持')
        }
      })
      .catch(() => setReason('代理或网络不可达'))
  }, [finalSrc])

  return (
    <figure className="m-0 flex flex-col gap-1">
      {err ? (
        <div className="flex flex-col items-center justify-center gap-1.5 h-44 rounded border border-dashed border-[var(--border-color)] bg-[var(--prose-bg)] px-3 text-center">
          <span className="text-[11px] text-[var(--text-muted)]">图片加载失败</span>
          {reason && (
            <span className="text-[10px] font-mono text-[var(--text-muted)] opacity-80 break-all line-clamp-3">
              {reason}
            </span>
          )}
          {isUrl && (
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 text-[11px] text-teal-500 hover:underline">
              打开原图
            </a>
          )}
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
            onError={handleError}
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

export function DisplayImagePreviewModal({ src, onClose }: { src: string; onClose: () => void }) {
  const { isUrl, finalSrc } = displayImageSrc(src)
  const { label: srcLabel, display: srcDisplay } = describeImageSrc(src)
  const [err, setErr] = useState(false)
  // 「打开原图」对 URL 形式指向原始外链 (绕开代理直接打开), 其余指向最终 src.
  const openOriginalHref = isUrl ? src : finalSrc

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

  // 切图时重置错误态 (同一 modal 实例复用).
  useEffect(() => { setErr(false) }, [src])

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
            {srcLabel} · {srcDisplay}
          </span>
          <a
            href={openOriginalHref}
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
          {err ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <span className="text-[12px] text-[var(--text-muted)]">图片加载失败 / 无法访问</span>
              <a
                href={openOriginalHref}
                target="_blank"
                rel="noreferrer"
                className="text-[12px] text-teal-500 hover:underline">
                打开原图
              </a>
            </div>
          ) : (
            <img
              src={finalSrc}
              alt={src}
              onError={() => setErr(true)}
              className="max-h-[calc(92vh-92px)] max-w-full object-contain"
            />
          )}
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
