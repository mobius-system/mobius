import { db } from '../../db';
import type { ProjectMembershipRole } from '../types/rows';

// 启用员工 = 未软删除 (与 users.ts ACTIVE_USER_SQL 保持一致).
const ACTIVE_USER_SQL = "(deleted_at IS NULL OR deleted_at = '')";

// 项目角色: 负责人 > 管理员 > 成员 > 访客. 用于排序与权限比较.
export const PROJECT_ROLE_RANK: Record<ProjectMembershipRole, number> = {
  viewer: 0,
  member: 1,
  manager: 2,
  owner: 3,
};

export const PROJECT_ROLE_LABELS: Record<ProjectMembershipRole, string> = {
  owner: '项目负责人',
  manager: '项目管理员',
  member: '项目成员',
  viewer: '项目访客',
};

const ROLE_SET = new Set<string>(['owner', 'manager', 'member', 'viewer']);

const ROLE_ORDER_SQL = `CASE pm.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'member' THEN 2 ELSE 3 END`;

interface RepoError extends Error {
  status: number;
}

function repoError(message: string, status: number = 400): RepoError {
  const e = new Error(message) as RepoError;
  e.status = status;
  return e;
}

// 规范化角色: 非法值回落为 member, 而非拒绝, 降低上层调用心智负担.
function normalizeRole(value: unknown): ProjectMembershipRole {
  const r = String(value || '').trim();
  return ROLE_SET.has(r) ? (r as ProjectMembershipRole) : 'member';
}

function dedupeIds(input: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of Array.isArray(input) ? input : []) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export interface ProjectMemberGroup {
  id: string;
  name: string;
  is_primary: boolean;
}

