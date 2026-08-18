import { Sessions } from '../repositories/sessions';
import { Messages } from '../repositories/messages';
import { buildSessionContext, wrapUserMessage } from './session-context';
import modelRegistry from './model-registry';
import agents from '../agents';
import { resolveSessionWorkspace } from './workspace';
import { appendSessionInput } from './session-inputs';
import { syncSkillsToWorkspace } from './session-skills-sync';
import { formatBackendSendFailure } from './session-errors';
import { buildSessionTransferMarkdown, transferReferencePrompt } from './session-transfer';
import { canOperateSession, canReadSession } from './access-control';
import { aimuxRemoteNameFromMeta } from './pc-client-context';
import {
  buildBidirectionalMentionPrompt,
  externalSessionWakePrompt,
  externalSessionDigestWakePrompt,
  closeAgentBridgeChannel,
  createAgentBridgeChannel,
  buildReadOnlyMentionPrompt,
  mintAgentBridgeToken,
  recordAgentBridgeMessage,
  type AgentMentionMode,
} from './agent-mention-bridge';
import {
  normalizeSessionAttachments,
  sessionContentWithAttachments,
} from './session-attachments';
import {
  safeRemoveRunningFlag,
  safeWriteFailedFlag,
} from '../utils/session-flags';
import { db } from '../../db';
import { randomUUID } from 'crypto';

function httpError(message: string, status: number = 500, category: string = ''): Error {
  const err = new Error(message) as Error & { status?: number; category?: string };
  err.status = status;
  if (category) err.category = category;
  return err;
}

function findSessionOperable(id: any, user: any): any {
  const session = Sessions.findById(id);
  return session && canOperateSession(user, session) ? session : null;
}

function mobiusPromptKind(content: any): string {
  return String(content || '').trim().startsWith('/compact') ? 'compact' : 'user_input';
}

interface PendingTransferPaths {
  full: string | null;
  user_messages: string | null;
  metadata: string | null;
}

type NormalizedAgentMention = {
  sessionId: string;
  mode: AgentMentionMode;
};

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


