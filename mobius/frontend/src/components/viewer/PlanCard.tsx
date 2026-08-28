/**
 * viewer/PlanCard.tsx — codex 计划模式 (update_plan function_call) 的可视化卡片.
 *
 * 把 update_plan 的 {plan:[{step,status}]} 渲染成步骤列表:
 *  - completed  → 绿勾
 *  - in_progress → 蓝色旋转
 *  - pending    → 灰色空心圈
 * 顶部展示进度条与各类计数, 让分步计划的进展一眼可扫.
 */
import { Check, Loader2, Circle } from 'lucide-react'
import type { PlanUpdate, PlanStep, PlanStepStatus } from './types'

type StatusMeta = {
  label: string
  icon: typeof Check
  iconClass: string
  spin: boolean
  textClass: string
  badgeClass: string
}

const STATUS_META: Record<PlanStepStatus, StatusMeta> = {
  completed: {
    label: '已完成',
    icon: Check,
    iconClass: 'text-emerald-400',
    spin: false,
    textClass: 'text-[var(--text-secondary)]',
    badgeClass: 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-300',
  },
  in_progress: {
    label: '进行中',
    icon: Loader2,
    iconClass: 'text-blue-400',
    spin: true,
    textClass: 'text-[var(--text-primary)] font-medium',
    badgeClass: 'border-blue-500/30 bg-blue-500/[0.08] text-blue-300',
  },
  pending: {
    label: '待处理',
    icon: Circle,
    iconClass: 'text-[var(--text-muted)]',
    spin: false,
    textClass: 'text-[var(--text-muted)]',
    badgeClass: 'border-[var(--border-color)] text-[var(--text-muted)]',
  },
}

function PlanRow({ index, step }: { index: number; step: PlanStep }) {
  const meta = STATUS_META[step.status]
  const Icon = meta.icon
  // 有 id 用任务 id (#6), 否则用顺序序号 (codex update_plan 无 id).
  const label = step.id ? `#${step.id}` : String(index)
  const detail = step.description || step.activeForm
  const depParts: string[] = []
  if (step.blocks?.length) depParts.push(`阻塞 ${step.blocks.map((b) => '#' + b).join(' ')}`)
  if (step.blockedBy?.length) depParts.push(`被阻塞 ${step.blockedBy.map((b) => '#' + b).join(' ')}`)
  return (
    <div className="flex items-start gap-2 px-2.5 py-1.5 border-b border-[var(--border-color)]/40 last:border-b-0">
      <span className="mt-0.5 flex-shrink-0 min-w-[1.25rem] text-right font-mono text-[10px] leading-[1.35] text-[var(--text-muted)] select-none">{label}</span>
      <Icon
        className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${meta.iconClass}${meta.spin ? ' animate-spin' : ''}`}
        strokeWidth={2.4}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <span className={`min-w-0 flex-1 text-[11.5px] leading-snug break-words ${meta.textClass}`}>
            {step.step}
          </span>
          <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-mono leading-none ${meta.badgeClass}`}>
            {meta.label}
          </span>
        </div>
        {detail && (
          <div className="mt-0.5 text-[10.5px] leading-snug text-[var(--text-muted)] break-words">
            {detail}
          </div>
        )}
        {depParts.length > 0 && (
          <div className="mt-0.5 text-[9px] font-mono text-[var(--text-dimmed)]">{depParts.join(' · ')}</div>
        )}
      </div>
    </div>
  )
}

export function JsonEntryPlanCard({ plan }: { plan: PlanUpdate }) {
  const total = plan.steps.length
  const pct = total > 0 ? Math.round((plan.completed / total) * 100) : 0
  const allDone = plan.completed === total && total > 0
  return (
    <div className="overflow-hidden rounded bg-[var(--prose-bg)] ring-0 ring-[var(--border-color)]/70">
      <div className="border-b border-[var(--border-color)] px-2.5 py-1.5">
        <div className="flex items-center gap-2 text-[10px]">
          <span className={`font-semibold ${allDone ? 'text-emerald-300' : 'text-violet-300'}`}>
            {allDone ? '计划已完成' : '计划模式'}
          </span>
          <span className="font-mono text-emerald-300/80">{plan.completed}/{total} 完成</span>
          {plan.inProgress > 0 && (
            <span className="font-mono text-blue-300/80">{plan.inProgress} 进行中</span>
          )}
          {plan.pending > 0 && (
            <span className="font-mono text-[var(--text-muted)]">{plan.pending} 待处理</span>
          )}
          <span className="ml-auto font-mono text-[var(--text-muted)]">{pct}%</span>
        </div>
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--border-color)]/50">
          <div
            className={`h-full rounded-full transition-all ${allDone ? 'bg-emerald-400/70' : 'bg-violet-400/70'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div>
        {plan.steps.map((step, idx) => (
          <PlanRow key={idx} index={idx + 1} step={step} />
        ))}
      </div>
    </div>
  )
}
