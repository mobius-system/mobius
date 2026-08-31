/**
 * session-general-com.ts — 智能体间通信 (agent-to-agent) 逻辑, 与"简单发消息"解耦.
 *
 * 从 session-message-runner.ts 抽出. runner 只保留"把一条 prompt 投给某个 agent 后端"的
 * 主干 (turn 分配 / 上下文包装 / dispatch / 失败善后), 所有跨 Session 协作关注点集中在本文件:
 *
 *   1. @ 提及 (mention) 处理 — 源侧:
 *      - read_only: 把对端上下文快照 (transfer bundle) 拼进本方 prompt, 对端无感知;
 *      - bidirectional: 建桥接通道 + 铸 JWT + stage 凭证 + 拼双向协作 prompt,
 *        并登记 pendingBridgeWakeups 等待投递.
 *   2. 外部通知 (externalEvent) 处理 — 目标侧:
 *      收到别的 agent @ 了本 session 时, stage 本侧桥接凭证并生成唤醒 prompt
 *      ("有外部通知, 用 bridge CLI read/accept/reply 处理"), 不写 messages_v2 / 不占 turn.
 *   3. 收件箱投递: dispatch 前 + 失败后对 pendingBridgeWakeups 的原子落库与回滚.
 *
 * 安全边界 (与 agent-mention-bridge.ts 的 trust boundary 对齐):
 * token 只落服务端受限目录 (0600) + workspace 写入无秘密 bridge CLI,
 * prompt 里只出现文件名级短 ID, token 永不进 LLM 上下文.
 */
import { Sessions } from '../repositories/sessions';
import { buildSessionContext } from './session-context';
import modelRegistry from './model-registry';
import agents from '../agents';
import { resolveSessionWorkspace } from './workspace';
import { storeBridgeToken, writeBridgeCliToWorkspace, type BridgeCredential } from './agent-bridge-cli';
import { buildSessionTransferMarkdown, writeSessionTransferBundle } from './session-transfer';
import { canOperateSession, canReadSession } from './access-control';
import {
  buildBidirectionalMentionPrompt,
  externalSessionWakePrompt,
  externalSessionDigestWakePrompt,
  closeAgentBridgeChannel,
  createAgentBridgeChannel,
  buildReadOnlyMentionPrompt,
  mintAgentBridgeToken,
  recordAgentBridgeMessage,
  updateAgentBridgeMessage,
  type AgentMentionMode,
} from './agent-mention-bridge';
import { db } from '../../db';
import { randomUUID } from 'crypto';
import { HIDDEN_FOLDER_NAME } from '../config';

export type { AgentMentionMode };

// 外部通知事件: 投递调度器 (routes/agent-bridge.ts deliverBridgeMessages) 从收件箱打包后
// 递归调 runSessionMessage 时传入, 标识"这条消息是别的 agent @ 了本 session".
export type ExternalSessionEvent = {
  messageId: number;
  channelId: string;
  sourceSessionId: string;
  sourceSessionName?: string;
  targetSessionId: string;
  token: string;
  batchId?: string | null;
  threadId?: string | null;
  messages?: Array<{
    messageId: number;
    channelId: string;
    sourceSessionId: string;
    sourceSessionName?: string;
  }>;
};

export type NormalizedAgentMention = {
  sessionId: string;
  mode: AgentMentionMode;
};

// 双向 @ 桥接的"待唤醒目标"清单: 每个 bidirectional mention 一项 (通道 + 铸好的 token + 首条投递内容).
// 职责链: ① applyAgentMentions 里逐 mention 建通道/mint token 后 push 进来;
//         ② dispatch 源 agent 之前, 先把首条消息原子落入对端收件箱 (queueBridgeInitialMessages),
//            消除"用户已发送但对端根本收不到"的窗口;
//         ③ dispatch 成功 → 响应里 external_messages_queued 报给前端; 失败 → settleBridgeWakeups
//            逐项回滚 (updateAgentBridgeMessage('failed') + closeAgentBridgeChannel).
export type PendingBridgeWakeup = {
  targetSession: any;
  token: string;
  mode: AgentMentionMode;
  channelId: string;
  content: string;
  messageId?: number;
  batchId: string;
};

