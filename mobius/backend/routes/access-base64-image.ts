import express from 'express';
import { downloadAuth } from '../middleware/auth';
import { Sessions } from '../repositories/sessions';
// @ts-ignore — service 仍是 .js
import { canReadSession } from '../services/access-control';
// @ts-ignore — service 仍是 .js
import { recordAdminAuditIfCrossUser } from '../services/admin-audit';
// @ts-ignore — service 仍是 .js
import { getEntryImage } from '../services/mobius-agent-history';

const router = express.Router();
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

router.get('/', downloadAuth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const sessionId = String(req.query.session_id || '');
  const entryUuid = String(req.query.entry_uuid || '');
  const imageIndex = Number(req.query.image_index);
  if (!sessionId || sessionId.length > 128 || !entryUuid || entryUuid.length > 256 || !Number.isInteger(imageIndex) || imageIndex < 0) {
    res.status(400).json({ error: '无效的图片引用' });
    return;
  }

  const session = Sessions.findById(sessionId) as any;
  if (!session || !canReadSession(user, session)) {
    res.status(404).json({ error: '图片不存在' });
    return;
  }
  recordAdminAuditIfCrossUser(user, 'read_session_history_image', 'session', session.session_id, session.user_id);

  const image = getEntryImage(sessionId, entryUuid, imageIndex);
  if (!image) {
    res.status(404).json({ error: '图片不存在' });
    return;
  }
  const allowedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml']);
  const mime = allowedMimeTypes.has(image.mime.toLowerCase()) ? image.mime.toLowerCase() : 'image/png';
  const base64 = image.base64.replace(/\s/g, '');
  if (base64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3)) {
    res.status(413).json({ error: '图片超过大小限制' });
    return;
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    res.status(413).json({ error: '图片超过大小限制或内容无效' });
    return;
  }

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.end(bytes);
});

export { router };
