/**
 * viewer/PendingQueueCard.tsx — 排队指令卡 (pending_round_openers 的伪组卡).
 *
 * 与 LIVE 卡保持同一形态 (rounded-lg + 呼吸点 + mono 标签 + 单行截断 + 流光),
 * 只显示最后一条待处理消息并给出总数 (等 N 条指令), 不整卡铺开全部 pending 列表.
 * 标准视图 / 简易视图 / 面板三处共用: 简易模式下由面板渲染, 以便排在 LIVE 卡之下.
 */
import type { CSSProperties } from 'react'

export function PendingQueueCard({ pending, onPauseToDequeue, easyMode = false }: {
  pending: Array<{ id: string; user_summary?: string }>
  // 闪电按钮: 打断当前 turn 并出队下一条排队指令.
  onPauseToDequeue?: () => void
  // 简易模式下左右留白与图标间距放宽一档, 与 LIVE 卡对齐 (具体数值见 index.css)
  // In easy mode the horizontal padding and gap widen one step to match the LIVE card (see index.css)
  easyMode?: boolean
}) {
  if (pending.length === 0) return null
  const last = pending[pending.length - 1]
  const count = pending.length
  return (
    <div
      className={`mb-2 rounded-lg border card-enter jsonl-live-sweep ${easyMode ? 'jsonl-pending-queue-card--easy' : ''} border-amber-500/15 bg-amber-500/[0.05] px-3 py-2 flex items-center gap-2 text-[length:var(--fs-md)]`}
      style={{ ['--live-accent' as string]: '#fbbf24' } as CSSProperties}>
      <span className="relative inline-flex w-2 h-2 flex-shrink-0">
        <span className="absolute inset-0 rounded-full bg-amber-400 animate-ping opacity-75" />
        <span className="relative inline-flex rounded-full w-2 h-2 bg-amber-400" />
      </span>
      <span className="font-mono font-semibold text-amber-300 flex-shrink-0">排队</span>
      <span className="flex-1 text-[length:var(--fs-sm)] truncate" style={{ color: 'var(--text-muted)' }} title={last?.user_summary || undefined}>
        {last?.user_summary || '(无内容)'}
      </span>
      <span className="text-[length:var(--fs-xs)] text-amber-300/80 font-mono flex-shrink-0">等 {count} 条指令</span>
      {onPauseToDequeue && (
        <button
          type="button"
          onClick={onPauseToDequeue}
          title="打断当前并出队下一条指令"
          aria-label="打断当前并出队下一条指令"
          className="flex-shrink-0 p-0.5 rounded text-amber-300 hover:bg-amber-500/20 hover:text-amber-200 transition-colors"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </button>
      )}
    </div>
  )
}
