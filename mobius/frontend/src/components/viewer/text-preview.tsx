/**
 * viewer/text-preview.tsx — 共享的小型文本展示组件.
 *
 * 从 jsonl-view.tsx 拆出. CodePreviewRows / ResultTextPreview 是带行号的代码/结果行预览
 * (Write 预览 / Bash 命令 / 工具返回结果共用); CompactPlainTextFallback 是 CompactMarkdown
 * 懒加载时的占位 <pre>. 多个卡片组件都用到, 单独成文件避免互相 import 成环.
 */
import { useMemo, useState, type ReactNode } from 'react'
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

/**
 * Render the folded remainder of a line preview.
 *
 * While folded it draws a divider plus a "expand remaining N lines" toggle. Once
 * the user expands it, the toggle and the divider are dropped entirely so the two
 * line blocks read as one continuous block; the state lives only in this component,
 * so collapsing the surrounding card (which unmounts the body) restores the fold.
 */
export function ExpandableRestLines({ count, suffix = '', children }: { count: number; suffix?: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  // 展开后连控件一起卸载, 分割线随之消失, 两段文本直接相接
  // Unmount the toggle itself after expansion so the divider disappears and both blocks join
  if (expanded) return <>{children}</>
  return (
    <details className="border-t border-[var(--border-color)]/60">
      {/* 拦下 details 的默认展开, 改为整体替换成无控件的连续内容 */}
      {/* Intercept the default toggle and swap in the control-free continuous block instead */}
      <summary
        className="cursor-pointer px-2 py-1.5 text-[length:var(--fs-xs)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
        onClick={(e) => { e.preventDefault(); setExpanded(true) }}
      >
        展开剩余 {count} 行{suffix}
      </summary>
      {children}
    </details>
  )
}

export function ResultTextPreview({ text, startLine = 1 }: { text: string; startLine?: number }) {
  const lines = useMemo(() => splitDiffValue(text), [text])
  const previewLines = lines.slice(0, WRITE_PREVIEW_LINE_LIMIT)
  const restLines = lines.slice(WRITE_PREVIEW_LINE_LIMIT)
  if (!text) return null
  return (
    <div className="min-w-max py-1 font-mono text-[length:var(--fs-sm)] leading-[1.45]">
      <CodePreviewRows lines={previewLines} startLine={startLine} />
      {restLines.length > 0 && (
        <ExpandableRestLines count={restLines.length}>
          <CodePreviewRows lines={restLines} startLine={startLine + WRITE_PREVIEW_LINE_LIMIT} />
        </ExpandableRestLines>
      )}
    </div>
  )
}

export function CompactPlainTextFallback({ text }: { text: string }) {
  return (
    <pre className="text-[length:var(--fs-sm)] leading-relaxed whitespace-pre-wrap break-words font-mono px-2 py-1.5 rounded bg-[var(--prose-bg)] text-[var(--text-primary)] select-text">{text}</pre>
  )
}
