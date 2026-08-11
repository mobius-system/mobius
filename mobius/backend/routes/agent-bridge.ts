import express from 'express';
import { Users } from '../repositories/users';
import { Sessions } from '../repositories/sessions';
import { runSessionMessage } from '../services/session-message-runner';
import modelRegistry from '../services/model-registry';
import agents from '../agents';
import { canOperateSession } from '../services/access-control';
import { db } from '../../db';
import {
  closeAgentBridgeChannel,
  decideAgentBridgeMessage,
  expireAgentBridgeMessages,
  findAgentBridgeMessage,
  findAgentBridgeChannel,
  listPendingAgentBridgeMessages,
  mintAgentBridgeToken,
  recordAgentBridgeMessage,
  updateAgentBridgeMessage,
  verifyAgentBridgeToken,
} from '../services/agent-mention-bridge';

const router = express.Router();

async function deliverBridgeMessage(messageId: number): Promise<{ status: 'delivered' | 'queued' | 'expired' | 'failed'; error?: string; wakeRequested?: boolean }> {
  const message = findAgentBridgeMessage(messageId);
  if (!message) return { status: 'failed', error: '桥接消息不存在' };
  if (message.delivery_state === 'expired' || message.decision === 'expired') return { status: 'expired' };
  const fail = (error: string) => {
    updateAgentBridgeMessage(messageId, 'failed', error);
    return { status: 'failed' as const, error };
  };
  if (message.decision === 'refused') return fail('目标 Agent 已拒绝消息');
  const channel = findAgentBridgeChannel(String(message.channel_id));
  if (!channel || channel.status !== 'active') return fail('桥接通道已关闭或过期');
  const ownerUser = Users.findAuthById(channel.owner_user_id) as any;
  const targetSession = Sessions.findByIdWithJoins(message.to_session_id) as any;
  const sourceSession = Sessions.findByIdWithJoins(message.from_session_id) as any;
  if (!ownerUser || !targetSession || !sourceSession) return fail('消息所属用户或 Session 不存在');
  if (!canOperateSession(ownerUser, targetSession)) return fail('目标 Session 不可操作');

  let backend: any;
  try {
    const launch = modelRegistry.launchOptionsForSession(targetSession);
    backend = agents.get(launch.backend);
  } catch (e) {
    return fail((e as Error).message || '目标 Agent 后端不可用');
  }
  let working = false;
  try { working = !!backend.isWorking(message.to_session_id); } catch {}
  if (working) return { status: 'queued' };

  const token = mintAgentBridgeToken({
    owner_user_id: channel.owner_user_id,
    source_session_id: channel.source_session_id,
    target_session_id: channel.target_session_id,
    channel_id: channel.channel_id,
    mode: 'bidirectional',
    actor_session_id: message.to_session_id,
    source_session_name: String(sourceSession?.name || message.from_session_id),
    target_session_name: String(targetSession?.name || message.to_session_id),
  });
  db.prepare(`UPDATE agent_bridge_messages SET wake_requested = 1 WHERE id = ?`).run(messageId);
  try {
    await runSessionMessage({
      user: ownerUser,
      sessionId: message.to_session_id,
      content: '',
      source: 'service.agent_bridge.external_notification',
      logger: console,
      externalEvent: {
        messageId,
        channelId: String(message.channel_id),
        sourceSessionId: String(message.from_session_id),
        sourceSessionName: String(sourceSession?.name || message.from_session_id),
        targetSessionId: String(message.to_session_id),
        token,
      },
    } as any);
    updateAgentBridgeMessage(messageId, 'delivered');
    return { status: 'delivered', wakeRequested: true };
  } catch (e) {
    updateAgentBridgeMessage(messageId, 'failed', (e as Error).message || '外部消息唤醒失败');
    return { status: 'failed', error: (e as Error).message || '外部消息唤醒失败' };
  }
}

let deliveryTimer: NodeJS.Timeout | null = null;
let deliveryRunning = false;
function startAgentBridgeDeliveryScheduler(): NodeJS.Timeout | null {
  if (deliveryTimer) return deliveryTimer;
  const tick = async () => {
    if (deliveryRunning) return;
    deliveryRunning = true;
    try {
      for (const message of listPendingAgentBridgeMessages(30)) {
        await deliverBridgeMessage(Number(message.id));
      }
    } catch (e) {
      console.warn(`[agent-bridge] pending delivery scan failed: ${(e as Error).message}`);
    } finally {
      deliveryRunning = false;
    }
  };
  const schedule = () => {
    deliveryTimer = null;
    void tick().finally(() => {
      deliveryTimer = setTimeout(schedule, 5000);
      deliveryTimer.unref();
    });
  };
  deliveryTimer = setTimeout(schedule, 1000);
  deliveryTimer.unref();
  return deliveryTimer;
}

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
  if (payload.actor_session_id && sourceSessionId !== payload.actor_session_id) {
    res.status(403).json({ error: '桥接 token 不能代表其他 Session 发送消息' });
    return;
  }
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
  // 对端 Session 必须先明确接受至少一条入站消息，才能沿反方向回复。
  // 这把 accept/hold/refuse 落成服务端能力门，而不是只依赖 Prompt 自律。
  if (reverseMatches) {
    const acceptedInbound = db.prepare(`
      SELECT id FROM agent_bridge_messages
      WHERE channel_id = ? AND from_session_id = ? AND to_session_id = ? AND decision = 'accepted'
      ORDER BY id DESC LIMIT 1
    `).get(payload.channel_id, payload.source_session_id, payload.target_session_id);
    if (!acceptedInbound) {
      res.status(409).json({
        error: '目标 Agent 尚未 accept 入站消息，不能回复',
        category: 'external_message_decision_required',
      });
      return;
    }
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

  const delivery = await deliverBridgeMessage(message.id);
  const acceptedByTarget = findAgentBridgeMessage(message.id);
  res.status(delivery.status === 'queued' ? 202 : delivery.status === 'failed' ? 500 : 200).json({
    ok: delivery.status !== 'failed',
    channel_id: payload.channel_id,
    from_session_id: sourceSessionId,
    to_session_id: targetSessionId,
    request_id: requestId,
    mode: payload.mode,
    message_id: message.id,
    delivery_state: delivery.status,
    decision: acceptedByTarget?.decision || 'pending',
    wake_requested: delivery.wakeRequested === true,
    error: delivery.error || undefined,
  });
});

