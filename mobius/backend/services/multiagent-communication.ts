/**
 * multiagent-communication.ts — 跨智能体双向通讯 (直通式).
 *
 * 取代旧 agent-bridge 收件箱机制. 全部逻辑:
 *   ① registerMultiagentLinks: 用户消息含双向 @ 时注册链接 (双向两行, 48h 有效, 幂等续期);
 *   ② deliverMultiagentMessage: /api/multiagent_communication 的处理 — 查链接放行,
 *      包装"收到跨智能体通讯"模板后经 runSessionMessage 直投目标会话 (无 accept/refuse);
 *   ③ 两段提示词模板 (发起侧追加在 @ 消息尾部 / 接收侧包装正文).
 *
 * 单向 (read_only) @ 不经过本模块 — 它只是 transfer bundle 文件引用, 见 session-transfer.ts.
 */
import { Sessions } from '../repositories/sessions';
import { runSessionMessage } from './session-message-runner';
import { db } from '../../db';

const LINK_TTL_HOURS = 48;

function expiresAtIso(from: Date = new Date()): string {
  return new Date(from.getTime() + LINK_TTL_HOURS * 3600 * 1000).toISOString();
}

// 会话归属描述: "项目名 / Issue「标题」" 或 "项目名 / Research「标题」"; 缺项逐级省略.
function sessionScopeLine(session: any): string {
  const parts: string[] = [];
  if (session?.project_name) parts.push(String(session.project_name));
  const scopeTitle = session?.scope_type === 'research'
    ? (session.research_title || '')
    : (session.issue_title || '');
  if (scopeTitle) {
    const kind = session?.scope_type === 'research' ? 'Research' : 'Issue';
    parts.push(`${kind}「${scopeTitle}」`);
  }
  return parts.join('，');
}

// 信息块 (两段模板共用): ID / 归属 / 名称. 值来自 findByIdWithJoins, 不信请求方自报.
function sessionInfoBlock(label: string, session: any): string {
  const scope = sessionScopeLine(session);
  return [
    `${label}智能体信息：`,
    `- ID: ${session?.session_id || '(未知)'}`,
    `- 所属项目，所属的issue/research: ${scope || '(无)'}`,
    `- session名称（如果有）: ${session?.name?.trim() || '(无)'}`,
  ].join('\n');
}

/**
 * 注册双向通讯链接: 一次 @ 同时建 self→target 与 target→self 两行 (@ 即互通).
 * 同对已存在且未过期 → 续期 48h; 已过期 → 覆盖重写. 幂等.
 */
export function registerMultiagentLinks(ownerUserId: string, selfSessionId: string, targetSessionId: string): void {
  const expires = expiresAtIso();
  const tx = db.transaction(() => {
    for (const [source, target] of [[selfSessionId, targetSessionId], [targetSessionId, selfSessionId]] as const) {
      const existing = db.prepare(
        'SELECT id FROM multiagent_links WHERE source_session_id = ? AND target_session_id = ?',
      ).get(source, target) as { id: number } | undefined;
      if (existing) {
        db.prepare(
          "UPDATE multiagent_links SET expires_at = ?, last_active = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
        ).run(expires, existing.id);
      } else {
        db.prepare(`
          INSERT INTO multiagent_links (owner_user_id, source_session_id, target_session_id, expires_at)
          VALUES (?, ?, ?, ?)
        `).run(ownerUserId, source, target, expires);
      }
    }
  });
  tx();
}

/**
 * 发起侧模板: 用户双向 @ 时追加在消息尾部 (不影响附件等解析 — 拼接在最终 content 之后).
 */
export function buildChannelOfferPrompt(selfSession: any, targetSession: any): string {
  return [
    '----------',
    '用户明确要求你和以下智能体建立通讯，你应该主动使用 multiagent_send 发起通讯：',
    '`multiagent_send <self_id> <target_id> "要传达的内容"`',
    '',
    sessionInfoBlock('目标', targetSession),
    '',
    `multiagent_send 在 48h 内有效。目标智能体可能回复你，也可能不会。`,
    '----------',
  ].join('\n').replace('<self_id>', String(selfSession?.session_id || '')).replace('<target_id>', String(targetSession?.session_id || ''));
}

/**
 * 接收侧模板: /api/multiagent_communication 投递时包裹正文.
 * 回复方与发起方走同一 API — 到达对端时套用的也是本模板 (对称).
 */
export function buildIncomingMessagePrompt(sourceSession: any, targetSession: any, content: string): string {
  return [
    '----------',
    '收到跨智能体通讯！',
    '',
    sessionInfoBlock('来源', sourceSession),
    `- 消息：${content}`,
    '',
    '你可以使用 multiagent_send 进行回复，也可以不回复，自由选择。如果需要回复，请使用：',
    '',
    '`multiagent_send <self_id> <target_id> "要传达的内容"`',
    '',
    '其中，target_id 为来源智能体的id，self_id是本会话的id。回复的时间窗口为48小时。',
    '----------',
  ].join('\n').replace('<self_id>', String(targetSession?.session_id || '')).replace('<target_id>', String(sourceSession?.session_id || ''));
}

export type MultiagentSendResult =
  | { ok: true; turnNumber: number; targetSessionId: string; expiresAt: string }
  | { ok: false; status: number; error: string };

/**
 * 处理 multiagent_send 请求: 校验链接 → 包装 → 直投目标会话.
 * 错误以 { status, error } 返回, 路由层转 HTTP; error 文案即 CLI terminal 所见.
 */
export async function deliverMultiagentMessage(args: {
  user: any;
  selfSessionId: string;
  targetSessionId: string;
  content: string;
}): Promise<MultiagentSendResult> {
  const { user, selfSessionId, targetSessionId, content } = args;

  const selfSession = Sessions.findByIdWithJoins(selfSessionId) as any;
  const targetSession = Sessions.findByIdWithJoins(targetSessionId) as any;
  if (!selfSession) {
    return { ok: false, status: 404, error: `发起方 Session 不存在：${selfSessionId}` };
  }
  if (String(selfSession.user_id) !== String(user.id)) {
    return { ok: false, status: 403, error: '无权限：self_id 不属于当前用户' };
  }
  if (!targetSession) {
    return { ok: false, status: 404, error: `目标 Session 不存在：${targetSessionId}` };
  }

  const linkRow = db.prepare(`
    SELECT * FROM multiagent_links
    WHERE source_session_id = ? AND target_session_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(selfSessionId, targetSessionId) as any;
  if (!linkRow) {
    return { ok: false, status: 404, error: `未建立双向通讯关系：Session ${targetSessionId} 未与你互相 @ 过。请用户在消息中重新 @ 建立链接。` };
  }
  if (new Date(linkRow.expires_at).getTime() <= Date.now()) {
    return { ok: false, status: 410, error: `通讯已过期（48h 窗口）：与 Session ${targetSessionId} 的链接已失效。请用户重新 @ 建立后重试。` };
  }

  const wrapped = buildIncomingMessagePrompt(selfSession, targetSession, content);
  try {
    const result = await runSessionMessage({
      user,
      sessionId: targetSessionId,
      content: wrapped,
      source: 'service.multiagent_communication',
      logger: console,
    });
    db.prepare(`
      UPDATE multiagent_links
      SET message_count = message_count + 1, last_active = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(linkRow.id);
    return {
      ok: true,
      turnNumber: Number(result?.turn_number) || 0,
      targetSessionId,
      expiresAt: linkRow.expires_at,
    };
  } catch (e) {
    return { ok: false, status: 500, error: `投递失败：${(e as Error).message || String(e)}` };
  }
}
