/**
 * viewer/types.ts — jsonl 视图各模块共享的类型定义.
 *
 * 从 jsonl-view.tsx 拆出, 集中放置纯类型, 让 entry-extract / entry-classify /
 * header-summary / 各卡片组件都从这一处 import, 避免类型分散重复定义.
 */

export type AnyEntry = Record<string, any>
export type CardMode = 'compact' | 'field' | 'code' | 'image' | 'plan' | 'initial'

export type CodeEditFile =
  | {
    kind: 'strings'
    filePath: string
    oldString: string
    newString: string
    oldLineCount: number
    newLineCount: number
  }
  | {
    kind: 'unified'
    filePath: string
    unifiedDiff: string
    oldLineCount: number
    newLineCount: number
    addedLineCount: number
    removedLineCount: number
  }

export type CodeEdit = {
  files: CodeEditFile[]
  displayPath: string
  sourceLength: number
}

export type WriteToolCall = {
  filePath: string
  content: string
  lineCount: number
  charCount: number
}

export type ReadFileResult = {
  filePath: string
  content: string
  numLines?: number
  startLine?: number
  totalLines?: number
}

export type BashToolResult = {
  entry: AnyEntry
  lineNo: number
  toolUseId?: string
  parentUuid?: string
  sourceAssistantUuid?: string
  stdout: string
  stderr: string
  content: string
  isError: boolean
  interrupted: boolean
  isImage: boolean
  imageUrls?: string[]
  noOutputExpected: boolean
  readFile?: ReadFileResult
  // aimux exec 信封 ({"output":..., "wall_time_seconds":..., "exit_code":...}) 解包后的执行元信息.
  // 命中信封时 stdout/content 已是解包后的 output 正文, 这里补充耗时/tokens/退出码供结果面板展示.
  meta?: BashResultMeta[]
}

// Bash/AIMUX 返回结果面板头部的执行元信息徽章 (label + value, 如 耗时 6.4s / exit 0).
export type BashResultMeta = { label: string; value: string }

export type ReadToolCall = {
  id?: string
  filePath: string
  offset?: number
  limit?: number
}

// ── codex 计划模式 (update_plan function_call) ──────────────────────────
// codex 在执行任务时通过 update_plan function_call 发布/更新一个分步计划,
// arguments 是 JSON 字符串 {"plan":[{"step": "...", "status": "completed|in_progress|pending"}, ...]}.
export type PlanStepStatus = 'completed' | 'in_progress' | 'pending'

export type PlanStep = {
  step: string
  status: PlanStepStatus
  // Claude Code task_reminder 附件的额外字段 (codex update_plan 不带, 全部可选):
  id?: string                 // 任务 id (task_reminder.content[].id)
  description?: string        // 任务详情 (task_reminder.content[].description)
  activeForm?: string         // 进行式短语 (task_reminder.content[].activeForm)
  blocks?: string[]           // 阻塞了哪些任务 id
  blockedBy?: string[]        // 被哪些任务 id 阻塞
}

export type PlanUpdate = {
  steps: PlanStep[]
  completed: number
  inProgress: number
  pending: number
  currentStep: string | null  // 当前 in_progress 的步骤文案 (没有则为 null)
}

export type JsonlViewItem = {
  entry: AnyEntry
  lineNo: number
  bashResults?: BashToolResult[]
  readResults?: BashToolResult[]
}

export type DiffRow = {
  key: string
  kind: 'added' | 'removed' | 'same' | 'hunk'
  oldLine: number | ''
  newLine: number | ''
  text: string
}

export type UnifiedHunkHeader = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

export type StringCodeEditFile = Extract<CodeEditFile, { kind: 'strings' }>
export type UnifiedCodeEditFile = Extract<CodeEditFile, { kind: 'unified' }>

// 卡片标题栏摘要: full 是不截断版, short 是给标题栏一行用的截断版.
export type HeaderSummary = { short: string; shortTail: string; full: string; truncated: boolean; canCompact: boolean }

// 本地命令产物标签 (从 user 消息 content 提取的 <local-command-*> / <command-*> 标签).
export type LocalCommandPart = { tag: string; body: string }

// ── 对话轮次分组 ──────────────────────────────────────────────────────────
// 每条 user entry 开启一个新"轮次"; 其后的 assistant/tool 条目属于该轮的回复.
export interface RoundItem {
  entry: AnyEntry
  bashResults?: BashToolResult[]
  readResults?: BashToolResult[]
  relIdx: number  // 0 = 该轮用户问题, 1+ = agent 回复
  lineNo: number  // 全局行号 (1-based)
}

// 巨轮渲染窗口跳过的一段内容. at = 提示行插在 round.items 中的下标 (0..items.length),
// count = 被跳过的原始条目数. 渲染层在 at 处插一张"本轮过长"提示卡 (见 RoundGroups.HiddenGapCard).
export interface RoundHiddenGap {
  at: number
  count: number
}

export interface Round {
  roundNum: number  // 可见窗口内 1-based 编号
  items: RoundItem[]
  // 条目数超过渲染窗口上限时, 被窗口跳过的中段会在这里留下标记 (没有跳过则缺省).
  hiddenGaps?: RoundHiddenGap[]
}

export type JsonlRenderBlock =
  | { key: string; kind: 'continuation'; items: JsonlViewItem[] }
  | { key: string; kind: 'preItem'; item: JsonlViewItem }
  | { key: string; kind: 'round'; round: Round; index: number }
  | { key: string; kind: 'pending'; pending: { id: string; user_summary: string }[] }
