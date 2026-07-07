/**
 * viewer/ReadCards.tsx — Read tool_use 文件读取卡片 + 读取结果面板.
 *
 * 从 jsonl-view.tsx 拆出. 同一条 assistant entry 多个 Read 调用渲染为多张并列卡片;
 * 命中的 tool_result (ReadResultPanel) 折在卡片里展示文件内容 (带行号, 首屏截断).
 */
import { useMemo, useState } from 'react'
import { splitDiffValue, basename } from './utils'
import { ResultTextPreview } from './text-preview'
import type { ReadToolCall, BashToolResult } from './types'

export function JsonEntryReadCalls({ calls, results = [] }: { calls: ReadToolCall[]; results?: BashToolResult[] }) {
  return (
    <div className="flex flex-col gap-2">
      {calls.map((call, idx) => {
        const callResults = results.filter((result) => {
          if (result.toolUseId && call.id) return result.toolUseId === call.id
          return calls.length === 1
        })
        return (
          <ReadCallCard
            key={(call.id || `read-${idx}`) + idx}
            call={call}
            index={calls.length > 1 ? idx + 1 : null}
            results={callResults}
          />
        )
      })}
    </div>
  )
}

function ReadCallCard({ call, index, results = [] }: { call: ReadToolCall; index: number | null; results?: BashToolResult[] }) {
  const [copied, setCopied] = useState<boolean>(false)
  const meta = [
    call.offset != null ? `offset ${call.offset}` : '',
    call.limit != null ? `limit ${call.limit}` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div className="overflow-hidden rounded bg-[var(--prose-bg)] ring-0 ring-[var(--border-color)]/70">
      <div className="flex min-w-0 items-start gap-2 border-b border-[var(--border-color)] px-2.5 py-1.5 text-[10px]">
        <div className="min-w-0 flex-1">
          {index != null && (
            <div className="font-mono text-[10px] text-[var(--text-muted)]">#{index}</div>
          )}
          <div className="truncate font-mono text-[12px] font-semibold text-[var(--text-secondary)]" title={call.filePath}>
            {basename(call.filePath)}
          </div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-muted)]" title={call.filePath}>
            {call.filePath}
          </div>
        </div>
        {meta && (
          <span className="flex-shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
            {meta}
          </span>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            navigator.clipboard.writeText(call.filePath).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1000)
            })
          }}
          className="flex-shrink-0 rounded border border-[var(--border-color)] px-2 py-0.5 text-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-secondary)]"
          title="复制文件路径到剪贴板"
        >
          {copied ? '已复制 ✓' : '复制路径'}
        </button>
      </div>
      {results.length > 0 ? (
        <div>
          {results.map((result, idx) => (
            <ReadResultPanel key={`${result.toolUseId || 'read-result'}-${result.lineNo}-${idx}`} result={result} fallbackPath={call.filePath} />
          ))}
        </div>
      ) : (
        <div className="px-2.5 py-2 text-[11px] font-mono text-[var(--text-muted)]">
          等待读取结果
        </div>
      )}
    </div>
  )
}

function ReadResultPanel({ result, fallbackPath }: { result: BashToolResult; fallbackPath: string }) {
  const [copied, setCopied] = useState<boolean>(false)
  const readFile = result.readFile
  const filePath = readFile?.filePath || fallbackPath
  const text = readFile?.content || result.content
  const startLine = readFile?.startLine || 1
  const lines = splitDiffValue(text)
  const stateLabel = result.isError ? 'error' : 'ok'
  const stateClass = result.isError ? 'text-red-300' : 'text-emerald-300'

  return (
    <div className="border-t border-[var(--border-color)]/70 first:border-t-0">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[10px]">
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-secondary)]" title={filePath}>
          读取结果
          <span className="ml-1 text-[var(--text-muted)]">#{result.lineNo}</span>
        </span>
        <span className={`flex-shrink-0 font-mono ${stateClass}`}>{stateLabel}</span>
        <span className="flex-shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
          {lines.length} lines
        </span>
        {readFile?.totalLines != null && (
          <span className="flex-shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
            total {readFile.totalLines}
          </span>
        )}
        {text && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              navigator.clipboard.writeText(text).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1000)
              })
            }}
            className="flex-shrink-0 rounded border border-[var(--border-color)] px-2 py-0.5 text-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-secondary)]"
            title="复制读取内容到剪贴板"
          >
            {copied ? '已复制 ✓' : '复制内容'}
          </button>
        )}
      </div>
      {text ? (
        <div className="max-h-[34rem] overflow-auto">
          <ResultTextPreview text={text} startLine={startLine} />
        </div>
      ) : (
        <div className="px-2.5 pb-2 text-[11px] font-mono text-[var(--text-muted)]">
          无内容
        </div>
      )}
    </div>
  )
}
