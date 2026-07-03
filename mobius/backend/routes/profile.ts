// =====================================================================
// profile.ts — 用户个人维度的轻量偏好接口 (普通 auth, 非管理员).
//
// 当前用于: 首登引导是否已看过. 替代旧 localStorage(`imac:first-login-tour-seen:v1:<userId>`)
// 的设备隔离门禁 — 按用户维度持久化, 换设备/换浏览器不再重复触发首登引导.
//
// 存储复用 admin-settings.json 的 `userFirstLoginSeen` 字典 (per-user), 但接口本身
// 走普通 auth, 不复用 admin 路由逻辑, 避免污染 admin 权限模型. 每个用户只能读写自己的标记.
// =====================================================================
import express from 'express';
import { auth } from '../middleware/auth';
import { getUserFirstLoginSeen, setUserFirstLoginSeen } from '../services/admin-settings';

const router = express.Router();

// 当前登录用户是否已看过首登引导. { seen: boolean }.
router.get('/tour-first-login-seen', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as { id?: string } | undefined;
  if (!user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json({ seen: getUserFirstLoginSeen(user.id) });
});

// 标记当前登录用户已看过首登引导 (按用户维度持久化, 跨设备生效).
router.post('/tour-first-login-seen', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as { id?: string } | undefined;
  if (!user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  setUserFirstLoginSeen(user.id);
  res.json({ seen: true });
});

export = router;
