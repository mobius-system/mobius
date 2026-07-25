/**
 * Terminal markdown renderer.
 *
 * The web frontend renders markdown with react-markdown + remark-gfm +
 * rehype-highlight (the message content is a plain markdown string). In the
 * terminal we instead parse the same markdown with `marked`'s lexer and render
 * the token tree to ANSI via `chalk` (prose) and `cli-highlight` (fenced code).
 * The resulting ANSI string is fed to an Ink <Text>; Ink strips ANSI only for
 * layout measurement and passes the codes through to the terminal.
 */
import chalk from 'chalk'
import { highlight, supportsLanguage } from 'cli-highlight'
import { lexer, type Token, type Tokens } from 'marked'

export interface RenderedMarkdownLine {
  text: string
  code: boolean
}

/**
 * Highlight a fenced code block the same way Codex does: foreground syntax
 * colors only, no language badge, border, fence characters, or background.
 * Unknown and unlabelled languages stay plain instead of being guessed as bash.
 */
function renderCode(code: string, lang?: string): string {
  const trimmed = code.replace(/\n$/, '')
  const language = lang?.split(/[\s,]/, 1)[0]?.trim()
  if (!language || !supportsLanguage(language)) return trimmed
  try {
    return highlight(trimmed, { language, ignoreIllegals: true })
  } catch {
    return trimmed
  }
}

function renderInline(tokens: Token[] | undefined): string {
  if (!tokens || tokens.length === 0) return ''
  return tokens.map((t) => renderInlineOne(t)).join('')
}

function renderInlineOne(t: Token): string {
  // marked inline tokens carry their own nested `.tokens`.
  const anyT = t as any
  switch (t.type) {
    case 'text':
      return anyT.tokens ? renderInline(anyT.tokens) : escapeAnsiReset(anyT.text)
    case 'strong':
      return chalk.bold(renderInline(anyT.tokens))
    case 'em':
      return chalk.italic(renderInline(anyT.tokens))
    case 'del':
      return chalk.dim.strikethrough(renderInline(anyT.tokens))
    case 'codespan':
      return chalk.cyanBright(anyT.text)
    case 'link': {
      const label = renderInline(anyT.tokens) || anyT.href
      return anyT.href && label !== anyT.href ? `${chalk.cyan(label)} (${chalk.dim.underline(anyT.href)})` : chalk.cyan(label)
    }
    case 'image':
      return chalk.magentaBright(`[图片: ${anyT.href || anyT.text}]`)
    case 'br':
      return '\n'
    case 'escape':
    case 'html':
      return anyT.text ?? ''
    default:
      return anyT.text ?? renderInline(anyT.tokens)
  }
}

/** Prevent a stray embedded reset from truncating the surrounding style span. */
function escapeAnsiReset(s: string): string {
  return s
}

function renderTable(t: Tokens.Table): string {
  const cell = (toks: any) => renderInline(toks?.tokens ?? [{ type: 'text', text: toks?.text ?? '' }])
  const header = t.header.map((h) => cell(h)).join(' | ')
  const rows = t.rows.map((r) => r.map((c) => cell(c)).join(' | ')).join('\n')
  return chalk.bold(header) + '\n' + chalk.dim('-'.repeat(Math.min(header.length, 80))) + '\n' + rows
}

/** Render markdown into visual lines so code can opt out of terminal wrapping. */
export function renderMarkdownLines(md: string): RenderedMarkdownLine[] {
  if (!md) return []
  const tokens = lexer(md, { gfm: true, breaks: false })
  const out: RenderedMarkdownLine[] = []
  for (const t of tokens) {
    const isCode = t.type === 'code'
    const rendered = isCode
      ? renderCode((t as any).text, (t as any).lang)
      : renderBlock(t)
    for (const text of rendered.split('\n')) out.push({ text, code: isCode })
  }

  // Collapse repeated prose separators while preserving blank lines that are
  // part of source code. Remove only non-code padding at the outer edges.
  const normalized: RenderedMarkdownLine[] = []
  for (const line of out) {
    const previous = normalized.at(-1)
    if (!line.code && line.text === '' && previous && !previous.code && previous.text === '') continue
    normalized.push(line)
  }
  while (normalized[0] && !normalized[0].code && normalized[0].text === '') normalized.shift()
  while (normalized.at(-1) && !normalized.at(-1)?.code && normalized.at(-1)?.text === '') normalized.pop()
  return normalized
}

/** Backward-compatible string projection used by non-Ink callers and tests. */
export function renderMarkdown(md: string): string {
  return renderMarkdownLines(md).map(line => line.text).join('\n')
}

function renderBlock(t: Token): string {
  const anyT = t as any
  switch (t.type) {
    case 'heading': {
      const inner = renderInline(anyT.tokens)
      return anyT.depth <= 2 ? chalk.bold.cyanBright(inner) : chalk.bold(inner)
    }
    case 'paragraph':
      return renderInline(anyT.tokens)
    case 'code': {
      return renderCode(anyT.text, anyT.lang)
    }
    case 'blockquote': {
      const inner = (anyT.tokens as Token[]).map(renderBlock).join('\n')
      return inner.split('\n').map((l) => chalk.dim('│ ' + l)).join('\n')
    }
    case 'list': {
      const items: string[] = (anyT.items as Token[]).map((it: any, i: number) => {
        const marker = anyT.ordered ? `${(anyT.start ?? 1) + i}. ` : '• '
        const body = renderListItemBody(it)
        return body.split('\n').map((l, idx) => (idx === 0 ? chalk.cyan(marker) + l : '  ' + l)).join('\n')
      })
      return items.join('\n')
    }
    case 'hr':
      return chalk.dim('─'.repeat(40))
    case 'table':
      return renderTable(t as Tokens.Table)
    case 'space':
      return ''
    case 'html':
      return chalk.dim(anyT.text ?? '')
    default:
      return anyT.text ?? renderInline(anyT.tokens)
  }
}

function renderListItemBody(item: any): string {
  // list_item token: nested block tokens (paragraph, list, text…)
  if (item.tokens && item.tokens.length) {
    return (item.tokens as Token[])
      .map((tok) => (tok.type === 'text' ? renderInline((tok as any).tokens) : renderBlock(tok)))
      .filter(Boolean)
      .join('\n')
  }
  return item.text ?? ''
}
