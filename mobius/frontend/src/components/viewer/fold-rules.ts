/**
 * viewer/fold-rules.ts — 基于上下文的"卡片默认折叠"规则 (纯逻辑, 无 React 依赖).
 *
 * 单条 entry 自身的配色/类型徽章在 ./entry-classify, 默认展开态在 EntryCard 内部
 * 按 isPatchApplyEvent/canPlan/canCode/canCompact 等本地条件决定. 但有一类卡片是否
 * "默认折叠" 取决于它前面的条目内容 (跨卡片上下文), 单张卡片看不到前后文, 必须在
 * JsonlView 顶层对可见条目序列做一次扫描后把结论透传下去. 本文件集中这类规则.
 *
 * 当前规则 (forgotten-flag 收尾折叠):
 *   mobius 的 forgotten-flag-scanner 检测到 "agent 停工但 running.flag 未删" 时, 会自动
 *   往该 session 注入一条系统 user 消息 (DEFAULT_FORGOTTEN_FLAG_MESSAGE), 文案以
 *   "It seems that the running flag is still present, ..." 开头. agent 收到后通常会做
 *   一串机械收尾动作 (find/ls/ps 排查 + rm running.flag). 这类卡片对浏览对话内容价值低,
 *   默认折叠可减少刷屏. 触发条件严格按用户规则:
 *     (1) 该卡片包含关键词 "running.flag";
 *     (2) 往前数 8 个 jsonl 条目里, 至少一张是用户卡片且包含关键句子
 *         "It seems that the running flag is still present".
 *   两者同时满足 → 该卡默认折叠 (用户仍可手动展开).
 */
import type { AnyEntry, JsonlViewItem } from './types'
import { extractBashCalls } from './entry-extract'

// forgotten-flag 系统注入消息的标志句 (DEFAULT_FORGOTTEN_FLAG_MESSAGE 的开头).
// 用整句而非单词 "running flag" 避免误命中 agent 自己提到 flag 的普通回复.
const FORGOTTEN_FLAG_SENTENCE = 'It seems that the running flag is still present'

// 触发折叠的关键词: 卡片可见文本含此 token 才进入候选.
const RUNNING_FLAG_KEYWORD = 'running.flag'

// 往前看的窗口大小 (条目数), 与用户规则 "往前数 8 个 jsonl 条目" 对齐.
const FOLD_LOOKBACK = 8

// 抽取 entry 自身承载的可见文本 (覆盖 Claude assistant.message.content 的 text/thinking/
// tool_use 命令, codex response_item 的 message/function_call, 以及 user 消息文本).
// 与 header-summary / entry-classify 的文本抽取口径保持一致, 但这里只要"是否含关键词",
// 不需要干净排版, 故直接拼大字符串做 includes 判定即可.
function entryVisibleText(entry: AnyEntry): string {
  const parts: string[] = []
  const t = entry?.type
  const msg = entry?.message
  const payload = entry?.payload

  // assistant / user 的 message.content (字符串或块数组).
  const pushContent = (content: any) => {
    if (typeof content === 'string') { parts.push(content); return }
    if (!Array.isArray(content)) return
    for (const b of content) {
      if (!b || typeof b !== 'object') continue
      if (typeof b.text === 'string') parts.push(b.text)
      if (typeof b.thinking === 'string') parts.push(b.thinking)
      if (typeof b.input_text === 'string') parts.push(b.input_text)
      if (typeof b.output_text === 'string') parts.push(b.output_text)
      // tool_use 的 input 里可能含命令文本 (如 Bash command 含 running.flag).
      if (b.input && typeof b.input === 'object') {
        const cmd = b.input.command ?? b.input.cmd ?? b.input.script
        if (typeof cmd === 'string') parts.push(cmd)
      }
      // tool_result 的 content 文本.
      if (typeof b.content === 'string') parts.push(b.content)
      else if (Array.isArray(b.content)) {
        for (const c of b.content) {
          if (typeof c === 'string') parts.push(c)
          else if (c && typeof c.text === 'string') parts.push(c.text)
        }
      }
    }
  }

  if (t === 'assistant' || t === 'user') {
    pushContent(msg?.content)
  }
  if (t === 'response_item') {
    const pt = payload?.type
    if (pt === 'message') pushContent(payload?.content)
    if (pt === 'function_call' || pt === 'custom_tool_call') {
      // function_call 的 arguments / input 可能含命令文本; 统一 stringify 后纳入.
      try { parts.push(JSON.stringify(payload?.arguments ?? '')) } catch { /* ignore */ }
      if (payload?.input != null) {
        try { parts.push(JSON.stringify(payload.input)) } catch { /* ignore */ }
      }
      // 同时用 extractBashCalls 取归一后的 command, 与卡片渲染同源.
      for (const call of extractBashCalls(entry)) {
        if (call.command) parts.push(call.command)
      }
    }
    if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
      try { parts.push(JSON.stringify(payload?.output ?? '')) } catch { /* ignore */ }
    }
  }
  if (t === 'event_msg') {
    if (typeof payload?.message === 'string') parts.push(payload.message)
    if (typeof payload?.content === 'string') parts.push(payload.content)
  }
  if (t === 'attachment' && typeof entry?.attachment === 'string') {
    parts.push(entry.attachment)
  }
  return parts.filter(Boolean).join('\n')
}