export interface ProjectMember {
  user_id: string;
  display_name: string;
  role: ProjectMembershipRole;
  groups: ProjectMemberGroup[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface MemberRawRow {
  user_id: string;
  role: ProjectMembershipRole;
  created_at: string;
  updated_at: string;
  display_name: string;
  deleted_at: string | null;
  group_id: string | null;
  group_name: string | null;
  is_primary: number | null;
}

const ProjectMemberships = {
  // 当前用户在该项目的角色; 非成员返回 null.
  roleFor(projectId: unknown, userId: unknown): ProjectMembershipRole | null {
    const pid = String(projectId || '');
    const uid = String(userId || '');
    if (!pid || !uid) return null;
    const row = db.prepare(
      'SELECT role FROM project_memberships WHERE project_id = ? AND user_id = ?'
    ).get(pid, uid) as { role?: ProjectMembershipRole } | undefined;
    return row?.role || null;
  },

  // 创建者首条成员关系 (owner). 已存在则保留不动 (ON CONFLICT DO NOTHING),
  // 绝不把已有 owner/manager 误降级. 用于 Projects.insert 事务.
  ensureOwner(projectId: string, userId: string, actorId?: string): void {
    db.prepare(`
      INSERT INTO project_memberships (project_id, user_id, role, created_by)
      VALUES (?, ?, 'owner', ?)
      ON CONFLICT(project_id, user_id) DO NOTHING
    `).run(projectId, userId, actorId || userId);
  },

  // 列出全部成员, 聚合其长期员工群组. 一次查询拿齐 (避免 N+1).
  list(projectId: unknown): ProjectMember[] {
    const pid = String(projectId || '');
    if (!pid) return [];
    const rows = db.prepare(`
      SELECT pm.user_id, pm.role, pm.created_at, pm.updated_at,
             u.display_name, u.deleted_at,
             ug.group_id, ug.is_primary, g.name AS group_name
      FROM project_memberships pm
      JOIN users u ON u.id = pm.user_id
      LEFT JOIN user_group_memberships ug ON ug.user_id = pm.user_id
      LEFT JOIN user_groups g ON g.id = ug.group_id
      WHERE pm.project_id = ?
      ORDER BY ${ROLE_ORDER_SQL}, u.display_name COLLATE NOCASE ASC
    `).all(pid) as MemberRawRow[];

    const byUser = new Map<string, ProjectMember>();
    for (const row of rows) {
      let member = byUser.get(row.user_id);
      if (!member) {
        member = {
          user_id: row.user_id,
          display_name: row.display_name || row.user_id,
          role: row.role,
          groups: [],
          is_active: !row.deleted_at,
          created_at: row.created_at,
          updated_at: row.updated_at,
        };
        byUser.set(row.user_id, member);
      }
      if (row.group_id) {
        member.groups.push({
          id: row.group_id,
          name: row.group_name || row.group_id,
          is_primary: !!row.is_primary,
        });
      }
    }
    return Array.from(byUser.values());
  },

  // 各角色计数 (UI 展示概览).
  counts(projectId: unknown): Record<ProjectMembershipRole, number> {
    const pid = String(projectId || '');
    if (!pid) return { owner: 0, manager: 0, member: 0, viewer: 0 };
    const rows = db.prepare(
      'SELECT role, COUNT(*) AS c FROM project_memberships WHERE project_id = ? GROUP BY role'
    ).all(pid) as Array<{ role: ProjectMembershipRole; c: number }>;
    const out: Record<ProjectMembershipRole, number> = { owner: 0, manager: 0, member: 0, viewer: 0 };
    for (const r of rows) out[r.role] = r.c;
    return out;
  },

  // 批量加入成员. 校验全部为启用员工, 任一非法即抛错回滚 (保证事务原子性).
  // 重复添加幂等: ON CONFLICT DO NOTHING, 不覆盖已有更高角色 (尤其保护 owner).
  addMany({ projectId, userIds, role = 'member', actorId }: {
    projectId: string;
    userIds: unknown;
    role?: unknown;
    actorId?: string;
  }): { project_id: string; role: ProjectMembershipRole; added: number } {
    const pid = String(projectId || '');
    if (!pid) throw repoError('缺少项目', 400);
    const ids = dedupeIds(userIds);
    const r = normalizeRole(role);
    if (!ids.length) return { project_id: pid, role: r, added: 0 };
    const placeholders = ids.map(() => '?').join(',');
    const found = db.prepare(
      `SELECT id FROM users WHERE id IN (${placeholders}) AND ${ACTIVE_USER_SQL}`
    ).all(...ids) as Array<{ id: string }>;
    const foundSet = new Set(found.map((x) => x.id));
    const missing = ids.filter((id) => !foundSet.has(id));
    if (missing.length) throw repoError('以下员工不存在或已停用：' + missing.join(', '), 400);
    const insert = db.prepare(`
      INSERT INTO project_memberships (project_id, user_id, role, created_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO NOTHING
    `);
    let added = 0;
    const tx = db.transaction(() => {
      for (const id of ids) {
        const res = insert.run(pid, id, r, actorId || null);
        added += res.changes;
      }
    });
    tx();
    return { project_id: pid, role: r, added };
  },

  // 修改成员角色. last-owner 保护: 降级最后一个 owner 时拒绝.
  updateRole({ projectId, userId, role, actorId }: {
    projectId: string;
    userId: string;
    role: unknown;
    actorId?: string;
  }): { project_id: string; user_id: string; role: ProjectMembershipRole } {
    const pid = String(projectId || '');
    const uid = String(userId || '');
    if (!pid || !uid) throw repoError('缺少项目或成员', 400);
    const r = normalizeRole(role);
    const existing = db.prepare(
      'SELECT role FROM project_memberships WHERE project_id = ? AND user_id = ?'
    ).get(pid, uid) as { role?: ProjectMembershipRole } | undefined;
    if (!existing) throw repoError('该成员不存在', 404);
    if (existing.role === 'owner' && r !== 'owner') {
      const ownerCount = (db.prepare(
        "SELECT COUNT(*) AS c FROM project_memberships WHERE project_id = ? AND role = 'owner'"
      ).get(pid) as { c: number }).c;
      if (ownerCount <= 1) throw repoError('项目必须至少保留一名项目负责人', 400);
    }
    db.prepare(`
      UPDATE project_memberships
      SET role = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE project_id = ? AND user_id = ?
    `).run(r, pid, uid);
    return { project_id: pid, user_id: uid, role: r };
  },

  // 移除成员. last-owner 保护: 移除最后一个 owner 时拒绝.
  remove({ projectId, userId }: { projectId: string; userId: string }): { ok: true } {
    const pid = String(projectId || '');
    const uid = String(userId || '');
    if (!pid || !uid) throw repoError('缺少项目或成员', 400);
    const target = db.prepare(
      'SELECT role FROM project_memberships WHERE project_id = ? AND user_id = ?'
    ).get(pid, uid) as { role?: ProjectMembershipRole } | undefined;
    if (!target) throw repoError('该成员不存在', 404);
    if (target.role === 'owner') {
      const ownerCount = (db.prepare(
        "SELECT COUNT(*) AS c FROM project_memberships WHERE project_id = ? AND role = 'owner'"
      ).get(pid) as { c: number }).c;
      if (ownerCount <= 1) throw repoError('项目必须至少保留一名项目负责人', 400);
    }
    db.prepare('DELETE FROM project_memberships WHERE project_id = ? AND user_id = ?').run(pid, uid);
    return { ok: true };
  },

  // owner/manager 可管理项目团队; 管理员全局覆盖; 创建者兜底为 owner.
  // 注意: 本函数不依赖 access-control (避免循环依赖), 自查角色与 created_by.
  canManage(projectId: unknown, user: any): boolean {
    if (!user?.id) return false;
    if (user.role === 'admin') return true;
    const pid = String(projectId || '');
    if (!pid) return false;
    const role = ProjectMemberships.roleFor(pid, user.id);
    if (role === 'owner' || role === 'manager') return true;
    const proj = db.prepare('SELECT created_by FROM projects WHERE id = ?').get(pid) as { created_by?: string } | undefined;
    return !!proj && proj.created_by === user.id;
  },
};

export { ProjectMemberships };
