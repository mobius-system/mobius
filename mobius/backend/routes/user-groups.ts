import express from 'express';
import { auth } from '../middleware/auth';
import { Users } from '../repositories/users';

// 员工群组查询 (普通登录用户可读): 用于"创建项目/项目设置"时按群组批量加入成员.
// 只暴露群组身份 + 启用成员数, 不含密码/工作目录/偏好等敏感字段.
const router = express.Router();

router.get('/', auth, (_req: express.Request, res: express.Response) => {
  try {
    const groups = Users.listGroups().map((g: any) => ({
      id: g.id,
      name: g.name,
      description: g.description || '',
      active_user_count: g.active_user_count || 0,
    }));
    res.json(groups);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message || '读取群组失败' });
  }
});

router.get('/:id/members', auth, (req: express.Request, res: express.Response) => {
  try {
    res.json({ members: Users.listGroupMembers(req.params.id) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message || '读取群组成员失败' });
  }
});

export default router;