interface PendingTransferPaths {
  full: string | null;
  user_messages: string | null;
  metadata: string | null;
}

// messages_v2 里最近一条 session_transfer 系统消息记录的 bundle 路径 (用户从别的 session
// "转移/继承"带入的参考资料), 首条消息时拼进 prompt. 属于会话迁移而非 agent 间通信,
// 但与 mention transfer 同源 (session-transfer.ts), 一并放这里.
export function readPendingTransferPaths(sessionId: any): PendingTransferPaths | null {
  try {
    const row = db.prepare(`
      SELECT content
      FROM messages_v2
      WHERE task_id = ? AND role = 'system' AND turn_summary = 'session_transfer'
      ORDER BY id DESC
      LIMIT 1
    `).get(sessionId) as { content?: string } | undefined;
    if (!row?.content) return null;
    const parsed = JSON.parse(row.content);
    const full = typeof parsed?.paths?.full === 'string' && parsed.paths.full.trim()
      ? parsed.paths.full.trim()
      : typeof parsed?.path === 'string' && parsed.path.trim()
        ? parsed.path.trim()
        : null;
    const userMessages = typeof parsed?.paths?.user_messages === 'string' && parsed.paths.user_messages.trim()
      ? parsed.paths.user_messages.trim()
      : typeof parsed?.paths?.userMessages === 'string' && parsed.paths.userMessages.trim()
        ? parsed.paths.userMessages.trim()
        : null;
    const metadata = typeof parsed?.paths?.metadata === 'string' && parsed.paths.metadata.trim()
      ? parsed.paths.metadata.trim()
      : null;
    return full || userMessages || metadata ? { full, user_messages: userMessages, metadata } : null;
  } catch {
    return null;
  }
}

// 归一化 @ 提及: 前端 mention 选择器对象 + 正文里粘贴的 `session=<id>` 都收进来.
// 同 session 去重, bidirectional 优先; 直填 ID 默认只读, 双向必须通过选择器明确选择
// (避免粘贴即唤醒对端).
export function normalizeAgentMentions(mentions: any, content: string = ''): NormalizedAgentMention[] {
  const indexBySession = new Map<string, number>();
  const output: NormalizedAgentMention[] = [];
  for (const raw of Array.isArray(mentions) ? mentions : []) {
    if (!raw || typeof raw !== 'object') continue;
    const kind = String(raw.kind || raw.type || '').trim();
    if (kind !== 'agent') continue;
    const sessionId = String(raw.session_id || raw.sessionId || raw.id || '').trim();
    if (!sessionId) continue;
    const mode = String(raw.mode || raw.mention_mode || raw.agent_mode || '').trim() === 'bidirectional'
      ? 'bidirectional'
      : 'read_only';
    const existingIndex = indexBySession.get(sessionId);
    if (existingIndex != null) {
      if (mode === 'bidirectional') output[existingIndex] = { sessionId, mode };
      continue;
    }
    indexBySession.set(sessionId, output.length);
    output.push({ sessionId, mode });
  }
  // 支持从别的页面直接复制 `session=<id>`，也支持 `@session=<id>`。
  const copiedIds = String(content || '').match(/(?:^|[\s(@])@?session=([A-Za-z0-9_-]{4,128})(?=$|[\s),.;!?，。！？])/gi) || [];
  for (const raw of copiedIds) {
    const match = raw.match(/session=([A-Za-z0-9_-]{4,128})/i);
    const sessionId = match?.[1]?.trim();
    if (!sessionId || indexBySession.has(sessionId)) continue;
    indexBySession.set(sessionId, output.length);
    output.push({ sessionId, mode: 'read_only' });
  }
  return output;
}

