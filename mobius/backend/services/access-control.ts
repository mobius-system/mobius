import { db } from '../../db';
import { parseSkillId } from './skills-fs';
import { parseMemoryId } from './memories-fs';
import { ProjectMemberships } from '../repositories/project-memberships';

const RESOURCE_TYPES = new Set(['project', 'issue', 'research', 'session', 'skill', 'memory']);
const VISIBILITIES = new Set(['inherit', 'private', 'team', 'public', 'allowlist']);
// 项目可见性简化为 2 档: 私有(仅项目成员可见) / 公开(全员可读).
// 原 team/allowlist 由成员机制取代 (allowlist 用户已迁移为 viewer 成员).
const PROJECT_VISIBILITIES = new Set(['private', 'public']);
const FIXED_LOGO_REVIEW_PROJECT_ID = '9986bdc3';
const FIXED_LOGO_REVIEW_SESSION_NAME = '迭代 Three.js 光点标志空间';

function normalizeResourceType(type: any): string {
  const value = String(type || '').trim();
  return RESOURCE_TYPES.has(value) ? value : '';
}

function normalizeVisibility(value: any, fallback: string = 'private', allowInherit: boolean = true): string {
  const v = String(value || '').trim();
  if (!VISIBILITIES.has(v)) return fallback;
  if (v === 'inherit' && !allowInherit) return fallback === 'inherit' ? 'private' : fallback;
  return v;
}

function normalizeProjectVisibility(value: any, fallback: string = 'private'): string {
  const v = String(value || '').trim();
  return PROJECT_VISIBILITIES.has(v) ? v : fallback;
}

function uniqStringList(value: any): string[] {
  const input = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[,\n]/) : []);
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function userGroupId(user: any): string {
  if (!user?.id) return '';
  if (user.group_id) return String(user.group_id);
  try {
    return (db.prepare('SELECT group_id FROM users WHERE id = ?').get(user.id) as { group_id?: string } | undefined)?.group_id || '';
  } catch {
    return '';
  }
}

function userById(userId: any): any {
  if (!userId) return null;
  try {
    return db.prepare('SELECT id, group_id FROM users WHERE id = ?').get(userId) || null;
  } catch {
    return null;
  }
}

function sameGroup(user: any, ownerId: any): boolean {
  if (!user?.id || !ownerId) return false;
  const viewerGroup = userGroupId(user);
  const ownerGroup = (userById(ownerId) as { group_id?: string } | undefined)?.group_id || '';
  return !!viewerGroup && !!ownerGroup && viewerGroup === ownerGroup;
}

function envFlagEnabled(name: string): boolean {
  const candidates = [
    process.env[name],
    process.env[name.toUpperCase()],
    process.env[`FEATURE_${name.toUpperCase()}`],
  ];
  return candidates.some((value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase()));
}

function isV3RunSessionGateEnabled(): boolean {
  return envFlagEnabled('v3_run_session_gate');
}

function projectById(projectOrId: any): any {
  if (!projectOrId) return null;
  if (typeof projectOrId === 'object') return projectOrId;
  try { return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectOrId) || null; }
  catch { return null; }
}

function issueById(issueOrId: any): any {
  if (!issueOrId) return null;
  if (typeof issueOrId === 'object') return issueOrId;
  try { return db.prepare('SELECT * FROM issues WHERE id = ?').get(issueOrId) || null; }
  catch { return null; }
}

function researchById(researchOrId: any): any {
  if (!researchOrId) return null;
  if (typeof researchOrId === 'object') return researchOrId;
  try { return db.prepare('SELECT * FROM researches WHERE id = ?').get(researchOrId) || null; }
  catch { return null; }
}

function sessionById(sessionOrId: any): any {
  if (!sessionOrId) return null;
  if (typeof sessionOrId === 'object') return sessionOrId;
  try { return db.prepare('SELECT * FROM sessions_v2 WHERE session_id = ?').get(sessionOrId) || null; }
  catch { return null; }
}

