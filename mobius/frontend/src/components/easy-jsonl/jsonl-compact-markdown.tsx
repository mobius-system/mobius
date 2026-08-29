import { useState, type ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import { MARKDOWN_REMARK_PLUGINS, MARKDOWN_REHYPE_PLUGINS } from '../easy-workbench/markdown'
import { resolveMediaSrc } from '../jsonl-vscode-link'
import { CODE_MARKDOWN_COMPONENTS } from '../easy-workbench/code-artifacts/CodeMarkdownComponents'

function MarkdownTable({ children, node: _node, ...props }: ComponentPropsWithoutRef<'table'> & { node?: unknown }) {
  return (
    <div className="jsonl-compact-md-table-wrap">
      <table {...props}>{children}</table>
    </div>
  )
}

// Markdown <img>: rewrite absolute filesystem-path srcs — e.g.
// ![shot](/home/.../x.png) captured inside an agent message — to the backend
// /api/download endpoint so they actually render. Without this the raw path in
// <img src> 404s against the host and the image stays blank. http(s) URLs and
// in-app paths pass through unchanged. Falls back to a small placeholder when
// the backend can't serve the file (missing, or outside the user's allowed
// roots) so "loading" is distinguishable from "permanently broken".
function MarkdownImage({ src, alt, node: _node, ...rest }: ComponentPropsWithoutRef<'img'> & { node?: unknown }) {
  const [failed, setFailed] = useState(false)
  if (!src) return null
  if (failed) {
    return (
      <span
        className="inline-flex items-center gap-1 my-1 px-2 py-1 rounded border border-dashed border-[var(--border-color)] bg-[var(--prose-bg)] text-[11px] text-[var(--text-muted)] break-all"
        title={src}
      >
        ⚠ 图片无法显示 · {alt || src}
      </span>
    )
  }
  return (
    <img
      {...rest}
      src={resolveMediaSrc(src)}
      alt={alt || ''}
      loading="lazy"
      onError={() => setFailed(true)}
      className="max-w-full h-auto rounded my-1 border border-[var(--border-color)]"
    />
  )
}

export default function JsonlCompactMarkdown({ text }: { text: string }) {
  return (
    <div className="jsonl-compact-md px-2 py-1.5 rounded bg-[var(--prose-bg)] text-[var(--text-primary)] select-text">
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS as any}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={{
          ...CODE_MARKDOWN_COMPONENTS,
          table: MarkdownTable as any,
          img: MarkdownImage as any,
        }}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