// @ 提及的展示元数据 (落 messages_v2.metadata.session_mentions, 前端渲染提及链).
export function sessionMentionMetadata(user: any, currentSessionId: string, mentions: NormalizedAgentMention[]): any[] {
  return mentions.map((mention) => {
    if (!mention.sessionId || mention.sessionId === currentSessionId) return null;
    const target = Sessions.findByIdWithJoins(mention.sessionId) as any;
    if (!target) return null;
    const allowed = mention.mode === 'read_only'
      ? canReadSession(user, target)
      : canOperateSession(user, target);
    if (!allowed) return null;
    const scopeTitle = target.scope_type === 'research'
      ? (target.research_title || target.research_id || '')
      : (target.issue_title || target.issue_id || '');
    return {
      session_id: target.session_id,
      name: target.name || target.session_id,
      mode: mention.mode,
      project_id: target.project_id || null,
      project_name: target.project_name || target.project_id || '',
      scope_type: target.scope_type || null,
      scope_id: target.scope_type === 'research' ? target.research_id : target.issue_id,
      scope_title: scopeTitle,
      context_at: new Date().toISOString(),
    };
  }).filter(Boolean);
}

// 提及目标 session 的 jsonl 路径 (跨后端兜底查询).
function resolveSessionJsonlPath(session: any, sessionId: string): string | null {
  try {
    const launch = modelRegistry.launchOptionsForSession(session);
    const backend = agents.get(launch.backend);
    return typeof backend?._resolveJsonlPath === 'function'
      ? backend._resolveJsonlPath(sessionId)
      : null;
  } catch {
    return null;
  }
}

// 源 session 的上下文快照, 给被 @ 的对端做参考资料: 优先落 transfer bundle 文件
// (对端工作区 agent_mentions/ 下, prompt 里只引用路径), 失败退回内联 markdown, 再退回
// buildSessionContext 全文.
function buildMentionTransfer(user: any, sourceSession: any, targetSession: any, logger: any): {
  markdown: string;
  paths: { full?: string | null; user_messages?: string | null; metadata?: string | null } | null;
} {
  const jsonlPath = resolveSessionJsonlPath(sourceSession, sourceSession.session_id);
  if (jsonlPath) {
    try {
      const targetWorkspace = resolveSessionWorkspace(user, targetSession.session_id);
      const bindPath = targetWorkspace.projectRoot || targetWorkspace.workDir;
      if (bindPath) {
        const bundle = writeSessionTransferBundle({
          bindPath,
          sourceSession,
          targetSessionId: targetSession.session_id,
          jsonlPath,
          directoryName: 'agent_mentions',
        });
        return { markdown: '', paths: bundle?.paths || null };
      }
      const transfer = buildSessionTransferMarkdown({ sourceSession, targetSessionId: targetSession.session_id, jsonlPath, maxTextChars: 4000, maxTotalChars: 12000 });
      if (transfer?.markdown) return { markdown: String(transfer.markdown || '').trimEnd(), paths: null };
    } catch (e) {
      logger?.warn?.(`[session-general-com] build mention transfer failed (${sourceSession.session_id}): ${e.message}`);
    }
  }

  try {
    const ctx = buildSessionContext(user, sourceSession.session_id);
    return { markdown: String(ctx?.body || '').trimEnd(), paths: null };
  } catch {
    return { markdown: '', paths: null };
  }
}

// 桥接凭证: token 落服务端受限目录 (0600), workspace 写入无秘密 CLI.
// prompt 里只出现 "bridge read 42" 级别的短指令, token 永不进 LLM 上下文.
function stageBridgeCredential(token: string, channelId: string, workDir: string | null, suffix = ''): BridgeCredential | null {
  const trimmed = String(token || '').trim();
  if (!trimmed || !channelId) return null;
  try {
    const credential = storeBridgeToken(trimmed, channelId, suffix);
    if (workDir) {
      try { writeBridgeCliToWorkspace(workDir, HIDDEN_FOLDER_NAME); } catch {}
    }
    return credential;
  } catch {
    return null;
  }
}

/**
 * 目标侧入口: 本条消息是"外部 Session 通知"(别的 agent @ 了本 session)时,
 * stage 本侧桥接凭证并生成唤醒 prompt. suffix 区分单条唤醒 (wake) 与批量摘要 (digest)
 * 两种凭证文件. 返回 null 表示不是外部事件, 调用方走普通消息路径.
 */
