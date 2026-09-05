/**
 * services/task-state-reducer.ts — TaskCreate/TaskUpdate 工具调用的任务状态累积器.
 *
 * 背景: Claude Code 的任务工具调用是"增量"语义 — TaskCreate 只带 subject/description
 * (id 由 TUI 分配, 不回写在该条目里), TaskUpdate 只带 {taskId, status, ...}。单条 jsonl
 * entry 无法渲染成完整任务列表; 标题在几百行之前的 TaskCreate 里。
 *
 * 这里在 backend 侧维护 per-session 任务表, 每见到一条任务工具调用就产出一个
 * "全量快照" (非 delta), 由调用方追加到 .mobius.jsonl sidecar (type: task_state):
 *   - timestamp 与触发的原生条目相同 → 合并排序时紧跟原生卡 (tie-break primary 优先);
 *   - anchor_uuid 指回原生条目, 前端据此把快照渲染到原生卡上 (计划卡片);
 *   - 后端重启后状态丢失 → 首次再见任务事件时全量回放原生 jsonl 一次重建 (懒初始化),
 *     task_reminder 附件 (TUI 自产的全量快照) 优先作为权威基底。
 *
 * 纯函数 (extract/apply/replay) 与有状态入口 (TaskStateReducer) 分离, 便于单测。
 */
import * as fs from 'fs'

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export interface TaskRecord {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: TaskStatus
  blocks?: string[]
  blockedBy?: string[]
}

export type TaskToolCall = { name: 'TaskCreate' | 'TaskUpdate'; toolUseId?: string; input: Record<string, any> }

const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate'])

export function isTaskToolName(name: unknown): boolean {
  return typeof name === 'string' && TASK_TOOL_NAMES.has(name)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeStatus(raw: unknown, prev: TaskStatus): TaskStatus {
  if (raw === 'completed' || raw === 'in_progress' || raw === 'pending') return raw
  return prev
}

function strList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out = raw.map((v) => String(v)).filter(Boolean)
  return out.length > 0 ? out : undefined
}

// 从 assistant entry 抽出全部任务工具调用 (保序)。其它形态返回空数组。
export function extractTaskToolCalls(entry: any): TaskToolCall[] {
  if (!entry || entry.type !== 'assistant') return []
  const content = entry?.message?.content
  if (!Array.isArray(content)) return []
  const out: TaskToolCall[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue
    if (!isTaskToolName(block.name)) continue
    out.push({
      name: block.name,
      toolUseId: typeof block.id === 'string' && block.id ? block.id : undefined,
      input: block?.input && typeof block.input === 'object' ? block.input : {},
    })
  }
  return out
}

// task_reminder 附件 (attachment.type === 'task_reminder' 且 content 非空) 是 TUI 自产的
// 全量任务快照, 作为权威状态来源。返回 null 表示该条目不携带可用快照。
export function extractTaskReminderSnapshot(entry: any): TaskRecord[] | null {
  if (!entry || entry.type !== 'attachment') return null
  const attachment = entry?.attachment
  if (!attachment || attachment.type !== 'task_reminder') return null
  const content = attachment?.content
  if (!Array.isArray(content) || content.length === 0) return null
  const tasks: TaskRecord[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const id = str(item.id)
    if (!id) continue
    tasks.push({
      id,
      subject: str(item.subject) || `任务 #${id}`,
      description: str(item.description),
      activeForm: str(item.activeForm),
      status: normalizeStatus(item.status, 'pending'),
      blocks: strList(item.blocks),
      blockedBy: strList(item.blockedBy),
    })
  }
  return tasks.length > 0 ? tasks : null
}

function nextTaskId(state: Map<string, TaskRecord>): string {
  let max = 0
  for (const id of state.keys()) {
    const n = Number(id)
    if (Number.isFinite(n) && n > max) max = n
  }
  return String(max + 1)
}

// 按序应用一组任务工具调用 (原地修改 state)。TaskCreate 以递增整数 id 入表;
// TaskUpdate 按 taskId 打补丁, 未知 id 宽松建条 (只有 id 也能显示状态)。
function applyTaskCalls(state: Map<string, TaskRecord>, calls: TaskToolCall[]): void {
  for (const call of calls) {
    const input = call.input || {}
    if (call.name === 'TaskCreate') {
      const id = nextTaskId(state)
      state.set(id, {
        id,
        subject: str(input.subject) || `任务 #${id}`,
        description: str(input.description),
        activeForm: str(input.activeForm),
        status: 'pending',
        blocks: strList(input.blocks),
        blockedBy: strList(input.blockedBy),
      })
      continue
    }
    const id = str(input.taskId ?? input.task_id ?? input.id)
    if (!id) continue
    const prev = state.get(id) || { id, subject: `任务 #${id}`, status: 'pending' as TaskStatus }
    state.set(id, {
      ...prev,
      subject: str(input.subject) || prev.subject,
      description: str(input.description) || prev.description,
      activeForm: str(input.activeForm) || prev.activeForm,
      status: normalizeStatus(input.status, prev.status),
      blocks: strList(input.blocks) || prev.blocks,
      blockedBy: strList(input.blockedBy) || prev.blockedBy,
    })
  }
}

export { applyTaskCalls }

export function taskRecordsSorted(state: Map<string, TaskRecord>): TaskRecord[] {
  return [...state.values()].sort((a, b) => {
    const na = Number(a.id)
    const nb = Number(b.id)
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
    return a.id.localeCompare(b.id)
  })
}

// 快照签名 (anchor + 任务内容): 相同签名不重复写 sidecar, 兼容双 watcher 并发去重。
export function taskSnapshotSignature(anchorUuid: string | null | undefined, tasks: TaskRecord[]): string {
  const anchor = anchorUuid || ''
  const body = tasks
    .map((t) => [t.id, t.subject, t.status, t.description || '', t.activeForm || '', (t.blocks || []).join(','), (t.blockedBy || []).join(',')].join(''))
    .join('')
  return `${anchor}${body}`
}

// 全量回放原生 jsonl 重建任务表: 依次吸收 task_reminder 快照 (权威覆盖) 与任务工具调用。
// 只在首次遇到任务事件时执行一次 (懒初始化); 回放时当前触发行已落盘, 会被一并吸收,
// 调用方据此跳过对当前行的重复 apply (TaskCreate 双应用会凭空多出一个任务)。
export function buildTaskStateFromJsonl(jsonlPath: string): Map<string, TaskRecord> {
  const state = new Map<string, TaskRecord>()
  let raw = ''
  try { raw = fs.readFileSync(jsonlPath, 'utf8') } catch { return state }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: any
    try { entry = JSON.parse(trimmed) } catch { continue }
    const reminder = extractTaskReminderSnapshot(entry)
    if (reminder) {
      state.clear()
      for (const task of reminder) state.set(task.id, task)
      continue
    }
    const calls = extractTaskToolCalls(entry)
    if (calls.length > 0) applyTaskCalls(state, calls)
  }
  return state
}
