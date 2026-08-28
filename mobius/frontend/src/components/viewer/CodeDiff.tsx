/**
 * viewer/CodeDiff.tsx — Edit tool_use / patch_apply_end 的代码差异渲染.
 *
 * 从 jsonl-view.tsx 拆出. buildStringDiffRows / buildUnifiedDiffRows 把 old/new 或 unified
 * diff 拆成带行号的 DiffRow[]; JsonEntryCodeDiff 渲染成多文件并排差异块. 仅此卡片用到,
 * 故 diff 行构建逻辑也内聚在这里.
 */
import { useMemo } from 'react'
import { diffLines } from 'diff'
import { splitDiffValue, parseUnifiedHunkHeader, basename } from './utils'
import type { DiffRow, CodeEdit, StringCodeEditFile, UnifiedCodeEditFile } from './types'

function buildStringDiffRows(file: StringCodeEditFile): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 1
  let newLine = 1
  diffLines(file.oldString, file.newString, { newlineIsToken: true }).forEach((change, changeIdx) => {
    const kind = change.added ? 'added' : change.removed ? 'removed' : 'same'
    splitDiffValue(change.value).forEach((line, lineIdx) => {
      rows.push({
        key: `${changeIdx}-${lineIdx}`,
        kind,
        oldLine: kind === 'added' ? '' : oldLine++,
        newLine: kind === 'removed' ? '' : newLine++,
        text: line,
      })
    })
  })
  return rows
}

function buildUnifiedDiffRows(file: UnifiedCodeEditFile): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 1
  let newLine = 1
  file.unifiedDiff.split('\n').forEach((rawLine, idx) => {
    if (rawLine === '') return
    if (rawLine.startsWith('---') || rawLine.startsWith('+++')) return
    if (rawLine.startsWith('@@')) {
      const header = parseUnifiedHunkHeader(rawLine)
      if (header) {
        oldLine = header.oldStart
        newLine = header.newStart
      }
      rows.push({
        key: `h-${idx}`,
        kind: 'hunk',
        oldLine: '',
        newLine: '',
        text: rawLine,
      })
      return
    }
    if (rawLine.startsWith('+')) {
      rows.push({ key: `a-${idx}`, kind: 'added', oldLine: '', newLine: newLine++, text: rawLine.slice(1) })
      return
    }
    if (rawLine.startsWith('-')) {
      rows.push({ key: `r-${idx}`, kind: 'removed', oldLine: oldLine++, newLine: '', text: rawLine.slice(1) })
      return
    }
    rows.push({
      key: `s-${idx}`,
      kind: 'same',
      oldLine: oldLine++,
      newLine: newLine++,
      text: rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine,
    })
  })
  return rows
}

function CodeDiffRows({ rows }: { rows: DiffRow[] }) {
  return (
    <>
      {rows.map((row) => {
        const rowClass =
          row.kind === 'added'
            ? 'code-diff-line--added'
            : row.kind === 'removed'
              ? 'code-diff-line--removed'
              : row.kind === 'hunk'
                ? 'code-diff-line--hunk'
                : 'code-diff-line'
        const markerClass =
          row.kind === 'added'
            ? 'code-diff-marker--added'
            : row.kind === 'removed'
              ? 'code-diff-marker--removed'
              : row.kind === 'hunk'
                ? 'code-diff-marker--hunk'
                : 'code-diff-line-number'
        return (
          <div key={row.key} className={`grid grid-cols-[3rem_3rem_1.5rem_minmax(0,1fr)] ${rowClass}`}>
            <span className="code-diff-line-number select-none border-r border-[var(--border-color)]/50 px-2 text-right">
              {row.oldLine}
            </span>
            <span className="code-diff-line-number select-none border-r border-[var(--border-color)]/50 px-2 text-right">
              {row.newLine}
            </span>
            <span className={`select-none px-1.5 text-center ${markerClass}`}>
              {row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : row.kind === 'hunk' ? '@' : ''}
            </span>
            <code className="whitespace-pre px-2 text-inherit">{row.text || ' '}</code>
          </div>
        )
      })}
    </>
  )
}

export function JsonEntryCodeDiff({ edit }: { edit: CodeEdit }) {
  const fileRows = useMemo(
    () => edit.files.map((file) => ({
      file,
      rows: file.kind === 'strings' ? buildStringDiffRows(file) : buildUnifiedDiffRows(file),
    })),
    [edit],
  )

  return (
    <div className="overflow-hidden rounded bg-[var(--prose-bg)] ring-0 ring-[var(--border-color)]/70">
      {fileRows.map(({ file, rows }, index) => (
        <div key={`${file.filePath || index}-${index}`} className={index > 0 ? 'border-t border-[var(--border-color)]' : ''}>
          <div className="flex min-w-0 items-center gap-2 border-b border-[var(--border-color)] px-2.5 py-1.5 text-[10px]">
            <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-secondary)]" title={file.filePath || undefined}>
              {file.filePath ? basename(file.filePath) : 'Edit'}
            </span>
            <span className="flex-shrink-0 font-mono text-red-700 dark:text-red-300">-{file.kind === 'unified' ? file.removedLineCount : file.oldLineCount}</span>
            <span className="flex-shrink-0 font-mono text-emerald-700 dark:text-emerald-300">+{file.kind === 'unified' ? file.addedLineCount : file.newLineCount}</span>
          </div>
          <div className="max-h-[34rem] overflow-auto">
            <div className="min-w-max py-1 font-mono text-[11px] leading-[1.45]">
              <CodeDiffRows rows={rows} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
