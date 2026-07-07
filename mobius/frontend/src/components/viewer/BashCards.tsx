/**
 * viewer/BashCards.tsx — Claude Code Bash tool_use 命令卡片 + 返回结果面板.
 *
 * 从 jsonl-view.tsx 拆出.
 * - 同一条 assistant entry 可能含多个 Bash 调用 → 渲染为多张并列卡片, 共享 cyan 主题.
 * - 每条单独的 Bash 卡片三段式: 顶部 header (description + cwd + 行/字符数 + 复制按钮)
 *   + 命令体 (终端色 pre + bash 高亮, 长/多行命令可滚).
 * - 命令文本严格按原样展示 (引号 / && / | / 重定向 / 换行全部保留), 不执行不重写.
 */
import { Suspense, lazy, useMemo, useState } from 'react'
import { splitDiffValue, codeFence } from './utils'
import { CodePreviewRows, ResultTextPreview, CompactPlainTextFallback, WRITE_PREVIEW_LINE_LIMIT } from './text-preview'
import type { BashToolResult } from './types'
import type { BashCall } from '../jsonl-bash-helpers'

const CompactMarkdown = lazy(() => import('../jsonl-compact-markdown'))

export function JsonEntryBashCommands({ calls, results = [] }: { calls: BashCall[]; results?: BashToolResult[] }) {
  return (
    <div className="flex flex-col gap-2">
      {calls.map((call, idx) => {
        const callResults = results.filter((result) => {
          if (result.toolUseId && call.id) return result.toolUseId === call.id
          return calls.length === 1
        })
        return (
          <BashCallCard
            key={(call.id || `bash-${idx}`) + idx}
            call={call}
            index={calls.length > 1 ? idx + 1 : null}
            results={callResults}
          />
        )
      })}
    </div>
  )
}

function BashCallCard({ call, index, results = [] }: { call: BashCall; index: number | null; results?: BashToolResult[] }) {
  const [copied, setCopied] = useState<boolean>(false)
  const lines = useMemo(() => splitDiffValue(call.command), [call.command])
  // 多行脚本首屏只露前 N 行, 余下 details 折叠, 与 Write 预览行为一致.
  const previewLines = lines.slice(0, WRITE_PREVIEW_LINE_LIMIT)
  const restLines = lines.slice(WRITE_PREVIEW_LINE_LIMIT)
  const markdownSource = useMemo(() => codeFence(call.command, 'bash'), [call.command])
  const hasDescription = !!call.description
  const hasCwd = !!call.cwd

  return (
    <div className="overflow-hidden rounded bg-[var(--prose-bg)] ring-0 ring-[var(--border-color)]/70">
      <div className="flex min-w-0 items-start gap-2 border-b border-[var(--border-color)] px-2.5 py-1.5 text-[10px]">
        <div className="min-w-0 flex-1">
          {index != null && (
            <div className="font-mono text-[10px] text-[var(--text-muted)]">#{index}</div>
          )}
          {hasDescription && (
            <div className="truncate font-mono text-[12px] font-semibold text-[var(--text-secondary)]" title={call.description}>
              {call.description}
            </div>
          )}
          {hasCwd && (
            <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--text-muted)]" title={call.cwd}>
              cwd: {call.cwd}
            </div>
          )}
        </div>
        <span className="flex-shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
          {lines.length} lines
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            navigator.clipboard.writeText(call.command).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1000)
            })
          }}
          className="flex-shrink-0 text-[10px] px-2 py-0.5 rounded border border-[var(--border-color)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] transition-colors"
          title="复制完整命令到剪贴板"
        >
          {copied ? '已复制 ✓' : '复制'}
        </button>
      </div>
      <div className="max-h-[34rem] overflow-auto">
        {/* 多行命令首屏截断预览 (纯文本带行号), 折叠区里仍给完整高亮版; 单行/短命令直接全量高亮. */}
        {restLines.length > 0 ? (
          <div className="min-w-max py-1 font-mono text-[11px] leading-[1.45]">
            <CodePreviewRows lines={previewLines} />
            <details className="border-t border-[var(--border-color)]/60">
              <summary className="cursor-pointer px-2 py-1.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                展开剩余 {restLines.length} 行 (含高亮)
              </summary>
              <div className="jsonl-compact-md !text-[11px]">
                <Suspense fallback={<CompactPlainTextFallback text={call.command} />}>
                  <CompactMarkdown text={markdownSource} />
                </Suspense>
              </div>
            </details>
          </div>
        ) : (
          <div className="jsonl-compact-md !text-[11px]">
            <Suspense fallback={<CompactPlainTextFallback text={call.command} />}>
              <CompactMarkdown text={markdownSource} />
            </Suspense>
          </div>
        )}
      </div>
      {results.length > 0 && (
        <div className="border-t border-[var(--border-color)] bg-black/5 dark:bg-white/[0.02]">
          {results.map((result, idx) => (
            <BashResultPanel key={`${result.toolUseId || 'result'}-${result.lineNo}-${idx}`} result={result} />
          ))}
        </div>
      )}
    </div>
  )
}

