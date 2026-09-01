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
 * 连续去重 ("只显示最后一个"): TUI 每轮都注入 task_reminder 快照, 任务状态不变时
 * 这些快照内容完全相同 (实测一晚 26 条 reminder 只有 2 种状态) — 连续渲染成一串
 * 雷同计划卡是噪声。plan 产出后按 "计划签名" (步骤×状态) 分段, 同签名的连续段只
 * 保留段尾 (最后一张, 时间上最接近下一步动作); 段内的其余条目从 plans 里剔除
 * (task_reminder 载体本就整卡隐藏, 任务工具卡退回普通工具卡)。
 *
 * 注意: 前端默认只拿尾部 200 条窗口, TaskCreate 在窗口外时任务标题缺失 —
 * 这正是 sidecar 快照存在的理由 (快照紧贴 anchor, 永远同窗口)。
 */
import type { AnyEntry, JsonlViewItem, PlanUpdate } from './types'
import { extractTaskReminderSnapshot, extractTaskToolCalls } from './entry-extract'

export type TaskPlanByUuid = Map<string, PlanUpdate>

// buildTaskPlans 的完整产出: 保留的计划卡 (段尾) + 被去重压掉的计划载体条目
// (连续重复段的非尾部)。载体 = task_reminder 附件 / 任务工具调用卡 — 前者本就
// 整卡隐藏, 去重后无计划可渲染; 后者退回普通工具卡。suppressedTaskUuids 让
// JsonlView 把前者也从渲染序列里隐藏 (后者不受影响, 仍显示为普通卡)。
export type TaskPlansResult = { plans: TaskPlanByUuid; suppressed: Set<string> }

export function buildTaskPlans(visibleItems: JsonlViewItem[]): TaskPlansResult {
  const state = new Map<string, { id: string; subject: string; status: string; description?: string; activeForm?: string; blocks?: string[]; blockedBy?: string[] }>()
  // 候选按顺序记录 (uuid, plan, kind): 先全量产出, 再按签名分段取段尾。
  const candidates: Array<{ uuid: string; plan: PlanUpdate; kind: 'reminder' | 'tool' | 'anchor' }> = []

  // 载体类型标记: suppressed 集合只收 task_reminder 载体 (整卡隐藏的对象)。
  const pushCandidate = (uuid: string | null, plan: PlanUpdate | null, kind: 'reminder' | 'tool' | 'anchor') => {
    if (uuid && plan) candidates.push({ uuid, plan, kind })
  }

  for (const item of visibleItems) {
    const entry: AnyEntry = item.entry

    // sidecar task_state 载体条目: timestamp 与原生条目相同, 排序后紧跟原生卡。
    // 顺序上它出现在原生卡之后 → 直接把快照写到 anchor (mobius.anchor_uuid)。
    if (entry?.type === 'task_state') {
      const tasks = entry?.mobius?.tasks
      const anchorUuid = typeof entry?.mobius?.anchor_uuid === 'string' ? entry.mobius.anchor_uuid : null
      if (anchorUuid && Array.isArray(tasks) && tasks.length > 0) {
        pushCandidate(anchorUuid, snapshotToPlan(tasks), 'anchor')
      }
      continue
    }

    // task_reminder 附件 (非空 content): TUI 自产的全量任务快照, 权威覆盖累积表。
    const reminder = extractTaskReminderSnapshot(entry)
    if (reminder) {
      state.clear()
      for (const task of reminder) state.set(task.id, task)
      pushCandidate(typeof entry?.uuid === 'string' ? entry.uuid : null, snapshotToPlan(reminder), 'reminder')
      continue
    }

    // 原生任务工具调用: 喂累积表, 并给该卡登记一份当时的全量快照 (兜底; 若后端
    // sidecar 快照稍后到达会以 anchor_uuid 覆盖同 key)。
    const calls = extractTaskToolCalls(entry)
    if (calls.length === 0) continue
    applyCalls(state, calls)
    pushCandidate(typeof entry?.uuid === 'string' ? entry.uuid : null, snapshotToPlan([...state.values()]), 'tool')
  }

  return dedupeKeepLastPerRun(candidates)
}

// 计划签名: 步骤 (id+subject+status) 序列。相同签名 = 内容与状态都没变的重复注入。
function planSignature(plan: PlanUpdate): string {
  return plan.steps.map((s) => `${s.id ?? ''}|${s.step}|${s.status}`).join('\n')
}

// 同签名连续段只留段尾。相邻两个候选之间可能隔着任意多的普通条目 (Bash/Read 等),
// 但"计划签名未变"本身即意味着中间没有任务状态推进 — 仍是同一张计划的重复展示。
// 段尾同位次偏好: 段内最后一张若是 task_reminder 载体而倒数区里还有更晚的任务工具卡
// (TaskUpdate 落在 reminder 之后), 优先把计划挂到工具卡 — 工具卡陈述"谁改了状态",
// reminder 只是周期注入的镜像; 两者签名相同, 挂哪张信息量等价, 但挂工具卡让因果可见。
function dedupeKeepLastPerRun(candidates: Array<{ uuid: string; plan: PlanUpdate; kind: 'reminder' | 'tool' | 'anchor' }>): TaskPlansResult {
  const plans: TaskPlanByUuid = new Map()
  const suppressed = new Set<string>()
  let runSig: string | null = null
  let runStart = 0
  const flushRun = (endExclusive: number) => {
    if (runSig == null) return
    // 段 [runStart, endExclusive): 从尾向头找第一张非 reminder 载体 (tool/anchor);
    // 全是 reminder 则取段尾。其余 reminder 收进 suppressed (整卡隐藏)。
    let keep = endExclusive - 1
    for (let j = endExclusive - 1; j >= runStart; j--) {
      if (candidates[j].kind !== 'reminder') { keep = j; break }
    }
    plans.set(candidates[keep].uuid, candidates[keep].plan)
    for (let j = runStart; j < endExclusive; j++) {
      if (j !== keep && candidates[j].kind === 'reminder') suppressed.add(candidates[j].uuid)
    }
  }
  for (let i = 0; i <= candidates.length; i++) {
    // 尾部哨兵: 末段在循环结束时 flush
    const sig = i < candidates.length ? planSignature(candidates[i].plan) : null
    if (sig !== runSig) {
      flushRun(i)
      runSig = sig
      runStart = i
    }
  }
  return { plans, suppressed }
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
