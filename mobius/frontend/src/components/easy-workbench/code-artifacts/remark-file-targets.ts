import { isUnambiguousFileCandidate, parseFileTarget, type FileCandidateContext } from './file-target'

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  data?: { hProperties?: Record<string, unknown> }
  children?: MarkdownNode[]
}

const FILE_CANDIDATE_PATTERN = new RegExp([
  'file:\\/\\/[^\\s`"\'<>]+',
  '\\\\\\\\[^\\s`"\'<>]+(?:\\\\[^\\s`"\'<>]+)+',
  '[A-Za-z]:[\\\\/][^\\s`"\'<>]+',
  '(?:~\\/|\\.{1,2}\\/|\\/)[^\\s`"\'<>]+',
  '(?:[A-Za-z0-9_@.-]+[\\\\/])+[^\\s`"\'<>]+',
  '(?:[A-Za-z0-9_@.-]+\\.[A-Za-z0-9+_-]*[A-Za-z][A-Za-z0-9+_-]*|\\.[A-Za-z][A-Za-z0-9_-]*)(?:(?::\\d+(?::\\d+|-\\d+)?)|(?:#L\\d+(?:(?:C\\d+)|(?:-L?\\d+))?))?',
].join('|'), 'gi')

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '。', '，', '；', '！', '？'])

function splitTrailingPunctuation(value: string) {
  let end = value.length
  while (end > 0 && TRAILING_PUNCTUATION.has(value[end - 1])) end -= 1
  return { candidate: value.slice(0, end), trailing: value.slice(end) }
}

function encodedTarget(raw: string, context: FileCandidateContext) {
  const target = parseFileTarget(raw, { context, source: 'message', intent: 'preview' })
  if (!target) return null
  return encodeURIComponent(JSON.stringify(target))
}

function linkNode(raw: string, context: FileCandidateContext, childType: 'text' | 'inlineCode'): MarkdownNode | null {
  const encoded = encodedTarget(raw, context)
  if (!encoded) return null
  return {
    type: 'link',
    url: raw,
    data: { hProperties: { 'data-file-target': encoded } },
    children: [{ type: childType, value: raw }],
  }
}

export function findFileTargetsInText(value: string) {
  FILE_CANDIDATE_PATTERN.lastIndex = 0
  const matches: Array<{ start: number; end: number; raw: string }> = []
  for (const match of value.matchAll(FILE_CANDIDATE_PATTERN)) {
    const start = match.index || 0
    const raw = match[0]
    const leading = value.slice(Math.max(0, start - 64), start)
    if (/[A-Za-z][A-Za-z0-9+.-]*:\/\/?[^\s]*$/i.test(leading)) continue
    const { candidate } = splitTrailingPunctuation(raw)
    if (!candidate || !isUnambiguousFileCandidate(candidate, 'text')) continue
    matches.push({ start, end: start + candidate.length, raw: candidate })
  }
  return matches
}

function linkifyText(value: string) {
  const matches = findFileTargetsInText(value)
  if (!matches.length) return null
  const nodes: MarkdownNode[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.start < cursor) continue
    if (match.start > cursor) nodes.push({ type: 'text', value: value.slice(cursor, match.start) })
    const link = linkNode(match.raw, 'text', 'text')
    if (link) nodes.push(link)
    else nodes.push({ type: 'text', value: match.raw })
    cursor = match.end
  }
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) })
  return nodes
}

function walk(node: MarkdownNode, parentType?: string) {
  if (!node.children) return
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]
    if (child.type === 'inlineCode' && typeof child.value === 'string' && parentType !== 'link') {
      const link = linkNode(child.value, 'inline-code', 'inlineCode')
      if (link) {
        node.children.splice(index, 1, link)
        continue
      }
    }
    if (child.type === 'text' && typeof child.value === 'string' && parentType !== 'link' && parentType !== 'code') {
      const next = linkifyText(child.value)
      if (next) {
        node.children.splice(index, 1, ...next)
        index += next.length - 1
        continue
      }
    }
    if (child.type !== 'code') walk(child, child.type)
  }
}

export function remarkFileTargets() {
  return (tree: MarkdownNode) => walk(tree)
}

export default remarkFileTargets