function isFixedLogoReviewSession(session: any): boolean {
  return !!(
    session
    && session.project_id === FIXED_LOGO_REVIEW_PROJECT_ID
    && String(session.name || '').includes(FIXED_LOGO_REVIEW_SESSION_NAME)
  );
}

function aclEntries(resourceType: any, resourceId: any, effect: string | null = null): any[] {
  const type = normalizeResourceType(resourceType);
  const id = String(resourceId || '').trim();
  if (!type || !id) return [];
  const whereEffect = effect === 'allow';
  return db.prepare(`
    SELECT subject_type, subject_id, effect, capabilities
    FROM resource_acl_entries
    WHERE resource_type = ? AND resource_id = ?
      ${whereEffect ? 'AND effect = ?' : ''}
    ORDER BY subject_type ASC, subject_id ASC
  `).all(...(whereEffect ? [type, id, effect] : [type, id])) as any[];
}

function aclMatches(user: any, row: any): boolean {
  if (!user?.id || !row) return false;
  if (row.subject_type === 'user') return row.subject_id === user.id;
  if (row.subject_type === 'group') return row.subject_id && row.subject_id === userGroupId(user);
  return false;
}

function hasAclEffect(user: any, resourceType: any, resourceId: any, effect: any): boolean {
  return aclEntries(resourceType, resourceId, effect).some((row) => aclMatches(user, row));
}

function accessPayload(resourceType: any, resourceId: any, fallbackVisibility: string = 'private'): any {
  const type = normalizeResourceType(resourceType);
  const id = String(resourceId || '').trim();
  let visibility = fallbackVisibility;
  if (type && id) {
    const row = db.prepare('SELECT visibility FROM resource_policies WHERE resource_type = ? AND resource_id = ?').get(type, id) as { visibility?: string } | undefined;
    if (row?.visibility) visibility = row.visibility;
  }
  const allows = aclEntries(type, id, 'allow');
  return {
    visibility,
    allow_user_ids: allows.filter((x) => x.subject_type === 'user').map((x) => x.subject_id),
    allow_group_ids: allows.filter((x) => x.subject_type === 'group').map((x) => x.subject_id),
  };
}

function projectAccessPayload(projectId: any): any {
  const project = projectById(projectId);
  const base = accessPayload('project', projectId, normalizeProjectVisibility(project?.visibility, 'private'));
  base.visibility = normalizeProjectVisibility(project?.visibility || base.visibility, 'private');
  return base;
}