// 该 item (含合并进来的工具结果) 的全部可见文本是否包含关键词 "running.flag".
// "卡片包含" 覆盖: entry 本体文本 + 合并进来的 bashResults/readResults 的 stdout/content
// (tool_result 可能整段读到了含 running.flag 文本的源码/日志).
function itemContainsRunningFlag(item: JsonlViewItem): boolean {
  if (entryVisibleText(item.entry).includes(RUNNING_FLAG_KEYWORD)) return true
  for (const r of item.bashResults ?? []) {
    if ((r.content || r.stdout || r.stderr).includes(RUNNING_FLAG_KEYWORD)) return true
  }
  for (const r of item.readResults ?? []) {
    if ((r.content || r.stdout || r.stderr).includes(RUNNING_FLAG_KEYWORD)) return true
  }
  return false
}

// 该 entry 是否为 "用户卡片且包含 forgotten-flag 标志句".
// "用户卡片" = Claude type:user (排除纯 tool_result entry, 那是工具回填不是人类/系统提问)
// 或 codex response_item.message[role=user] / event_msg.user_message.
// forgotten-flag 消息本身就是 user 外壳, 命中此谓词.
export function isForgottenFlagUserEntry(entry: AnyEntry): boolean {
  const t = entry?.type
  let text = ''
  if (t === 'user') {
    const c = entry?.message?.content
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) {
      // 只取 text 块; 纯 tool_result 的 user 条目不算"用户提问卡片".
      text = c.filter((b: any) => b?.type === 'text').map((b: any) => b?.text || '').join('\n')
    }
  } else if (t === 'response_item' && entry?.payload?.type === 'message' && entry?.payload?.role === 'user') {
    const c = entry?.payload?.content
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) {
      text = c.map((b: any) => (typeof b === 'string' ? b : (b?.text ?? b?.input_text ?? ''))).join('\n')
    }
  } else if (t === 'event_msg' && entry?.payload?.type === 'user_message') {
    text = String(entry?.payload?.message || entry?.payload?.content || '')
  }
  return !!text && text.includes(FORGOTTEN_FLAG_SENTENCE)
}

/**
 * 扫描可见条目序列, 返回应"默认折叠"的卡片 lineNo 集合.
 *
 * 对每个 item: 若它包含 "running.flag", 且在它之前 FOLD_LOOKBACK 个条目里至少有一个
 * isForgottenFlagUserEntry 的用户卡片, 则该 item 的 lineNo 纳入折叠集合.
 *
 * @param items  已合并 tool_result / 已过滤噪声后的可见条目序列 (与卡片渲染同序).
 * @returns      Set<lineNo> — 命中折叠的卡片行号集合.
 */
export function computeCollapsedByForgottenFlag(items: JsonlViewItem[]): Set<number> {
  const collapsed = new Set<number>()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!itemContainsRunningFlag(item)) continue
    const start = Math.max(0, i - FOLD_LOOKBACK)
    let triggered = false
    for (let j = i - 1; j >= start; j--) {
      if (isForgottenFlagUserEntry(items[j].entry)) { triggered = true; break }
    }
    if (triggered) collapsed.add(item.lineNo)
  }
  return collapsed
}
