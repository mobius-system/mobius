import type { ComponentPropsWithoutRef } from 'react'
import { FileReferenceLink } from './FileReferenceLink'
import { parseFileTarget, type CodeArtifactTarget } from './file-target'
import { MarkdownCodeBlock } from './CodeBlock'

function targetFromData(value: unknown): CodeArtifactTarget | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<CodeArtifactTarget>
    if (typeof parsed.path !== 'string' || typeof parsed.rawPath !== 'string') return null
    return {
      rawPath: parsed.rawPath,
      path: parsed.path,
      line: typeof parsed.line === 'number' ? parsed.line : null,
      column: typeof parsed.column === 'number' ? parsed.column : null,
      endLine: typeof parsed.endLine === 'number' ? parsed.endLine : null,
      intent: parsed.intent === 'diff' || parsed.intent === 'history' ? parsed.intent : 'preview',
      source: parsed.source === 'code-block' || parsed.source === 'jsonl-tool' || parsed.source === 'diff' || parsed.source === 'git-log'
        ? parsed.source
        : 'message',
      ...(typeof parsed.commitSha === 'string' || parsed.commitSha === null ? { commitSha: parsed.commitSha } : {}),
    }
  } catch {
    return null
  }
}

export function CodeMarkdownAnchor({
  href,
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'a'> & { node?: unknown; 'data-file-target'?: string }) {
  const target = targetFromData(props['data-file-target']) || (href
    ? parseFileTarget(href, { context: 'href', source: 'message', intent: 'preview' })
    : null)
  if (target) return <FileReferenceLink target={target}>{children}</FileReferenceLink>
  return (
    <a {...props} href={href} target={href ? '_blank' : undefined} rel={href ? 'noreferrer' : undefined}>
      {children}
    </a>
  )
}

export function CodeMarkdownCode({ node: _node, ...props }: ComponentPropsWithoutRef<'code'> & { node?: unknown }) {
  return <code {...props} />
}

export const CODE_MARKDOWN_COMPONENTS = {
  a: CodeMarkdownAnchor as any,
  code: CodeMarkdownCode as any,
  pre: MarkdownCodeBlock as any,
}