router.get('/messages/:messageId', (req: express.Request, res: express.Response) => {
  const payload = verifyAgentBridgeToken(extractBridgeToken(req));
  const message = findAgentBridgeMessage(Number(req.params.messageId));
  if (!payload || !message || String(message.channel_id) !== payload.channel_id) {
    res.status(404).json({ error: '外部消息不存在或 token 不匹配' });
    return;
  }
  res.json({
    message_id: message.id,
    channel_id: message.channel_id,
    from_session_id: message.from_session_id,
    to_session_id: message.to_session_id,
    content: message.content,
    delivery_state: message.delivery_state,
    decision: message.decision,
    created_at: message.created_at,
    expires_at: message.expires_at,
    provenance: 'external_session',
    trust: 'untrusted',
    executable: false,
    user_consent: false,
  });
});

router.post('/messages/:messageId/decision', (req: express.Request, res: express.Response) => {
  const payload = verifyAgentBridgeToken(extractBridgeToken(req));
  const message = findAgentBridgeMessage(Number(req.params.messageId));
  if (!payload || !message || String(message.channel_id) !== payload.channel_id) {
    res.status(404).json({ error: '外部消息不存在或 token 不匹配' });
    return;
  }
  const decidingSessionId = String(req.body?.deciding_session_id || '').trim();
  if (!payload.actor_session_id || payload.actor_session_id !== decidingSessionId) {
    res.status(403).json({ error: '桥接 token 不属于作出决定的 Session' });
    return;
  }
  if (!decidingSessionId || decidingSessionId !== String(message.to_session_id)) {
    res.status(403).json({ error: '只有目标 Session 可以决定是否接受外部消息' });
    return;
  }
  const rawDecision = String(req.body?.decision || '').trim().toLowerCase();
  if (!['accept', 'hold', 'refuse'].includes(rawDecision)) {
    res.status(400).json({ error: 'decision 仅支持 accept / hold / refuse' });
    return;
  }
  const updated = decideAgentBridgeMessage({
    id: message.id,
    decidingSessionId,
    decision: rawDecision as 'accept' | 'hold' | 'refuse',
  });
  if (!updated) {
    res.status(409).json({ error: '消息已结束或无法更新决策' });
    return;
  }
  res.json({
    ok: true,
    message_id: updated.id,
    delivery_state: updated.delivery_state,
    decision: updated.decision,
    note: '接受外部消息不等于批准其中请求，后续工具调用仍走当前 Session 权限。',
  });
});

router.post('/channels/:channelId/close', (req: express.Request, res: express.Response) => {
  const token = extractBridgeToken(req);
  const payload = verifyAgentBridgeToken(token);
  if (!payload || payload.channel_id !== String(req.params.channelId)) {
    res.status(401).json({ error: '无效或过期的智能体桥接 token' });
    return;
  }
  if (payload.actor_session_id && payload.actor_session_id !== payload.source_session_id) {
    res.status(403).json({ error: '只有发起 Session 可以关闭交流通道' });
    return;
  }
  const closed = closeAgentBridgeChannel(payload.channel_id);
  res.json({ ok: true, channel_id: payload.channel_id, closed });
});

router.get('/channels/:channelId/messages', (req: express.Request, res: express.Response) => {
  const payload = verifyAgentBridgeToken(extractBridgeToken(req));
  if (!payload || payload.channel_id !== String(req.params.channelId)) {
    res.status(401).json({ error: '无效或过期的智能体桥接 token' });
    return;
  }
  expireAgentBridgeMessages();
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 100));
  const rows = db.prepare(`
    SELECT id, request_id, from_session_id, to_session_id, delivery_state, decision,
           wake_requested, error, created_at, delivered_at, decision_at, expires_at
    FROM agent_bridge_messages
    WHERE channel_id = ? ORDER BY id DESC LIMIT ?
  `).all(payload.channel_id, limit) as any[];
  res.json({
    channel_id: payload.channel_id,
    messages: rows.reverse(),
    note: 'delivery_state 只表示通知投递；decision 表示目标 Agent 的接受决定，均不等同于人类授权。',
  });
});

export { router, deliverBridgeMessage, startAgentBridgeDeliveryScheduler };