function readPendingTransferPaths(sessionId: any): PendingTransferPaths | null {
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
  // 直填 ID 默认只读，双向模式必须通过选择器明确选择，避免粘贴即唤醒对端。
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

function sessionMentionMetadata(user: any, currentSessionId: string, mentions: NormalizedAgentMention[]): any[] {
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

function buildMentionTransferMarkdown(user: any, sourceSession: any, targetSessionId: string, logger: any): string {
  const jsonlPath = resolveSessionJsonlPath(sourceSession, sourceSession.session_id);
  if (jsonlPath) {
    try {
      const transfer = buildSessionTransferMarkdown({
        sourceSession,
        targetSessionId,
        jsonlPath,
        maxTextChars: 12_000,
        maxTotalChars: 120_000,
      });
      if (transfer?.markdown) return String(transfer.markdown || '').trimEnd();
    } catch (e) {
      logger?.warn?.(`[sessions/messages] build mention transfer failed (${sourceSession.session_id}): ${e.message}`);
    }
  }

  try {
    const ctx = buildSessionContext(user, sourceSession.session_id);
    return String(ctx?.body || '').trimEnd();
  } catch {
    return '';
  }
}

async function runSessionMessage({
  user,
  sessionId,
  content,
  inputText = '',
  hasInputText = false,
  requestId = null,
  attachments = [],
  mentions = [],
  source = 'service.session.messages',
  logger = console,
  urgent = false,
  externalEvent = null,
}: {
  user?: any;
  sessionId?: any;
  content?: any;
  inputText?: any;
  hasInputText?: boolean;
  requestId?: any;
  attachments?: any[];
  mentions?: any[];
  source?: string;
  logger?: any;
  urgent?: boolean;
  externalEvent?: ExternalSessionEvent | null;
} = {}): Promise<any> {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedContent = typeof content === 'string' ? content : '';
  const normalizedRequestId = typeof requestId === 'string' ? requestId : null;
  const normalizedInputText = hasInputText ? String(inputText || '') : '';
  const isExternalEvent = !!externalEvent;

  if (!user?.id) throw httpError('用户不可用', 401);

  const sess = findSessionOperable(normalizedSessionId, user);
  if (!sess) throw httpError(`session ${normalizedSessionId} 不存在或不属于你`, 404);

  const workspace = resolveSessionWorkspace(user, normalizedSessionId);
  if (workspace.error) {
    try { Sessions.setIdle(normalizedSessionId, user.id); } catch {}
    try { Messages.insertSystem(normalizedSessionId, workspace.error, null as any, '工作目录不可用'); } catch {}
    throw httpError(workspace.error, 400, 'workspace');
  }
  const workDir = workspace.workDir;
  const flagRoot = workspace.projectRoot || workspace.workDir;
  const normalizedAttachments = isExternalEvent ? [] : normalizeSessionAttachments(
    attachments,
    user,
    [workspace.projectRoot, workspace.workDir],
  );
  const normalizedMentions = isExternalEvent ? [] : normalizeAgentMentions(mentions, normalizedContent);
  const mentionMetadata = isExternalEvent ? [] : sessionMentionMetadata(user, normalizedSessionId, normalizedMentions);
  if (!isExternalEvent && !normalizedContent.trim() && normalizedAttachments.length === 0) {
    throw httpError('content 不能为空', 400);
  }
  const externalMessageIds = externalEvent?.messages?.map((message) => message.messageId) || (externalEvent ? [externalEvent.messageId] : []);
  const displayContent = isExternalEvent
    ? `[外部 Session 通知 ${externalMessageIds.filter(Boolean).join(', ')}]`
    : normalizedContent.trim()
    ? normalizedContent
    : sessionContentWithAttachments('', normalizedAttachments);

  // 模型被管理员删除/禁用: 会话进入只读状态, 拒绝发消息, 提示"更换模型并继续".
  // launchOptionsForSession 本身也会抛错, 但这里给出结构化 category='model_removed'
  // 和需求指定的提示文案, 便于前端精准识别并渲染更换模型入口.
  if (!modelRegistry.resolveSessionModel(sess?.model)) {
    throw httpError(
      '因之前使用的模型被管理员移除，本次会话不能继续，如需继续，请点击"更换模型并继续"。',
      409,
      'model_removed',
    );
  }
  const launch = modelRegistry.launchOptionsForSession(sess);
  const backend = agents.get(launch.backend);

  const lastTurnNum = Messages.maxTurnFor(normalizedSessionId) || 0;
  const turnNum = isExternalEvent ? lastTurnNum : lastTurnNum + 1;
  if (!isExternalEvent) {
    Messages.insertUser(
      normalizedSessionId,
      displayContent,
      turnNum,
      mentionMetadata.length > 0 ? JSON.stringify({ session_mentions: mentionMetadata }) : null,
    );
    Sessions.touchActive(normalizedSessionId);
  }
  if (hasInputText && !isExternalEvent) {
    try {
      appendSessionInput({
        projectRoot: flagRoot,
        sessionId: normalizedSessionId,
        inputText: normalizedInputText,
        content: displayContent,
        requestId: normalizedRequestId,
        turnNumber: turnNum,
      });
    } catch (e) {
      logger?.warn?.(`[sessions/messages] append session input failed (${normalizedSessionId}): ${e.message}`);
    }
  }

  const mobiusJsonl = {
    source,
    kind: isExternalEvent ? 'external_session_message' : mobiusPromptKind(displayContent),
    content: isExternalEvent ? '' : displayContent,
    inputText: isExternalEvent ? null : (hasInputText ? normalizedInputText : null),
    requestId: normalizedRequestId,
    turnNumber: turnNum,
    userId: user?.id || null,
    attachments: normalizedAttachments,
    mentions: normalizedMentions,
    ...(isExternalEvent ? {
      sourceSessionId: externalEvent?.sourceSessionId,
      targetSessionId: externalEvent?.targetSessionId,
      messageId: externalEvent?.messageId,
      channelId: externalEvent?.channelId,
      batchId: externalEvent?.batchId || null,
      threadId: externalEvent?.threadId || null,
      externalMessages: externalEvent?.messages || null,
    } : {}),
    timestamp: new Date().toISOString(),
  };

  let finalContent = isExternalEvent
    ? externalEvent!.messages && externalEvent!.messages.length > 1
      ? externalSessionDigestWakePrompt({
          messages: externalEvent!.messages,
          targetSession: sess,
          token: externalEvent!.token,
          batchId: externalEvent!.batchId,
          threadId: externalEvent!.threadId,
        })
      : externalSessionWakePrompt({
        messageId: externalEvent!.messageId,
        sourceSession: { session_id: externalEvent!.sourceSessionId, name: externalEvent!.sourceSessionName },
        targetSession: sess,
        token: externalEvent!.token,
      })
    : sessionContentWithAttachments(normalizedContent, normalizedAttachments);
  const bridgeKickoffs: Array<{
    targetSession: any;
    token: string;
    mode: AgentMentionMode;
    channelId: string;
    content: string;
    messageId?: number;
    batchId: string;
  }> = [];
  const mentionBatchId = normalizedMentions.some((mention) => mention.mode === 'bidirectional')
    ? `abatch_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    : null;
  if (
    !isExternalEvent
    && Messages.countUserMessagesFor(normalizedSessionId) <= 1
  ) {
    const ctx = buildSessionContext(user, normalizedSessionId);
    if (workDir && ctx.sources?.skills?.length > 0) {
      try { syncSkillsToWorkspace(workDir, ctx.sources.skills); }
      catch (e) { logger?.warn?.(`[sessions/messages] sync skills failed: ${e.message}`); }
    }
    if (ctx.body) {
      try {
        Sessions.writeContextSnapshot(
          normalizedSessionId,
          ctx.body,
          (ctx.sources ? JSON.stringify(ctx.sources) : null) as any,
        );
      } catch (e) {
        logger?.warn?.(`[sessions/messages] writeContextSnapshot: ${e.message}`);
      }
      finalContent = wrapUserMessage(ctx.body, finalContent, ctx.language);
    }
    const transferPaths = readPendingTransferPaths(normalizedSessionId);
    if (transferPaths) {
      try {
        finalContent = transferReferencePrompt(transferPaths, finalContent);
      } catch (e) {
        logger?.warn?.(`[sessions/messages] append session transfer references failed (${normalizedSessionId}): ${e.message}`);
      }
    }
  }

  if (!isExternalEvent && normalizedMentions.length > 0) {
    for (const mention of normalizedMentions) {
      const targetSession = Sessions.findById(mention.sessionId) as any;
      if (!targetSession) continue;
      if (targetSession.session_id === normalizedSessionId) continue;
      const canUseTarget = mention.mode === 'read_only'
        ? canReadSession(user, targetSession)
        : canOperateSession(user, targetSession);
      if (!canUseTarget) continue;
      const sourceTransferMarkdown = buildMentionTransferMarkdown(user, targetSession, normalizedSessionId, logger);
      if (!sourceTransferMarkdown) continue;
      if (mention.mode === 'read_only') {
        finalContent = [
          finalContent,
          buildReadOnlyMentionPrompt({
            sourceSession: sess,
            targetSession,
            transferMarkdown: sourceTransferMarkdown,
            currentUserName: user?.display_name || user?.id,
          }),
        ].filter(Boolean).join('\n\n');
        continue;
      }

      const channel = createAgentBridgeChannel({
        ownerUserId: user.id,
        sourceSessionId: normalizedSessionId,
        targetSessionId: targetSession.session_id,
        batchId: mentionBatchId,
        threadId: mentionBatchId,
      });
      const token = mintAgentBridgeToken({
        owner_user_id: user.id,
        source_session_id: normalizedSessionId,
        target_session_id: targetSession.session_id,
        channel_id: channel.channelId,
        mode: mention.mode,
        actor_session_id: normalizedSessionId,
        source_session_name: String(sess?.name || '').trim() || normalizedSessionId,
        target_session_name: String(targetSession?.name || '').trim() || targetSession.session_id,
      });
      finalContent = [
        finalContent,
        buildBidirectionalMentionPrompt({
          perspective: 'source',
          mode: mention.mode,
          token,
          sourceSession: sess,
          targetSession,
          transferMarkdown: sourceTransferMarkdown,
          currentUserName: user?.display_name || user?.id,
          channelId: channel.channelId,
        }),
      ].filter(Boolean).join('\n\n');
      bridgeKickoffs.push({
        targetSession,
        token,
        mode: mention.mode,
        channelId: channel.channelId,
        content: normalizedContent.trim() || displayContent,
        batchId: mentionBatchId!,
      });
    }
  }

  try {
    const dispatchOpts = {
      sessionId: normalizedSessionId,
      prompt: finalContent,
      cwd: workDir,
      flagRoot,
      model: launch.model || undefined,
      settingsPath: launch.settingsPath,
      forceNoProxy: launch.forceNoProxy,
      useProxy: launch.forceNoProxy ? false : launch.useProxy === true,
      codexProfileKey: launch.codexProfileKey || undefined,
      codexChannel: launch.codexChannel || undefined,
      codexConfigPath: launch.codexConfigPath || undefined,
      codexSecretEnvKey: launch.codexSecretEnvKey || undefined,
      codexSecretValue: launch.codexSecretValue || undefined,
      harnessProvider: launch.harnessProvider || undefined,
      harnessBaseUrl: launch.harnessBaseUrl || undefined,
      harnessSecretValue: launch.harnessSecretValue || undefined,
      harnessMaxTokens: launch.harnessMaxTokens || undefined,
      harnessRuntimeVersion: launch.harnessRuntimeVersion || undefined,
      displayName: sess.name,
      agentSessionId: sess.claude_session_id || undefined,
      mobiusJsonl,
      suppressRunningFlag: isExternalEvent,
      aimuxRemoteName: aimuxRemoteNameFromMeta(sess?.pc_client_metadata),
    };
    if (urgent) {
      // 加急: 中断当前推理/输出再投递. pauseCurrentAndResumeFromSession 带 prompt =
      // _pauseImpl 的 urgent 分支 (单次 C-c + Alt+Enter 换行 + paste 提交).
      // 空闲/未存活时 _pauseImpl 自带兜底 (不中断直接投递 / respawn-if-dead).
      await backend.pauseCurrentAndResumeFromSession({ ...dispatchOpts, urgent: true });
    } else {
      await backend.noPauseCurrentAndQueueQueryAtSession(dispatchOpts);
    }
    const runtimeInfo = backend.listSessions().find((s: any) => s.sessionId === normalizedSessionId);
    const newAgentSid = runtimeInfo?.agentSessionId || null;
    if (newAgentSid && newAgentSid !== sess.claude_session_id) {
      try {
        db.prepare('UPDATE sessions_v2 SET claude_session_id=? WHERE session_id=?').run(newAgentSid, normalizedSessionId);
      } catch (e) {
        logger?.warn?.(`[sessions/messages] save agent session id: ${e.message}`);
      }
    }
    for (const kickoff of bridgeKickoffs) {
      const queued = recordAgentBridgeMessage({
        channelId: kickoff.channelId,
        requestId: `initial-${normalizedRequestId || `${normalizedSessionId}-${Date.now()}`}`,
        fromSessionId: normalizedSessionId,
        toSessionId: kickoff.targetSession.session_id,
        content: kickoff.content,
        batchId: kickoff.batchId,
        threadId: kickoff.batchId,
      });
      kickoff.messageId = queued.id;
    }
    return {
      ok: true,
      session_id: normalizedSessionId,
      turn_number: turnNum,
      request_id: normalizedRequestId,
      backend: backend.name,
      external_messages_queued: bridgeKickoffs.map((kickoff) => ({
        message_id: kickoff.messageId || null,
        channel_id: kickoff.channelId,
        target_session_id: kickoff.targetSession.session_id,
        delivery: 'queued',
        batch_id: kickoff.batchId,
      })),
    };
  } catch (e) {
    for (const kickoff of bridgeKickoffs) {
      try { closeAgentBridgeChannel(kickoff.channelId); } catch {}
    }
    const { userMessage: detail, rawMessage } = formatBackendSendFailure(e);
    logger?.warn?.(`[sessions/messages] ${rawMessage}${rawMessage !== detail ? `; user_message=${detail}` : ''} (session=${normalizedSessionId})`);
    const failedFields: any = { backend: backend.name, reason: detail };
    if (rawMessage !== detail) failedFields.raw_reason = rawMessage;
    safeRemoveRunningFlag(flagRoot, normalizedSessionId, 'sessions/messages');
    safeWriteFailedFlag(flagRoot, normalizedSessionId, failedFields, 'sessions/messages');
    try { Sessions.setIdle(normalizedSessionId, user.id); } catch {}
    try { Messages.insertSystem(normalizedSessionId, detail, turnNum, '启动失败'); } catch {}
    throw httpError(detail, 500, 'backend');
  }
}

export {
  runSessionMessage,
};
