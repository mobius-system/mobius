import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { db } from '../../db';
import { isWithin } from '../services/file-access';
import {
  WORKSPACE_ROOT,
  workDirFor,
} from '../config';
import type { UserRow, UserGroupRawRow } from '../types/rows';
import type * as BetterSqlite3 from 'better-sqlite3';

// migration: 收紧系统角色为 admin/user，并把历史 developer 账号降为普通用户.
(() => {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get() as { sql?: string } | undefined;
  const oldSql = row?.sql || '';
  if (oldSql.includes("CHECK(role IN ('admin','user'))")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`CREATE TABLE users__role_migration (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
        work_dir TEXT NOT NULL,
        group_id TEXT DEFAULT 'default',
        deleted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY (group_id) REFERENCES user_groups(id) ON DELETE SET NULL
      )`);
      db.exec("INSERT INTO users__role_migration (id, display_name, password_hash, role, work_dir, group_id, deleted_at, created_at) SELECT id, display_name, password_hash, CASE WHEN role = 'admin' THEN 'admin' ELSE 'user' END, work_dir, group_id, deleted_at, created_at FROM users");
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users__role_migration RENAME TO users');
    })();
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
})();

const ACTIVE_USER_SQL = "(deleted_at IS NULL OR deleted_at = '')";
const DEFAULT_GROUP_ID = 'default';
const DEFAULT_GROUP_NAME = '默认组';

const insertUser = db.prepare(`
  INSERT INTO users (id, display_name, password_hash, role, work_dir, group_id)
  VALUES (@id, @display_name, @password_hash, @role, @work_dir, @group_id)
`) as BetterSqlite3.Statement;

const restoreUser = db.prepare(`
  UPDATE users
  SET display_name = @display_name,
      password_hash = @password_hash,
      role = @role,
      work_dir = @work_dir,
      group_id = @group_id,
      deleted_at = NULL
  WHERE id = @id
`) as BetterSqlite3.Statement;

const ensureDefaultGroupStmt = db.prepare(`
  INSERT OR IGNORE INTO user_groups (id, name, description)
  VALUES (?, ?, ?)
`) as BetterSqlite3.Statement;

interface RepoError extends Error {
  status: number;
}

function repoError(message: string, status: number = 400): RepoError {
  const e = new Error(message) as RepoError;
  e.status = status;
  return e;
}

function normalizeGroupName(value: unknown): string {
  const name = String(value || '').trim();
  if (!name) throw repoError('群组名称不能为空');
  if (name.length > 60) throw repoError('群组名称最多 60 个字符');
  if (name.includes('\0')) throw repoError('群组名称不能包含非法字符');
  return name;
}

function normalizeGroupDescription(value: unknown): string {
  const desc = String(value || '').trim();
  if (desc.length > 200) throw repoError('群组说明最多 200 个字符');
  if (desc.includes('\0')) throw repoError('群组说明不能包含非法字符');
  return desc;
}

