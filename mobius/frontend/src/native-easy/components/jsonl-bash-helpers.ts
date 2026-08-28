/**
 * jsonl-bash-helpers.ts — Claude Code Bash tool_use 卡片的纯逻辑辅助.
 *
 * 这里只放无 React 依赖的纯函数, 方便 jsonl-view.tsx 与 Node 测试共享同一份实现,
 * 避免 "测试一份, 渲染另一份" 的脱节. 组件层只负责把这些数据渲染成卡片.
 */

export type BashCall = {
  id?: string
  description: string
  cwd: string
  command: string
  commandSource: 'command' | 'cmd' | 'script'
}

// AIMUX 通过 MCP 暴露的远程命令工具。它仍然执行 shell 命令，但语义是把任务交给
// 已连接的协作算力，因此卡片标题需要与本机 Bash / exec_command 区分。
export function isAimuxCommandToolUseName(name: unknown): boolean {
  if (typeof name !== 'string') return false
  const normalized = name.toLowerCase()
  return normalized.startsWith('mcp__aimux__') && normalized.endsWith('exec_command')
}

// AIMUX 远程补丁工具的输入是 apply_patch 格式文本，和远程命令不同：它应进入
// 代码差异卡片，而不是被当作命令或通用 JSON 工具调用渲染。
export function isAimuxRemoteApplyPatchToolUseName(name: unknown): boolean {
  return typeof name === 'string' && name.toLowerCase() === 'mcp__aimux__remote_apply_patch'
}

// Claude Code 官方 Bash 工具名是 'Bash', 不同代理实现里出现过 'bash'/'BASH' 大小写不一,
// 一律按小写比较兼容. Codex 的等价工具叫 'exec_command' 但走 response_item.function_call,
// 不进这条 assistant tool_use 路径, 这里不处理.
export function isBashToolUseName(name: unknown): boolean {
  return typeof name === 'string' && name.toLowerCase() === 'bash'
}

// 从单个 tool_use block 抽出 BashCall. 返回 null 表示这不是一个我们能识别的 Bash 调用
// (没 command/cmd/script 任一字段 → 不强渲染, 让上层走默认 JSON 摘要).
//
// command 优先级: input.command > input.cmd > input.script. 这三个字段都见过:
//   - Claude Code 官方: input.command
//   - 个别 fork/早期版本: input.cmd
//   - 部分把整段脚本塞进去的实现: input.script
//
// cwd 优先 input.workdir / input.cwd, 否则用 entry 顶层 cwd (会话级 cwd 兜底).
// description 严格按 input.description 字符串, 不存在则留空 (上层渲染时跳过).
export function extractBashCallFromBlock(block: any, entryCwd: string): BashCall | null {
  if (!block || block.type !== 'tool_use' || (!isBashToolUseName(block.name) && !isAimuxCommandToolUseName(block.name))) return null
  const input = block?.input && typeof block.input === 'object' ? block.input : {}
  let command = ''
  let commandSource: BashCall['commandSource'] = 'command'
  if (typeof input.command === 'string' && input.command.length > 0) {
    command = input.command
    commandSource = 'command'
  } else if (typeof input.cmd === 'string' && input.cmd.length > 0) {
    command = input.cmd
    commandSource = 'cmd'
  } else if (typeof input.script === 'string' && input.script.length > 0) {
    command = input.script
    commandSource = 'script'
  } else {
    return null
  }
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  const inputCwd = typeof input.workdir === 'string' ? input.workdir.trim()
    : typeof input.cwd === 'string' ? input.cwd.trim()
    : ''
  const cwd = inputCwd || entryCwd
  const id = typeof block.id === 'string' && block.id.length > 0 ? block.id : undefined
  return { id, description, cwd, command, commandSource }
}

// 从 assistant.message.content 抽出全部 Bash tool_use 调用 (保序; 同一条 entry 多 Bash 都返回).
// 非 assistant entry 或没有 content 数组 → 空数组.
export function extractBashCalls(entry: any): BashCall[] {
  if (!entry || entry?.type !== 'assistant') return []
  const c = entry?.message?.content
  if (!Array.isArray(c)) return []
  const entryCwd = typeof entry?.cwd === 'string' ? entry.cwd.trim() : ''
  const out: BashCall[] = []
  for (const block of c) {
    const call = extractBashCallFromBlock(block, entryCwd)
    if (call) out.push(call)
  }
  return out
}

// 一行预览: 优先 description (人类可读); 没有就退到命令首行, 加 $ 前缀提示是命令.
export function bashCallOneLineSummary(call: BashCall): string {
  if (!call) return ''
  if (call.description) return call.description
  const firstLine = (call.command || '').split(/\r?\n/, 1)[0].trim()
  return firstLine ? `$ ${firstLine}` : ''
}
