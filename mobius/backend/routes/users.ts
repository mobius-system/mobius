import express from 'express';
import { adminAuth } from '../middleware/auth';
import { db } from '../../db';

const router = express.Router();

const ACTIVE = "(deleted_at IS NULL OR deleted_at = '')";
const MAX_PAGE_SIZE = 200;

// 全部已注册用户列表({id, display_name, role}), 支持搜索框 q + 分页.
// 这是系统账号名录的**全量**出口, 只给管理员: 普通用户不得获得系统用户清单
// (他们需要"按账号找人"时走 /api/auth/user-search 的精确解析, 见 services/user-directory).
router.get('/', adminAuth, (req: express.Request, res: express.Response) => {
  const me = (req as any).user;
  const q = String(req.query.q || '').trim();
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(String(req.query.pageSize || '50'), 10) || 50));
  const offset = (page - 1) * pageSize;
  const like = q ? `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%` : null;

  const where = q
    ? `WHERE ${ACTIVE} AND (id LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')`
    : `WHERE ${ACTIVE}`;

  const countParams: Array<string> = q ? [like as string, like as string] : [];
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM users ${where}`).get(...countParams) as { c: number }).c;

  const listParams: Array<string | number> = [];
  if (q) listParams.push(like as string, like as string);
  listParams.push(me.id, pageSize, offset);
  const rows = db.prepare(`
    SELECT id, display_name, role
    FROM users
    ${where}
    ORDER BY CASE WHEN id = ? COLLATE NOCASE THEN 0 ELSE 1 END, display_name COLLATE NOCASE ASC, id ASC
    LIMIT ? OFFSET ?
  `).all(...listParams) as Array<{ id: string; display_name: string; role: string }>;

  res.json({
    users: rows.map((r) => ({ id: r.id, display_name: r.display_name, role: r.role, is_self: r.id === me.id })),
    page,
    pageSize,
    total,
  });
});

export = router;
