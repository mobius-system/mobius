import { Suspense, isValidElement, lazy, type ComponentPropsWithoutRef, type ReactNode } from 'react'

const MermaidDiagram = lazy(() => import('./mermaid-diagram'))

/*
 * Extract Mermaid source only from fenced Markdown blocks explicitly labelled `mermaid`.
 */
export function getMermaidSource(children: ReactNode): string | null {
  const child = Array.isArray(children) && children.length === 1 ? children[0] : children
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null
  if (!/(?:^|\s)language-mermaid(?:\s|$)/i.test(child.props.className || '')) return null
  return String(child.props.children ?? '').replace(/\n$/, '')
}

export function MermaidCodeBlock({ source }: { source: string }) {
  return (
    <Suspense fallback={<div className="mermaid-diagram mermaid-diagram--loading">正在加载图表…</div>}>
      <MermaidDiagram source={source} />
    </Suspense>
  )
}

/*
 * Replace a Mermaid code fence with a diagram while preserving normal preformatted blocks.
 */
export function MarkdownPre({ children, node: _node, ...props }: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
  const source = getMermaidSource(children)
  if (source !== null) return <MermaidCodeBlock source={source} />
  return <pre {...props}>{children}</pre>
}

export const MARKDOWN_COMPONENTS = { pre: MarkdownPre as any }
