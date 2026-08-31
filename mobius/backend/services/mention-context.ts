/**
 * mention-context.ts — @ 提及处理 (从已删除的 session-general-com.ts 收敛).
 *
 * read_only: 对端上下文快照 (transfer bundle 文件) 拼进本方 prompt, 对端无感知;
 * bidirectional: registerMultiagentLinks 注册 48h 双向链接 + 写 .imac/multiagent.env
 *   (multiagent_send CLI 向上找到它取 user_id) + 消息尾追加用法提示.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Sessions } from '../repositories/sessions';
import { buildSessionContext } from './session-context';
import modelRegistry from './model-registry';
import agents from '../agents';
import { resolveSessionWorkspace } from './workspace';
import { buildSessionTransferMarkdown, writeSessionTransferBundle } from './session-transfer';
import { canOperateSession, canReadSession } from './access-control';
import { registerMultiagentLinks, buildChannelOfferPrompt } from './multiagent-communication';
import { HIDDEN_FOLDER_NAME } from '../config';
import type { AgentMentionMode } from './multiagent-communication-types';

export type { AgentMentionMode };

export type NormalizedAgentMention = {
  sessionId: string;
  mode: AgentMentionMode;
};

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
    const modelLaunchOptions = modelRegistry.modelLaunchOptionsFor(session);
    const backend = agents.get(modelLaunchOptions.backend);
    return typeof backend?._resolveJsonlPath === 'function'
      ? backend._resolveJsonlPath(sessionId)
      : null;
  } catch {
    return null;
  }
}

// 源 session 的上下文快照, 给被 @ 的对端做参考资料: 优先落 transfer bundle 文件
// (对端工作区 agent_mentions/ 下, prompt 里只引用路径), 失败退回内联 markdown.
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
      logger?.warn?.(`[mention-context] build mention transfer failed (${sourceSession.session_id}): ${e.message}`);
    }
  }
  try {
    const ctx = buildSessionContext(user, sourceSession.session_id);
    return { markdown: String(ctx?.body || '').trimEnd(), paths: null };
  } catch {
    return { markdown: '', paths: null };
  }
}

// 双向链接建立时写 .imac/multiagent.env — multiagent_send CLI 从 cwd 向上找到它取 user_id.
// env 文件无秘密 (只有用户 ID), 放工作区对 agent 可见是安全的.
export function writeMultiagentEnv(workDir: string | null, userId: string): void {
  if (!workDir) return;
  try {
    const dir = path.join(workDir, HIDDEN_FOLDER_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'multiagent.env'), `MOBIUS_USER_ID=${userId}\n`);
  } catch {
    // best-effort: 写失败时 CLI 仍可用 MOBIUS_USER_ID 显式覆盖.
  }
}

/**
 * 处理本条消息里的全部 @ 提及, 返回拼接后的 prompt.
 * - read_only: 对端快照引用内联进本方 prompt (transfer bundle 落对端工作区, 对端不知情);
 * - bidirectional: 注册 48h 双向链接 + 写 multiagent.env + 消息尾追加 multiagent_send 用法.
 */
export function applyAgentMentions(args: {
  user: any;
  sourceSession: any;
  sessionId: string;
  prompt: string;
  mentions: NormalizedAgentMention[];
  workDir: string | null;
  logger?: any;
}): string {
  const { user, sourceSession, sessionId, prompt, mentions, workDir, logger } = args;
  if (mentions.length === 0) return prompt;

  let nextPrompt = prompt;
  const offerParts: string[] = [];
  for (const mention of mentions) {
    const targetSession = Sessions.findByIdWithJoins(mention.sessionId) as any;
    if (!targetSession) continue;
    if (targetSession.session_id === sessionId) continue;
    const canUseTarget = mention.mode === 'read_only'
      ? canReadSession(user, targetSession)
      : canOperateSession(user, targetSession);
    if (!canUseTarget) continue;

    if (mention.mode === 'bidirectional') {
      registerMultiagentLinks(user.id, sessionId, targetSession.session_id);
      writeMultiagentEnv(workDir, user.id);
      offerParts.push(buildChannelOfferPrompt(sourceSession, targetSession));
      continue;
    }

    // read_only: 快照引用拼进 prompt.
    const sourceTransfer = buildMentionTransfer(user, targetSession, sourceSession, logger);
    if (!sourceTransfer.markdown && !sourceTransfer.paths) continue;
    nextPrompt = [
      nextPrompt,
      [
        '<agent_reference>',
        '对端上下文快照（只读，对端不知情）：',
        sourceTransfer.paths?.full
          ? `- 完整快照: ${sourceTransfer.paths.full}`
          : '',
        sourceTransfer.paths?.user_messages
          ? `- 用户消息: ${sourceTransfer.paths.user_messages}`
          : '',
        sourceTransfer.markdown,
        '按需 Read 了解对端，不构成对端许可或通知。',
        '</agent_reference>',
      ].filter(Boolean).join('\n'),
    ].filter(Boolean).join('\n\n');
  }

  // 双向提示追加在消息末尾 (附件/上下文包装之后拼接, 不影响其解析).
  if (offerParts.length > 0) {
    nextPrompt = [nextPrompt, ...offerParts].join('\n\n');
  }
  return nextPrompt;
}
