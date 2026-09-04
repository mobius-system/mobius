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
 * 连续去重 ("只显示最后一个"), 两层规则:
 *  ① 任务推进簇: 连续的任务工具调用 (中间只隔工具回执/任务快照等非实质条目) 是
 *     agent 在一口气推进任务表 (典型: 连发 N 个 TaskCreate 建计划, 或 51→completed
 *     + 52→in_progress 背靠背) — 整簇只保留最后一张 (状态最全)。
 *  ② 同签名段: TUI 每轮注入 task_reminder 快照, 状态不变时内容完全相同 (实测一晚
 *     26 条 reminder 只有 2 种状态) — 同签名的连续段也只留一张。
 * 两层都作用在候选序列上, 被压掉的 task_reminder 载体整卡隐藏 (suppressed),
 * 任务工具卡退回普通工具卡显示 (信息不丢, 只是不再铺计划视图)。
 *
 * 注意: 前端默认只拿尾部 200 条窗口, TaskCreate 在窗口外时任务标题缺失 —
 * 这正是 sidecar 快照存在的理由 (快照紧贴 anchor, 永远同窗口)。
 */
import type { AnyEntry, JsonlViewItem, PlanUpdate } from './types'
import { extractTaskReminderSnapshot, extractTaskToolCalls } from './entry-extract'

export type TaskPlanByUuid = Map<string, PlanUpdate>

// buildTaskPlans 的完整产出: 保留的计划卡 + 被去重压掉的计划载体条目。
// 载体 = task_reminder 附件 / 任务工具调用卡 — 前者本就整卡隐藏, 去重后无计划
// 可渲染; 后者退回普通工具卡。suppressedTaskUuids 让 JsonlView 把前者也从渲染
// 序列里隐藏 (后者不受影响, 仍显示为普通卡)。
export type TaskPlansResult = { plans: TaskPlanByUuid; suppressed: Set<string> }

export function buildTaskPlans(visibleItems: JsonlViewItem[]): TaskPlansResult {
  const state = new Map<string, { id: string; subject: string; status: string; description?: string; activeForm?: string; blocks?: string[]; blockedBy?: string[] }>()
  // 候选按顺序记录 (uuid, plan, kind, cluster): cluster = 所属任务推进簇 id。
  const candidates: Array<{ uuid: string; plan: PlanUpdate; kind: 'reminder' | 'tool' | 'anchor'; cluster: number }> = []
  // 推进簇切分: 遇到"实质条目"(任务工具调用之外的 assistant 正文/工具、真实用户
  // 消息) 就开新簇; 工具回执 / task_reminder / task_state 载体不打断簇 (回执是簇内
  // 调用的镜像, reminder/载体是任务表快照, 都不是新的对话内容)。
  let clusterId = 0

  const pushCandidate = (uuid: string | null, plan: PlanUpdate | null, kind: 'reminder' | 'tool' | 'anchor', cluster: number) => {
    if (uuid && plan) candidates.push({ uuid, plan, kind, cluster })
  }

  for (const item of visibleItems) {
    const entry: AnyEntry = item.entry

    // sidecar task_state 载体条目: timestamp 与原生条目相同, 排序后紧跟原生卡。
    // 顺序上它出现在原生卡之后 → 直接把快照写到 anchor (mobius.anchor_uuid)。
    if (entry?.type === 'task_state') {
      const tasks = entry?.mobius?.tasks
      const anchorUuid = typeof entry?.mobius?.anchor_uuid === 'string' ? entry.mobius.anchor_uuid : null
      if (anchorUuid && Array.isArray(tasks) && tasks.length > 0) {
        pushCandidate(anchorUuid, snapshotToPlan(tasks), 'anchor', clusterId)
      }
      continue
    }

    // task_reminder 附件 (非空 content): TUI 自产的全量任务快照, 权威覆盖累积表。
    // 不打断推进簇 (快照是任务表的镜像, 不是新对话内容)。
    const reminder = extractTaskReminderSnapshot(entry)
    if (reminder) {
      state.clear()
      for (const task of reminder) state.set(task.id, task)
      pushCandidate(typeof entry?.uuid === 'string' ? entry.uuid : null, snapshotToPlan(reminder), 'reminder', clusterId)
      continue
    }

    // 原生任务工具调用: 喂累积表, 并给该卡登记一份当时的全量快照 (兜底; 若后端
    // sidecar 快照稍后到达会以 anchor_uuid 覆盖同 key)。
    const calls = extractTaskToolCalls(entry)
    if (calls.length > 0) {
      applyCalls(state, calls)
      pushCandidate(typeof entry?.uuid === 'string' ? entry.uuid : null, snapshotToPlan([...state.values()]), 'tool', clusterId)
      continue
    }

    // 非任务条目: 只有"实质内容"才切断推进簇 — 工具回执 (纯 tool_result user 卡)
    // 与无内容元数据 (last-prompt/ai-title/mode 等) 不切, 其余 (assistant 正文/
    // 其它工具调用/真实用户消息) 切簇。
    if (isSubstantiveEntry(entry)) clusterId += 1
  }

  return dedupePlans(candidates)
}

