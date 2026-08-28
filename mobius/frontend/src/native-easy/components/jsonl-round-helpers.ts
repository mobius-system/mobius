/**
 * jsonl-round-helpers.ts — 对话轮次分组的纯逻辑辅助.
 *
 * 这里只放无 React 依赖的纯函数, 方便 jsonl-view.tsx 与 Node 测试共享同一份实现,
 * 避免 "测试一份, 渲染另一份" 的脱节. 组件层只负责把这些数据组装成 RoundGroup.
 */

// 与 Research Blackboard 相关的消息标记: 投递给 agent 的提醒 prompt 与写回会话的
// system 提醒消息都以此开头 (见后端 research-blackboard.js buildNotifyPrompt / insertSystem).
export const BLACKBOARD_MARKER = '[Research Blackboard 更新提醒]'

// forgotten-flag-scanner 在 "agent 停工但 running.flag 未删" 时自动发给 session 的系统提醒
// (见后端 config.js DEFAULT_FORGOTTEN_FLAG_MESSAGE). 文案以 "[A message that comes from the
// system, not the user]" 开头, 语义上是系统注入而非人类提问, 与 Blackboard 提醒同理,
// 在对话轮次分组里不应开新轮. 取核心句做 marker, 既覆盖带/不带方括号的写法, 也足够特异.
export const RUNNING_FLAG_REMINDER_MARKER = 'It seems that the running flag is still present'

// 收集 entry 里所有可能"承载用户可见文本"的字段, 用于判断是否为 Blackboard 提醒.
// 覆盖三种 entry 形态:
//   1. event_msg.payload.message / event_msg.payload.content (字符串)
//   2. type:user 的 message.content (字符串或数组, 数组只取 text/input_text 块)
//   3. response_item.message[role=user].content (同上)
function collectEntryUserTexts(entry: any, out: string[]): void {
  if (!entry || typeof entry !== 'object') return

  if (entry.type === 'event_msg' && entry.payload && typeof entry.payload === 'object') {
    if (typeof entry.payload.message === 'string') out.push(entry.payload.message)
    if (typeof entry.payload.content === 'string') out.push(entry.payload.content)
  }

  if (entry.type === 'user' && entry.message && typeof entry.message === 'object') {
    const c = entry.message.content
    if (typeof c === 'string') out.push(c)
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || typeof b !== 'object') continue
        if (typeof b.text === 'string') out.push(b.text)
        else if (typeof b.input_text === 'string') out.push(b.input_text)
      }
    }
  }

  if (
    entry.type === 'response_item'
    && entry.payload && typeof entry.payload === 'object'
    && entry.payload.type === 'message'
    && entry.payload.role === 'user'
  ) {
    const c = entry.payload.content
    if (typeof c === 'string') out.push(c)
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || typeof b !== 'object') continue
        if (typeof b.text === 'string') out.push(b.text)
        else if (typeof b.input_text === 'string') out.push(b.input_text)
      }
    }
  }
}

// 收集 entry 用户文本后, 判断是否命中给定 marker 子串 (大小写敏感). 复用 collectEntryUserTexts
// 对三种 entry 形态的覆盖, 让 Blackboard / running flag 等所有系统提醒共用同一套文本抽取.
function entryIncludesMarker(entry: any, marker: string): boolean {
  const texts: string[] = []
  collectEntryUserTexts(entry, texts)
  return texts.some((t) => typeof t === 'string' && t.includes(marker))
}

// 该 entry 是否为 Research Blackboard 更新提醒.
// Blackboard 提醒后端会以 event_msg.user_message / type:user / response_item.message[role=user]
// 三种形态投递, 但语义上是"系统注入"而非"人类提问", 在对话轮次分组里不应开新轮.
export function isBlackboardReminder(entry: any): boolean {
  return entryIncludesMarker(entry, BLACKBOARD_MARKER)
}

// 该 entry 是否为 forgotten-flag-scanner 注入的 running flag 系统提醒.
// 与 Blackboard 同理: 套了 user_message / type:user 的壳, 但不是人类提问, 不应开新轮.
export function isRunningFlagReminder(entry: any): boolean {
  return entryIncludesMarker(entry, RUNNING_FLAG_REMINDER_MARKER)
}

// Claude Code slash command / 本地命令产物 (content 被 <local-command-stdout|caveat|command-name|message|args> 等标签包裹).
// 一次 /compact 等命令会产生 caveat / command-name / stdout 等多条 user 消息, 都套了 user 外壳但不是人类提问.
// 与 Blackboard / running-flag 同理: 不应开新轮, 否则一次命令会被拆成多个空轮次 (如 14.0/15.0/16.0).
// (用正则而非固定子串: 信号是 <tag> 包裹结构, 不像 Blackboard 那样有稳定前缀串; \1 反向引用保证开闭标签匹配.)
const LOCAL_COMMAND_TAG_PATTERN = /<(local-command-stdout|local-command-caveat|command-name|command-message|command-args)>[\s\S]*?<\/\1>/i
export function isLocalCommandReminder(entry: any): boolean {
  const texts: string[] = []
  collectEntryUserTexts(entry, texts)
  return texts.some((t) => typeof t === 'string' && LOCAL_COMMAND_TAG_PATTERN.test(t))
}

// 统一: 任何"系统注入提醒"都不开新轮. 后续新增系统提醒文案时, 在这里 OR 一条 isXxxReminder
// 即可, 无需改动 isNewRound 的主体分支逻辑.
function isSystemReminder(entry: any): boolean {
  return isBlackboardReminder(entry) || isRunningFlagReminder(entry) || isLocalCommandReminder(entry)
}

// 判断是否为真正的用户问题 (而非 tool_result 回调或系统提醒).
// Claude API 把 tool result 也包在 type==="user" 的 message 里 — 只有含 text 块的才算新一轮;
// 同理, Blackboard / forgotten-flag 等系统提醒虽然套了 user_message / type:user 的壳, 也不算新一轮.
export function isNewRound(e: any): boolean {
  if (isSystemReminder(e)) return false
  if (e?.type === 'event_msg' && e?.payload?.type === 'user_message') return true
  if (e?.type === 'response_item' && e?.payload?.type === 'message' && e?.payload?.role === 'user') {
    const c = e?.payload?.content
    if (typeof c === 'string') return c.trim().length > 0
    if (Array.isArray(c)) return c.some((b: any) => b?.type === 'text' || b?.type === 'input_text')
    return false
  }
  if (e?.type === 'user') {
    const c = e?.message?.content
    if (typeof c === 'string') return c.trim().length > 0
    // 数组格式: 只有包含 text 块才算人类问题; 纯 tool_result 数组是工具回调, 不开新轮
    if (Array.isArray(c)) return c.some((b: any) => b?.type === 'text')
    return false
  }
  return false
}
