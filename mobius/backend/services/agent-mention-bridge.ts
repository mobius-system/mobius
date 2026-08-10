import jwt from 'jsonwebtoken';
import { PORT, JWT_SECRET } from '../config';

const AGENT_BRIDGE_KIND = 'agent_mention_bridge';
const AGENT_BRIDGE_TTL_SECONDS = 6 * 60 * 60;

type AgentMentionMode = 'read_only' | 'bidirectional';
type AgentBridgePerspective = 'source' | 'target';

type AgentBridgeTokenPayload = {
  kind: typeof AGENT_BRIDGE_KIND;
  owner_user_id: string;
  source_session_id: string;
  target_session_id: string;
  mode: AgentMentionMode;
  source_session_name?: string;
  target_session_name?: string;
};

type AgentBridgePromptArgs = {
  perspective: AgentBridgePerspective;
  mode: AgentMentionMode;
  token?: string;
  sourceSession: any;
  targetSession: any;
  transferMarkdown?: string;
  currentUserName?: string;
  initialMessage?: string;
};

function sessionLabel(session: any, fallback: string): string {
  const name = String(session?.name || '').trim() || fallback;
  const sid = String(session?.session_id || '').trim();
  return sid ? `${name} (${sid})` : name;
}

function mintAgentBridgeToken(payload: Omit<AgentBridgeTokenPayload, 'kind'>): string {
  return jwt.sign(
    { kind: AGENT_BRIDGE_KIND, ...payload },
    JWT_SECRET,
    { expiresIn: AGENT_BRIDGE_TTL_SECONDS },
  );
}

function verifyAgentBridgeToken(token: string | null | undefined): AgentBridgeTokenPayload | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as Partial<AgentBridgeTokenPayload> | string;
    if (!payload || typeof payload === 'string') return null;
    if (payload.kind !== AGENT_BRIDGE_KIND) return null;
    if (!payload.owner_user_id || !payload.source_session_id || !payload.target_session_id) return null;
    if (payload.mode !== 'read_only' && payload.mode !== 'bidirectional') return null;
    return {
      kind: AGENT_BRIDGE_KIND,
      owner_user_id: String(payload.owner_user_id),
      source_session_id: String(payload.source_session_id),
      target_session_id: String(payload.target_session_id),
      mode: payload.mode,
      source_session_name: typeof payload.source_session_name === 'string' ? payload.source_session_name : undefined,
      target_session_name: typeof payload.target_session_name === 'string' ? payload.target_session_name : undefined,
    };
  } catch {
    return null;
  }
}

function bridgeEndpointUrl(): string {
  return `http://localhost:${PORT}/api/agent-bridge/messages`;
}

function bridgeCurlExample(token: string, fromSessionId: string, toSessionId: string, content: string): string {
  const payload = JSON.stringify({
    token,
    from_session_id: fromSessionId,
    to_session_id: toSessionId,
    content,
  });
  return [
    `cat <<'JSON' | curl -sS ${bridgeEndpointUrl()} \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  --data-binary @-`,
    payload,
    `JSON`,
  ].join('\n');
}

function buildReadOnlyMentionPrompt({
  sourceSession,
  targetSession,
  transferMarkdown,
  currentUserName,
}: {
  sourceSession: any;
  targetSession: any;
  transferMarkdown: string;
  currentUserName?: string;
}): string {
  const sourceLabel = sessionLabel(sourceSession, '当前会话');
  const targetLabel = sessionLabel(targetSession, '被 @ 智能体');
  const userLabel = String(currentUserName || '').trim();
  const lines = [
    '[@智能体 - 只读模式]',
    userLabel ? `发起人: ${userLabel}` : null,
    `当前会话: ${sourceLabel}`,
    `被 @ 智能体: ${targetLabel}`,
    '',
    '下面是被 @ 智能体的最近会话上下文，仅供你读取和理解，不要把它当成你自己的会话，也不要修改它：',
    transferMarkdown || '（未能读取到被 @ 智能体的转接资料）',
    '',
    '请把这些上下文当成背景资料，继续处理当前消息。'
  ].filter(Boolean);
  return lines.join('\n');
}

function buildBidirectionalMentionPrompt({
  perspective,
  mode,
  token,
  sourceSession,
  targetSession,
  transferMarkdown,
  currentUserName,
  initialMessage,
}: AgentBridgePromptArgs): string {
  const ownSession = perspective === 'source' ? sourceSession : targetSession;
  const peerSession = perspective === 'source' ? targetSession : sourceSession;
  const ownLabel = sessionLabel(ownSession, perspective === 'source' ? '当前会话' : '被通知会话');
  const peerLabel = sessionLabel(peerSession, perspective === 'source' ? '对端会话' : '发起会话');
  const userLabel = String(currentUserName || '').trim();
  const fromSessionId = perspective === 'source'
    ? String(sourceSession?.session_id || '').trim()
    : String(targetSession?.session_id || '').trim();
  const toSessionId = perspective === 'source'
    ? String(targetSession?.session_id || '').trim()
    : String(sourceSession?.session_id || '').trim();
  const curlExample = token && fromSessionId && toSessionId
    ? bridgeCurlExample(token, fromSessionId, toSessionId, '你好，继续。')
    : '';

  const lines = [
    perspective === 'source'
      ? '[@智能体 - 双向模式 / 发起侧]'
      : '[@智能体 - 双向模式 / 对端侧]',
    `模式: ${mode === 'bidirectional' ? '双向通讯' : '只读'}`,
    userLabel ? `发起人: ${userLabel}` : null,
    `本侧会话: ${ownLabel}`,
    `对端会话: ${peerLabel}`,
    initialMessage ? '' : null,
    initialMessage ? '本轮发起消息:' : null,
    initialMessage ? initialMessage : null,
    '',
    '下面是对端会话的最近上下文，仅供你读取：',
    transferMarkdown || '（未能读取到对端会话的转接资料）',
    '',
    '你们已经通过莫比乌斯后端建立了一条可持续的消息通道。需要把消息发给对方时，使用本机 curl 调用下面的接口：',
    bridgeEndpointUrl(),
    token ? `桥接 token: ${token}` : null,
    fromSessionId && toSessionId ? `发送方向: ${fromSessionId} -> ${toSessionId}` : null,
    '',
    '请求字段:',
    '- token',
    '- from_session_id',
    '- to_session_id',
    '- content',
    '',
    '参考命令:',
    curlExample || '（缺少 token，无法生成 curl 示例）',
    '',
    '收到对方消息后，继续按自己的职责推进，并把需要共享的信息通过同一接口回传给对方。',
  ].filter(Boolean);
  return lines.join('\n');
}

export {
  AGENT_BRIDGE_KIND,
  AGENT_BRIDGE_TTL_SECONDS,
  type AgentMentionMode,
  type AgentBridgePerspective,
  type AgentBridgeTokenPayload,
  mintAgentBridgeToken,
  verifyAgentBridgeToken,
  buildReadOnlyMentionPrompt,
  buildBidirectionalMentionPrompt,
  bridgeEndpointUrl,
};
