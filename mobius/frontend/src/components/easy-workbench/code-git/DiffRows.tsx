import type { MouseEvent, ReactNode } from 'react'
import { useCodeArtifactOpen } from '../code-artifacts/CodeArtifactOpenContext'
import { targetFromTrustedPath, type CodeArtifactTarget } from '../code-artifacts/file-target'

export type UnifiedDiffRowKind = 'meta' | 'hunk' | 'added' | 'removed' | 'context' | 'no-newline'

export type UnifiedDiffRow = {
  key: string
  kind: UnifiedDiffRowKind
  raw: string
  text: string
  oldLine: number | null
  newLine: number | null
  oldCount?: number
  newCount?: number
}

export type UnifiedDiffModel = {
  rows: UnifiedDiffRow[]
  oldPath: string | null
  newPath: string | null
  displayPath: string
  hasHunks: boolean
  binary: boolean
  renamed: boolean
  added: boolean
  deleted: boolean
}

export type UnifiedDiffFile = {
  path: string
  oldPath: string | null
  newPath: string | null
  diff: string
  model: UnifiedDiffModel
}

export function unifiedDiffNoHunkMessage(model: UnifiedDiffModel) {
  if (model.binary) return '这是二进制文件变更，Git 没有可显示的文本 hunk。'
  if (model.renamed) return '文件已重命名，本次没有额外的文本 hunk。'
  if (model.added) return '这是新文件记录，本次没有可显示的文本 hunk。'
  if (model.deleted) return '这是删除文件记录，本次没有可显示的文本 hunk。'
  return '当前 diff 只包含文件元数据，没有 unified hunk。'
}

function parseCount(value: string | undefined) {
  if (!value) return 1
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 1
}

function parseHunkHeader(raw: string) {
  const match = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
  if (!match) return null
  return {
    oldStart: Number.parseInt(match[1], 10),
    oldCount: parseCount(match[2]),
    newStart: Number.parseInt(match[3], 10),
    newCount: parseCount(match[4]),
  }
}

function decodeGitPath(value: string) {
  const trimmed = value.trim().replace(/\t.*$/, '')
  if (trimmed === '/dev/null') return null
  let decoded = trimmed
  if (decoded.startsWith('"') && decoded.endsWith('"')) {
    try { decoded = JSON.parse(decoded) } catch { decoded = decoded.slice(1, -1) }
  }
  return decoded.replace(/^[ab]\//, '')
}

function diffHeaderPaths(raw: string) {
  const match = raw.match(/^diff --git ("(?:\\.|[^"\\])*"|\S+) ("(?:\\.|[^"\\])*"|\S+)$/)
  if (!match) return null
  return { oldPath: decodeGitPath(match[1]), newPath: decodeGitPath(match[2]) }
}

export function parseUnifiedDiff(diff: string, fallbackPath = ''): UnifiedDiffModel {
  const rows: UnifiedDiffRow[] = []
  let oldPath: string | null = fallbackPath || null
  let newPath: string | null = fallbackPath || null
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  let binary = false
  let renamed = false
  let added = false
  let deleted = false

  const rawLines = String(diff || '').split('\n')
  rawLines.forEach((raw, index) => {
    if (index === rawLines.length - 1 && raw === '') return

    const headerPaths = diffHeaderPaths(raw)
    if (headerPaths) {
      oldPath = headerPaths.oldPath || oldPath
      newPath = headerPaths.newPath || newPath
    } else if (raw.startsWith('--- ')) {
      oldPath = decodeGitPath(raw.slice(4))
      if (oldPath === null) added = true
    } else if (raw.startsWith('+++ ')) {
      newPath = decodeGitPath(raw.slice(4))
      if (newPath === null) deleted = true
    } else if (raw.startsWith('rename from ')) {
      oldPath = decodeGitPath(raw.slice('rename from '.length))
      renamed = true
    } else if (raw.startsWith('rename to ')) {
      newPath = decodeGitPath(raw.slice('rename to '.length))
      renamed = true
    } else if (raw.startsWith('new file mode ')) {
      added = true
    } else if (raw.startsWith('deleted file mode ')) {
      deleted = true
    }

    if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') binary = true

    if (raw.startsWith('@@')) {
      const hunk = parseHunkHeader(raw)
      if (hunk) {
        oldLine = hunk.oldStart
        newLine = hunk.newStart
        inHunk = true
        rows.push({
          key: `h-${index}`,
          kind: 'hunk',
          raw,
          text: raw,
          oldLine: hunk.oldStart,
          newLine: hunk.newStart,
          oldCount: hunk.oldCount,
          newCount: hunk.newCount,
        })
        return
      }
    }

    if (inHunk && raw.startsWith('+') && !raw.startsWith('+++')) {
      rows.push({ key: `a-${index}`, kind: 'added', raw, text: raw.slice(1), oldLine: null, newLine: newLine++ })
      return
    }
    if (inHunk && raw.startsWith('-') && !raw.startsWith('---')) {
      rows.push({ key: `r-${index}`, kind: 'removed', raw, text: raw.slice(1), oldLine: oldLine++, newLine: null })
      return
    }
    if (inHunk && raw.startsWith(' ')) {
      rows.push({ key: `c-${index}`, kind: 'context', raw, text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ })
      return
    }
    if (inHunk && raw.startsWith('\\ No newline at end of file')) {
      rows.push({ key: `n-${index}`, kind: 'no-newline', raw, text: raw, oldLine: null, newLine: null })
      return
    }

    inHunk = false
    rows.push({ key: `m-${index}`, kind: 'meta', raw, text: raw, oldLine: null, newLine: null })
  })

  if (added) oldPath = null
  if (deleted) newPath = null
  return {
    rows,
    oldPath,
    newPath,
    displayPath: newPath || oldPath || fallbackPath,
    hasHunks: rows.some(row => row.kind === 'hunk'),
    binary,
    renamed,
    added,
    deleted,
  }
}

export function splitUnifiedDiffFiles(diff: string): UnifiedDiffFile[] {
  const lines = String(diff || '').split('\n')
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (line.startsWith('diff --git ')) starts.push(index)
  })
  if (!starts.length) return []

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length
    const section = lines.slice(start, end).join('\n').replace(/\n+$/, '')
    const model = parseUnifiedDiff(section)
    return {
      path: model.newPath || model.oldPath || `变更 ${index + 1}`,
      oldPath: model.oldPath,
      newPath: model.newPath,
      diff: section,
      model,
    }
  })
}