function replaceAcl(resourceType: any, resourceId: any, effect: any, { userIds = [], groupIds = [] }: any = {}): void {
  const type = normalizeResourceType(resourceType);
  const id = String(resourceId || '').trim();
  if (!type || !id || !['allow'].includes(effect)) return;
  db.prepare('DELETE FROM resource_acl_entries WHERE resource_type = ? AND resource_id = ? AND effect = ?')
    .run(type, id, effect);
  const insert = db.prepare(`
    INSERT INTO resource_acl_entries (resource_type, resource_id, subject_type, subject_id, effect, capabilities)
    VALUES (?, ?, ?, ?, ?, '["read"]')
    ON CONFLICT(resource_type, resource_id, subject_type, subject_id, effect) DO UPDATE SET
      capabilities = excluded.capabilities,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);
  for (const userId of uniqStringList(userIds)) insert.run(type, id, 'user', userId, effect);
  for (const groupId of uniqStringList(groupIds)) insert.run(type, id, 'group', groupId, effect);
}

function setResourcePolicy(resourceType: any, resourceId: any, { visibility, createdBy, allowUserIds, allowGroupIds }: any = {}): any {
  const type = normalizeResourceType(resourceType);
  const id = String(resourceId || '').trim();
  if (!type || !id) return null;
  const allowInherit = type !== 'project';
  const existing = db.prepare('SELECT visibility, created_by FROM resource_policies WHERE resource_type = ? AND resource_id = ?')
    .get(type, id) as { visibility?: string; created_by?: string } | undefined;
  const fallback = existing?.visibility || (allowInherit ? 'inherit' : 'private');
  const normalized = visibility === undefined
    ? normalizeVisibility(fallback, allowInherit ? 'inherit' : 'private', allowInherit)
    : normalizeVisibility(visibility, allowInherit ? 'inherit' : 'private', allowInherit);
  db.prepare(`
    INSERT INTO resource_policies (resource_type, resource_id, visibility, created_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(resource_type, resource_id) DO UPDATE SET
      visibility = excluded.visibility,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(type, id, normalized, createdBy || existing?.created_by || null);
  if (allowUserIds !== undefined || allowGroupIds !== undefined) {
    replaceAcl(type, id, 'allow', { userIds: allowUserIds, groupIds: allowGroupIds });
  }
  return accessPayload(type, id, normalized);
}

function setProjectAccess(projectId: any, { visibility, allowUserIds, allowGroupIds }: any = {}): any {
  const project = projectById(projectId);
  if (!project) return null;
  const next = normalizeProjectVisibility(visibility, project.visibility || 'private');
  db.prepare("UPDATE projects SET visibility = ? WHERE id = ?").run(next, project.id);
  setResourcePolicy('project', project.id, {
    visibility: next,
    createdBy: project.created_by,
    allowUserIds,
    allowGroupIds,
  });
  return projectAccessPayload(project.id);
}

function allowedByVisibility(user: any, { resourceType, resourceId, ownerId, visibility, teamOwnerId }: any): boolean {
  if (!user?.id) return false;
  if (user.role === 'admin') return true;
  if (ownerId && user.id === ownerId) return true;
  if (hasAclEffect(user, resourceType, resourceId, 'allow')) return true;
  if (visibility === 'public') return true;
  if (visibility === 'team') return sameGroup(user, teamOwnerId || ownerId);
  return false;
}

// 受限群组(如"试用组")的项目可见性上下文: 取用户主群组(group_id)的受限模式 + 白名单.
// 结果挂到 user 对象上 —— readableProjectsForUser 用同一 user 过滤多个项目时只查一次库.
function ensureGroupVisCtx(user: any): { restricted: boolean; whitelist: Set<string> } {
  const ctx = { restricted: false, whitelist: new Set<string>() };
  if (user?.id) {
    const cached = (user as any).__groupVisCtx;
    if (cached) return cached;
    const gid = userGroupId(user);
    if (gid) {
      try {
        const g = db.prepare('SELECT project_visibility_mode FROM user_groups WHERE id = ?').get(gid) as { project_visibility_mode?: string } | undefined;
        if (g?.project_visibility_mode === 'restricted') {
          ctx.restricted = true;
          const rows = db.prepare('SELECT project_id FROM group_visible_projects WHERE group_id = ?').all(gid) as Array<{ project_id: string }>;
          ctx.whitelist = new Set(rows.map((r) => r.project_id));
        }
      } catch {
        // 查询失败(如迁移未完成缺表) 视为非受限, 不阻断可见性.
      }
    }
    (user as any).__groupVisCtx = ctx;
  }
  return ctx;
}

function canReadProject(user: any, projectOrId: any): boolean {
  const project = projectById(projectOrId);
  if (!project || !user?.id) return false;
  // 纯成员制 (项目可见性 public/team/allowlist 已退役): admin 全局可见; 创建者可见; 项目成员(任意角色)可读.
  if (user.role === 'admin') return true;
  if (project.created_by === user.id) return true;
  if (ProjectMemberships.roleFor(project.id, user.id)) return true;
  // 受限群组白名单: 管理员授权给该群组的项目, 视同间接成员.
  const visCtx = ensureGroupVisCtx(user);
  if (visCtx.restricted && visCtx.whitelist.has(project.id)) return true;
  // 项目级 ACL 显式 allow (遗留 allowlist 授权), 保留.
  if (hasAclEffect(user, 'project', project.id, 'allow')) return true;
  // 其余非成员一律不可见.
  return false;
}

function canManageProject(user: any, projectOrId: any): boolean {
  const project = projectById(projectOrId);
  if (!project || !user?.id) return false;
  if (user.role === 'admin' || project.created_by === user.id) return true;
  // 项目负责人 / 项目管理员可管理团队与项目设置.
  const role = ProjectMemberships.roleFor(project.id, user.id);
  return role === 'owner' || role === 'manager';
}

function canCreateIssue(user: any, projectOrId: any): boolean {
  return projectAllowsReaderWrite(user, projectOrId, 'can_post_issue');
}

function projectAllowsReaderWrite(user: any, projectOrId: any, _flagColumn: string): boolean {
  const project = projectById(projectOrId);
  if (!project || !user?.id) return false;
  if (user.role === 'admin' || project.created_by === user.id) return true;
  // 成员制写权限 (读者开关 can_post_issue/can_run_session 已退役):
  // owner/manager/member 可写(建任务单/跑会话); viewer 只读; 非成员不可写.
  const role = ProjectMemberships.roleFor(project.id, user.id);
  if (role === 'owner' || role === 'manager' || role === 'member') return true;
  return false;
}

function canSetIssueVisibilityWithinProject(projectOrId: any, visibility: any): boolean {
  const project = projectById(projectOrId);
  if (!project) return false;
  const projectVisibility = normalizeProjectVisibility(project.visibility, 'private');
  const issueVisibility = normalizeVisibility(visibility, 'inherit', true);
  if (issueVisibility === 'inherit' || issueVisibility === 'private') return true;
  if (projectVisibility === 'private') return false;
  if (projectVisibility === 'team') return issueVisibility === 'team';
  if (projectVisibility === 'public') return true;
  if (projectVisibility === 'allowlist') return issueVisibility === 'allowlist';
  return false;
}

function canReadIssue(user: any, issueOrId: any): boolean {
  const issue = issueById(issueOrId);
  if (!issue || !user?.id) return false;
  const project = projectById(issue.project_id);
  if (!project) return false;
  if (user.role === 'admin' || issue.created_by === user.id || project.created_by === user.id) return true;
  if (!canReadProject(user, project)) return false;
  const visibility = normalizeVisibility(issue.visibility, 'inherit', true);
  if (visibility === 'inherit') return true;
  return allowedByVisibility(user, {
    resourceType: 'issue',
    resourceId: issue.id,
    ownerId: issue.created_by,
    teamOwnerId: project.created_by,
    visibility,
  });
}

function canManageIssue(user: any, issueOrId: any): boolean {
  const issue = issueById(issueOrId);
  if (!issue || !user?.id) return false;
  const project = projectById(issue.project_id);
  return !!(user.role === 'admin' || issue.created_by === user.id || project?.created_by === user.id);
}

function canReadResearch(user: any, researchOrId: any): boolean {
  const research = researchById(researchOrId);
  if (!research || !user?.id) return false;
  const project = projectById(research.project_id);
  if (!project) return false;
  if (user.role === 'admin' || research.created_by === user.id || project.created_by === user.id) return true;
  if (!canReadProject(user, project)) return false;
  const visibility = normalizeVisibility(research.visibility, 'inherit', true);
  if (visibility === 'inherit') return true;
  return allowedByVisibility(user, {
    resourceType: 'research',
    resourceId: research.id,
    ownerId: research.created_by,
    teamOwnerId: project.created_by,
    visibility,
  });
}

function canManageResearch(user: any, researchOrId: any): boolean {
  const research = researchById(researchOrId);
  if (!research || !user?.id) return false;
  const project = projectById(research.project_id);
  return !!(user.role === 'admin' || research.created_by === user.id || project?.created_by === user.id);
}

function canCreateSessionForIssue(user: any, issueOrId: any): boolean {
  if (!isV3RunSessionGateEnabled()) return canReadIssue(user, issueOrId);
  const issue = issueById(issueOrId);
  if (!issue || !user?.id) return false;
  if (!canReadIssue(user, issue)) return false;
  return projectAllowsReaderWrite(user, issue.project_id, 'can_run_session');
}

function canCreateSessionForResearch(user: any, researchOrId: any): boolean {
  return canReadResearch(user, researchOrId);
}

function harnessRunById(runOrId: any): any {
  if (!runOrId) return null;
  if (typeof runOrId === 'object') return runOrId;
  try { return db.prepare('SELECT * FROM harness_runs WHERE id = ?').get(runOrId) || null; }
  catch { return null; }
}

function canCreateHarnessRun(user: any, issueOrId: any): boolean {
  const issue = issueById(issueOrId);
  if (!issue || !user?.id || !canReadIssue(user, issue)) return false;
  // Harness can spend more resources and delegate to several Sessions, so the
  // legacy read-implies-create fallback is intentionally not reused here.
  return projectAllowsReaderWrite(user, issue.project_id, 'can_run_session');
}

function canReadHarnessRun(user: any, runOrId: any): boolean {
  const run = harnessRunById(runOrId);
  if (!run || !user?.id) return false;
  if (user.role === 'admin' || run.owner_user_id === user.id) return true;
  return run.anchor_type === 'issue' ? canReadIssue(user, run.issue_id) : canReadResearch(user, run.research_id);
}

function canOperateHarnessRun(user: any, runOrId: any): boolean {
  const run = harnessRunById(runOrId);
  if (!run || !user?.id) return false;
  if (user.role === 'admin' || run.owner_user_id === user.id) return true;
  return canManageProject(user, run.project_id);
}

function canManageHarnessRun(user: any, runOrId: any): boolean {
  const run = harnessRunById(runOrId);
  return !!run && canManageProject(user, run.project_id);
}

function canReadSession(user: any, sessionOrId: any): boolean {
  const session = sessionById(sessionOrId);
  if (!session || !user?.id) return false;
  if (user.role === 'admin' || session.user_id === user.id) return true;
  // 固定“验收完成案例”是全员可读教程素材；仅放开读取，不放开操作权限。
  if (isFixedLogoReviewSession(session)) return true;
  const project = projectById(session.project_id);
  return !!(project && project.created_by === user.id);
}

function canOperateSession(user: any, sessionOrId: any): boolean {
  const session = sessionById(sessionOrId);
  if (!session || !user?.id) return false;
  if (user.role === 'admin' || session.user_id === user.id) return true;
  const project = projectById(session.project_id);
  return !!(project && project.created_by === user.id);
}

function parsedContextId(kind: string, id: any): any {
  return kind === 'skill' ? parseSkillId(id) : parseMemoryId(id);
}

function defaultContextVisibility(kind: string, item: any): string {
  if (!item) return 'private';
  if (item.scope === 'project') return 'inherit';
  return 'private';
}

function contextPolicy(kind: string, item: any): string {
  const fallback = defaultContextVisibility(kind, item);
  const row = db.prepare('SELECT visibility FROM resource_policies WHERE resource_type = ? AND resource_id = ?')
    .get(kind, item.id) as { visibility?: string } | undefined;
  return normalizeVisibility(row?.visibility, fallback, true);
}

function canReadContextItem(user: any, kind: string, item: any): boolean {
  if (!item || !user?.id) return false;
  if (kind === 'skill' && item.scope === 'builtin') return true;
  const parsed = parsedContextId(kind, item.id);
  if (!parsed) return false;
  const creatorId = parsed.userId || item.created_by || item.owner_id;
  if (user.role === 'admin' || creatorId === user.id) return true;
  const visibility = contextPolicy(kind, item);
  if (parsed.scope === 'project') {
    const project = projectById(parsed.projectId || item.owner_id);
    if (!project) return false;
    // 项目级 skill/memory 一律跟随项目: 能读项目(= 项目成员 / admin / owner)即可读,
    // 不再单独设可见性 / 指定用户 (与项目成员制统一).
    return canReadProject(user, project);
  }
  if (visibility === 'inherit') return false;
  return allowedByVisibility(user, {
    resourceType: kind,
    resourceId: item.id,
    ownerId: creatorId,
    teamOwnerId: creatorId,
    visibility,
  });
}

function canManageContextItem(user: any, kind: string, item: any): boolean {
  if (!item || !user?.id) return false;
  const parsed = parsedContextId(kind, item.id);
  if (!parsed) return false;
  if (user.role === 'admin' || parsed.userId === user.id) return true;
  if (parsed.scope === 'project') {
    const project = projectById(parsed.projectId || item.owner_id);
    return project?.created_by === user.id;
  }
  return false;
}

function canContributeProjectContext(user: any, projectOrId: any): boolean {
  return canManageProject(user, projectOrId);
}

function filterReadableContextItems(user: any, kind: string, items: any): any[] {
  return (Array.isArray(items) ? items : []).filter((item) => canReadContextItem(user, kind, item));
}

function contextAccessPayload(kind: string, item: any): any {
  if (!item) return null;
  return accessPayload(kind, item.id, defaultContextVisibility(kind, item));
}

function withContextAccess(kind: string, item: any, user: any = null): any {
  if (!item) return item;
  const access = contextAccessPayload(kind, item);
  return {
    ...item,
    visibility: access.visibility,
    access,
    hidden: user?.id ? isHidden(user.id, kind, item.id) : false,
    can_manage: user ? canManageContextItem(user, kind, item) : false,
  };
}

function isHidden(userId: any, resourceType: any, resourceId: any): boolean {
  const type = normalizeResourceType(resourceType);
  const uid = String(userId || '').trim();
  const id = String(resourceId || '').trim();
  if (!type || !uid || !id) return false;
  return !!db.prepare(`
    SELECT 1 FROM user_resource_hides
    WHERE user_id = ? AND resource_type = ? AND resource_id = ?
  `).get(uid, type, id);
}

function setHidden(userId: any, resourceType: any, resourceId: any, hidden: boolean): boolean {
  const type = normalizeResourceType(resourceType);
  const uid = String(userId || '').trim();
  const id = String(resourceId || '').trim();
  if (!type || !uid || !id) return false;
  if (hidden) {
    db.prepare(`
      INSERT INTO user_resource_hides (user_id, resource_type, resource_id)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, resource_type, resource_id) DO NOTHING
    `).run(uid, type, id);
  } else {
    db.prepare(`
      DELETE FROM user_resource_hides
      WHERE user_id = ? AND resource_type = ? AND resource_id = ?
    `).run(uid, type, id);
  }
  return true;
}

export {
  normalizeVisibility,
  normalizeProjectVisibility,
  uniqStringList,
  projectAccessPayload,
  accessPayload,
  setProjectAccess,
  setResourcePolicy,
  isV3RunSessionGateEnabled,
  canSetIssueVisibilityWithinProject,
  canReadProject,
  canManageProject,
  projectAllowsReaderWrite,
  canCreateIssue,
  canReadIssue,
  canManageIssue,
  canReadResearch,
  canManageResearch,
  canCreateSessionForIssue,
  canCreateSessionForResearch,
  canCreateHarnessRun,
  canReadHarnessRun,
  canOperateHarnessRun,
  canManageHarnessRun,
  canReadSession,
  canOperateSession,
  canReadContextItem,
  canManageContextItem,
  canContributeProjectContext,
  filterReadableContextItems,
  withContextAccess,
  contextAccessPayload,
  isHidden,
  setHidden,
};
