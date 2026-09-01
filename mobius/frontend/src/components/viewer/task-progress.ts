/**
 * viewer/task-progress.ts — TaskCreate/TaskUpdate 工具调用的跨条目累积 (前端兜底).
 *
 * 任务工具调用是增量语义, 单卡无法渲染完整任务列表。后端 task-state-reducer 会在
 * sidecar .mobius.jsonl 写 task_state 全量快照 (权威); 但老会话 / watcher 未覆盖的
 * 场景没有快照, 这里在 JsonlView 顶层对 visibleItems 做一次 O(n) 扫描兜底:
 *   - 原生 TaskCreate/TaskUpdate 依次喂进累积表 (与后端 reducer 同口径);
 *   - task_reminder 附件 (TUI 自产全量快照) 权威覆盖累积表;
 *   - sidecar task_state 载体条目直接登记到 anchor 卡 (权威, 覆盖兜底推断)。
 * 输出 anchor entry uuid → PlanUpdate 的 Map, 沿 props 链透传给 EntryCard,
 * 与 update_plan / task_reminder 共用同一张计划卡片。
 *
 * 注意: 前端默认只拿尾部 200 条窗口, TaskCreate 在窗口外时任务标题缺失 —
 * 这正是 sidecar 快照存在的理由 (快照紧贴 anchor, 永远同窗口)。
 */
import type { AnyEntry, JsonlViewItem, PlanUpdate } from './types'
import { extractTaskReminderSnapshot, extractTaskToolCalls } from './entry-extract'

export type TaskPlanByUuid = Map<string, PlanUpdate>

export function buildTaskPlans(visibleItems: JsonlViewItem[]): TaskPlanByUuid {
  const state = new Map<string, { id: string; subject: string; status: string; description?: string; activeForm?: string; blocks?: string[]; blockedBy?: string[] }>()
  const plans: TaskPlanByUuid = new Map()

  for (const item of visibleItems) {
    const entry: AnyEntry = item.entry

    // sidecar task_state 载体条目: timestamp 与原生条目相同, 排序后紧跟原生卡。
    // 顺序上它出现在原生卡之后 → 直接把快照写到 anchor (mobius.anchor_uuid)。
    if (entry?.type === 'task_state') {
      const tasks = entry?.mobius?.tasks
      const anchorUuid = typeof entry?.mobius?.anchor_uuid === 'string' ? entry.mobius.anchor_uuid : null
      if (anchorUuid && Array.isArray(tasks) && tasks.length > 0) {
        const plan = snapshotToPlan(tasks)
        if (plan) plans.set(anchorUuid, plan)
      }
      continue
    }

    // task_reminder 附件 (非空 content): TUI 自产的全量任务快照, 权威覆盖累积表。
    const reminder = extractTaskReminderSnapshot(entry)
    if (reminder) {
      state.clear()
      for (const task of reminder) state.set(task.id, task)
      continue
    }

    // 原生任务工具调用: 喂累积表, 并给该卡登记一份当时的全量快照 (兜底; 若后端
    // sidecar 快照稍后到达会以 anchor_uuid 覆盖同 key)。
    const calls = extractTaskToolCalls(entry)
    if (calls.length === 0) continue
    applyCalls(state, calls)
    const uuid = typeof entry?.uuid === 'string' ? entry.uuid : null
    if (uuid) {
      const plan = snapshotToPlan([...state.values()])
      if (plan) plans.set(uuid, plan)
    }
  }
  return plans
}

// 与 viewer/types PlanStep 的字段同构的轻量转换 (不直接 import buildPlanUpdate,
// 保持本模块对 entry-extract 的依赖最小)。
function snapshotToPlan(tasks: any[]): PlanUpdate | null {
  if (!Array.isArray(tasks) || tasks.length === 0) return null
  const steps = tasks
    .filter((task) => task && typeof task === 'object')
    .map((task) => ({
      step: typeof task.subject === 'string' && task.subject.trim() ? task.subject.trim()
        : task.id != null ? `任务 #${task.id}` : '(空任务)',
      status: task.status === 'completed' || task.status === 'in_progress' || task.status === 'pending' ? task.status : 'pending',
      id: task.id == null ? undefined : String(task.id),
      description: typeof task.description === 'string' && task.description.trim() ? task.description.trim() : undefined,
      activeForm: typeof task.activeForm === 'string' && task.activeForm.trim() ? task.activeForm.trim() : undefined,
      blocks: Array.isArray(task.blocks) ? task.blocks.map((b: any) => String(b)).filter(Boolean) : undefined,
      blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map((b: any) => String(b)).filter(Boolean) : undefined,
    }))
  if (steps.length === 0) return null
  const completed = steps.filter((s) => s.status === 'completed').length
  const inProgress = steps.filter((s) => s.status === 'in_progress').length
  return {
    steps,
    completed,
    inProgress,
    pending: steps.length - completed - inProgress,
    currentStep: steps.find((s) => s.status === 'in_progress')?.step ?? null,
  }
}

// 前端兜底 apply (与后端 reducer 同口径): TaskCreate 递增整数 id, TaskUpdate 按 taskId 打补丁。
function applyCalls(state: Map<any, any>, calls: Array<{ name: string; input: Record<string, any> }>): void {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const strList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : undefined)
  for (const call of calls) {
    const input = call.input || {}
    if (call.name === 'TaskCreate') {
      let max = 0
      for (const id of state.keys()) {
        const n = Number(id)
        if (Number.isFinite(n) && n > max) max = n
      }
      const id = String(max + 1)
      state.set(id, {
        id,
        subject: str(input.subject) || `任务 #${id}`,
        status: 'pending',
        description: str(input.description),
        activeForm: str(input.activeForm),
        blocks: strList(input.blocks),
        blockedBy: strList(input.blockedBy),
      })
      continue
    }
    const id = str(input.taskId ?? input.task_id ?? input.id)
    if (!id) continue
    const prev = state.get(id) || { id, subject: `任务 #${id}`, status: 'pending' }
    state.set(id, {
      ...prev,
      subject: str(input.subject) || prev.subject,
      description: str(input.description) || prev.description,
      activeForm: str(input.activeForm) || prev.activeForm,
      status: input.status === 'completed' || input.status === 'in_progress' || input.status === 'pending' ? input.status : prev.status,
      blocks: strList(input.blocks) || prev.blocks,
      blockedBy: strList(input.blockedBy) || prev.blockedBy,
    })
  }
}
