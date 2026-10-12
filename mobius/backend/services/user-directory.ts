import { db } from '../../db';

// 账号名册查询的唯一收口处.
//
// 背景: 「添加成员 / 添加访客 / 邀请」这类界面需要按账号找到人, 但任何"列出全站账号"
// 的能力都等于把系统用户清单交给调用者. 因此这里按调用者角色分档:
//   - 管理员: 关键字包含匹配 (空关键字给首屏若干条), 返回 id / 昵称 / 系统角色.
//   - 普通用户: **只做精确解析** (必须给出完整账号 id 或完整昵称), 返回 id / 昵称,
//     不回系统角色 (避免暴露"谁是管理员"), 不返回任何列表.
// 二者都不返回 password_hash / work_dir 等敏感字段.
export type DirectoryEntry = {
  id: string;
  display_name: string;
  role?: string;
};

type Actor = { id?: string; role?: string } | undefined | null;

const ACTIVE = "(deleted_at IS NULL OR deleted_at = '')";
// 普通用户精确解析的结果上限: 精确匹配正常只会命中 1 条, 留一点余量应对同名/大小写.
const EXACT_LIMIT = 5;

export function isAdminActor(actor: Actor): boolean {
  return !!actor && actor.role === 'admin';
}

function escapeLike(q: string): string {
  return q.replace(/[%_\\]/g, (m) => `\\${m}`);
}

// 管理员: 关键字包含匹配; 传空关键字时返回首屏候选 (供下拉框首次聚焦时展示).
export function searchDirectory(actor: Actor, rawQuery: unknown, limit = 12): DirectoryEntry[] {
  const q = String(rawQuery ?? '').trim();
  if (!isAdminActor(actor)) return exactLookup(q);
  if (!q) {
    return db.prepare(`
      SELECT id, display_name, role
      FROM users
      WHERE ${ACTIVE}
      ORDER BY display_name COLLATE NOCASE ASC, id COLLATE NOCASE ASC
      LIMIT ?
    `).all(limit) as DirectoryEntry[];
  }
  const like = `%${escapeLike(q)}%`;
  return db.prepare(`
    SELECT id, display_name, role
    FROM users
    WHERE ${ACTIVE}
      AND (id LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
    ORDER BY
      CASE WHEN id = ? COLLATE NOCASE THEN 0
           WHEN display_name = ? COLLATE NOCASE THEN 1
           ELSE 2 END ASC,
      display_name ASC, id ASC
    LIMIT ?
  `).all(like, like, q, q, limit) as DirectoryEntry[];
}

// 普通用户: 只认完整账号 id 或完整昵称 (大小写不敏感), 不做包含匹配、不做空查询列表.
function exactLookup(q: string): DirectoryEntry[] {
  if (!q) return [];
  return db.prepare(`
    SELECT id, display_name
    FROM users
    WHERE ${ACTIVE}
      AND (id = ? COLLATE NOCASE OR display_name = ? COLLATE NOCASE)
    ORDER BY CASE WHEN id = ? COLLATE NOCASE THEN 0 ELSE 1 END, id ASC
    LIMIT ?
  `).all(q, q, q, EXACT_LIMIT) as DirectoryEntry[];
}

// 按 id 批量解析展示信息 (下拉框 chip / 成员表格渲染用).
// 普通用户同样是精确解析语义: 只回传调用者已经点名的 id, 不回传额外账号.
export function resolveDirectoryIds(actor: Actor, rawIds: unknown, limit = 64): DirectoryEntry[] {
  const ids = Array.isArray(rawIds) ? rawIds : [];
  const cleaned = Array.from(new Set(
    ids.map((x) => String(x ?? '').trim()).filter(Boolean),
  )).slice(0, limit);
  if (!cleaned.length) return [];
  const placeholders = cleaned.map(() => '?').join(',');
  const columns = isAdminActor(actor) ? 'id, display_name, role' : 'id, display_name';
  return db.prepare(`
    SELECT ${columns}
    FROM users
    WHERE id IN (${placeholders}) AND ${ACTIVE}
  `).all(...cleaned) as DirectoryEntry[];
}