export function buildIncomingExternalPrompt(
  externalEvent: ExternalSessionEvent | null | undefined,
  sess: any,
  workDir: string | null,
): string | null {
  if (!externalEvent) return null;
  const incomingBridgeCredential = stageBridgeCredential(
    externalEvent.token,
    String(externalEvent.channelId || ''),
    workDir,
    externalEvent.messages && externalEvent.messages.length > 1 ? 'digest' : 'wake',
  );
  return externalEvent.messages && externalEvent.messages.length > 1
    ? externalSessionDigestWakePrompt({
        messages: externalEvent.messages,
        targetSession: sess,
        credential: incomingBridgeCredential,
        batchId: externalEvent.batchId,
        threadId: externalEvent.threadId,
      })
    : externalSessionWakePrompt({
      messageId: externalEvent.messageId,
      sourceSession: { session_id: externalEvent.sourceSessionId, name: externalEvent.sourceSessionName },
      targetSession: sess,
      credential: incomingBridgeCredential,
    });
}

/**
 * 源侧入口: 处理本条消息里的全部 @ 提及, 返回拼接后的 prompt 与待唤醒清单.
 * - read_only mention: 对端上下文快照内联进本方 prompt, 对端无感知, 不产生 wakeup;
 * - bidirectional mention: 建通道 + 铸 token + stage 源侧凭证 ('src') + 拼双向协作 prompt,
 *   并 push 一个 PendingBridgeWakeup (内容/通道/批次) 供后续投递.
 * 同一条消息 @ 多个 bidirectional 目标共享一个 batchId (abatch_*), 投递侧按 thread 分组 digest.
 */