function makeGroupId(): string {
  return `grp_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

interface GroupRow extends UserGroupRawRow {
  active_user_count?: number;
  user_count?: number;
  is_default?: boolean;
  project_visibility_mode?: 'default' | 'restricted';
  visible_project_ids?: string[];
}

interface UserGroupMembershipRow {
  user_id: string;
  group_id: string;
  group_name: string;
  group_description: string;
  is_primary: number;
  created_at: string;
}

function ensureDefaultGroup(): GroupRow {
  ensureDefaultGroupStmt.run(DEFAULT_GROUP_ID, DEFAULT_GROUP_NAME, '未指定群组的员工默认归属');
  db.prepare(`
    UPDATE users
    SET group_id = ?
    WHERE group_id IS NULL OR group_id = ''
  `).run(DEFAULT_GROUP_ID);
  return db.prepare('SELECT * FROM user_groups WHERE id = ?').get(DEFAULT_GROUP_ID) as GroupRow;
}

function ensureUserMembership(userId: string): void {
  ensureDefaultGroup();
  const existing = db.prepare('SELECT 1 FROM user_group_memberships WHERE user_id = ? LIMIT 1').get(userId);
  if (existing) return;
  const row = db.prepare(`
    SELECT u.id, CASE WHEN g.id IS NULL THEN ? ELSE u.group_id END AS group_id
    FROM users u
    LEFT JOIN user_groups g ON g.id = u.group_id
    WHERE u.id = ?
  `).get(DEFAULT_GROUP_ID, userId) as { id: string; group_id: string } | undefined;
  if (!row) return;
  db.prepare(`
    INSERT OR IGNORE INTO user_group_memberships (user_id, group_id, is_primary, created_by)
    VALUES (?, ?, 1, ?)
  `).run(userId, row.group_id || DEFAULT_GROUP_ID, userId);
}

function listGroupMemberships(userId: unknown): UserGroupMembershipRow[] {
  const id = String(userId || '').trim();
  if (!id) return [];
  ensureUserMembership(id);
  return db.prepare(`
    SELECT ugm.user_id, ugm.group_id, g.name AS group_name,
           g.description AS group_description, ugm.is_primary, ugm.created_at
    FROM user_group_memberships ugm
    JOIN user_groups g ON g.id = ugm.group_id
    WHERE ugm.user_id = ?
    ORDER BY ugm.is_primary DESC, g.name COLLATE NOCASE ASC, g.id ASC
  `).all(id) as UserGroupMembershipRow[];
}

// 列某员工群组下的当前启用成员 (id + 昵称). 用于"按群组批量加入项目": 选群组→展开成员.
// 只返回安全字段, 不含密码/工作目录/偏好.
function listGroupMembers(groupId: unknown): Array<{ id: string; display_name: string }> {
  const gid = String(groupId || '').trim();
  if (!gid) return [];
  return db.prepare(`
    SELECT u.id, u.display_name
    FROM user_group_memberships ugm
    JOIN users u ON u.id = ugm.user_id
    WHERE ugm.group_id = ? AND ${ACTIVE_USER_SQL}
    ORDER BY u.display_name COLLATE NOCASE ASC
  `).all(gid) as Array<{ id: string; display_name: string }>;
}

const replaceGroupsTx = db.transaction((userId: unknown, rawGroupIds: unknown, actorId?: unknown) => {
  ensureDefaultGroup();
  const id = String(userId || '').trim();
  const user = db.prepare(`SELECT id FROM users WHERE id = ? AND ${ACTIVE_USER_SQL}`).get(id);
  if (!user) throw repoError('员工账号不存在或已删除', 404);
  const input = Array.isArray(rawGroupIds) ? rawGroupIds : [];
  const groupIds = Array.from(new Set(input.map((value) => String(value || '').trim()).filter(Boolean)));
  if (!groupIds.length) groupIds.push(DEFAULT_GROUP_ID);
  const found = db.prepare(`SELECT id FROM user_groups WHERE id IN (${groupIds.map(() => '?').join(',')})`).all(...groupIds) as Array<{ id: string }>;
  if (found.length !== groupIds.length) throw repoError('群组不存在', 404);
  db.prepare('DELETE FROM user_group_memberships WHERE user_id = ?').run(id);
  const insert = db.prepare(`
    INSERT INTO user_group_memberships (user_id, group_id, is_primary, created_by)
    VALUES (?, ?, ?, ?)
  `);
  groupIds.forEach((groupId, index) => insert.run(id, groupId, index === 0 ? 1 : 0, String(actorId || '') || null));
  db.prepare(`UPDATE users SET group_id = ? WHERE id = ? AND ${ACTIVE_USER_SQL}`).run(groupIds[0], id);
  return {
    user_id: id,
    primary_group_id: groupIds[0],
    group_ids: groupIds,
    groups: listGroupMemberships(id),
  };
});

function shapeGroup(row: (UserGroupRawRow & { active_user_count?: number; user_count?: number; visible_project_ids?: string | null }) | null | undefined): GroupRow | null {
  if (!row) return null;
  const rawVisible = row.visible_project_ids;
  return {
    ...row,
    is_default: row.id === DEFAULT_GROUP_ID,
    active_user_count: Number(row.active_user_count || 0),
    user_count: Number(row.user_count || row.active_user_count || 0),
    project_visibility_mode: row.project_visibility_mode === 'restricted' ? 'restricted' : 'default',
    visible_project_ids: typeof rawVisible === 'string' && rawVisible ? rawVisible.split(',').filter(Boolean) : [],
  } as GroupRow;
}

function findGroupById(id: string | null | undefined): UserGroupRawRow | null {
  if (!id) return null;
  return db.prepare('SELECT * FROM user_groups WHERE id = ?').get(String(id).trim()) as UserGroupRawRow || null;
}

function findGroupByName(name: string | null | undefined): UserGroupRawRow | null {
  if (!name) return null;
  return db.prepare('SELECT * FROM user_groups WHERE lower(name) = lower(?)').get(String(name).trim()) as UserGroupRawRow || null;
}

interface CreateGroupArgs {
  name: unknown;
  description?: unknown;
}

const createGroupTx = db.transaction(({ name, description = '' }: CreateGroupArgs): GroupRow | null => {
  ensureDefaultGroup();
  const normalizedName = normalizeGroupName(name);
  const normalizedDescription = normalizeGroupDescription(description);
  const existing = findGroupByName(normalizedName);
  if (existing) return shapeGroup({ ...existing, active_user_count: 0, user_count: 0 });
  const id = makeGroupId();
  db.prepare(`
    INSERT INTO user_groups (id, name, description)
    VALUES (?, ?, ?)
  `).run(id, normalizedName, normalizedDescription);
  return shapeGroup(db.prepare('SELECT *, 0 AS active_user_count, 0 AS user_count FROM user_groups WHERE id = ?').get(id) as UserGroupRawRow & { active_user_count: number; user_count: number });
});

interface UpdateGroupArgs {
  name?: unknown;
  description?: unknown;
}

const updateGroupTx = db.transaction((id: unknown, params: UpdateGroupArgs = {}): GroupRow | null => {
  ensureDefaultGroup();
  const groupId = String(id || '').trim();
  const existing = findGroupById(groupId);
  if (!existing) throw repoError('群组不存在', 404);
  const name = normalizeGroupName(params.name ?? existing.name);
  const description = normalizeGroupDescription(params.description ?? existing.description);
  const duplicate = findGroupByName(name);
  if (duplicate && duplicate.id !== groupId) throw repoError('群组名称已存在', 409);
  db.prepare(`
    UPDATE user_groups
    SET name = ?, description = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(name, description, groupId);
  return shapeGroup(db.prepare('SELECT *, 0 AS active_user_count, 0 AS user_count FROM user_groups WHERE id = ?').get(groupId) as UserGroupRawRow & { active_user_count: number; user_count: number });
});

