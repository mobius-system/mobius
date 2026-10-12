import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { JWT_SECRET, ENABLE_PASSWORD_LOGIN, BRANDING, HIDDEN_FOLDER_NAME, APP_DIR } from '../config';
import { auth } from '../middleware/auth';
import { Users } from '../repositories/users';
import { assertUserIsolationAvailable } from '../services/user-isolation';
import { searchDirectory, resolveDirectoryIds } from '../services/user-directory';

const router = express.Router();

router.get('/config', (_req: express.Request, res: express.Response) => {
  res.json({ password_required: ENABLE_PASSWORD_LOGIN });
});

// 全站品牌显示配置 (顶部 Logo / 系统名称 / Tab 标题). 由 .env 注入, 任何客户端
// (含未登录的登录页) 都可读取, 用于首屏渲染前同步注入避免闪烁. 不接受 PUT.
router.get('/branding', (_req: express.Request, res: express.Response) => {
  res.json({
    hideLogo: BRANDING.hideLogo === true,
    systemNameZh: BRANDING.systemNameZh,
    systemNameEn: BRANDING.systemNameEn,
    // 隐藏工作缓存目录名 (.imac / .mobius), 前端拼 <bindPath>/<该目录>/... 路径时用, 必须与后端一致.
    hiddenFolderName: HIDDEN_FOLDER_NAME,
    // 仓库根绝对路径 (APP_DIR), 前端展示给 agent 的 skill 绝对路径等场景用, 避免硬编码部署路径.
    appDir: APP_DIR,
  });
});

router.post('/login', (req: express.Request, res: express.Response) => {
  const { username, password } = (req.body || {}) as { username?: string; password?: string };
  if (!username) {
    res.status(400).json({ error: 'Missing credentials' });
    return;
  }
  if (ENABLE_PASSWORD_LOGIN && !password) {
    res.status(400).json({ error: 'Missing credentials' });
    return;
  }

  // 用户名大小写不敏感: 前端会把用户名 toLowerCase(), 而账号 id 可能含大写 (如 EvolveWithAI).
  // 用 findByLoginId (COLLATE NOCASE) 兜底, 否则这类账号永远登不上 (401 User not found).
  const user = Users.findByLoginId(username);
  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }
  try { assertUserIsolationAvailable(user); } catch (e) {
    return res.status((e as any).status || 503).json({ error: (e as Error).message, code: 'AGENT_SANDBOX_UNAVAILABLE' });
  }
  if (ENABLE_PASSWORD_LOGIN && !bcrypt.compareSync(password || '', user.password_hash)) {
    res.status(401).json({ error: 'Wrong password' });
    return;
  }

  const token = jwt.sign(
    { id: user.id, display_name: user.display_name, role: user.role, work_dir: user.work_dir },
    JWT_SECRET,
    { expiresIn: '7d' },
  );
  res.json({ token, user: { id: user.id, display_name: user.display_name, role: user.role, work_dir: user.work_dir } });
});

router.get('/me', auth, (req: express.Request, res: express.Response) => {
  res.json((req as any).user);
});

// 资源访问面板 (项目权限 / Skill 权限 / Memory 权限) 的 user picker 需要一个轻量
// 查询接口. **普通用户不得拿到系统用户清单**, 故按角色分档 (见 services/user-directory):
//   管理员 → 关键字包含匹配 (空关键字给首屏候选) + 系统角色;
//   普通用户 → 只认完整账号 id / 完整昵称的精确解析, 不回系统角色, 不回列表.
router.get('/user-search', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json(searchDirectory(user, req.query.q));
});

// user picker 解析已选 ID 时使用: 一次查一组 ID 对应的展示信息 (普通用户不含系统角色).
// 上限 64 个, 多余截断; 重复去空, 缺失自动跳过.
router.post('/users-by-id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.json(resolveDirectoryIds(user, (req.body as any)?.ids));
});

router.post('/change-password', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const { old_password, new_password } = (req.body || {}) as { old_password?: string; new_password?: string };
  if (!old_password || !new_password) {
    res.status(400).json({ error: '请填写完整' });
    return;
  }
  if (new_password.length < 6) {
    res.status(400).json({ error: '新密码至少 6 位' });
    return;
  }

  const dbUser = Users.findById(user.id);
  if (!dbUser || !bcrypt.compareSync(old_password, dbUser.password_hash)) {
    res.status(401).json({ error: '原密码错误' });
    return;
  }
  Users.updatePassword(user.id, bcrypt.hashSync(new_password, 10));
  res.json({ ok: true });
});

export = router;