function BashResultPanel({ result }: { result: BashToolResult }) {
  const [copied, setCopied] = useState(false)
  const stdout = result.stdout || (!result.stderr ? result.content : '')
  const stderr = result.stderr
  const copyText = [
    stdout ? `stdout:\n${stdout}` : '',
    stderr ? `stderr:\n${stderr}` : '',
  ].filter(Boolean).join('\n\n')
  const displayText = stdout || stderr || result.content
  const displayLines = splitDiffValue(displayText)
  const stateLabel = result.interrupted
    ? 'interrupted'
    : result.isError
      ? 'error'
      : result.noOutputExpected && !displayText
        ? 'no output expected'
        : 'ok'
  const stateClass = result.isError || result.interrupted
    ? 'text-red-300'
    : 'text-emerald-300'

  return (
    <div className="border-t border-[var(--border-color)]/70 first:border-t-0">
      <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[10px]">
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-secondary)]">
          返回结果
          <span className="ml-1 text-[var(--text-muted)]">#{result.lineNo}</span>
        </span>
        <span className={`flex-shrink-0 font-mono ${stateClass}`}>{stateLabel}</span>
        {displayText && (
          <>
            <span className="flex-shrink-0 rounded border border-[var(--border-color)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
              {displayLines.length} lines
            </span>
          </>
        )}
        {copyText && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              navigator.clipboard.writeText(copyText).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1000)
              })
            }}
            className="flex-shrink-0 rounded border border-[var(--border-color)] px-2 py-0.5 text-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-secondary)]"
            title="复制完整返回结果到剪贴板"
          >
            {copied ? '已复制 ✓' : '复制'}
          </button>
        )}
      </div>
      {result.imageUrls && result.imageUrls.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-2.5 py-2">
          {result.imageUrls.map((url, i) => (
            <a key={i} href={url} target="_blank" rel="noreferrer" className="block">
              <img
                src={url}
                alt={`output image ${i + 1}`}
                className="max-h-48 max-w-full rounded border border-[var(--border-color)] object-contain"
              />
            </a>
          ))}
        </div>
      ) : displayText ? (
        <div className="max-h-[34rem] overflow-auto">
          {stdout && stderr ? (
            <div>
              <div className="border-y border-[var(--border-color)]/60 px-2.5 py-1 text-[10px] font-mono text-emerald-300/90">stdout</div>
              <ResultTextPreview text={stdout} />
              <div className="border-y border-[var(--border-color)]/60 px-2.5 py-1 text-[10px] font-mono text-red-300/90">stderr</div>
              <ResultTextPreview text={stderr} />
            </div>
          ) : (
            <ResultTextPreview text={displayText} />
          )}
        </div>
      ) : (
        <div className="px-2.5 pb-2 text-[11px] font-mono text-[var(--text-muted)]">
          无输出
        </div>
      )}
    </div>
  )
}
