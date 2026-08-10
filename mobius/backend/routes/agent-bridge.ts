import express from 'express';
import { Users } from '../repositories/users';
import { Sessions } from '../repositories/sessions';
import { runSessionMessage } from '../services/session-message-runner';
import {
  closeAgentBridgeChannel,
  findAgentBridgeChannel,
  recordAgentBridgeMessage,
  updateAgentBridgeMessage,
  verifyAgentBridgeToken,
} from '../services/agent-mention-bridge';

const router = express.Router();

function extractBridgeToken(req: express.Request): string {
  const bodyToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (bodyToken) return bodyToken;
  const authHeader = String(req.headers.authorization || '').trim();
  if (authHeader) {
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (bearer) return bearer;
  }
  const headerToken = String(req.headers['x-agent-bridge-token'] || '').trim();
  if (headerToken) return headerToken;
  return '';
}

router.post('/messages', async (req: express.Request, res: express.Response) => {
  const token = extractBridgeToken(req);
  const payload = verifyAgentBridgeToken(token);
  if (!payload) {
    res.status(401).json({ error: '无效或过期的智能体桥接 token' });
    return;
  }
  if (payload.mode !== 'bidirectional') {
    res.status(403).json({ error: '只读 @ 不允许向对端发送消息' });
    return;
  }

  const bodyFromSessionId = typeof req.body?.from_session_id === 'string' ? req.body.from_session_id.trim() : '';
  const bodyToSessionId = typeof req.body?.to_session_id === 'string' ? req.body.to_session_id.trim() : '';
  const sourceSessionId = bodyFromSessionId || payload.source_session_id;
  const targetSessionId = bodyToSessionId || payload.target_session_id;
  const sourceMatches = sourceSessionId === payload.source_session_id && targetSessionId === payload.target_session_id;
  const reverseMatches = sourceSessionId === payload.target_session_id && targetSessionId === payload.source_session_id;
  if (!sourceMatches && !reverseMatches) {
    res.status(403).json({ error: '桥接 token 与会话配对不一致' });
    return;
  }

  const content = String(req.body?.content || '').trim();
  if (!content) {
    res.status(400).json({ error: 'content 不能为空' });
    return;
  }
  if (content.length > 8000) {
    res.status(400).json({ error: 'content 过长' });
    return;
  }

  const ownerUser = Users.findAuthById(payload.owner_user_id) as any;
  if (!ownerUser) {
    res.status(401).json({ error: '桥接所属用户不存在' });
    return;
  }
  const targetSession = Sessions.findById(targetSessionId) as any;
  if (!targetSession) {
    res.status(404).json({ error: '目标 Session 不存在' });
    return;
  }

  const channel = findAgentBridgeChannel(payload.channel_id);
  if (!channel || channel.status !== 'active') {
    res.status(409).json({ error: '桥接通道已关闭、过期或耗尽' });
    return;
  }
  const channelPair = (sourceSessionId === channel.source_session_id && targetSessionId === channel.target_session_id)
    || (sourceSessionId === channel.target_session_id && targetSessionId === channel.source_session_id);
  if (channel.owner_user_id !== payload.owner_user_id || !channelPair) {
    res.status(403).json({ error: '桥接通道与会话方向不一致' });
    return;
  }
  const requestId = typeof req.body?.request_id === 'string' && req.body.request_id.trim()
    ? req.body.request_id.trim().slice(0, 200)
    : `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let message: { id: number; duplicate: boolean };
  try {
    message = recordAgentBridgeMessage({
      channelId: payload.channel_id,
      requestId,
      fromSessionId: sourceSessionId,
      toSessionId: targetSessionId,
      content,
    });
  } catch (e) {
    res.status(409).json({ error: (e as Error).message || '桥接消息无法入队' });
    return;
  }
  if (message.duplicate) {
    res.json({ ok: true, duplicate: true, channel_id: payload.channel_id, request_id: requestId });
    return;
  }

  try {
    const result = await runSessionMessage({
      user: ownerUser,
      sessionId: targetSessionId,
      content,
      inputText: content,
      hasInputText: true,
      requestId: `agent-bridge-${payload.channel_id}-${message.id}`,
      source: 'api.agent_bridge.messages',
      logger: console,
      urgent: req.body?.urgent === true,
    } as any);
    updateAgentBridgeMessage(message.id, 'delivered');
    res.json({
      ok: true,
      channel_id: payload.channel_id,
      from_session_id: sourceSessionId,
      to_session_id: targetSessionId,
      request_id: result?.request_id ?? null,
      turn_number: result?.turn_number ?? null,
      mode: payload.mode,
      message_id: message.id,
    });
  } catch (e) {
    const err = e as any;
    updateAgentBridgeMessage(message.id, 'failed', err.message || '桥接消息发送失败');
    res.status(err.status || 500).json({
      error: err.message || '桥接消息发送失败',
      category: err.category || undefined,
    });
  }
});

router.post('/channels/:channelId/close', (req: express.Request, res: express.Response) => {
  const token = extractBridgeToken(req);
  const payload = verifyAgentBridgeToken(token);
  if (!payload || payload.channel_id !== String(req.params.channelId)) {
    res.status(401).json({ error: '无效或过期的智能体桥接 token' });
    return;
  }
  const closed = closeAgentBridgeChannel(payload.channel_id);
  res.json({ ok: true, channel_id: payload.channel_id, closed });
});

export { router };
