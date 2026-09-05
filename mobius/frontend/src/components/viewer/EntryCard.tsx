/**
 * viewer/EntryCard.tsx — 单条 entry 卡片 (jsonl 视图的核心卡片).
 *
 * 从 jsonl-view.tsx 拆出. 设计要点 (原文件顶部注释):
 *  - 每条 entry 一张卡片. 卡片顶端: 类型徽章 + 时间戳 + 行号.
 *  - 顶层 type 字段决定卡片整体配色, 方便快扫; 各类 tool_use / 系统提醒 / 关键回复有专属特例配色
 *    (见 ./themes); 配色优先级见下方 theme 解析.
 *  - 卡片整体默认折叠, 唯独"第一张 user 卡片"(会话起始 prompt) 与"最后一张 assistant 卡片"(最新回复)
 *    默认展开; 展开态受控于卡片本地 state, 用户手动折叠后保持折叠, 不被实时轮询重渲染强制掀开.
 *  - 展开后默认: 可代码 → 代码模式; 可精简 → 精简模式; 其它 → 字段模式 (递归 KeyNode).
 *  - 超大卡片保护: entry + 工具结果渲染字符总量超 10 万时截断后再渲染, 避免前端卡顿崩溃.
 */
import { Suspense, lazy, memo, useEffect, useMemo, useRef, useState } from 'react'
import { Code2, ListChecks, AlignLeft, Braces, BookOpen, Image as ImageIcon, Check, Loader2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { BLACKBOARD_MARKER } from '../jsonl-round-helpers'
import {
  TYPE_THEME,
  DEFAULT_THEME,
  EDIT_TOOL_THEME,
  AIMUX_PATCH_THEME,
  START_PY_THEME,
  BASH_TOOL_THEME,
  AIMUX_COMMAND_THEME,
  READ_TOOL_THEME,
  CONTEXT_COMPACTED_THEME,
  ASSISTANT_END_TURN_THEME,
  THINKING_ONLY_THEME,
  COMPACT_DONE_THEME,
  GOAL_SET_THEME,
  LOCAL_COMMAND_THEME,
  ASSISTANT_RESPONSE_KEYWORD_THEME,
  BLACKBOARD_THEME,
  PLAN_THEME,
  MCP_RESULT_THEME,
  INITIAL_THEME,
} from './themes'
import { formatTs } from './utils'
import {
  extractCodeEdit,
  extractWriteToolCall,
  extractBashCalls,
  extractReadCalls,
  extractLocalCommandParts,
  isStartPyToolUse,
  functionOutputImageUrls,
  functionOutputTextBody,
  isFunctionCallOutputPayload,
  extractPlanCard,
  extractMcpToolResult,
  isAimuxCommandToolUse,
  isAimuxRemoteApplyPatchToolUse,
} from './entry-extract'
import {
  isEditToolUse,
  isContextCompactedEvent,
  isAssistantEndTurnEntry,
  isThinkingOnlyAssistantEntry,
  isAssistantResponseGoldKeyword,
  isCompactDoneEntry,
  isGoalSetEntry,
  isLocalCommandEntry,
  jsonEntryTourTarget,
} from './entry-classify'
import { buildHeaderSummary, resolveTaskHeaderSummary } from './header-summary'
import { deriveToolCallStatus, TOOL_STATUS_META } from './tool-status'
import type { ResolvedCallMap, ToolStatus } from './tool-status'
import { estimateRenderChars, estimateToolResultsChars, clampNodeForRender, clampToolResults } from './oversized'
import { KeyNode } from './KeyNode'
import { JsonEntryCodeDiff } from './CodeDiff'
import { JsonEntryWritePreview } from './WritePreview'
import { JsonEntryBashCommands } from './BashCards'
import { JsonEntryReadCalls } from './ReadCards'
import { JsonEntryLocalCommandBlock } from './LocalCommandBlock'
import { JsonEntryPlanCard } from './PlanCard'
import { JsonEntryInitialCard } from './InitialCard'
import { extractInitialContext } from './initial-context'
import { ImageOutputPanel } from './ImageOutput'
import { CompactPlainTextFallback } from './text-preview'
import { JsonlCopyButton } from './JsonlCopyButton'
import type { AnyEntry, CardMode, BashToolResult, PlanUpdate } from './types'

const CompactMarkdown = lazy(() => import('../jsonl-compact-markdown'))

// 单张 jsonl 卡片渲染时的字符预算: 超过此阈值的 entry / 工具结果内容会被截断后再渲染,
// 避免 DOM 节点爆炸导致前端卡顿崩溃 (用户反馈: 某条 jsonl 卡片字符数过大时页面卡死).
// 阈值 100,000 字符 (约 100KB) — 经验上单卡渲染到这个量级以上就明显卡顿.
const MAX_CARD_RENDER_CHARS = 100_000

/**
 * 各卡片视图模式对应的图标 (模式切换按钮的文字 → 图标).
 * 按钮显示"点击后将切换到的目标模式"的图标, 与原文字按钮语义一致 (文字时也是显示目标模式名).
 * 详细说明收进 title/aria-label (悬停可见); 尺寸样式与复制按钮一致 (共用 .jsonl-icon-button).
 */
const MODE_ICON: Record<CardMode, LucideIcon> = {
  code: Code2,           // 代码模式: diff / Write 文件预览 / Bash 命令 / Read 读取
  plan: ListChecks,      // 计划模式: 分步计划
  initial: BookOpen,     // 初始模式: 首轮注入上下文分块视图
  image: ImageIcon,      // 图片模式: 内嵌图片渲染
  compact: AlignLeft,    // 精简模式: 渲染后的摘要文本
  field: Braces,         // 字段模式: 按 key 递归展开原始 JSON
}

// 工具调用状态 (running/success/error) → lucide 图标. 与 PlanCard 的 STATUS_META 同款范式.
const TOOL_STATUS_ICON: Record<ToolStatus, typeof Check> = {
  running: Loader2,
  success: Check,
  error: X,
}

// 头部状态图标: 替换工具卡上的装饰彩点, 用图标直观表达工具执行状态 (Cursor 式).
// 外层状态槽始终固定为 14px。普通卡的圆点与工具的对钩/加载/错误图标共用该槽，
// 这样不同状态不会改变后方类型标签和摘要的横向起点。
function ToolStatusIcon({ status }: { status: ToolStatus }) {
  const meta = TOOL_STATUS_META[status]
  const Icon = TOOL_STATUS_ICON[status]
  return (
    <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
      <Icon
        className={`h-3 w-3 ${meta.iconClass}${meta.spin ? ' animate-spin' : ''}`}
        strokeWidth={2.4}
        aria-label={meta.label}
        role="img"
      />
    </span>
  )
}

/**
 * 单卡 open 的"系统期望值" — 所有展开/折叠条件合并到此一处判定, 优先级 (高 → 低):
 *   ① 字段模式       始终默认折叠 — 字段树不能被任何自动展开信号掀开.
 *   ② forceOpen       搜索命中        — 用户显式查看, 压过 parentOrderedCollapse.
 *   ③ parentOrderedCollapse    forgotten-flag  — 默认折叠; 压过本地展开条件.
 *   ④ 本地展开条件     patch_apply / 计划(canPlan) / 纯文本卡(可精简·可图片·error 类型, 且非代码卡).
 *   ⑤ toolError       工具失败        — "折叠不藏错误"; 被 ①抑制.
 *   ⑥ 兜底            折叠.
 * 这是"系统期望"的单向判定; 实际 open 还受用户手动 onToggle 锁定 (见下方 userToggledRef).
 * 自动信号只"掀开"(ratchet, 不自动折回) — 字段模式保持折叠, 其它折叠仅来自初值 ③ 或用户手动.
 */
function resolveDesiredOpen(opts: {
  mode: CardMode
  forceOpen: boolean
  parentOrderedCollapse: boolean
  isPatchApply: boolean
  canPlan: boolean
  canInitial: boolean
  canCode: boolean
  canCompact: boolean
  canImage: boolean
  isErrorType: boolean
  toolError: boolean
}): boolean {
  if (opts.mode === 'field') return false       // 字段模式永远不自动展开, 压过其它规则
  if (opts.forceOpen) return true       // ① 搜索命中
  if (opts.parentOrderedCollapse) return false   // ② forgotten-flag
  // ③ 本地展开条件: patch_apply / 计划 / 初始 / 纯文本卡(可精简·可图片·error 类型, 且非代码卡)
  if (opts.isPatchApply || opts.canPlan || opts.canInitial || (!opts.canCode && (opts.canCompact || opts.canImage || opts.isErrorType))) return true
  if (opts.toolError) return true       // ④ 工具失败
  return false                          // ⑤ 兜底折叠
}

/**
 * 单条 entry 卡片. type 决定颜色, 摘要行展示关键内容 (供快速扫).
 */
function JsonEntryCardInner({ entry, lineNo, forceOpen = false, parentOrderedCollapse = false, showMeta = true, dense = false, bashResults = [], readResults = [], resolvedMap, taskPlan }: {
  entry: AnyEntry
  lineNo?: number
  // forceOpen: 搜索命中该卡 — 用户显式查看, 优先级最高, 压过 parentOrderedCollapse 与用户曾手动折叠.
  forceOpen?: boolean
  // parentOrderedCollapse: forgotten-flag 收尾卡 (agent 被 forgotten-flag 系统提醒触发的机械删 flag 链路) —
  // 默认折叠, 压过本地展开条件, 但被 forceOpen 压过. 用户仍可手动展开 (onToggle 写回 state, userToggledRef 阻止自动掀开).
  parentOrderedCollapse?: boolean
  showMeta?: boolean
  // dense: compact surfaces render the shared card with genuinely smaller
  // header classes instead of relying only on a parent CSS override.
  dense?: boolean
  bashResults?: BashToolResult[]
  readResults?: BashToolResult[]
  resolvedMap?: ResolvedCallMap | null
  // 任务工具 (TaskCreate/TaskUpdate) 的跨条目累积快照 (JsonlView 顶层扫描产出,
  // anchor uuid → PlanUpdate). 与 update_plan / task_reminder 共用计划卡片视图.
  taskPlan?: PlanUpdate | null
}) {
  const type = entry?.type || 'unknown'
  // 超大卡片保护: entry + 工具结果的渲染字符总量超过 10 万时, 用截断版渲染, 避免前端卡顿崩溃.
  // 截断版只影响"展开态内容渲染", 卡片头部摘要 / 配色 / 折叠态不受影响.
  const { renderEntry, renderBashResults, renderReadResults, oversized, totalChars, imageOutputUrls, imageOutputText } = useMemo(() => {
    // codex function_call_output 里的内嵌图片 (input_image base64): 单独抽 data url 走 <img> 渲染,
    // 不进字段模式递归展开 base64. 图片源取自未截断的原始 entry (截断会破坏 base64).
    const isImageOutput = entry?.type === 'response_item' && isFunctionCallOutputPayload(entry?.payload)
    const imageUrls = isImageOutput ? functionOutputImageUrls(entry?.payload?.output) : []
    const imageText = isImageOutput ? functionOutputTextBody(entry?.payload?.output) : ''
    const total =
      estimateRenderChars(entry) +
      estimateToolResultsChars(bashResults) +
      estimateToolResultsChars(readResults)
    // 含图片的 output 走专用渲染分支, 不展开 base64 字段, 不会卡顿, 不触发超大卡片保护.
    if (imageUrls.length > 0) {
      return { renderEntry: entry, renderBashResults: bashResults, renderReadResults: readResults, oversized: false, totalChars: total, imageOutputUrls: imageUrls, imageOutputText: imageText }
    }
    if (total <= MAX_CARD_RENDER_CHARS) {
      return { renderEntry: entry, renderBashResults: bashResults, renderReadResults: readResults, oversized: false, totalChars: total, imageOutputUrls: imageUrls, imageOutputText: imageText }
    }
    const budget = { remaining: MAX_CARD_RENDER_CHARS }
    return {
      renderEntry: clampNodeForRender(entry, budget),
      renderBashResults: clampToolResults(bashResults, budget),
      renderReadResults: clampToolResults(readResults, budget),
      oversized: true,
      totalChars: total,
      imageOutputUrls: imageUrls,
      imageOutputText: imageText,
    }
  }, [entry, bashResults, readResults])
  const canImage = imageOutputUrls.length > 0
  const headerSummary = useMemo(() => buildHeaderSummary(renderEntry), [renderEntry])
  // 任务工具卡摘要增强: 跨条目累积快照在手时, 标题栏显示 "计划 · X/N · 任务标题"
  // 而非原始 tool_use JSON. 仅影响一行预览, 字段模式仍可看原始数据.
  const effectiveHeaderSummary = useMemo(
    () => (taskPlan ? (resolveTaskHeaderSummary(entry, taskPlan) ?? headerSummary) : headerSummary),
    [entry, taskPlan, headerSummary],
  )
  const codeEdit = useMemo(() => extractCodeEdit(renderEntry), [renderEntry])
  const writeCall = useMemo(() => extractWriteToolCall(renderEntry), [renderEntry])
  const bashCalls = useMemo(() => extractBashCalls(renderEntry), [renderEntry])
  const readCalls = useMemo(() => extractReadCalls(renderEntry), [renderEntry])
  // 本地命令产物标签 (非空 = 命中 /compact 等 slash command 产物): 展开时走专属金色提示块, 不铺原始 JSON 字段.
  const localCommandParts = useMemo(() => extractLocalCommandParts(renderEntry), [renderEntry])
  // 计划模式 (codex update_plan / Claude task_reminder / 任务工具跨条目累积): 展开时走专属计划卡片, 不铺原始 JSON 字段.
  // taskPlan 来自未截断的原始 entry 的 uuid (JsonlView 顶层扫描), 与 renderEntry 无关, 不受超大卡片保护影响.
  const selfPlanUpdate = useMemo(() => extractPlanCard(renderEntry), [renderEntry])
  const planUpdate = selfPlanUpdate ?? taskPlan ?? null
  // MCP 工具返回信封 ({"output":..., "wall_time_seconds":..., "original_token_count":...}):
  // 仅用于主题识别 (emerald "返回"). 渲染走精简模式 - header-summary 把 output 包成 markdown 代码块,
  // 卡片展开时由 compact 分支 (CompactMarkdown) 渲染, 不铺原始 JSON 字段.
  const mcpResult = useMemo(() => extractMcpToolResult(renderEntry), [renderEntry])
  // 初始消息辨识 (首轮注入上下文包装): 与 taskPlan 同款, 用未截断的原始 entry 解析
  // (超大卡片保护不影响); 非初始消息快速短路返回 null。
  const initialContext = useMemo(() => extractInitialContext(entry), [entry])
  // canCode 覆盖代码视图: Edit diff / Write 文件预览 / Bash 命令卡片 / Read 文件读取卡片.
  // 字段模式仍是入口的兜底, 让用户随时切回看原始 JSON.
  const canCode = !!codeEdit || !!writeCall || bashCalls.length > 0 || readCalls.length > 0
  // canPlan 覆盖计划视图: update_plan function_call 走可视化步骤卡片.
  const canPlan = !!planUpdate
  // canInitial 覆盖初始视图: 首轮注入上下文消息走分块手风琴卡片.
  const canInitial = !!initialContext
  const isPatchApplyEvent = entry?.type === 'event_msg' && String(entry?.payload?.type || '').startsWith('patch_apply')
  // 正文含 blackboard 标记 → 视作 Research Blackboard 相关消息.
  const isBlackboard = headerSummary.full.includes(BLACKBOARD_MARKER)
  // 配色优先级: 初始消息 (结构辨识, 最具体) > blackboard 相关 (最醒目) > user compact 完成信号 (gold) > user /goal 设置信号 (gold) > user 其他本地命令产物 (gold) > assistant 只含 thinking 思考卡 (purple) > assistant end_turn (gold) > assistant 文本关键词 (gold) > name:"Edit" 的 tool_use (indigo) > AIMUX 协作执行 (teal) > Bash command 含 "start.py" (gold) > 普通 Bash tool_use (cyan) > event_msg.context_compacted (gold) > 顶层 type.
  // initial 必须排在 blackboard 之前: research 会话的初始消息正文含 blackboard 字样, 但它是初始消息不是黑板写入.
  // start.py 必须排在 Bash 之前: 它本身也是 Bash, 但语义更具体, 不能被 cyan 普通主题盖掉.
  // compact / goal-set 必须排在 local-cmd 之前: 它们都是 local-command-stdout 的特例, 文案/标签更具体.
  // thinking-only 必须排在 end_turn 之前: 只含思考块的卡片, "这是思考卡"比"这是结束态"更能说明卡片性质.
  const theme = canInitial
    ? INITIAL_THEME
    : isBlackboard
    ? BLACKBOARD_THEME
    : isCompactDoneEntry(entry)
    ? COMPACT_DONE_THEME
    : isGoalSetEntry(entry)
    ? GOAL_SET_THEME
    : isLocalCommandEntry(entry)
    ? LOCAL_COMMAND_THEME
    : isThinkingOnlyAssistantEntry(entry)
    ? THINKING_ONLY_THEME
    : isAssistantEndTurnEntry(entry)
    ? ASSISTANT_END_TURN_THEME
    : isAssistantResponseGoldKeyword(entry)
    ? ASSISTANT_RESPONSE_KEYWORD_THEME
    : isEditToolUse(entry)
    ? EDIT_TOOL_THEME
    : isAimuxRemoteApplyPatchToolUse(entry)
    ? AIMUX_PATCH_THEME
    : isAimuxCommandToolUse(entry)
    ? AIMUX_COMMAND_THEME
    : isStartPyToolUse(entry)
    ? START_PY_THEME
    : bashCalls.length > 0
    ? BASH_TOOL_THEME
    : readCalls.length > 0
    ? READ_TOOL_THEME
    : isContextCompactedEvent(entry)
    ? CONTEXT_COMPACTED_THEME
    : canPlan
    ? PLAN_THEME
    : mcpResult
    ? MCP_RESULT_THEME
    : (TYPE_THEME[type] || DEFAULT_THEME)
  const ts = entry?.timestamp ? formatTs(entry.timestamp) : null
  // 仅 summary 被截断时才提供"精简模式"入口; 没截断的卡片只有字段模式
  const canCompact = headerSummary.canCompact
  // 展开后默认: 可计划 → 计划模式; 可初始 → 初始模式; 可代码 → 代码模式; 可图片 → 图片模式; 可精简 → 精简模式; 其它 → 字段模式
  const [mode, setMode] = useState<CardMode>(canPlan ? 'plan' : canInitial ? 'initial' : canCode ? 'code' : canImage ? 'image' : canCompact ? 'compact' : 'field')

  // 卡片展开态受控于本地 state, 跨父组件重渲染 (实时轮询追加 entry) 保持不变.
  // 展开优先级集中在上方的 resolveDesiredOpen: field(字段模式) > forceOpen(搜索) >
  // parentOrderedCollapse(forgotten-flag) > localExpand(本地展开条件) > toolError(工具失败) > 兜底折叠.
  // 用户手动折叠 → onToggle 写回 state, 此后重渲染不再强制掀开 (字段模式也不会被自动掀开).
  const tourTarget = jsonEntryTourTarget(entry)

  // 工具调用状态: 由 "该 tool_use 的结果是否已落地" 推导 (running = 已发起未回结果).
  const toolStatus = deriveToolCallStatus(entry, resolvedMap)

  // 系统期望 open — 所有展开/折叠条件集中在上方的 resolveDesiredOpen 判定.
  const desiredOpen = resolveDesiredOpen({
    mode,
    forceOpen,
    parentOrderedCollapse,
    isPatchApply: isPatchApplyEvent,
    canPlan,
    canInitial,
    canCode,
    canCompact,
    canImage,
    isErrorType: type === 'error',
    toolError: toolStatus === 'error',
  })

  // 用户是否手动点过折叠/展开: 一旦手动操作, 自动展开就不再强制掀开 (字段模式除外).
  const userToggledRef = useRef(false)
  const [open, setOpen] = useState<boolean>(desiredOpen)

  // 自动信号跟随 — ratchet (只掀开不折回; 字段模式保持折叠) + 尊重用户手动:
  //   · forceOpen (搜索): 非字段模式下即使用户曾手动折叠也强制掀开 (显式查看优先).
  //   · 其它信号: 用户手动操作过则锁定不动.
  useEffect(() => {
    if (forceOpen && mode !== 'field') { setOpen(true); return }
    if (!userToggledRef.current && desiredOpen) setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceOpen, desiredOpen])

  // 精简/字段模式复制按钮反馈: 点击后短暂切换为 Check 图标再还原.
  const [copied, setCopied] = useState<boolean>(false)

  // 默认折叠 (第一张 user 卡片除外). summary 可选中: select-text 显式覆盖某些浏览器/OS 默认禁选.
  //
  // a11y 注意: <button> 不能嵌套在 <summary> 里 (HTML 规范禁止 interactive content 作为
  // summary 后代 — Chrome DevTools Issues tab 会标 "InteractiveContent SummaryDescendant").
  // 旧版把「复制」和「切换模式」两个按钮塞进 summary, 每张展开的卡片都会触发 1 条 a11y issue,
  // 用户在 F12 Issues 里看到"卡片数 ≈ 错误数". 现在把按钮 absolute 到 details 右上角,
  // 视觉位置不变, 但 DOM 上 button 是 details 的直接子元素而非 summary 后代, 规范合规.
  // 字段模式也带复制按钮 (复制原始 JSON), 与精简模式的复制按钮对齐, 故 hasHeaderAction
  // 额外纳入 mode === 'field' —— 让只支持字段模式的小卡片也能露出复制入口.
  const hasHeaderAction = open && ((mode === 'compact') || (mode === 'field') || (mode === 'image') || (mode === 'plan') || (mode === 'initial') || canCompact || canCode || canImage || canPlan || canInitial)

  // 模式切换图标按钮: 计算点击后将切换到的目标模式 + 悬停说明.
  // (原为文字按钮显示目标模式名, 现改为图标按钮, 文字说明收进 title.)
  const modeToggle = (canCompact || canCode || canImage || canPlan || canInitial)
    ? (() => {
        let target: CardMode
        let title: string
        if (canCode) {
          target = mode === 'code' ? 'field' : 'code'
          title = mode === 'code'
            ? '切换到字段模式 (按 key 展开 JSON)'
            : writeCall ? '切换到代码模式 (显示 Write 文件预览)'
              : codeEdit ? '切换到代码模式 (显示 old_string → new_string 的编辑差异)'
                : readCalls.length > 0 && bashCalls.length > 0 ? '切换到代码模式 (显示工具调用)'
                  : readCalls.length > 0 ? '切换到代码模式 (显示 Read 文件读取)'
                    : '切换到代码模式 (显示 Bash 命令)'
        } else if (canInitial) {
          target = mode === 'initial' ? 'field' : 'initial'
          title = mode === 'initial' ? '切换到字段模式 (按 key 展开 JSON)' : '切换到初始模式 (分块查看注入上下文与用户问题)'
        } else if (canImage) {
          target = mode === 'image' ? 'field' : 'image'
          title = mode === 'image' ? '切换到字段模式 (按 key 展开 JSON)' : '切换到图片模式 (渲染内嵌图片)'
        } else if (canPlan) {
          target = mode === 'plan' ? 'field' : 'plan'
          title = mode === 'plan' ? '切换到字段模式 (按 key 展开 JSON)' : '切换到计划模式 (显示分步计划)'
        } else {
          target = mode === 'compact' ? 'field' : 'compact'
          title = mode === 'compact' ? '切换到字段模式 (按 key 展开 JSON)' : '切换到精简模式 (显示完整摘要文本)'
        }
        return { target, title, Icon: MODE_ICON[target] }
      })()
    : null
  return (
    <details
      data-tour={tourTarget}
      data-jsonl-line-no={lineNo}
      data-jsonl-entry-id={entry?.uuid || entry?.id || undefined}
      data-density={dense ? 'dense' : undefined}
      open={open}
      onToggle={(e) => { userToggledRef.current = true; setOpen((e.currentTarget as HTMLDetailsElement).open) }}
      className={`jsonl-entry-card relative mb-2 rounded-lg border shadow-sm card-enter ${theme.border} ${theme.bg}`}>
      <summary className={`jsonl-entry-summary cursor-pointer ${dense ? 'px-1 pt-0.5 gap-1' : 'px-3 pt-1.5 gap-2'} ${open ? 'pb-0.5' : dense ? 'pb-0.5' : 'pb-1.5'} flex items-center select-text${hasHeaderAction ? ' pr-[120px]' : ''}`}>
        {showMeta && typeof lineNo === 'number' && <span className="jsonl-entry-summary-meta text-[var(--text-muted)] font-mono flex-shrink-0">#{lineNo}</span>}
        {showMeta && ts && <span className="jsonl-entry-summary-meta text-[var(--text-muted)] font-mono flex-shrink-0">{ts}</span>}
        {toolStatus ? (
          <ToolStatusIcon status={toolStatus} />
        ) : (
          <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
            <span className={`h-1.5 w-1.5 rounded-full ${theme.dot}`}></span>
          </span>
        )}
        <span className={`font-mono font-semibold ${theme.text} flex-shrink-0`}>{theme.label}</span>
        {canCode && (
          <span
            className={`inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border-current/30 ${theme.text}`}
            title="代码模式 — 点击展开查看 diff / 文件 / 命令 / 读取结果"
            aria-label="代码模式"
          >
            <Code2 className="h-3 w-3" strokeWidth={2.2} aria-hidden="true" />
          </span>
        )}
        {canPlan && (
          <span
            className={`inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border-current/30 ${theme.text}`}
            title="计划模式 — 点击展开查看分步计划"
            aria-label="计划模式"
          >
            <ListChecks className="h-3 w-3" strokeWidth={2.2} aria-hidden="true" />
          </span>
        )}
        {oversized && (
          <span
            className="jsonl-entry-summary-meta flex-shrink-0 font-mono text-amber-300 border border-amber-500/40 rounded px-1 py-0.5"
            title={`该条目原始约 ${totalChars.toLocaleString()} 字符, 超过 10 万字符渲染上限, 已截断显示以避免卡顿`}
          >
            ⚠ 已截断
          </span>
        )}
        {/* 精简模式展开时正文已渲染完整摘要 (headerSummary.full), header 顶部 short 与之重复 → 隐藏;
            折叠态或 code/field/plan/image 等其它模式仍保留 short 作预览.
            任务工具卡用 effectiveHeaderSummary (累积快照的 "计划 · X/N · 标题"). */}
        {effectiveHeaderSummary.short && !(open && mode === 'compact') && <span className="jsonl-entry-summary-preview text-[var(--text-muted)] truncate flex-1">{effectiveHeaderSummary.short}</span>}
      </summary>
      {hasHeaderAction && (
        <div className="absolute top-1 right-2 flex items-center gap-1.5 z-[5]">
          {open && mode === 'compact' && (
            <JsonlCopyButton
              copied={copied}
              title="复制渲染前的原始 markdown 源"
              copiedTitle="Markdown 已复制"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                navigator.clipboard.writeText(headerSummary.full).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1000)
                })
              }}
            />
          )}
          {open && mode === 'initial' && initialContext && (
            <JsonlCopyButton
              copied={copied}
              title="复制初始消息原始 markdown 源"
              copiedTitle="Markdown 已复制"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                navigator.clipboard.writeText(initialContext.raw).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1000)
                })
              }}
            />
          )}
          {open && mode === 'field' && (
            <JsonlCopyButton
              copied={copied}
              title="复制原始 JSON 到剪贴板"
              copiedTitle="JSON 已复制"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                // 字段模式展示的是 entry 的 JSON 树, 复制即给原始 JSON (用未截断的 entry,
                // 而非可能被超大卡片保护截断的 renderEntry, 让用户拿到完整数据).
                let jsonText = ''
                try { jsonText = JSON.stringify(entry, null, 2) } catch { jsonText = '' }
                if (!jsonText) return
                navigator.clipboard.writeText(jsonText).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1000)
                })
              }}
            />
          )}
          {modeToggle && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMode(modeToggle.target)
              }}
              className="jsonl-icon-button"
              title={modeToggle.title}
              aria-label={modeToggle.title}
            >
              <modeToggle.Icon className="h-2.5 w-2.5" strokeWidth={2.2} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {open && (
        <div className="px-1 pb-1 pt-1">
          {oversized && (
            <div className="jsonl-entry-note mb-2 rounded border border-amber-500/30 bg-amber-500/[0.06] px-2 py-1 text-amber-200">
              ⚠ 该条目原始约 {totalChars.toLocaleString()} 字符, 超过 10 万字符渲染上限, 超出部分已截断以避免前端卡顿.
            </div>
          )}
          {localCommandParts.length > 0 ? (
            <JsonEntryLocalCommandBlock parts={localCommandParts} />
          ) : mode === 'code' && codeEdit ? (
            <JsonEntryCodeDiff edit={codeEdit} />
          ) : mode === 'code' && writeCall ? (
            <JsonEntryWritePreview writeCall={writeCall} />
          ) : mode === 'code' && (bashCalls.length > 0 || readCalls.length > 0) ? (
            <div className="flex flex-col gap-2">
              {bashCalls.length > 0 && (
                <JsonEntryBashCommands calls={bashCalls} results={renderBashResults} />
              )}
              {readCalls.length > 0 && (
                <JsonEntryReadCalls calls={readCalls} results={renderReadResults} />
              )}
            </div>
          ) : mode === 'image' && canImage ? (
            <ImageOutputPanel imageUrls={imageOutputUrls} textBody={imageOutputText} />
          ) : mode === 'plan' && planUpdate ? (
            <JsonEntryPlanCard plan={planUpdate} />
          ) : mode === 'initial' && initialContext ? (
            <JsonEntryInitialCard match={initialContext} />
          ) : mode === 'compact' && canCompact && !canCode ? (
            <div className="max-h-[60vh] overflow-y-auto">
              <Suspense fallback={<CompactPlainTextFallback text={headerSummary.full} />}>
                <CompactMarkdown text={headerSummary.full} />
              </Suspense>
            </div>
          ) : (
            Object.entries(renderEntry).map(([k, v]) => <KeyNode key={k} k={k} v={v} depth={0} />)
          )}
        </div>
      )}
    </details>
  )
}

export const JsonEntryCard = memo(
  JsonEntryCardInner,
  (prev, next) => prev.entry === next.entry && prev.lineNo === next.lineNo && prev.showMeta === next.showMeta && prev.dense === next.dense && prev.bashResults === next.bashResults && prev.readResults === next.readResults && prev.resolvedMap === next.resolvedMap && prev.parentOrderedCollapse === next.parentOrderedCollapse && prev.forceOpen === next.forceOpen && prev.taskPlan === next.taskPlan,
)
