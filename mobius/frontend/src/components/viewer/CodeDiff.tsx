/**
 * viewer/CodeDiff.tsx — Edit tool_use / patch_apply_end 的代码差异渲染.
 *
 * 从 jsonl-view.tsx 拆出。Edit 工具的 old/new 字符串先转成共享 UnifiedDiffModel；
 * unified patch 直接使用 code-git/DiffRows 的 parser 和 renderer，避免 JSONL 再维护一份行 UI。
 */
import { useMemo } from 'react'
import { diffLines } from 'diff'
import { splitDiffValue } from './utils'
import type { CodeEdit, StringCodeEditFile, UnifiedCodeEditFile } from './types'
import { targetFromTrustedPath } from '../code-artifacts/file-target'
import { CodeBlockHeader, codeLanguageFromPath } from '../code-artifacts/CodeBlock'
import { DiffRows, parseUnifiedDiff, type UnifiedDiffModel, type UnifiedDiffRow } from '../code-git/DiffRows'

function buildStringDiffRows(file: StringCodeEditFile): UnifiedDiffRow[] {
  const rows: UnifiedDiffRow[] = []
  let oldLine = 1
  let newLine = 1
  diffLines(file.oldString, file.newString, { newlineIsToken: true }).forEach((change, changeIdx) => {
    const kind = change.added ? 'added' : change.removed ? 'removed' : 'context'
    splitDiffValue(change.value).forEach((line, lineIdx) => {
      const rowOldLine = kind === 'added' ? null : oldLine++
      const rowNewLine = kind === 'removed' ? null : newLine++
      rows.push({
        key: `${changeIdx}-${lineIdx}`,
        kind,
        raw: `${kind === 'added' ? '+' : kind === 'removed' ? '-' : ' '}${line}`,
        oldLine: rowOldLine,
        newLine: rowNewLine,
        text: line,
      })
    })
  })
  return rows
}

export function buildUnifiedDiffRows(file: UnifiedCodeEditFile): UnifiedDiffRow[] {
  return parseUnifiedDiff(file.unifiedDiff, file.filePath).rows
}

function stringDiffModel(file: StringCodeEditFile): UnifiedDiffModel {
  return {
    rows: buildStringDiffRows(file),
    oldPath: file.filePath || null,
    newPath: file.filePath || null,
    displayPath: file.filePath,
    hasHunks: false,
    binary: false,
    renamed: false,
    added: false,
    deleted: false,
  }
}

export function JsonEntryCodeDiff({ edit }: { edit: CodeEdit }) {
  const fileRows = useMemo(
    () => edit.files.map((file) => ({
      file,
      model: file.kind === 'strings' ? stringDiffModel(file) : parseUnifiedDiff(file.unifiedDiff, file.filePath),
      target: file.filePath ? targetFromTrustedPath(file.filePath, { intent: 'diff', source: 'jsonl-tool' }) : null,
    })),
    [edit],
  )

  return (
    <div className="overflow-hidden rounded bg-[var(--prose-bg)] ring-0 ring-[var(--border-color)]/70">
      {fileRows.map(({ file, model, target }, index) => (
        <div key={`${file.filePath || index}-${index}`} className={index > 0 ? 'border-t border-[var(--border-color)]' : ''}>
          <CodeBlockHeader
            language={codeLanguageFromPath(file.filePath)}
            target={target}
            copySource={file.kind === 'unified' ? file.unifiedDiff : file.newString}
          >
            <span className="flex-shrink-0 font-mono text-red-700 dark:text-red-300">-{file.kind === 'unified' ? file.removedLineCount : file.oldLineCount}</span>
            <span className="flex-shrink-0 font-mono text-emerald-700 dark:text-emerald-300">+{file.kind === 'unified' ? file.addedLineCount : file.newLineCount}</span>
          </CodeBlockHeader>
          <div className="max-h-[34rem] overflow-auto">
            <DiffRows model={model} fallbackPath={file.filePath} />
          </div>
        </div>
      ))}
    </div>
  )
}
