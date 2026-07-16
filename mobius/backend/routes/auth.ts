import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { JWT_SECRET, ENABLE_PASSWORD_LOGIN, BRANDING, HIDDEN_FOLDER_NAME, APP_DIR } from '../config';
import { auth } from '../middleware/auth';
import { Users } from '../repositories/users';
import { db } from '../../db';

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

// 资源访问面板 (项目权限 / Skill 权限 / Memory 权限) 的 user picker 需要
// 一个轻量查询接口: 输入关键字返回匹配的活跃用户 {id, display_name, role}.
// 仅返回最少字段, 严格按关键字前缀匹配, 上限 12 条, 避免被滥用为用户列表枚举.
router.get('/user-search', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const q = String(req.query.q || '').trim();
  if (!q) {
    res.json([]);
    return;
  }
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const rows = db.prepare(`
    SELECT id, display_name, role
    FROM users
    WHERE (deleted_at IS NULL OR deleted_at = '')
      AND (id LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
    ORDER BY
      CASE WHEN id = ? COLLATE NOCASE THEN 0
           WHEN display_name = ? COLLATE NOCASE THEN 1
           ELSE 2 END ASC,
      display_name ASC, id ASC
    LIMIT 12
  `).all(like, like, q, q);
  res.json(rows);
});

// user picker 解析已选 ID 时使用: 一次查一组 ID 对应的 {id, display_name, role}.
// 上限 64 个, 多余截断; 重复去空, 缺失自动跳过.
router.post('/users-by-id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const ids: unknown[] = Array.isArray((req.body as any)?.ids) ? (req.body as any).ids : [];
  if (!ids.length) {
    res.json([]);
    return;
  }
  const cleaned = Array.from(new Set(
    ids.map((x) => String(x || '').trim()).filter(Boolean),
  )).slice(0, 64);
  if (!cleaned.length) {
    res.json([]);
    return;
  }
  const placeholders = cleaned.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, display_name, role
    FROM users
    WHERE id IN (${placeholders}) AND (deleted_at IS NULL OR deleted_at = '')
  `).all(...cleaned);
  res.json(rows);
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