export function applyAgentMentions(args: {
  user: any;
  sourceSession: any;
  sessionId: string;
  prompt: string;
  mentions: NormalizedAgentMention[];
  displayContent: string;
  workDir: string | null;
  logger?: any;
}): { prompt: string; pendingBridgeWakeups: PendingBridgeWakeup[] } {
  const { user, sourceSession, sessionId, prompt, mentions, displayContent, workDir, logger } = args;
  const pendingBridgeWakeups: PendingBridgeWakeup[] = [];
  if (mentions.length === 0) return { prompt, pendingBridgeWakeups };

  let nextPrompt = prompt;
  const mentionBatchId = mentions.some((mention) => mention.mode === 'bidirectional')
    ? `abatch_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    : null;

  for (const mention of mentions) {
    const targetSession = Sessions.findById(mention.sessionId) as any;
    if (!targetSession) continue;
    if (targetSession.session_id === sessionId) continue;
    const canUseTarget = mention.mode === 'read_only'
      ? canReadSession(user, targetSession)
      : canOperateSession(user, targetSession);
    if (!canUseTarget) continue;
    const sourceTransfer = buildMentionTransfer(user, targetSession, sourceSession, logger);
    if (!sourceTransfer.markdown && !sourceTransfer.paths) continue;
    if (mention.mode === 'read_only') {
      nextPrompt = [
        nextPrompt,
        buildReadOnlyMentionPrompt({
          sourceSession,
          targetSession,
          transferMarkdown: sourceTransfer.markdown,
          transferPaths: sourceTransfer.paths,
          currentUserName: user?.display_name || user?.id,
        }),
      ].filter(Boolean).join('\n\n');
      continue;
    }

    const channel = createAgentBridgeChannel({
      ownerUserId: user.id,
      sourceSessionId: sessionId,
      targetSessionId: targetSession.session_id,
      batchId: mentionBatchId,
      threadId: mentionBatchId,
    });
    const token = mintAgentBridgeToken({
      owner_user_id: user.id,
      source_session_id: sessionId,
      target_session_id: targetSession.session_id,
      channel_id: channel.channelId,
      mode: mention.mode,
      actor_session_id: sessionId,
      source_session_name: String(sourceSession?.name || '').trim() || sessionId,
      target_session_name: String(targetSession?.name || '').trim() || targetSession.session_id,
    });
    // 源侧桥接凭证 (suffix 'src'): 本方 agent 回复对端时用的 CLI 凭证, 与对端收到的
    // 'wake'/'digest' 凭证区分. token 仍只落服务端, prompt 里是文件名级短 ID.
    const sourceBridgeCredential = stageBridgeCredential(token, channel.channelId, workDir, 'src');
    nextPrompt = [
      nextPrompt,
      buildBidirectionalMentionPrompt({
        perspective: 'source',
        mode: mention.mode,
        credential: sourceBridgeCredential,
        sourceSession,
        targetSession,
        transferMarkdown: sourceTransfer.markdown,
        transferPaths: sourceTransfer.paths,
        currentUserName: user?.display_name || user?.id,
        channelId: channel.channelId,
      }),
    ].filter(Boolean).join('\n\n');
    pendingBridgeWakeups.push({
      targetSession,
      token,
      mode: mention.mode,
      channelId: channel.channelId,
      content: displayContent,
      batchId: mentionBatchId!,
    });
  }
  return { prompt: nextPrompt, pendingBridgeWakeups };
}

/**
 * 收件箱投递: dispatch 源 agent 之前, 先把双向 @ 的首条消息原子落入对端收件箱.
 * 旧顺序在 dispatch 成功后才写库; spawn/网络异常会留下"用户已发送但对端根本收不到"的窗口.
 * request_id 幂等去重, 重试不会重复投递.
 */
export function queueBridgeInitialMessages(
  pendingBridgeWakeups: PendingBridgeWakeup[],
  args: { sessionId: string; requestId: string | null },
): void {
  for (const wakeup of pendingBridgeWakeups) {
    const queued = recordAgentBridgeMessage({
      channelId: wakeup.channelId,
      requestId: `initial-${args.requestId || `${args.sessionId}-${Date.now()}`}`,
      fromSessionId: args.sessionId,
      toSessionId: wakeup.targetSession.session_id,
      content: wakeup.content,
      batchId: wakeup.batchId,
      threadId: wakeup.batchId,
    });
    wakeup.messageId = queued.id;
  }
}

/**
 * 投递收尾: dispatch 失败时逐项回滚 (收件箱条目标 failed + 关闭通道).
 * dispatch 成功侧不需要调用本函数 — 响应字段 external_messages_queued 由 runner 直接映射.
 */
export function settleBridgeWakeupsOnFailure(pendingBridgeWakeups: PendingBridgeWakeup[], error: string): void {
  for (const wakeup of pendingBridgeWakeups) {
    if (wakeup.messageId) {
      try { updateAgentBridgeMessage(wakeup.messageId, 'failed', error || '源 Session 启动失败'); } catch {}
    }
    try { closeAgentBridgeChannel(wakeup.channelId); } catch {}
  }
}

// runner 响应里的回执字段: 每个 wakeup 一条, delivery='queued' 表示"已进对端收件箱",
// 由 routes/agent-bridge.ts 的 2s 投递调度器接力 (目标空闲时打包成 externalEvent 递归唤醒).
export function describeBridgeWakeupsQueued(pendingBridgeWakeups: PendingBridgeWakeup[]): any[] {
  return pendingBridgeWakeups.map((wakeup) => ({
    message_id: wakeup.messageId || null,
    channel_id: wakeup.channelId,
    target_session_id: wakeup.targetSession.session_id,
    delivery: 'queued',
    batch_id: wakeup.batchId,
  }));
}

// 供 mobiusPromptRecord 归档外部事件溯源字段 (不进 prompt, 只进 .mobius.jsonl 边车).
export function externalEventArchiveFields(externalEvent: ExternalSessionEvent | null | undefined): any {
  if (!externalEvent) return {};
  return {
    sourceSessionId: externalEvent.sourceSessionId,
    targetSessionId: externalEvent.targetSessionId,
    messageId: externalEvent.messageId,
    channelId: externalEvent.channelId,
    batchId: externalEvent.batchId || null,
    threadId: externalEvent.threadId || null,
    externalMessages: externalEvent.messages || null,
  };
}


