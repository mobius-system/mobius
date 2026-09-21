/**
 * mobius-kinds.ts — Mobius 用户卡片的 kind 枚举 (零依赖, 前后端共用).
 *
 * kind 回答"这张卡从哪来", 并且是"这张卡开不开新轮"的唯一依据 —— 不再靠正文文本猜来源。
 * 与 session-context-sections.ts 同款做法: 生成侧与消费侧 import 同一份常量, 改枚举后
 * 前端 viewer/utils.ts 自动跟随, 不存在两处维护。
 *
 * 覆盖范围 = 本仓库写入的所有 mobius.kind。唯一的例外是 external_session_message, 它由
 * 仓库外的 PC 客户端直接写进 jsonl, 不在枚举里; 它也不在任何开轮集合中, 故安全。
 */

/*
 * Every kind a Mobius user card can carry. The kind records provenance only; whether it opens a
 * round is decided by ROUND_OPENING_KINDS below.
 */
export const MOBIUS_KIND = {
  // ── 提示卡 (type=user): 由 buildMobiusPromptRecord 写入 ──────────────────
  user: 'user',                    // 人发出的提问: 会话页 / 小莫 / 研究成员启动, 一律算这一类
  userSpCommand: 'user-sp-command',// 其中的 slash command (/compact)
  monitor: 'mobius-monitor',       // 生命周期通知 / running.flag 催办
  blackboard: 'mobius-blackboard', // 黑板提醒 / research 团队系统提示
  extension: 'mobius-extension',   // 扩展发起的会话消息
  com: 'mobius-com',               // 群聊里 @agent 触发
  multiagent: 'mobius-multiagent', // 跨智能体通讯投递的消息 (agent 给 agent 发)
  other: 'mobius-other',           // 兜底: 没有声明自己来源的调用方

  // ── 平台记录卡: 另有两个构造器, type 不是 user, 从不参与开轮 ─────────────
  recentError: 'recent_error',     // 错误扫描写入 (type=error)
  taskState: 'task_state',         // 任务快照 (type=task_state)
} as const;

/*
 * The only slash command that gets its own kind: it rewrites the conversation rather than asking
 * anything, and the viewer renders its result differently from a plain question.
 */
export const SLASH_COMMAND_PREFIX = '/compact';

export type MobiusKind = (typeof MOBIUS_KIND)[keyof typeof MOBIUS_KIND];

/*
 * The kinds that open a new round: each is an independent unit of work delivered to a session.
 * Whatever is not listed here joins the round already in progress — and when the session has no
 * round yet that means group 0, so any kind that arrives first in a fresh session must be listed.
 */
export const ROUND_OPENING_KINDS: ReadonlySet<string> = new Set<string>([
  // 人提交的提问: 会话页 / 小莫 / 研究成员启动
  // A prompt someone submitted: session page, 小莫, or a research member being launched
  MOBIUS_KIND.user,
  MOBIUS_KIND.userSpCommand,
  // 跨智能体通讯: 每条投递是独立一件事, 否则会全部堆进同一轮
  // A cross-agent delivery is its own unit of work, or they all pile up in one round
  MOBIUS_KIND.multiagent,
  // 群聊 @agent: 跑在一条全新分身 session 里, 是该会话的第一条消息, 必须开第 1 轮
  // A group @ mention runs in a fresh clone session, where it is the first message
  MOBIUS_KIND.com,
  // 扩展发起: 扩展先建空 session 再投第一条消息 (self-cognition / chatgpt 都是这个模式)
  // An extension creates an empty session and posts its first message through this path
  MOBIUS_KIND.extension,
]);

/*
 * Picks the kind for a submitted prompt: a slash command is still the user speaking, but the
 * viewer treats its result as a command rather than a question. Whoever submits — the session
 * page or 小莫 — goes through here, so both land on the same kind.
 */
export function sessionPromptKind(content: unknown): MobiusKind {
  const text = String(content || '').trim();
  return text.startsWith(SLASH_COMMAND_PREFIX) ? MOBIUS_KIND.userSpCommand : MOBIUS_KIND.user;
}

/*
 * Kinds recorded before this enum existed, when kind still meant "card type". Historical rows keep
 * their opener status through these; the set can go once no stored session predates the change.
 */
export const LEGACY_ROUND_OPENING_KINDS: ReadonlySet<string> = new Set<string>([
  'user_input',   // 旧的 user / compact 合并值, 现在拆成 user 与 user-sp-command
  'compact',
]);

/*
 * Read-side test for a stored card: does it open its round? Lenient on purpose — it accepts the
 * legacy kinds so sessions written before the enum still resolve the same opener.
 */
export function kindOpensRound(kind: unknown): boolean {
  const value = String(kind || '');
  return ROUND_OPENING_KINDS.has(value) || LEGACY_ROUND_OPENING_KINDS.has(value);
}
