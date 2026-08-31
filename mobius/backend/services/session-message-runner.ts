/**
 * session-message-runner.ts — "把一条消息投给某个 agent 后端"的主干.
 *
 * 职责 (与智能体间通信解耦后): 鉴权 / workspace 解析 / turn 分配 / messages_v2 落库 /
 * 首条消息的上下文包装 (project/issue/memory) / dispatch (urgent 或普通) / 失败善后.
 *
 * 智能体间通信 (@ 提及桥接 / 外部 Session 通知唤醒 / 收件箱投递回滚) 全部在
 * ./session-general-com — 本文件只在三个接缝调用它:
 *   1. buildIncomingExternalPrompt  — externalEvent 分支的唤醒 prompt;
 *   2. applyAgentMentions           — 源侧 @ 处理 (read_only 拼 prompt / bidirectional 收集 wakeup);
 *   3. queueBridgeInitialMessages / settleBridgeWakeupsOnFailure — 收件箱投递与失败回滚.
 */
import { Sessions } from '../repositories/sessions';
import { Messages } from '../repositories/messages';
import { buildSessionContext, wrapUserMessage } from './session-context';
import modelRegistry from './model-registry';
import agents from '../agents';
import { resolveSessionWorkspace } from './workspace';
import { appendSessionInput } from './session-inputs';
import { syncSkillsToWorkspace } from './session-skills-sync';
import { formatBackendSendFailure } from './session-errors';
import { transferReferencePrompt } from './session-transfer';
import { canOperateSession } from './access-control';
import {
  normalizeAgentMentions,
  sessionMentionMetadata,
  readPendingTransferPaths,
  buildIncomingExternalPrompt,
  applyAgentMentions,
  queueBridgeInitialMessages,
  settleBridgeWakeupsOnFailure,
  describeBridgeWakeupsQueued,
  externalEventArchiveFields,
  type ExternalSessionEvent,
  type NormalizedAgentMention,
} from './session-general-com';
import {
  normalizeSessionAttachments,
  sessionContentWithAttachments,
} from './session-attachments';
import {
  safeRemoveRunningFlag,
  safeWriteFailedFlag,
} from '../utils/session-flags';
import { db } from '../../db';
import { aimuxRemoteNameFromMeta } from './pc-client-context';

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
  const normalizedMentions: NormalizedAgentMention[] = isExternalEvent ? [] : normalizeAgentMentions(mentions, normalizedContent);
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
  // modelLaunchOptionsFor 本身也会抛错, 但这里给出结构化 category='model_removed'
  // 和需求指定的提示文案, 便于前端精准识别并渲染更换模型入口.
  if (!modelRegistry.resolveSessionModel(sess?.model)) {
    throw httpError(
      '因之前使用的模型被管理员移除，本次会话不能继续，如需继续，请点击"更换模型并继续"。',
      409,
      'model_removed',
    );
  }
  const modelLaunchOptions = modelRegistry.modelLaunchOptionsFor(sess);
  const backend = agents.get(modelLaunchOptions.backend);

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

  // mobius 侧 prompt 提交记录: 随 dispatchOpts 下发, agent 后端 _appendMobiusPromptEntry
  // 把它同步写进 <uuid>.mobius.jsonl 边车文件 (与主 jsonl 双轨, 见 services/mobius-jsonl.ts).
  const mobiusPromptRecord = {
    source,
    kind: isExternalEvent ? 'external_session_message' : mobiusPromptKind(displayContent),
    content: isExternalEvent ? '' : displayContent,
    inputText: isExternalEvent ? null : (hasInputText ? normalizedInputText : null),
    requestId: normalizedRequestId,
    turnNumber: turnNum,
    userId: user?.id || null,
    attachments: normalizedAttachments,
    mentions: normalizedMentions,
    ...externalEventArchiveFields(externalEvent),
    timestamp: new Date().toISOString(),
  };

  // 接缝 1 (目标侧): 外部 Session 通知 → 唤醒 prompt; 普通消息 → 附件拼装.
  let finalContent = buildIncomingExternalPrompt(externalEvent, sess, workDir)
    ?? sessionContentWithAttachments(normalizedContent, normalizedAttachments);

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

  // 处理 @ 其他 Agent （只读模式） 把对端快照拼进本方 prompt;
  // bidirectional 建桥接通道并收集待唤醒清单 pendingBridgeWakeups.
  const mentionResult = isExternalEvent
    ? { prompt: finalContent, pendingBridgeWakeups: [] as ReturnType<typeof applyAgentMentions>['pendingBridgeWakeups'] }
    : applyAgentMentions({
        user,
        sourceSession: sess,
        sessionId: normalizedSessionId,
        prompt: finalContent,
        mentions: normalizedMentions,
        displayContent: normalizedContent.trim() || displayContent,
        workDir,
        logger,
      });
  finalContent = mentionResult.prompt;
  const pendingBridgeWakeups = mentionResult.pendingBridgeWakeups;

  try {
    // 接缝 3a: dispatch 之前先把双向 @ 的首条消息原子落入对端收件箱 (幂等).
    queueBridgeInitialMessages(pendingBridgeWakeups, { sessionId: normalizedSessionId, requestId: normalizedRequestId });
    const dispatchOpts = {
      sessionId: normalizedSessionId,
      prompt: finalContent,
      cwd: workDir,
      flagRoot,
      // 模型启动选项整包下传 (backend/model/settingsPath/codex*/harness*/代理挡位...),
      // 各 agent 后端自行解构所需字段, dispatch 层不逐项展开.
      modelLaunchOptions: modelLaunchOptions,
      displayName: sess.name,
      agentSessionId: sess.agent_session_id || undefined,
      mobiusPromptRecord,
      suppressRunningFlag: isExternalEvent,
      aimuxRemoteName: aimuxRemoteNameFromMeta(sess?.pc_client_metadata),
    };
    if (urgent) {
      // 加急: 中断当前推理/输出再投递
      await backend.pauseCurrentAndResumeFromSession({ ...dispatchOpts, urgent: true });
    } else {
      await backend.noPauseCurrentAndQueueQueryAtSession(dispatchOpts);
    }
    const runtimeInfo = backend.listSessions().find((s: any) => s.sessionId === normalizedSessionId);
    // agent 后端原生会话 ID (claude TUI 的 UUID / codex thread ID), 与 mobius 平台会话 ID 是两层体系.
    // 仅首条消息或 respawn 换了原生会话时才回写, 供下次 dispatch resume 同一原生会话 + 定位 jsonl.
    const newAgentSessionId = runtimeInfo?.agentSessionId || null;
    if (newAgentSessionId && newAgentSessionId !== sess.agent_session_id) {
      try {
        db.prepare('UPDATE sessions_v2 SET agent_session_id=? WHERE session_id=?').run(newAgentSessionId, normalizedSessionId);
      } catch (e) {
        logger?.warn?.(`[sessions/messages] save agent session id: ${e.message}`);
      }
    }
    return {
      ok: true,
      session_id: normalizedSessionId,
      turn_number: turnNum,
      request_id: normalizedRequestId,
      backend: backend.name,
      external_messages_queued: describeBridgeWakeupsQueued(pendingBridgeWakeups),
    };
  } catch (e) {
    // 接缝 3b: dispatch 失败 → 收件箱条目标 failed + 关闭桥接通道.
    settleBridgeWakeupsOnFailure(pendingBridgeWakeups, (e as Error).message);
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
