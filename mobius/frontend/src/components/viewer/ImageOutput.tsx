/**
 * viewer/ImageOutput.tsx — function_call_output 内嵌图片 (input_image base64) 渲染面板.
 *
 * codex / OpenAI response API 偶尔把工具返回值 (response_item.payload.type === 'function_call_output'
 * 的 payload.output) 写成结构化数组, 例如:
 *   [{ type: 'input_image', image_url: 'data:image/png;base64,<十几万字符>', detail: 'high' }]
 * 这种 entry 在 jsonl 视图里是一条独立卡片. 若走字段模式递归展开 JSON, base64 会撑爆
 * DOM (触发"超大卡片保护"截断, 用户看到的是一坨截断的 base64 而不是图). 本面板直接把
 * data url 当 <img> 源铺成网格, 点击放大复用 DisplayImages 的放大弹窗; 若 output 里还夹带
 * 文字说明, 把文字附在图片下方 (图片优先).
 */
import { useEffect, useState } from 'react'
import { describeImageSrc, DisplayImagePreviewModal } from './DisplayImages'
import { ResultTextPreview } from './text-preview'
import { authenticatedImageUrl } from './image-url'

function ImageOutputItem({ url, index, onOpen }: { url: string; index: number; onOpen: (url: string) => void }) {
  const [err, setErr] = useState(false)
  const { label, display } = describeImageSrc(url)
  const src = authenticatedImageUrl(url)
  return (
    <figure className="m-0 flex w-56 max-w-full flex-col gap-1">
      {err ? (
        <div className="flex h-40 w-full items-center justify-center rounded border border-dashed border-[var(--border-color)] bg-[var(--prose-bg)] px-3 text-center text-[length:var(--fs-sm)] text-[var(--text-muted)]">
          图片解码失败
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(src)}
          className="group block h-40 w-full cursor-zoom-in overflow-hidden rounded border border-[var(--border-color)] bg-[var(--prose-bg)] focus:outline-none focus:ring-2 focus:ring-teal-400/60"
          title="点击放大查看"
        >
          <img
            src={src}
            alt={`output image ${index + 1}`}
            loading="lazy"
            onError={() => setErr(true)}
            className="h-full w-full object-contain transition-transform duration-150 group-hover:scale-[1.02]"
          />
        </button>
      )}
      <figcaption className="truncate select-text font-mono text-[length:var(--fs-xs)] text-[var(--text-muted)]">
        {label} · {display} · #{index + 1}
      </figcaption>
    </figure>
  )
}

export function ImageOutputPanel({ imageUrls, textBody }: { imageUrls: string[]; textBody?: string }) {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const hasText = !!textBody && textBody.trim().length > 0
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {imageUrls.map((url, i) => (
          <ImageOutputItem key={i + '·' + url.slice(0, 32)} url={url} index={i} onOpen={setPreviewSrc} />
        ))}
      </div>
      {hasText && (
        <div className="mt-2 max-h-[24rem] overflow-auto rounded border border-[var(--border-color)]/60 bg-black/5 dark:bg-white/[0.02]">
          <ResultTextPreview text={textBody!} />
        </div>
      )}
      {previewSrc && <DisplayImagePreviewModal src={previewSrc} onClose={() => setPreviewSrc(null)} />}
    </>
  )
}

/*
 * <persisted-output> 存根图像面板 — 原图在 CC 落盘的 tool-results 文件里 (MB 级),
 * 卡片只携带 2KB 预览, 无法内联渲染. 挂载时先取 meta (张数/mime/体积), 再把 <img>
 * 指到 /api/sessions/tool-result-media 字节流端点 (token 走 query, 与 /api/download
 * 同款; 后端已校验文件归属于当前用户可读的会话).
 */
type PersistedImageMeta = { count: number; images: Array<{ mime: string; bytes: number }> }

function toolResultMediaUrl(callId: string, savedPath: string, params: Record<string, string>): string {
  const token = typeof window !== 'undefined' ? (localStorage.getItem('cc-token') || '') : ''
  const qs = new URLSearchParams({ call_id: callId, path: savedPath, ...params })
  if (token) qs.set('token', token)
  return `/api/sessions/tool-result-media?${qs.toString()}`
}

function mediaSizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

export function PersistedImageOutputPanel({ callId, savedPath }: { callId: string; savedPath: string }) {
  const [meta, setMeta] = useState<PersistedImageMeta | null>(null)
  const [error, setError] = useState('')
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(toolResultMediaUrl(callId, savedPath, { meta: '1' }))
      .then(async (r) => {
        if (!r.ok) {
          let msg = `HTTP ${r.status}`
          try { const j = await r.json(); if (j?.error) msg += ` · ${j.error}` } catch { /* 非 JSON 响应体 */ }
          throw new Error(msg)
        }
        return r.json()
      })
      .then((data: PersistedImageMeta) => { if (alive) setMeta(data) })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [callId, savedPath])

  if (error) {
    return (
      <div className="rounded border border-dashed border-red-400/40 bg-red-500/[0.04] px-3 py-2 text-[length:var(--fs-sm)] text-red-300">
        原图加载失败 · {error}
      </div>
    )
  }
  if (!meta) {
    return (
      <div className="flex h-40 w-full items-center justify-center rounded border border-dashed border-[var(--border-color)] bg-[var(--prose-bg)] px-3 text-center text-[length:var(--fs-sm)] text-[var(--text-muted)]">
        正在加载已存盘的原图…
      </div>
    )
  }
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {meta.images.map((image, i) => (
          <figure key={i} className="m-0 flex w-56 max-w-full flex-col gap-1">
            <button
              type="button"
              onClick={() => setPreviewSrc(toolResultMediaUrl(callId, savedPath, { index: String(i) }))}
              className="group block h-40 w-full cursor-zoom-in overflow-hidden rounded border border-[var(--border-color)] bg-[var(--prose-bg)] focus:outline-none focus:ring-2 focus:ring-teal-400/60"
              title="点击放大查看"
            >
              <img
                src={toolResultMediaUrl(callId, savedPath, { index: String(i) })}
                alt={`persisted output image ${i + 1}`}
                loading="lazy"
                className="h-full w-full object-contain transition-transform duration-150 group-hover:scale-[1.02]"
              />
            </button>
            <figcaption className="truncate select-text font-mono text-[length:var(--fs-xs)] text-[var(--text-muted)]">
              已存盘图片 · {image.mime} · {mediaSizeLabel(image.bytes)} · #{i + 1}
            </figcaption>
          </figure>
        ))}
      </div>
      {previewSrc && <DisplayImagePreviewModal src={previewSrc} onClose={() => setPreviewSrc(null)} />}
    </>
  )
}
