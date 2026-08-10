import express from 'express';
import { Users } from '../repositories/users';
import { Sessions } from '../repositories/sessions';
import { runSessionMessage } from '../services/session-message-runner';
import { verifyAgentBridgeToken } from '../services/agent-mention-bridge';

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

  try {
    const result = await runSessionMessage({
      user: ownerUser,
      sessionId: targetSessionId,
      content,
      inputText: content,
      hasInputText: true,
      requestId: typeof req.body?.request_id === 'string' ? req.body.request_id : `bridge-${Date.now()}`,
      source: 'api.agent_bridge.messages',
      logger: console,
      urgent: req.body?.urgent === true,
    } as any);
    res.json({
      ok: true,
      from_session_id: sourceSessionId,
      to_session_id: targetSessionId,
      request_id: result?.request_id ?? null,
      turn_number: result?.turn_number ?? null,
      mode: payload.mode,
    });
  } catch (e) {
    const err = e as any;
    res.status(err.status || 500).json({
      error: err.message || '桥接消息发送失败',
      category: err.category || undefined,
    });
  }
});

export { router };
