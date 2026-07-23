/**
 * viewer/themes.ts — jsonl 卡片配色主题 (Tailwind class fragments).
 *
 * 从 jsonl-view.tsx 拆出. 顶层 type → 卡片色调, 以及各类 tool_use / 系统提醒 /
 * 关键回复的专属特例配色, 全部集中在这里, 方便整体调整观感.
 */

export type CardTheme = { dot: string; border: string; bg: string; text: string; label: string }

// 顶层 type → 卡片色调 (Tailwind class fragments)
// label 全部 ≤2 汉字 (用户审查确认: 2026-07-23), 数据 type 名仍保持英文以便 JSONL 协议稳定.
export const TYPE_THEME: Record<string, CardTheme> = {
  user:                   { dot: 'bg-slate-400',  border: 'border-slate-500/15', bg: 'bg-slate-500/[0.04]',  text: 'text-slate-300',  label: '用户' },
  assistant:              { dot: 'bg-blue-400',   border: 'border-blue-500/15',  bg: 'bg-blue-500/[0.04]',   text: 'text-blue-300',   label: '助手' },
  attachment:             { dot: 'bg-purple-400', border: 'border-purple-500/15',bg: 'bg-purple-500/[0.04]', text: 'text-purple-300', label: '附件' },
  system:                 { dot: 'bg-amber-400',  border: 'border-amber-500/15', bg: 'bg-amber-500/[0.04]',  text: 'text-amber-300',  label: '系统' },
  'queue-operation':      { dot: 'bg-zinc-500',   border: 'border-zinc-600/15',  bg: 'bg-zinc-700/[0.04]',   text: 'text-zinc-400',   label: '队列' },
  'last-prompt':          { dot: 'bg-cyan-400',   border: 'border-cyan-500/15',  bg: 'bg-cyan-500/[0.04]',   text: 'text-cyan-300',   label: '上问' },
  'permission-mode':      { dot: 'bg-pink-400',   border: 'border-pink-500/15',  bg: 'bg-pink-500/[0.04]',   text: 'text-pink-300',   label: '权限' },
  'file-history-snapshot':{ dot: 'bg-emerald-400',border: 'border-emerald-500/15',bg:'bg-emerald-500/[0.04]',text: 'text-emerald-300',label: '快照' },
  'custom-title':         { dot: 'bg-zinc-400',   border: 'border-zinc-500/15',  bg: 'bg-zinc-700/[0.04]',   text: 'text-zinc-300',   label: '标题' },
  'agent-name':           { dot: 'bg-zinc-400',   border: 'border-zinc-500/15',  bg: 'bg-zinc-700/[0.04]',   text: 'text-zinc-300',   label: '代号' },
  session_meta:           { dot: 'bg-zinc-400',   border: 'border-zinc-500/15',  bg: 'bg-zinc-700/[0.04]',   text: 'text-zinc-300',   label: '会话' },
  turn_context:           { dot: 'bg-amber-400',  border: 'border-amber-500/15', bg: 'bg-amber-500/[0.04]',  text: 'text-amber-300',  label: '轮次' },
  event_msg:              { dot: 'bg-cyan-400',   border: 'border-cyan-500/15',  bg: 'bg-cyan-500/[0.04]',   text: 'text-cyan-300',   label: '事件' },
  response_item:          { dot: 'bg-blue-400',   border: 'border-blue-500/15',  bg: 'bg-blue-500/[0.04]',   text: 'text-blue-300',   label: '应答' },
  error:                  { dot: 'bg-red-500',    border: 'border-red-500/25',   bg: 'bg-red-500/[0.10]',    text: 'text-red-200',    label: '错误' },
}
export const DEFAULT_THEME: CardTheme = { dot: 'bg-gray-500', border: 'border-gray-500/15', bg: 'bg-gray-500/[0.04]', text: 'text-gray-400', label: '条目' }

// 特例: assistant 里带 name:"Edit" 的 tool_use 卡片 — 用 indigo (与 assistant 蓝相邻但可区分),
// 边框/底色比常规 type 稍重一点, 方便在长列表里一眼扫到文件改动.
export const EDIT_TOOL_THEME: CardTheme = { dot: 'bg-indigo-400', border: 'border-indigo-500/20', bg: 'bg-indigo-500/[0.07]', text: 'text-indigo-300', label: '编辑' }

