import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { db } from '../../db';
import {
  fallbackWorkDirFor,
  homeWorkDirFor,
  legacyFallbackWorkDirFor,
  workDirFor,
} from '../config';
import type { UserRow, UserGroupRawRow } from '../types/rows';
import type * as BetterSqlite3 from 'better-sqlite3';

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

function shapeGroup(row: (UserGroupRawRow & { active_user_count?: number; user_count?: number }) | null | undefined): GroupRow | null {
  if (!row) return null;
  return {
    ...row,
    is_default: row.id === DEFAULT_GROUP_ID,
    active_user_count: Number(row.active_user_count || 0),
    user_count: Number(row.user_count || row.active_user_count || 0),
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
  return [
    workDirFor(userId),
    homeWorkDirFor(userId),
    fallbackWorkDirFor(userId),
    legacyFallbackWorkDirFor(userId),
  ].map(normalizePath).filter(Boolean);
}

function isGeneratedWorkDir(userId: string, currentWorkDir: string | null | undefined): boolean {
  if (!currentWorkDir) return true;
  const current = normalizePath(currentWorkDir);
  return !!current && generatedWorkDirsFor(userId).includes(current);
}

function isLegacyFallbackWorkDir(userId: string, currentWorkDir: string | null | undefined): boolean {
  const current = normalizePath(currentWorkDir);
  return !!current && current === normalizePath(legacyFallbackWorkDirFor(userId));
}

function usableDirectory(p: string): string | null {
  const resolved = normalizePath(p);
  if (!resolved) return null;
  if (isDirectory(resolved) || tryEnsureDirectory(resolved)) return resolved;
  return null;
}

function ensureUsableWorkDir<T extends { id: string; work_dir?: string | null } | null | undefined>(user: T): T {
  if (!user || !user.id) return user;
  const currentWorkDir = user.work_dir || homeWorkDirFor(user.id);
  const current = normalizePath(currentWorkDir);
  const generated = isGeneratedWorkDir(user.id, currentWorkDir);

  if (!generated) {
    const usable = usableDirectory(current);
    return (usable ? { ...user, work_dir: usable } : user) as T;
  }

  const candidates = isLegacyFallbackWorkDir(user.id, currentWorkDir)
    ? [homeWorkDirFor(user.id), fallbackWorkDirFor(user.id), current]
    : [current, homeWorkDirFor(user.id), fallbackWorkDirFor(user.id)];
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
      SELECT g.id, g.name, g.description, g.created_at, g.updated_at,
             SUM(CASE WHEN u.id IS NOT NULL AND ${ACTIVE_USER_SQL.replaceAll('deleted_at', 'u.deleted_at')} THEN 1 ELSE 0 END) AS active_user_count,
             COUNT(u.id) AS user_count
      FROM user_groups g
      LEFT JOIN users u ON u.group_id = g.id
      GROUP BY g.id
      ORDER BY CASE WHEN g.id = ? THEN 0 ELSE 1 END, g.name COLLATE NOCASE ASC
    `).all(DEFAULT_GROUP_ID) as Array<UserGroupRawRow & { active_user_count: number; user_count: number }>).map(shapeGroup);
  },
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
  activeAdminCount: (): number => (db.prepare(`SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND ${ACTIVE_USER_SQL}`).get() as { c: number }).c,
  countAll: (): number => (db.prepare(`SELECT COUNT(*) as c FROM users WHERE ${ACTIVE_USER_SQL}`).get() as { c: number }).c,
};

export { Users };
