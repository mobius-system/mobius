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
import { useState } from 'react'
import { describeImageSrc, DisplayImagePreviewModal } from './DisplayImages'
import { ResultTextPreview } from './text-preview'

function ImageOutputItem({ url, index, onOpen }: { url: string; index: number; onOpen: (url: string) => void }) {
  const [err, setErr] = useState(false)
  const { label, display } = describeImageSrc(url)
  return (
    <figure className="m-0 flex w-56 max-w-full flex-col gap-1">
      {err ? (
        <div className="flex h-40 w-full items-center justify-center rounded border border-dashed border-[var(--border-color)] bg-[var(--prose-bg)] px-3 text-center text-[11px] text-[var(--text-muted)]">
          图片解码失败
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(url)}
          className="group block h-40 w-full cursor-zoom-in overflow-hidden rounded border border-[var(--border-color)] bg-[var(--prose-bg)] focus:outline-none focus:ring-2 focus:ring-teal-400/60"
          title="点击放大查看"
        >
          <img
            src={url}
            alt={`output image ${index + 1}`}
            loading="lazy"
            onError={() => setErr(true)}
            className="h-full w-full object-contain transition-transform duration-150 group-hover:scale-[1.02]"
          />
        </button>
      )}
      <figcaption className="truncate select-text font-mono text-[10px] text-[var(--text-muted)]">
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
