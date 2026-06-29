import { Sessions } from '../repositories/sessions';
import { Messages } from '../repositories/messages';
import { buildSessionContext, wrapUserMessage } from './session-context';
import modelRegistry from './model-registry';
import agents from '../agents';
import { resolveSessionWorkspace } from './workspace';
import { appendSessionInput } from './session-inputs';
import { syncSkillsToWorkspace } from './session-skills-sync';
import { formatBackendSendFailure } from './session-errors';
import { transferAppendPrompt } from './session-transfer';
import { canOperateSession } from './access-control';
import {
  normalizeSessionAttachments,
  sessionContentWithAttachments,
} from './session-attachments';
import {
  safeRemoveRunningFlag,
  safeWriteFailedFlag,
} from '../utils/session-flags';
import { db } from '../../db';

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

function readPendingTransferPath(sessionId: any): string | null {
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
    return typeof parsed?.path === 'string' && parsed.path.trim() ? parsed.path.trim() : null;
  } catch {
    return null;
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
  source = 'service.session.messages',
  logger = console,
  urgent = false,
}: {
  user?: any;
  sessionId?: any;
  content?: any;
  inputText?: any;
  hasInputText?: boolean;
  requestId?: any;
  attachments?: any[];
  source?: string;
  logger?: any;
  urgent?: boolean;
} = {}): Promise<any> {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedContent = typeof content === 'string' ? content : '';
  const normalizedRequestId = typeof requestId === 'string' ? requestId : null;
  const normalizedInputText = hasInputText ? String(inputText || '') : '';

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
  const normalizedAttachments = normalizeSessionAttachments(
    attachments,
    user,
    [workspace.projectRoot, workspace.workDir],
  );
  if (!normalizedContent.trim() && normalizedAttachments.length === 0) {
    throw httpError('content 不能为空', 400);
  }
  const displayContent = normalizedContent.trim()
    ? normalizedContent
    : sessionContentWithAttachments('', normalizedAttachments);

  const launch = modelRegistry.launchOptionsForSession(sess);
  const backend = agents.get(launch.backend);

  const turnNum = (Messages.maxTurnFor(normalizedSessionId) || 0) + 1;
  Messages.insertUser(normalizedSessionId, displayContent, turnNum);
  Sessions.touchActive(normalizedSessionId);
  if (hasInputText) {
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
    kind: mobiusPromptKind(displayContent),
    content: displayContent,
    inputText: hasInputText ? normalizedInputText : null,
    requestId: normalizedRequestId,
    turnNumber: turnNum,
    userId: user?.id || null,
    attachments: normalizedAttachments,
    timestamp: new Date().toISOString(),
  };

  let finalContent = sessionContentWithAttachments(normalizedContent, normalizedAttachments);
  if (Messages.countUserMessagesFor(normalizedSessionId) <= 1) {
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
    const transferPath = readPendingTransferPath(normalizedSessionId);
    if (transferPath) {
      try {
        finalContent = transferAppendPrompt(transferPath, finalContent);
      } catch (e) {
        logger?.warn?.(`[sessions/messages] append session transfer failed (${normalizedSessionId}): ${e.message}`);
      }
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
      displayName: sess.name,
      agentSessionId: sess.claude_session_id || undefined,
      mobiusJsonl,
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
    return {
      ok: true,
      session_id: normalizedSessionId,
      turn_number: turnNum,
      request_id: normalizedRequestId,
      backend: backend.name,
    };
  } catch (e) {
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