// 特例: assistant 里带 name:"Bash" 且 input.command 包含 "start.py" 的 tool_use 卡片 —
// 用 gold (yellow), 提示这是触发了产品构建的 shell 调用, 在长列表里一眼可扫.
// 用 yellow 与 system/turn 的 amber 拉开, 避免和已有暖色调混淆.
export const START_PY_THEME: CardTheme = { dot: 'bg-yellow-400', border: 'border-yellow-500/20', bg: 'bg-yellow-500/[0.07]', text: 'text-yellow-300', label: '部署' }

// 特例: assistant 里带 name:"Bash" 的 tool_use 卡片 (Claude Code shell 调用).
// 用 cyan, 呼应终端/控制台意象, 与 Edit indigo、start.py yellow 都拉开, 长列表里可识别.
export const BASH_TOOL_THEME: CardTheme = { dot: 'bg-cyan-400', border: 'border-cyan-500/20', bg: 'bg-cyan-500/[0.06]', text: 'text-cyan-300', label: '命令' }

// 特例: assistant 里带 name:"Read" 的 tool_use 卡片.
// 用 sky, 与 Bash cyan / Edit indigo 近邻但可区分, 方便扫文件读取操作.
export const READ_TOOL_THEME: CardTheme = { dot: 'bg-sky-400', border: 'border-sky-500/20', bg: 'bg-sky-500/[0.06]', text: 'text-sky-300', label: '读取' }

// 特例: event_msg.payload.type === 'context_compacted' 的卡片 — 一次上下文压缩事件,
// 在长列表里需要一眼可扫, 复用 yellow (gold) 与 start.py 同色但 label 区分.
export const CONTEXT_COMPACTED_THEME: CardTheme = { ...START_PY_THEME, label: '压缩' }

// 特例: Claude assistant 最终结束消息. 复用 system/turn_duration 的 amber gold 主题,
// 让 stop_reason:"end_turn" 的卡片在长列表中和轮次耗时卡片一样容易扫到.
export const ASSISTANT_END_TURN_THEME: CardTheme = { ...TYPE_THEME.system, label: '结束' }

// 特例: user 消息里的 Claude Code compact 完成信号
// (content 被 <local-command-stdout> ... </local-command-stdout> 包裹, 正文以 "Compacted" 开头).
// 这是一次对话上下文压缩完成的产物, 套了 user 外壳但不是人类提问.
// 复用 system/turn_duration 的 amber gold 主题, 与 stop_reason:"end_turn" 金色卡片风格统一.
export const COMPACT_DONE_THEME: CardTheme = { ...TYPE_THEME.system, label: '压完' }

// 特例: user 消息里的 /goal 命令输出信号 (local-command-stdout 正文以 "Goal set" 开头).
// 与 compact 同款 amber gold, label 区分, 让"目标已设置"在长列表里一眼可扫.
export const GOAL_SET_THEME: CardTheme = { ...TYPE_THEME.system, label: '定目' }

// 特例: user 消息里的 Claude Code 本地命令产物 (compact 完成信号之外的其余 <local-command-*> / <command-*> 标签,
// 如 /compact 的 <command-name> / <local-command-caveat> 等). 与 compact / end_turn 同款 amber gold, 风格统一.
export const LOCAL_COMMAND_THEME: CardTheme = { ...TYPE_THEME.system, label: '本地' }

// 特例: assistant 响应文本命中这些关键词时整卡复用 gold 主题.
// 只检查 assistant 文本响应, 不把 tool_use/input.command 当作本规则的命中范围.
export const ASSISTANT_RESPONSE_KEYWORD_THEME: CardTheme = { ...START_PY_THEME, label: '关键' }

// 醒目主题: blackboard 相关消息用 fuchsia, 边框/底色比常规 type 重很多, 在长列表里一眼可见.
export const BLACKBOARD_THEME: CardTheme = { dot: 'bg-fuchsia-400', border: 'border-fuchsia-500/15', bg: 'bg-fuchsia-500/[0.05]', text: 'text-fuchsia-200', label: '黑板' }

// display_images 派生图像卡片主题 (teal, 与其它工具主题拉开).
export const IMAGES_THEME: CardTheme = { dot: 'bg-teal-400', border: 'border-teal-500/20', bg: 'bg-teal-500/[0.06]', text: 'text-teal-300', label: '图像' }

// 特例: codex 计划模式 (update_plan function_call) 卡片.
// 用 violet, 与 Edit indigo / Bash cyan / Read sky 等工具主题都拉开, 让分步计划在长列表里一眼可扫.
export const PLAN_THEME: CardTheme = { dot: 'bg-violet-400', border: 'border-violet-500/20', bg: 'bg-violet-500/[0.06]', text: 'text-violet-300', label: '计划' }