const deleteGroupTx = db.transaction((id: unknown): { ok: true } => {
  ensureDefaultGroup();
  const groupId = String(id || '').trim();
  if (groupId === DEFAULT_GROUP_ID) throw repoError('不能删除默认组');
  const existing = findGroupById(groupId);
  if (!existing) throw repoError('群组不存在', 404);
  const activeCount = (db.prepare(`
    SELECT COUNT(*) AS c
    FROM users
    WHERE group_id = ? AND ${ACTIVE_USER_SQL}
  `).get(groupId) as { c: number }).c;
  if (activeCount > 0) throw repoError('只能删除没有启用员工的空群组');
  db.prepare(`
    UPDATE users
    SET group_id = ?
    WHERE group_id = ?
  `).run(DEFAULT_GROUP_ID, groupId);
  db.prepare('DELETE FROM user_groups WHERE id = ?').run(groupId);
  return { ok: true };
});

interface ResolveGroupInput {
  group_id?: unknown;
  groupId?: unknown;
  group_name?: unknown;
  groupName?: unknown;
  group?: unknown;
  create_if_missing?: boolean;
  createIfMissing?: boolean;
}

function resolveGroup(input: ResolveGroupInput = {}): UserGroupRawRow {
  ensureDefaultGroup();
  const groupId = String(input.group_id ?? input.groupId ?? '').trim();
  const groupName = String(input.group_name ?? input.groupName ?? input.group ?? '').trim();
  if (groupId) {
    const group = findGroupById(groupId);
    if (!group) throw repoError('群组不存在', 404);
    return group;
  }
  if (groupName) {
    const existing = findGroupByName(groupName);
    if (existing) return existing;
    if (input.create_if_missing === false || input.createIfMissing === false) {
      throw repoError('群组不存在', 404);
    }
    return createGroupTx({ name: groupName }) as UserGroupRawRow;
  }
  return ensureDefaultGroup();
}