// "实质条目" = 会推进对话内容的东西: assistant 文本/思考/非任务工具、真实用户
// 消息、事件。纯 tool_result 回执卡与各类无内容元数据返回 false (不切簇)。
function isSubstantiveEntry(entry: AnyEntry): boolean {
  const type = entry?.type
  if (type === 'assistant') {
    const content = entry?.message?.content
    if (!Array.isArray(content)) return false
    return content.some((block: any) => {
      if (!block || typeof block !== 'object') return false
      if (block.type === 'text' || block.type === 'thinking') return true
      return block.type === 'tool_use' // 任务工具已在上方 continue, 这里是非任务工具
    })
  }
  if (type === 'user') {
    const content = entry?.message?.content
    if (Array.isArray(content)) {
      // 纯回执 (全是 tool_result) 不算实质; 含 text 块的真实用户输入算
      return content.some((block: any) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim())
    }
    return typeof content === 'string' && content.trim().length > 0
  }
  if (type === 'response_item') {
    const payload = entry?.payload
    if (payload?.type === 'message') return true
    return false
  }
  // attachment (非任务 reminder) / event_msg 等按实质处理; 无内容元数据 (last-prompt
  // / ai-title / mode / permission-mode / queue-operation / file-history-snapshot) 不切。
  const metaTypes = new Set(['last-prompt', 'ai-title', 'mode', 'permission-mode', 'queue-operation', 'file-history-snapshot', 'system', 'custom-title', 'agent-name'])
  return !metaTypes.has(String(type))
}

// 两层去重: ① 同簇只留最后一张; ② 跨簇的同签名连续段再留一张 (reminder 重复注入)。
function dedupePlans(candidates: Array<{ uuid: string; plan: PlanUpdate; kind: 'reminder' | 'tool' | 'anchor'; cluster: number }>): TaskPlansResult {
  const plans: TaskPlanByUuid = new Map()
  const suppressed = new Set<string>()

  // ① 簇内去重: 每个推进簇保留最后一张, 其余候选 (reminder 载体) 整卡隐藏,
  //    任务工具卡不加计划 (退回普通卡)。
  const clusterLast = new Map<number, number>()
  candidates.forEach((c, i) => clusterLast.set(c.cluster, i))
  const afterCluster: Array<{ uuid: string; plan: PlanUpdate; kind: 'reminder' | 'tool' | 'anchor' }> = []
  candidates.forEach((c, i) => {
    if (clusterLast.get(c.cluster) === i) {
      afterCluster.push({ uuid: c.uuid, plan: c.plan, kind: c.kind })
    } else if (c.kind === 'reminder') {
      suppressed.add(c.uuid)
    }
  })

  // ② 同签名段去重 (跨簇): reminder 重复注入仍是同签名长段。段内从尾向头优先挂
  //    非 reminder 载体 (工具卡陈述"谁改了状态"); 其余 reminder 进 suppressed。
  let runSig: string | null = null
  let runStart = 0
  const flushRun = (endExclusive: number) => {
    if (runSig == null) return
    let keep = endExclusive - 1
    for (let j = endExclusive - 1; j >= runStart; j--) {
      if (afterCluster[j].kind !== 'reminder') { keep = j; break }
    }
    plans.set(afterCluster[keep].uuid, afterCluster[keep].plan)
    for (let j = runStart; j < endExclusive; j++) {
      if (j !== keep && afterCluster[j].kind === 'reminder') suppressed.add(afterCluster[j].uuid)
    }
  }
  for (let i = 0; i <= afterCluster.length; i++) {
    const sig = i < afterCluster.length ? planSignature(afterCluster[i].plan) : null
    if (sig !== runSig) {
      flushRun(i)
      runSig = sig
      runStart = i
    }
  }
  return { plans, suppressed }
}

// 计划签名: 步骤 (id+subject+status) 序列。相同签名 = 内容与状态都没变的重复注入。
function planSignature(plan: PlanUpdate): string {
  return plan.steps.map((s) => `${s.id ?? ''}|${s.step}|${s.status}`).join('\n')
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
