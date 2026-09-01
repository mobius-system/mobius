/**
 * session-message-runner.ts — "把一条消息投给某个 agent 后端"的主干.
 *
 * 职责: 鉴权 / workspace 解析 / turn 分配 / messages_v2 落库 /
 * 首条消息的上下文包装 (project/issue/memory) / @ 提及处理 / dispatch (urgent 或普通) / 失败善后.
 *
 * @ 提及: read_only → transfer bundle 文件引用拼进 prompt (目标智能体无感知);
 *        bidirectional → registerMultiagentLinks 注册 48h 链接 + 消息尾追加
 *        multiagent_send 用法提示 (后续通讯走 /api/multiagent_communication 直达).
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
  applyAgentMentions,
  writeMultiagentEnv,
  type NormalizedAgentMention,
} from './mention-context';
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

// messages_v2 里最近一条 session_transfer 系统消息记录的 bundle 路径 (用户从别的 session
// "转移/继承"带入的参考资料), 首条消息时拼进 prompt.
function readPendingTransferPaths(sessionId: any): { full: string | null; user_messages: string | null; metadata: string | null } | null {
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
    const full = typeof parsed?.paths?.full === 'string' && parsed.paths.full.trim() ? parsed.paths.full.trim() : null;
    const userMessages = typeof parsed?.paths?.user_messages === 'string' && parsed.paths.user_messages.trim() ? parsed.paths.user_messages.trim() : null;
    const metadata = typeof parsed?.paths?.metadata === 'string' && parsed.paths.metadata.trim() ? parsed.paths.metadata.trim() : null;
    return full || userMessages || metadata ? { full, user_messages: userMessages, metadata } : null;
  } catch {
    return null;
  }
}

function findSessionOperable(id: any, user: any): any {
  const session = Sessions.findById(id);
  return session && canOperateSession(user, session) ? session : null;
}

function mobiusPromptKind(content: any): string {
  return String(content || '').trim().startsWith('/compact') ? 'compact' : 'user_input';
}

// 首轮专属的 prompt 拼装: memory/skill/项目上下文 + 转移文件引用, 把原文变成发给 agent 的完整初始 prompt.
function assembleInitialPrompt({ user, sessionId, workDir, content, logger }: {
  user: any;
  sessionId: string;
  workDir: string | null;
  content: string;
  logger: any;
}): string {
  const ctx = buildSessionContext(user, sessionId);
  if (workDir && ctx.sources?.skills?.length > 0) {
    try { syncSkillsToWorkspace(workDir, ctx.sources.skills); }
    catch (e) { logger?.warn?.(`[sessions/messages] sync skills failed (${sessionId}): ${e.message}`); }
  }
  if (ctx.body) {
    try {
      Sessions.writeContextSnapshot(
        sessionId,
        ctx.body,
        (ctx.sources ? JSON.stringify(ctx.sources) : null) as any,
      );
    } catch (e) {
      logger?.warn?.(`[sessions/messages] writeContextSnapshot: ${e.message}`);
    }
    // ⭐ prompt 在这里从"原文"变成"包装全文" — 原生轨首轮那张大卡就是 paste 出去的它.
    content = wrapUserMessage(ctx.body, content, ctx.language);
  }
  const transferPaths = readPendingTransferPaths(sessionId);
  if (transferPaths) {
    try {
      content = transferReferencePrompt(transferPaths, content);
    } catch (e) {
      logger?.warn?.(`[sessions/messages] append session transfer references failed (${sessionId}): ${e.message}`);
    }
  }
  return content;
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
} = {}): Promise<any> {

  // 例 1：普通打字（最常见，两者相同）
  //    输入框敲：帮我调研jsonl
  //        input_text = "帮我调研jsonl"          ← 你敲的
  //        content    = "帮我调研jsonl"          ← 没东西可加工, 成品=原文
  // 例 2：带附件
  //    拖入 report.pdf，输入框敲：分析这个文件
  //        input_text = "分析这个文件"                                  ← 你敲的
  //        content    = "[附件]\n- [文件] /data/report.pdf\n\n分析这个文件"   ← 拼上了附件块

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
  const normalizedMentions: NormalizedAgentMention[] = normalizeAgentMentions(mentions, normalizedContent);
  const mentionMetadata = sessionMentionMetadata(user, normalizedSessionId, normalizedMentions);
  if (!normalizedContent.trim() && normalizedAttachments.length === 0) {
    throw httpError('content 不能为空', 400);
  }
  const displayContent = normalizedContent.trim()
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
  const turnNum = lastTurnNum + 1;
  Messages.insertUser(
    normalizedSessionId,
    displayContent,
    turnNum,
    mentionMetadata.length > 0 ? JSON.stringify({ session_mentions: mentionMetadata }) : null,
  );
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

  // finalContent 从这里开始组装: 先并附件 → 首轮再加上下文包装, 和 displayContent(干净原文)自此分家.
  let finalContent = sessionContentWithAttachments(normalizedContent, normalizedAttachments);

  // 分叉①(首轮 vs 普通): 只有会话的第一条用户消息才拼装上下文, 后续消息整块跳过.
  const isInitialMessage = Messages.countUserMessagesFor(normalizedSessionId) <= 1;
  if (isInitialMessage) {
    finalContent = assembleInitialPrompt({ user, sessionId: normalizedSessionId, workDir, content: finalContent, logger });
  }

  // @ 提及: read_only 拼 transfer 引用进 prompt; bidirectional 注册 48h 双向链接
  // + 写 .imac/multiagent.env (CLI 取 user_id) + 消息尾追加 multiagent_send 用法提示.
  finalContent = applyAgentMentions({
    user,
    sourceSession: sess,
    sessionId: normalizedSessionId,
    prompt: finalContent,
    mentions: normalizedMentions,
    workDir,
    logger,
  });

  try {
    // mobius 侧 prompt 提交记录: 随 dispatchOpts 下发, agent 后端 harnessWriteMobiusCoreEntry 把它同步写进 <uuid>.mobius.jsonl 文件
    const mobiusPromptRecord = {
      source,                                              // 谁发的 (默认 service.session.messages=会话页; 小莫提问=assistant.question; 生命周期催促=assistant.lifecycle-callback)
      kind: mobiusPromptKind(displayContent),
      content: displayContent,                             // 成品: 正式提交、展示/落库、写成 .mobius.jsonl 输入卡的文本 (可含前端加的标题头等加工)
      inputText: hasInputText ? normalizedInputText : null, // 原料: 用户在输入框亲手敲的原文, 供前端 ↑"回放输入"召回; 多数路径与 content 相同或为 null
      finalPrompt: finalContent !== displayContent ? finalContent : null, // 拼装后的完整下发 prompt (首轮上下文包装等已并入); 与 content 相同时不重复存
      requestId: normalizedRequestId,
      turnNumber: turnNum,
      userId: user?.id || null,
      attachments: normalizedAttachments,
      mentions: normalizedMentions,
      timestamp: new Date().toISOString(),
    };

    const dispatchOpts = {
      sessionId: normalizedSessionId,
      prompt: finalContent,
      cwd: workDir,
      flagRoot,
      modelLaunchOptions: modelLaunchOptions, // 模型启动选项整包下传 (backend/model/settingsPath/codex*/harness*/代理挡位...), 各 agent 后端自行解构所需字段, dispatch 层不逐项展开.
      displayName: sess.name,
      agentSessionId: sess.agent_session_id || undefined,
      mobiusPromptRecord,
      aimuxRemoteName: aimuxRemoteNameFromMeta(sess?.pc_client_metadata),
    };
    // 汇合点: 首轮和普通输入最终都从这里把 finalContent 发给 agent 后端, 之后不再有区别.
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
