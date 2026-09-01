/**
 * viewer/InitialCard.tsx — 初始卡片 (首轮注入上下文消息的专属视图).
 *
 * 命中 extractInitialContext 的 user 消息不再铺原始 JSON / 整段 markdown, 而是:
 *  - 用户的问题: 主体, 默认渲染 (CompactMarkdown);
 *  - 注入上下文: 按 session-context-sections 目录切块的手风琴列表, 默认折叠,
 *    点开才渲染该块 markdown (天然规避 27KB 一次铺开; Memory 大段有独立滚动)。
 */
import { Suspense, lazy, useState } from 'react'
import {
  BookOpen,
  Brain,
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
      className="group rounded border border-[var(--border-color)]/60 bg-[var(--bg-card)]/40"
    >
      <summary className="cursor-pointer flex items-center gap-2 px-2 py-1 text-[11px] select-none">
        <Icon className="h-3 w-3 flex-shrink-0 text-orange-300/80" strokeWidth={2.2} aria-hidden="true" />
        <span className="font-medium text-[var(--text-secondary)] flex-shrink-0">{meta.label}</span>
        <span className="text-[10px] text-[var(--text-dimmed)] font-mono flex-shrink-0">{block.lineCount} 行</span>
        <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]" title={blockPreview(block)}>
          {blockPreview(block)}
        </span>
        <span className="text-[9px] text-[var(--text-dimmed)] font-mono flex-shrink-0 opacity-60 group-hover:opacity-100">
          {open ? '▲' : '▼'}
        </span>
      </summary>
      {open && block.body && (
        <div className="border-t border-[var(--border-color)]/50 px-2 py-1.5">
          <div className="max-h-[46vh] overflow-y-auto text-[12px]">
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
  return (
    <div className="overflow-hidden rounded bg-[var(--prose-bg)] ring-0 ring-[var(--border-color)]/70">
      {match.question ? (
        <div className="border-b border-[var(--border-color)] px-2.5 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[10px]">
            <UserRound className="h-3 w-3 text-orange-300" strokeWidth={2.4} aria-hidden="true" />
            <span className="font-semibold text-orange-300">用户的问题</span>
            <span className="text-[var(--text-dimmed)] font-mono">{match.question.trim().split('\n').length} 行</span>
          </div>
          <div className="max-h-[46vh] overflow-y-auto text-[12px]">
            <Suspense fallback={<CompactPlainTextFallback text={match.question} />}>
              <CompactMarkdown text={match.question} />
            </Suspense>
          </div>
        </div>
      ) : null}
      {match.blocks.length > 0 && (
        <div className="px-2.5 py-2">
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px]">
            <BookOpen className="h-3 w-3 text-[var(--text-muted)]" strokeWidth={2.2} aria-hidden="true" />
            <span className="font-semibold text-[var(--text-secondary)]">注入上下文</span>
            <span className="text-[var(--text-dimmed)] font-mono">
              {match.blocks.length} 块 · {totalChars.toLocaleString()} 字符{match.language === 'en' ? ' · EN' : ''}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            {match.blocks.map((block, idx) => (
              <InitialBlockRow key={`${block.key}#${idx}`} block={block} />
            ))}
          </div>
        </div>
      )}
      {!match.question && match.blocks.length === 0 ? (
        <div className="px-2.5 py-2 text-[11px] text-[var(--text-muted)]">
          <CompactPlainTextFallback text={match.raw} />
        </div>
      ) : null}
    </div>
  )
}