function artifactTarget(path: string, line: number | null, endLine: number | null = null): CodeArtifactTarget | null {
  const target = targetFromTrustedPath(path, { intent: 'preview', source: 'diff' })
  return target ? { ...target, line, endLine } : null
}

function DiffLocationLink({ target, children, label }: {
  target: CodeArtifactTarget | null
  children: ReactNode
  label: string
}) {
  const artifactOpen = useCodeArtifactOpen()
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (target) artifactOpen?.openArtifact({ target, trigger: event.currentTarget })
  }
  return (
    <button
      type="button"
      className="git-diff-location"
      onClick={open}
      disabled={!target || !artifactOpen}
      aria-label={label}
      data-file-path={target?.path}
      data-file-line={target?.line ?? undefined}
      data-file-end-line={target?.endLine ?? undefined}
    >
      {children}
    </button>
  )
}

export function DiffRows({ model, fallbackPath, selection, onSelectRow }: {
  model: UnifiedDiffModel
  fallbackPath: string
  selection?: { start: number; end: number } | null
  onSelectRow?: (index: number, extend: boolean) => void
}) {
  return (
    <div className="git-diff-rows min-w-max py-1 font-mono text-[11px] leading-[1.45]" role="listbox" aria-label="Unified diff" aria-multiselectable="true">
      {model.rows.map((row, index) => {
        const selected = !!selection && index >= selection.start && index <= selection.end && row.kind !== 'meta' && row.kind !== 'no-newline'
        if (row.kind === 'meta' || row.kind === 'no-newline') {
          return (
            <div key={row.key} className="code-diff-line--meta grid grid-cols-[3rem_3rem_1.5rem_minmax(0,1fr)]">
              <span /><span /><span className="select-none px-1.5 text-center">·</span>
              <code className="whitespace-pre px-2 text-inherit">{row.text || ' '}</code>
            </div>
          )
        }

        if (row.kind === 'hunk') {
          const hunkPath = model.newPath || model.oldPath || fallbackPath
          const hunkLine = row.newLine ?? row.oldLine
          const hunkCount = row.newLine !== null ? row.newCount : row.oldCount
          const hunkTarget = artifactTarget(hunkPath, hunkLine, hunkLine !== null && hunkCount && hunkCount > 1 ? hunkLine + hunkCount - 1 : null)
          return (
            <div
              key={row.key}
              role="option"
              aria-selected={selected}
              className={`code-diff-line--hunk git-diff-selectable grid grid-cols-[7.5rem_minmax(0,1fr)]${selected ? ' git-diff-selectable--selected' : ''}`}
              onClick={event => onSelectRow?.(index, event.shiftKey)}
            >
              <span className="select-none px-2 text-right">hunk</span>
              <DiffLocationLink target={hunkTarget} label={`打开 ${hunkPath} hunk 起始行`}>
                <code className="whitespace-pre text-inherit">{row.text}</code>
              </DiffLocationLink>
            </div>
          )
        }

        const oldTarget = row.oldLine === null ? null : artifactTarget(model.oldPath || fallbackPath, row.oldLine)
        const newTarget = row.newLine === null ? null : artifactTarget(model.newPath || fallbackPath, row.newLine)
        const rowClass = row.kind === 'added'
          ? 'code-diff-line--added'
          : row.kind === 'removed'
            ? 'code-diff-line--removed'
            : 'code-diff-line'
        const markerClass = row.kind === 'added'
          ? 'code-diff-marker--added'
          : row.kind === 'removed'
            ? 'code-diff-marker--removed'
            : 'code-diff-line-number'
        return (
          <div
            key={row.key}
            role="option"
            aria-selected={selected}
            className={`${rowClass} git-diff-selectable grid grid-cols-[3rem_3rem_1.5rem_minmax(0,1fr)]${selected ? ' git-diff-selectable--selected' : ''}`}
            onClick={event => onSelectRow?.(index, event.shiftKey)}
          >
            <DiffLocationLink target={oldTarget} label={oldTarget ? `打开旧文件第 ${row.oldLine} 行` : '无旧文件行'}>{row.oldLine ?? ''}</DiffLocationLink>
            <DiffLocationLink target={newTarget} label={newTarget ? `打开当前文件第 ${row.newLine} 行` : '无当前文件行'}>{row.newLine ?? ''}</DiffLocationLink>
            <span className={`select-none px-1.5 text-center ${markerClass}`}>{row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ''}</span>
            <code className="whitespace-pre px-2 text-inherit">{row.text || ' '}</code>
          </div>
        )
      })}
    </div>
  )
}
