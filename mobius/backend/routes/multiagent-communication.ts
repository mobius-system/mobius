/**
 * multiagent-communication.ts — POST /api/multiagent_communication.
 *
 * CLI multiagent_send 的落点: JWT 鉴权 (generate_localhost_jwt 签发, 与 middleware/auth
 * 的 AuthPayload 同构) → services/multiagent-communication.deliverMultiagentMessage.
 * 错误响应统一 { error }, 文案直接成为 CLI 的 terminal 输出.
 */
import express from 'express';
import { auth } from '../middleware/auth';
import { deliverMultiagentMessage } from '../services/multiagent-communication';

const router = express.Router();

router.post('/multiagent_communication', auth, async (req: express.Request, res: express.Response) => {
  const selfSessionId = String(req.body?.self_id || '').trim();
  const targetSessionId = String(req.body?.target_id || '').trim();
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!selfSessionId || !targetSessionId || !content) {
    res.status(400).json({ error: '参数不完整：需要 self_id, target_id, content' });
    return;
  }
  const result = await deliverMultiagentMessage({
    user: (req as any).user,
    selfSessionId,
    targetSessionId,
    content,
  });
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({
    ok: true,
    target_id: result.targetSessionId,
    turn_number: result.turnNumber,
    expires_at: result.expiresAt,
  });
});

export { router };
