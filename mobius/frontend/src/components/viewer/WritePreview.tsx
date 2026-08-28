/**
 * viewer/WritePreview.tsx — Write tool_use 的文件内容预览.
 *
 * 从 jsonl-view.tsx 拆出. 多行内容首屏只露前 N 行, 余下 details 折叠, 行号从 1 开始.
 */
import { useMemo } from 'react'
import { splitDiffValue, basename } from './utils'
import { CodePreviewRows, WRITE_PREVIEW_LINE_LIMIT } from './text-preview'
import type { WriteToolCall } from './types'

export function JsonEntryWritePreview({ writeCall }: { writeCall: WriteToolCall }) {
  const lines = useMemo(() => splitDiffValue(writeCall.content), [writeCall.content])
  const previewLines = lines.slice(0, WRITE_PREVIEW_LINE_LIMIT)
  const restLines = lines.slice(WRITE_PREVIEW_LINE_LIMIT)

  return (
    <div className="overflow-hidden rounded bg-[var(--prose-bg)] ring-0 ring-[var(--border-color)]/70">
      <div className="flex min-w-0 items-start gap-2 border-b border-[var(--border-color)] px-2.5 py-1.5 text-[10px]">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] font-semibold text-[var(--text-secondary)]" title={writeCall.filePath}>
            {basename(writeCall.filePath)}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-muted)]" title={writeCall.filePath}>
            {writeCall.filePath}
          </div>
        </div>
        <span className="flex-shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
          {writeCall.lineCount} lines
        </span>
      </div>
      <div className="max-h-[34rem] overflow-auto">
        <div className="min-w-max py-1 font-mono text-[11px] leading-[1.45]">
          <CodePreviewRows lines={previewLines} />
          {restLines.length > 0 && (
            <details className="border-t border-[var(--border-color)]/60">
              <summary className="cursor-pointer px-2 py-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                展开剩余 {restLines.length} 行
              </summary>
              <CodePreviewRows lines={restLines} startLine={WRITE_PREVIEW_LINE_LIMIT + 1} />
            </details>
          )}
        </div>
      </div>
    </div>
  )
}
