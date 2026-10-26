import express from 'express';
import { auth } from '../middleware/auth';
import { RemoteDeviceNames } from '../repositories/remote-device-names';

const router = express.Router();

router.get('/list', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as { id: string };
  res.json({ names: RemoteDeviceNames.listForUser(user.id) });
});

router.post('/set', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as { id: string };
  const deviceId = typeof req.body?.device_id === 'string' ? req.body.device_id.trim() : '';
  const displayName = typeof req.body?.display_name === 'string' ? req.body.display_name.trim() : '';
  if (!deviceId || deviceId.length > 256 || /[\r\n\0]/.test(deviceId)) {
    res.status(400).json({ error: '设备正式 ID 无效' });
    return;
  }
  if (displayName.length > 64 || /[\u0000-\u001f\u007f]/.test(displayName)) {
    res.status(400).json({ error: '设备名称最多 64 个字符且不能包含换行' });
    return;
  }
  res.json({ names: RemoteDeviceNames.setForUser(user.id, deviceId, displayName) });
});

export = router;