const insertDefaultPreferences = db.prepare(`
  INSERT OR IGNORE INTO user_preferences (user_id, response_style, language, tone, personal_prompt)
  VALUES (@user_id, 'detailed', 'auto', 'professional', '')
`) as BetterSqlite3.Statement;

interface CreateUserParams {
  id: string;
  display_name: string;
  password_hash: string;
  role: 'admin' | 'user';
  work_dir: string;
  group_id?: string;
  [key: string]: any;
}

const createOrRestoreUser = db.transaction((params: CreateUserParams): { ok: boolean; status: 'exists' | 'restored' | 'created' } => {
  ensureDefaultGroup();
  const userParams = {
    ...params,
    group_id: params.group_id || DEFAULT_GROUP_ID,
  };
  if (!findGroupById(userParams.group_id)) userParams.group_id = DEFAULT_GROUP_ID;
  const existing = db.prepare('SELECT id, deleted_at FROM users WHERE id = ?').get(params.id) as { id: string; deleted_at: string | null } | undefined;
  if (existing && !existing.deleted_at) {
    return { ok: false, status: 'exists' };
  }
  if (existing) {
    restoreUser.run(userParams);
    insertDefaultPreferences.run({ user_id: userParams.id });
    return { ok: true, status: 'restored' };
  }
  insertUser.run(userParams);
  insertDefaultPreferences.run({ user_id: userParams.id });
  return { ok: true, status: 'created' };
});

