/**
 * viewer/text-preview.tsx — 共享的小型文本展示组件.
 *
 * 从 jsonl-view.tsx 拆出. CodePreviewRows / ResultTextPreview 是带行号的代码/结果行预览
 * (Write 预览 / Bash 命令 / 工具返回结果共用); CompactPlainTextFallback 是 CompactMarkdown
 * 懒加载时的占位 <pre>. 多个卡片组件都用到, 单独成文件避免互相 import 成环.
 */
import { useMemo } from 'react'
import { splitDiffValue } from './utils'

// 多行脚本/文件/结果首屏只露前 N 行, 余下 details 折叠. Write 预览 / Bash 命令 / 工具返回结果共用此阈值.
export const WRITE_PREVIEW_LINE_LIMIT = 40

export function CodePreviewRows({ lines, startLine = 1 }: { lines: string[]; startLine?: number }) {
  return (
    <>
      {lines.map((line, idx) => (
        <div key={`${startLine + idx}-${idx}`} className="grid grid-cols-[3rem_minmax(0,1fr)] code-diff-line">
          <span className="code-diff-line-number select-none border-r border-[var(--border-color)]/50 px-2 text-right">
            {startLine + idx}
          </span>
          <code className="whitespace-pre px-2 text-inherit">{line || ' '}</code>
        </div>
      ))}
    </>
  )
}

export function ResultTextPreview({ text, startLine = 1 }: { text: string; startLine?: number }) {
  const lines = useMemo(() => splitDiffValue(text), [text])
  const previewLines = lines.slice(0, WRITE_PREVIEW_LINE_LIMIT)
  const restLines = lines.slice(WRITE_PREVIEW_LINE_LIMIT)
  if (!text) return null
  return (
    <div className="min-w-max py-1 font-mono text-[11px] leading-[1.45]">
      <CodePreviewRows lines={previewLines} startLine={startLine} />
      {restLines.length > 0 && (
        <details className="border-t border-[var(--border-color)]/60">
          <summary className="cursor-pointer px-2 py-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
            展开剩余 {restLines.length} 行
          </summary>
          <CodePreviewRows lines={restLines} startLine={startLine + WRITE_PREVIEW_LINE_LIMIT} />
        </details>
      )}
    </div>
  )
}

export function CompactPlainTextFallback({ text }: { text: string }) {
  return (
    <pre className="text-[11px] leading-relaxed whitespace-pre-wrap break-words font-mono px-2 py-1.5 rounded bg-[var(--prose-bg)] text-[var(--text-primary)] select-text">{text}</pre>
  )
}
