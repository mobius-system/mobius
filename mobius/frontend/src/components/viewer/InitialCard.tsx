/**
 * viewer/InitialCard.tsx — 初始卡片 (首轮注入上下文消息的专属视图).
 *
 * 命中 extractInitialContext 的 user 消息不再铺原始 JSON / 整段 markdown, 而是:
 *  - 用户的问题: 主体, 橙色强调面板内默认渲染 (CompactMarkdown);
 *  - 注入上下文: 按 session-context-sections 目录切块的无边框手风琴列表, 默认折叠,
 *    点开才在该块内渲染 markdown (天然规避 27KB 一次铺开; 大段有独立滚动)。
 * 配色走 --initial-* 变量 (index.css 定义明暗两套), 不硬编码 tailwind 色号。
 */
import { Suspense, lazy, useState } from 'react'
import {
  BookOpen,
  Brain,
  ChevronDown,
  CircleDot,
  ClipboardList,
  FileText,
  Flag,
  FlaskConical,
  FolderKanban,
  GitBranch,
  MessagesSquare,
  Monitor,
  UserRound,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { InitialContextBlock, InitialContextMatch } from './initial-context'
import { CompactPlainTextFallback } from './text-preview'

const CompactMarkdown = lazy(() => import('../jsonl-compact-markdown'))

// 块 key → 图标 + 展示名 (UI 固定中文, 与 themes.ts 徽章惯例一致)
const BLOCK_META: Record<string, { icon: LucideIcon; label: string }> = {
  user: { icon: UserRound, label: '用户' },
  project: { icon: FolderKanban, label: '项目' },
  research: { icon: FlaskConical, label: 'Research' },
  blackboard: { icon: ClipboardList, label: '研究黑板' },
  chief: { icon: Users, label: '团队管理' },
  peers: { icon: Users, label: '研究会话' },
  memory: { icon: Brain, label: '持久记忆' },
  skills: { icon: Wrench, label: '必要技能' },
  worktree: { icon: GitBranch, label: 'Git 工作区' },
  completionFlag: { icon: Flag, label: '完成标记' },
  issue: { icon: CircleDot, label: 'Issue' },
  session: { icon: MessagesSquare, label: '会话信息' },
  pcTaskMode: { icon: Monitor, label: 'PC 任务模式' },
}

function blockPreview(block: InitialContextBlock): string {
  const first = block.body.split('\n').map((l) => l.trim()).find((l) => l) || ''
  return first.length > 72 ? `${first.slice(0, 72)}…` : first
}

function InitialBlockRow({ block }: { block: InitialContextBlock }) {
  const [open, setOpen] = useState(false)
  const meta = BLOCK_META[block.key] || { icon: FileText, label: block.title }
  const Icon = meta.icon
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="group rounded-md transition-colors hover:bg-[var(--bg-hover)]"
    >
      <summary className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-[11px] select-none">
        <span className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-[var(--initial-accent-soft)]">
          <Icon className="h-3 w-3 text-[var(--initial-accent-text)]" strokeWidth={2.2} aria-hidden="true" />
        </span>
        <span className="flex-shrink-0 font-medium text-[var(--text-secondary)]">{meta.label}</span>
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--text-muted)]" title={blockPreview(block)}>
          {blockPreview(block)}
        </span>
        <span className="flex-shrink-0 font-mono text-[9px] text-[var(--text-dimmed)]">{block.lineCount} 行</span>
        <ChevronDown
          className="h-3 w-3 flex-shrink-0 text-[var(--text-dimmed)] transition-transform group-open:rotate-180"
          strokeWidth={2.2}
          aria-hidden="true"
        />
      </summary>
      {open && block.body && (
        <div className="mx-1.5 mb-1 mt-0.5 rounded-md border border-[var(--border-color)] bg-[var(--prose-bg)] px-2.5 py-2">
          <div className="max-h-[46vh] overflow-y-auto text-[12px] leading-relaxed">
            <Suspense fallback={<CompactPlainTextFallback text={block.body} />}>
              <CompactMarkdown text={block.body} />
            </Suspense>
          </div>
        </div>
      )}
    </details>
  )
}

export function JsonEntryInitialCard({ match }: { match: InitialContextMatch }) {
  const totalChars = match.blocks.reduce((acc, b) => acc + b.body.length, 0)
  const questionLines = match.question.trim() ? match.question.trim().split('\n').length : 0
  return (
    <div className="jsonl-initial-card flex flex-col gap-2 px-1 pb-1.5 pt-1">
      {match.question ? (
        <div className="rounded-lg border border-[var(--initial-accent-border)] bg-[var(--initial-question-bg)] px-3 py-2">
          <div className="mb-1.5 flex items-center gap-1.5">
            <UserRound className="h-3.5 w-3.5 flex-shrink-0 text-[var(--initial-accent)]" strokeWidth={2.4} aria-hidden="true" />
            <span className="text-[10px] font-semibold tracking-wide text-[var(--initial-accent-text)]">用户的初始请求</span>
            <span className="ml-auto font-mono text-[9px] text-[var(--text-dimmed)]">{questionLines} 行</span>
          </div>
          <div className="max-h-[46vh] overflow-y-auto text-[12.5px] leading-relaxed">
            <Suspense fallback={<CompactPlainTextFallback text={match.question} />}>
              <CompactMarkdown text={match.question} />
            </Suspense>
          </div>
        </div>
      ) : null}
      {match.blocks.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-2 px-1.5">
            <BookOpen className="h-3 w-3 flex-shrink-0 text-[var(--text-muted)]" strokeWidth={2.2} aria-hidden="true" />
            <span className="flex-shrink-0 text-[10px] font-semibold text-[var(--text-secondary)]">注入上下文</span>
            <span className="flex-shrink-0 font-mono text-[9px] text-[var(--text-dimmed)]">
              {match.blocks.length} 块 · {totalChars.toLocaleString()} 字符{match.language === 'en' ? ' · EN' : ''}
            </span>
            <span className="h-px min-w-4 flex-1 bg-[var(--border-color)]" />
          </div>
          <div className="flex flex-col gap-0.5">
            {match.blocks.map((block, idx) => (
              <InitialBlockRow key={`${block.key}#${idx}`} block={block} />
            ))}
          </div>
        </div>
      )}
      {!match.question && match.blocks.length === 0 ? (
        <div className="px-1.5 py-1 text-[11px] text-[var(--text-muted)]">
          <CompactPlainTextFallback text={match.raw} />
        </div>
      ) : null}
    </div>
  )
}