function isDirectory(p: string | null | undefined): boolean {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function tryEnsureDirectory(p: string): boolean {
  try {
    fs.mkdirSync(p, { recursive: true });
    return isDirectory(p);
  } catch {
    return false;
  }
}

function normalizePath(p: string | null | undefined): string {
  if (!p) return '';
  try {
    return path.resolve(String(p));
  } catch {
    return '';
  }
}

function generatedWorkDirsFor(userId: string): string[] {
  return [workDirFor(userId)].map(normalizePath).filter(Boolean);
}

function isGeneratedWorkDir(userId: string, currentWorkDir: string | null | undefined): boolean {
  if (!currentWorkDir) return true;
  const current = normalizePath(currentWorkDir);
  return !!current && generatedWorkDirsFor(userId).includes(current);
}

function usableDirectory(p: string): string | null {
  const resolved = normalizePath(p);
  if (!resolved) return null;
  if (isDirectory(resolved) || tryEnsureDirectory(resolved)) return resolved;
  return null;
}

/*
 * 只探测不落盘的 "mkdir -p 能不能成功": 目录已存在即算可用, 否则向上找最近的存在祖先,
 * 看它可不可写. 预览不能有副作用, 所以不能直接调用 tryEnsureDirectory.
 * Side-effect-free stand-in for tryEnsureDirectory: walk up to the nearest existing
 * ancestor and test writability, so a preview never creates directories.
 */
function canCreateUnder(p: string): boolean {
  const resolved = normalizePath(p);
  if (!resolved) return false;
  if (isDirectory(resolved)) return true;
  let dir = path.dirname(resolved);
  while (dir !== path.dirname(dir) && !fs.existsSync(dir)) dir = path.dirname(dir);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const WORKSPACE_ROOTS = [WORKSPACE_ROOT]
  .map((p) => normalizePath(p))
  .filter(Boolean);

function otherActiveWorkDirs(userId: string): string[] {
  const rows = db.prepare(`
    SELECT work_dir FROM users
    WHERE id <> ? AND work_dir <> '' AND ${ACTIVE_USER_SQL}
  `).all(userId) as Array<{ work_dir: string }>;
  return rows.map((row) => normalizePath(row.work_dir)).filter(Boolean);
}

/*
 * 把某个账号的工作目录指向 p 会撞到什么? null = 可以用.
 * 两条硬规则:
 *   1) 已有内容的目录不能拿来当工作目录 —— 那多半是别人的数据, 一旦挂上去新账号
 *      就能直接读写它 (Landlock 会把"自己的工作目录"整棵授权).
 *   2) 不能等于、也不能包含别的账号的工作目录 —— 否则等于把别人的工作区划进自己的地盘.
 * 返回错误文案, 由调用方决定抛错还是换个候选.
 * Why a non-empty directory is refused: the work dir is granted wholesale to the agent
 * that owns it, so pointing a fresh account at someone else's populated tree hands over
 * their files. A work dir may also never equal or contain another account's work dir.
 */
function workDirConflict(userId: string, p: string): string | null {
  const target = normalizePath(p);
  if (!target) return '工作目录不能为空';
  try {
    if (fs.statSync(target).isDirectory()) {
      let entries: string[];
      try { entries = fs.readdirSync(target); } catch { return `目录 ${target} 不可读取, 不能作为工作目录`; }
      if (entries.length) return `目录 ${target} 已有内容, 请选一个空目录或不存在的路径`;
    }
  } catch {
    // 不存在 / 不可 stat: 交给创建流程去建或报错
  }
  // 工作区根 / 它的祖先不能当某个账号的工作目录: 那里是所有账号工作目录的公共父目录.
  for (const root of WORKSPACE_ROOTS) {
    if (isWithin(target, root)) return `${target} 是工作区根目录所在位置, 不能作为账号工作目录`;
  }
  for (const dir of otherActiveWorkDirs(userId)) {
    if (dir === target) return `${target} 已是其他账号的工作目录`;
    if (isWithin(target, dir)) return `${target} 包含其他账号的工作目录, 不能作为工作目录`;
  }
  return null;
}

/*
 * 角色与工作目录的搭配是否合法. 普通用户的工作目录必须在工作区根 (WORKSPACE_ROOT)
 * 之下 —— 那里既是 landlock 整棵授权的边界, 也是本系统唯一负责创建/回收的目录树;
 * 管理员不受此限, 可以显式指到别处 (例如自己的家目录). 返回错误文案, null = 合法.
 */
export function workDirRoleProblem(p: string | null | undefined, role?: string | null): string | null {
  if (String(role || 'user') === 'admin') return null;
  const target = normalizePath(p);
  if (!target) return '工作目录不能为空';
  const root = normalizePath(WORKSPACE_ROOT);
  if (!isWithin(root, target)) return `普通用户的工作目录必须位于工作区根下: ${root}`;
  return null;
}

/*
 * 新增/编辑员工时的工作目录校验. 原值回填 (目标就是该账号当前记录的工作目录) 放行,
 * 否则先按角色判 (见 workDirRoleProblem), 再按 workDirConflict 判内容/包含关系.
 * 抛出的错误带 status=400, 由路由回给管理端.
 */
export function assertWorkDirAssignable(userId: string, p: string, role?: string | null): void {
  const target = normalizePath(p);
  if (!target) throw repoError('工作目录不能为空');
  const row = db.prepare('SELECT work_dir FROM users WHERE id = ?').get(userId) as { work_dir?: string } | undefined;
  if (row?.work_dir && normalizePath(row.work_dir) === target) return;
  const roleProblem = workDirRoleProblem(target, role);
  if (roleProblem) throw repoError(roleProblem);
  const conflict = workDirConflict(userId, target);
  if (conflict) throw repoError(conflict);
}

/*
 * 预览新建账号会拿到的工作目录: 工作区根下的 <WORKSPACE_ROOT>/<id>. 与
 * ensureUsableWorkDir 对新账号的判定一致, 但不创建任何目录, 且跳过会被
 * workDirConflict 拒绝的候选 —— 占位符不能显示一个建号时必然报错的路径.
 * 全不可用时返回空路径, 前端回落到"留空则由系统按 ID 分配".
 * Preview of the work dir a brand-new account would get: the per-account directory under
 * the workspace root, without touching the filesystem.
 */
export function previewDefaultWorkDir(userId: string): { work_dir: string; source: 'workspace' | 'none' } {
  const resolved = normalizePath(workDirFor(userId));
  if (resolved && canCreateUnder(resolved) && !workDirConflict(userId, resolved)) {
    return { work_dir: resolved, source: 'workspace' };
  }
  return { work_dir: '', source: 'none' };
}

function ensureUsableWorkDir<T extends { id: string; work_dir?: string | null } | null | undefined>(user: T): T {
  if (!user || !user.id) return user;
  const currentWorkDir = user.work_dir || workDirFor(user.id);
  const current = normalizePath(currentWorkDir);
  const generated = isGeneratedWorkDir(user.id, currentWorkDir);

  if (!generated) {
    const usable = usableDirectory(current);
    return (usable ? { ...user, work_dir: usable } : user) as T;
  }

  // 唯一的自动分配位置就是工作区根下的 <id>; 记录里留下的别处路径走上面 !generated 分支,
  // 只做"能建/可用就保留", 不会被这里改掉.
  const candidates = [current, normalizePath(workDirFor(user.id))].filter(Boolean);
  for (const candidate of candidates) {
    const usable = usableDirectory(candidate);
    if (!usable) continue;
    if (usable !== user.work_dir) {
      db.prepare(`UPDATE users SET work_dir = ? WHERE id = ? AND ${ACTIVE_USER_SQL}`).run(usable, user.id);
    }
    return { ...user, work_dir: usable } as T;
  }

  return user;
}

const Users = {
  findById: (id: string): UserRow | undefined => ensureUsableWorkDir(db.prepare(`
    SELECT u.*, g.name AS group_name, g.description AS group_description
    FROM users u
    LEFT JOIN user_groups g ON g.id = u.group_id
    WHERE u.id = ? AND ${ACTIVE_USER_SQL}
  `).get(id) as UserRow | undefined),
  // 登录专用: 用户名大小写不敏感. 前端登录页会把输入的用户名 toLowerCase()
  // (见 pages/Login.tsx), 而历史/手动创建的账号 id 可能含大写字母 (如 EvolveWithAI),
  // 用大小写敏感的 findById 会让这类账号永远返回 401 "User not found". 这里用
  // COLLATE NOCASE 兜底, 返回真实 (大小写原样) 的 user.id, 后续 JWT/鉴权仍走精确匹配.
  findByLoginId: (id: string): UserRow | undefined => ensureUsableWorkDir(db.prepare(`
    SELECT u.*, g.name AS group_name, g.description AS group_description
    FROM users u
    LEFT JOIN user_groups g ON g.id = u.group_id
    WHERE u.id = ? COLLATE NOCASE AND ${ACTIVE_USER_SQL}
  `).get(id) as UserRow | undefined),
  findAuthById: (id: string) => ensureUsableWorkDir(db.prepare(`
    SELECT u.id, u.display_name, u.role, u.work_dir, u.group_id, g.name AS group_name
    FROM users u
    LEFT JOIN user_groups g ON g.id = u.group_id
    WHERE u.id = ? AND ${ACTIVE_USER_SQL}
  `).get(id) as any),
  findAnyById: (id: string) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any,
  listForAdmin: ({ includeDeleted = false }: { includeDeleted?: boolean } = {}) => {
    ensureDefaultGroup();
    const where = includeDeleted ? '' : `WHERE ${ACTIVE_USER_SQL}`;
    const rows = db.prepare(`
      SELECT u.id, u.display_name, u.role, u.work_dir, u.group_id,
             COALESCE(g.name, ?) AS group_name,
             COALESCE(g.description, '') AS group_description,
             u.created_at, u.deleted_at
      FROM users u
      LEFT JOIN user_groups g ON g.id = u.group_id
      ${where}
      ORDER BY g.name COLLATE NOCASE ASC, u.created_at ASC, u.id ASC
    `).all(DEFAULT_GROUP_NAME) as Array<any>;
    return rows.map((row) => {
      const shaped = {
        ...row,
        group_id: row.group_id || DEFAULT_GROUP_ID,
        group_name: row.group_name || DEFAULT_GROUP_NAME,
      };
      return shaped.deleted_at ? shaped : ensureUsableWorkDir(shaped);
    });
  },
  listGroups: (): Array<GroupRow | null> => {
    ensureDefaultGroup();
    return (db.prepare(`
      SELECT g.id, g.name, g.description, g.project_visibility_mode, g.created_at, g.updated_at,
             SUM(CASE WHEN u.id IS NOT NULL AND ${ACTIVE_USER_SQL.replaceAll('deleted_at', 'u.deleted_at')} THEN 1 ELSE 0 END) AS active_user_count,
             COUNT(u.id) AS user_count,
             (SELECT GROUP_CONCAT(gvp.project_id, ',') FROM group_visible_projects gvp WHERE gvp.group_id = g.id) AS visible_project_ids
      FROM user_groups g
      LEFT JOIN users u ON u.group_id = g.id
      GROUP BY g.id
      ORDER BY CASE WHEN g.id = ? THEN 0 ELSE 1 END, g.name COLLATE NOCASE ASC
    `).all(DEFAULT_GROUP_ID) as Array<UserGroupRawRow & { active_user_count: number; user_count: number; visible_project_ids?: string | null }>).map(shapeGroup);
  },
  getGroupProjectVisibilityMode: (groupId: unknown): 'default' | 'restricted' => {
    const gid = String(groupId || '').trim();
    if (!gid) return 'default';
    const row = db.prepare('SELECT project_visibility_mode FROM user_groups WHERE id = ?').get(gid) as { project_visibility_mode?: string } | undefined;
    return row?.project_visibility_mode === 'restricted' ? 'restricted' : 'default';
  },
  listVisibleProjectIds: (groupId: unknown): string[] => {
    const gid = String(groupId || '').trim();
    if (!gid) return [];
    const rows = db.prepare('SELECT project_id FROM group_visible_projects WHERE group_id = ?').all(gid) as Array<{ project_id: string }>;
    return rows.map((r) => r.project_id);
  },
  setGroupProjectVisibility: (groupId: unknown, params: { mode?: unknown; visible_project_ids?: unknown } = {}) => {
    ensureDefaultGroup();
    const gid = String(groupId || '').trim();
    const existing = findGroupById(gid);
    if (!existing) throw repoError('群组不存在', 404);
    if (gid === DEFAULT_GROUP_ID) throw repoError('默认组不能设为受限');
    const mode: 'default' | 'restricted' = params.mode === 'restricted' ? 'restricted' : 'default';
    const rawIds = Array.isArray(params.visible_project_ids) ? params.visible_project_ids : [];
    const projectIds = Array.from(new Set(rawIds.map((v) => String(v || '').trim()).filter(Boolean)));
    if (projectIds.length) {
      const found = db.prepare(`SELECT COUNT(*) AS c FROM projects WHERE id IN (${projectIds.map(() => '?').join(',')})`).get(...projectIds) as { c: number };
      if (found.c !== projectIds.length) throw repoError('部分指定项目不存在', 400);
    }
    const tx = db.transaction(() => {
      db.prepare(`UPDATE user_groups SET project_visibility_mode = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(mode, gid);
      db.prepare('DELETE FROM group_visible_projects WHERE group_id = ?').run(gid);
      if (projectIds.length) {
        const ins = db.prepare('INSERT OR IGNORE INTO group_visible_projects (group_id, project_id) VALUES (?, ?)');
        projectIds.forEach((pid) => ins.run(gid, pid));
      }
    });
    tx();
    return { group_id: gid, project_visibility_mode: mode, visible_project_ids: projectIds };
  },
  listGroupMemberships,
  listGroupMembers,
  replaceGroups: (userId: unknown, groupIds: unknown, actorId?: unknown) => replaceGroupsTx(userId, groupIds, actorId),
  createGroup: (params: CreateGroupArgs) => createGroupTx(params || {}),
  updateGroup: (id: unknown, params: UpdateGroupArgs) => updateGroupTx(id, params || {}),
  deleteGroup: (id: unknown) => deleteGroupTx(id),
  resolveGroup,
  assignGroup: (userId: unknown, groupInput: ResolveGroupInput = {}) => {
    ensureDefaultGroup();
    const id = String(userId || '').trim();
    const user = db.prepare(`SELECT id FROM users WHERE id = ? AND ${ACTIVE_USER_SQL}`).get(id);
    if (!user) throw repoError('员工账号不存在或已删除', 404);
    const group = resolveGroup({ ...groupInput, create_if_missing: groupInput.create_if_missing ?? false });
    db.prepare(`UPDATE users SET group_id = ? WHERE id = ? AND ${ACTIVE_USER_SQL}`).run(group.id, id);
    return {
      user_id: id,
      group_id: group.id,
      group_name: group.name,
      group_description: group.description || '',
    };
  },
  taskStats: () => db.prepare(`
    WITH session_prompt_lengths AS (
      SELECT s.*,
             (
               length(COALESCE(i.description, '')) +
               length(COALESCE(i.title, '')) +
               length(COALESCE(s.description, '')) +
               length(COALESCE(s.name, ''))
             ) AS prompt_length
      FROM sessions_v2 s
      LEFT JOIN issues i ON i.id = s.issue_id
    )
    SELECT user_id,
           COUNT(*) as session_count,
           COUNT(*) as task_count,
           SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active_count,
           SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed_count,
           SUM(CASE WHEN status='archived' THEN 1 ELSE 0 END) as archived_count,
           COALESCE(SUM(message_count), 0) as total_messages,
           COALESCE(SUM(CASE WHEN issue_id IS NOT NULL THEN prompt_length ELSE 0 END), 0) as prompt_length_total,
           SUM(CASE WHEN issue_id IS NOT NULL THEN 1 ELSE 0 END) as prompt_length_count,
           ROUND(COALESCE(AVG(CASE WHEN issue_id IS NOT NULL THEN prompt_length END), 0), 1) as prompt_length_avg,
           MAX(last_active) as last_active
    FROM session_prompt_lengths GROUP BY user_id
  `).all() as Array<any>,
  createOrRestore: (params: CreateUserParams) => createOrRestoreUser(params),
  ensureUsableWorkDir,
  updateWorkDir: (id: string, workDir: string) => db.prepare(`UPDATE users SET work_dir = ? WHERE id = ? AND ${ACTIVE_USER_SQL}`).run(workDir, id),
  softDelete: (id: string) => db.prepare(`
    UPDATE users
    SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND ${ACTIVE_USER_SQL}
  `).run(id),
  updatePassword: (id: string, hash: string) => db.prepare(`UPDATE users SET password_hash = ? WHERE id = ? AND ${ACTIVE_USER_SQL}`).run(hash, id),
  updateRole: (id: string, role: string) => db.prepare(`UPDATE users SET role = ? WHERE id = ? AND ${ACTIVE_USER_SQL}`).run(role, id),
  updateDisplayName: (id: string, displayName: string) => db.prepare(`UPDATE users SET display_name = ? WHERE id = ? AND ${ACTIVE_USER_SQL}`).run(displayName, id),
  activeAdminCount: (): number => (db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND ${ACTIVE_USER_SQL}`).get() as { c: number }).c,
  countAll: (): number => (db.prepare(`SELECT COUNT(*) as c FROM users WHERE ${ACTIVE_USER_SQL}`).get() as { c: number }).c,
};

export { Users };
