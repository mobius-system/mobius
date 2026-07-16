import { db } from '../../db';
import {
  APP_DIR,
  DEFAULT_FORGOTTEN_FLAG_MESSAGE,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE,
  FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES_MIN,
  FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES_MIN,
  FORGOTTEN_FLAG_BACKOFF_MIN,
  FORGOTTEN_FLAG_BACKOFF_MAX,
  FORGOTTEN_FLAG_PATIENCE_MIN,
  FORGOTTEN_FLAG_PATIENCE_MAX,
} from '../config';
import type { ProjectRow, ProjectRawRow } from '../types/rows';

type ProjectVisibility = 'private' | 'team' | 'public' | 'allowlist';
const CARD_BORDER_THEME_IDS = new Set([
  'auto',
  'neutral',
  'dark-gold',
  'dark-cyan',
  'latex-paper',
  'latex-violet',
  'emerald-copper',
]);

function normalizeIntervalMinutes(value: unknown, fallback: number, min: number): number {
  const n = Number(value);
  if (Number.isInteger(n) && n >= min) return n;
  return fallback;
}

function normalizeBackoff(value: unknown, fallback: number): number {
  const n = Number(value);
  if (Number.isFinite(n) && n >= FORGOTTEN_FLAG_BACKOFF_MIN && n <= FORGOTTEN_FLAG_BACKOFF_MAX) return n;
  return fallback;
}

function normalizePatience(value: unknown, fallback: number): number {
  const n = Number(value);
  if (Number.isInteger(n) && n >= FORGOTTEN_FLAG_PATIENCE_MIN && n <= FORGOTTEN_FLAG_PATIENCE_MAX) return n;
  return fallback;
}

function parseOptionalIdArray(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id: unknown) => typeof id === 'string' && (id as string).length > 0) : [];
  } catch {
    return [];
  }
}

function uniqueIds(ids: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeCardBorderTheme(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return CARD_BORDER_THEME_IDS.has(text) ? text : 'auto';
}

type ProjectRawRowWithExtras = ProjectRawRow & {
  starred?: number;
  hidden?: number;
  issue_count?: number;
  research_count?: number;
  last_session_activity_at?: string | null;
  created_by_name?: string;
};

// git_repos 字段在库里是 JSON 字符串，对外暴露成数组
function hydrate(row: ProjectRawRowWithExtras | null | undefined): ProjectRow | null | undefined {
  if (!row) return row;
  let repos: any[] = [];
  try { repos = JSON.parse(row.git_repos || '[]'); } catch { repos = []; }
  const issueInit = normalizeIntervalMinutes(
    row.forgotten_flag_issue_init_minutes ?? row.forgotten_flag_issue_interval_minutes,
    DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES,
    FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES_MIN,
  );
  const researchInit = normalizeIntervalMinutes(
    row.forgotten_flag_research_init_minutes ?? row.forgotten_flag_research_interval_minutes,
    DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES,
    FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES_MIN,
  );
  const issueBackoff = normalizeBackoff(row.forgotten_flag_issue_backoff, DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF);
  const researchBackoff = normalizeBackoff(row.forgotten_flag_research_backoff, DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF);
  const issuePatience = normalizePatience(row.forgotten_flag_issue_patience, DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE);
  const researchPatience = normalizePatience(row.forgotten_flag_research_patience, DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE);
  return {
    ...row,
    git_repos: Array.isArray(repos) ? repos : [],
    // 库里存 0/1 整数, 对外暴露成布尔, 方便前端直接消费
    default_use_worktree: !!row.default_use_worktree,
    // 项目级 Research 系统开关: 默认关闭.
    research_enabled: !!row.research_enabled,
    // 绑定路径是否为"手动输入(不校验)". 前端据此在重开编辑界面时
    // 把 bindPathManual 还原为 true, 避免再次保存时走严格校验把路径回撤.
    bind_path_manual: !!row.bind_path_manual,
    starred: !!row.starred,
    // 拓展系统: 'normal' | 'extension'. 后者由 mobius/extension/<name>/ 目录自动同步出来.
    kind: row.kind || 'normal',
    extension_name: row.extension_name || null,
    disabled: !!row.disabled,
    visibility: (row.visibility || 'private') as ProjectVisibility,
    can_post_issue: !!row.can_post_issue,
    can_run_session: !!row.can_run_session,
    // 每用户隐藏标记 (仅 kind='extension' 真正用到): 由 findById/listAll 在 userId 路径下
    // LEFT JOIN project_user_hidden 注入; 前端据此过滤掉用户已隐藏的拓展卡片.
    // 拓展一律默认可见 (default_hidden 已移除); hidden 仅来自用户自己的隐藏动作.
    hidden: !!row.hidden,
    // 项目级默认模型偏好: 空字符串规范化为 null, 表示"未指定 (跟随系统全局默认)".
    // 前端新建 Session 时若该字段非空, 用作模型下拉的初始值; 否则回落到 DEFAULT_SESSION_MODEL.
    default_model: (typeof row.default_model === 'string' && row.default_model.trim())
      ? row.default_model.trim()
      : null,
    card_border_theme: normalizeCardBorderTheme(row.card_border_theme),
    // 实际生效的"被遗忘 flag 提醒消息": 配置了用配置, 否则用系统默认.
    // 前端用它预填输入框 (单一真相源在 config.DEFAULT_FORGOTTEN_FLAG_MESSAGE).
    forgotten_flag_message_effective:
      (typeof row.forgotten_flag_message === 'string' && row.forgotten_flag_message.trim())
        ? row.forgotten_flag_message
        : DEFAULT_FORGOTTEN_FLAG_MESSAGE,
    forgotten_flag_issue_interval_minutes: issueInit,
    forgotten_flag_research_interval_minutes: researchInit,
    forgotten_flag_issue_init_minutes: issueInit,
    forgotten_flag_issue_backoff: issueBackoff,
    forgotten_flag_issue_patience: issuePatience,
    forgotten_flag_research_init_minutes: researchInit,
    forgotten_flag_research_backoff: researchBackoff,
    forgotten_flag_research_patience: researchPatience,
    is_self_develop: !!(row.bind_path && APP_DIR && row.bind_path === APP_DIR),
  } as ProjectRow;
}

interface InsertArgs {
  id: string;
  name: string;
  description?: string | null;
  createdBy: string;
  bindPath?: string;
  bindPathManual?: boolean;
  gitRepos?: string[];
  defaultUseWorktree?: boolean;
  researchEnabled?: boolean;
  visibility?: ProjectVisibility;
  canPostIssue?: boolean;
  canRunSession?: boolean;
  defaultModel?: string | null;
}

interface UpsertExtensionArgs {
  id: string;
  name: string;
  description?: string | null;
  createdBy: string;
  bindPath: string;
  extensionName: string;
}

interface WhitelistRow {
  skill_ids: string[] | null;
  builtin_skill_ids: string[] | null;
  memory_ids: string[] | null;
  created_at: string | null;
  updated_at: string | null;
}

interface SetUserContextWhitelistArgs {
  skillIds?: string[] | null;
  builtinSkillIds?: string[] | null;
  memoryIds?: string[] | null;
}

const Projects = {
  findById: (id: string, userId: string | null = null): ProjectRow | null | undefined => {
    if (userId) {
      return hydrate(db.prepare(`
        SELECT p.*,
          CASE WHEN pus.user_id IS NULL THEN 0 ELSE 1 END AS starred,
          CASE WHEN puh.user_id IS NULL THEN 0 ELSE 1 END AS hidden
        FROM projects p
        LEFT JOIN project_user_stars pus ON pus.project_id = p.id AND pus.user_id = ?
        LEFT JOIN project_user_hidden puh ON puh.project_id = p.id AND puh.user_id = ?
        WHERE p.id = ?
      `).get(userId, userId, id) as ProjectRawRowWithExtras | undefined);
    }
    return hydrate(db.prepare('SELECT *, 0 AS starred, 0 AS hidden FROM projects WHERE id = ?').get(id) as ProjectRawRowWithExtras | undefined);
  },

  listAll: (userId: string | null = null): Array<ProjectRow | null | undefined> => {
    if (userId) {
      return (db.prepare(`
        SELECT p.*, u.display_name as created_by_name,
          CASE WHEN pus.user_id IS NULL THEN 0 ELSE 1 END AS starred,
          CASE WHEN puh.user_id IS NULL THEN 0 ELSE 1 END AS hidden,
          (SELECT COUNT(*) FROM issues WHERE project_id = p.id) as issue_count,
          (SELECT COUNT(*) FROM researches WHERE project_id = p.id) as research_count,
          (SELECT MAX(created_at) FROM sessions_v2 WHERE project_id = p.id) as last_session_activity_at
        FROM projects p
        LEFT JOIN users u ON p.created_by = u.id
        LEFT JOIN project_user_stars pus ON pus.project_id = p.id AND pus.user_id = ?
        LEFT JOIN project_user_hidden puh ON puh.project_id = p.id AND puh.user_id = ?
        ORDER BY starred DESC, last_session_activity_at DESC, p.last_active DESC, p.name ASC
      `).all(userId, userId) as ProjectRawRowWithExtras[]).map(hydrate);
    }
    return (db.prepare(`
      SELECT p.*, u.display_name as created_by_name,
      0 AS starred, 0 AS hidden,
      (SELECT COUNT(*) FROM issues WHERE project_id = p.id) as issue_count,
      (SELECT COUNT(*) FROM researches WHERE project_id = p.id) as research_count,
      (SELECT MAX(created_at) FROM sessions_v2 WHERE project_id = p.id) as last_session_activity_at
      FROM projects p
      LEFT JOIN users u ON p.created_by = u.id
      ORDER BY starred DESC, last_session_activity_at DESC, p.last_active DESC, p.name ASC
    `).all() as ProjectRawRowWithExtras[]).map(hydrate);
  },

  insert: ({ id, name, description, createdBy, bindPath, bindPathManual, gitRepos, defaultUseWorktree, researchEnabled, visibility, canPostIssue, canRunSession, defaultModel }: InsertArgs) => db.prepare(
    'INSERT INTO projects (id, name, description, created_by, bind_path, bind_path_manual, git_repos, default_use_worktree, research_enabled, visibility, can_post_issue, can_run_session, default_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, name, description || '', createdBy, bindPath || '', bindPathManual ? 1 : 0,
    JSON.stringify(gitRepos || []), defaultUseWorktree ? 1 : 0, researchEnabled ? 1 : 0, visibility || 'private',
    canPostIssue ? 1 : 0, canRunSession ? 1 : 0,
    (typeof defaultModel === 'string' && defaultModel.trim()) ? defaultModel.trim() : null),

  // ===== 拓展项目专用 =====
  // 注意: kind='extension' 行的 bind_path/default_use_worktree/research_enabled 由 registry 锁定,
  // 普通项目编辑接口 (updateBindPath/updateResearchEnabled/...) 在 routes 层会拦下来.
  findByExtensionName: (extName: string, userId: string | null = null): ProjectRow | null | undefined => {
    if (userId) {
      return hydrate(db.prepare(`
        SELECT p.*,
          CASE WHEN pus.user_id IS NULL THEN 0 ELSE 1 END AS starred
        FROM projects p
        LEFT JOIN project_user_stars pus ON pus.project_id = p.id AND pus.user_id = ?
        WHERE p.extension_name = ?
      `).get(userId, extName) as ProjectRawRowWithExtras | undefined);
    }
    return hydrate(db.prepare('SELECT *, 0 AS starred FROM projects WHERE extension_name = ?').get(extName) as ProjectRawRowWithExtras | undefined);
  },
  listExtensions: (): Array<ProjectRow | null | undefined> => (db.prepare(
    "SELECT *, 0 AS starred FROM projects WHERE kind = 'extension'"
  ).all() as ProjectRawRowWithExtras[]).map(hydrate),
  upsertExtension: ({ id, name, description, createdBy, bindPath, extensionName }: UpsertExtensionArgs): string => {
    const existing = db.prepare('SELECT id FROM projects WHERE extension_name = ?').get(extensionName) as { id: string } | undefined;
    if (existing) {
      // 已存在: 把可能漂移的字段同步回锁定值 (name/description 来自 manifest), 并清 disabled.
      db.prepare(`
        UPDATE projects SET
          name = ?, description = ?, bind_path = ?, bind_path_manual = 1,
          default_use_worktree = 0, research_enabled = 0,
          kind = 'extension', disabled = 0
        WHERE id = ?
      `).run(name, description || '', bindPath, existing.id);
      return existing.id;
    }
    db.prepare(`
      INSERT INTO projects (
        id, name, description, created_by, bind_path, bind_path_manual,
        git_repos, default_use_worktree, research_enabled,
        kind, extension_name, disabled
      ) VALUES (?, ?, ?, ?, ?, 1, '[]', 0, 0, 'extension', ?, 0)
    `).run(id, name, description || '', createdBy, bindPath, extensionName);
    return id;
  },
  setExtensionDisabled: (extName: string, disabled: boolean) => db.prepare(
    "UPDATE projects SET disabled = ? WHERE kind = 'extension' AND extension_name = ?"
  ).run(disabled ? 1 : 0, extName),

  // ===== 拓展项目: 每用户隐藏 / 彻底删除 =====
  // setHidden(false) = "撤销隐藏" (用户自己撤销或管理员撤销, 同一行 DELETE)
  setHidden: (projectId: string, userId: string, hidden: boolean): void => {
    if (hidden) {
      db.prepare(`
        INSERT INTO project_user_hidden (project_id, user_id)
        VALUES (?, ?)
        ON CONFLICT(project_id, user_id) DO NOTHING
      `).run(projectId, userId);
    } else {
      db.prepare(
        'DELETE FROM project_user_hidden WHERE project_id = ? AND user_id = ?'
      ).run(projectId, userId);
    }
  },
  // 管理员面板用: 列出所有 (用户, 拓展项目) 隐藏对.
  listHidden: () => db.prepare(`
    SELECT puh.project_id, puh.user_id, puh.hidden_at,
           p.name as project_name, p.extension_name, p.disabled,
           u.display_name as user_display_name
    FROM project_user_hidden puh
    JOIN projects p ON p.id = puh.project_id
    LEFT JOIN users u ON u.id = puh.user_id
    WHERE p.kind = 'extension'
    ORDER BY puh.hidden_at DESC
  `).all(),
  // "彻底删除": 事务删该用户在该拓展项目上的全部私有/共享数据, 再插隐藏行.
  purgeUserExtensionData: (projectId: string, userId: string): void => {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM sessions_v2 WHERE project_id = ? AND user_id = ?').run(projectId, userId);
      db.prepare('DELETE FROM issues WHERE project_id = ? AND created_by = ?').run(projectId, userId);
      db.prepare('DELETE FROM project_user_stars WHERE project_id = ? AND user_id = ?').run(projectId, userId);
      db.prepare('DELETE FROM project_user_context_whitelists WHERE project_id = ? AND user_id = ?').run(projectId, userId);
      db.prepare(`
        INSERT INTO project_user_hidden (project_id, user_id)
        VALUES (?, ?)
        ON CONFLICT(project_id, user_id) DO NOTHING
      `).run(projectId, userId);
    });
    tx();
  },

  delete: (id: string) => db.prepare('DELETE FROM projects WHERE id = ?').run(id),
  updateName: (id: string, name: string) => db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id),
  updateDescription: (id: string, desc: string) => db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(desc, id),
  // manual 标记随路径一起持久化: 决定后续保存走严格还是不校验解析.
  updateBindPath: (id: string, bindPath: string, bindPathManual: boolean) => db.prepare(
    'UPDATE projects SET bind_path = ?, bind_path_manual = ? WHERE id = ?'
  ).run(bindPath || '', bindPathManual ? 1 : 0, id),
  updateGitRepos: (id: string, repos: string[]) => db.prepare('UPDATE projects SET git_repos = ? WHERE id = ?').run(JSON.stringify(repos || []), id),
  updateDefaultUseWorktree: (id: string, val: boolean) => db.prepare('UPDATE projects SET default_use_worktree = ? WHERE id = ?').run(val ? 1 : 0, id),
  updateResearchEnabled: (id: string, val: boolean) => db.prepare('UPDATE projects SET research_enabled = ? WHERE id = ?').run(val ? 1 : 0, id),
  updateVisibility: (id: string, visibility: ProjectVisibility) => db.prepare('UPDATE projects SET visibility = ? WHERE id = ?').run(visibility, id),
  updateCanPostIssue: (id: string, val: boolean) => db.prepare('UPDATE projects SET can_post_issue = ? WHERE id = ?').run(val ? 1 : 0, id),
  updateCanRunSession: (id: string, val: boolean) => db.prepare('UPDATE projects SET can_run_session = ? WHERE id = ?').run(val ? 1 : 0, id),
  // 项目级默认模型偏好. 空串/空白 → 存 NULL, 表示 "未指定 (跟系统全局默认)".
  updateDefaultModel: (id: string, val: string | null): void => {
    const v = (typeof val === 'string' && val.trim()) ? val.trim() : null;
    db.prepare('UPDATE projects SET default_model = ? WHERE id = ?').run(v, id);
  },
  updateCardBorderTheme: (id: string, val: string): void => {
    db.prepare('UPDATE projects SET card_border_theme = ? WHERE id = ?').run(normalizeCardBorderTheme(val), id);
  },
  // 空串/空白 → 存 NULL, 表示 "用 scanner 内置默认文案".
  updateForgottenFlagMessage: (id: string, msg: string | null): void => {
    const v = (typeof msg === 'string' && msg.trim().length > 0) ? msg : null;
    db.prepare('UPDATE projects SET forgotten_flag_message = ? WHERE id = ?').run(v, id);
  },
  updateForgottenFlagIssueIntervalMinutes: (id: string, minutes: number) => db.prepare(
    'UPDATE projects SET forgotten_flag_issue_interval_minutes = ?, forgotten_flag_issue_init_minutes = ? WHERE id = ?'
  ).run(minutes, minutes, id),
  updateForgottenFlagResearchIntervalMinutes: (id: string, minutes: number) => db.prepare(
    'UPDATE projects SET forgotten_flag_research_interval_minutes = ?, forgotten_flag_research_init_minutes = ? WHERE id = ?'
  ).run(minutes, minutes, id),
  updateForgottenFlagIssuePolicy: (id: string, { initMinutes, backoff, patience }: { initMinutes: number; backoff: number; patience: number }) => db.prepare(`
    UPDATE projects
    SET forgotten_flag_issue_interval_minutes = ?,
        forgotten_flag_issue_init_minutes = ?,
        forgotten_flag_issue_backoff = ?,
        forgotten_flag_issue_patience = ?
    WHERE id = ?
  `).run(initMinutes, initMinutes, backoff, patience, id),
  updateForgottenFlagResearchPolicy: (id: string, { initMinutes, backoff, patience }: { initMinutes: number; backoff: number; patience: number }) => db.prepare(`
    UPDATE projects
    SET forgotten_flag_research_interval_minutes = ?,
        forgotten_flag_research_init_minutes = ?,
        forgotten_flag_research_backoff = ?,
        forgotten_flag_research_patience = ?
    WHERE id = ?
  `).run(initMinutes, initMinutes, backoff, patience, id),
  setStarred: (id: string, userId: string, starred: boolean): void => {
    if (starred) {
      db.prepare(`
        INSERT INTO project_user_stars (project_id, user_id)
        VALUES (?, ?)
        ON CONFLICT(project_id, user_id) DO NOTHING
      `).run(id, userId);
    } else {
      db.prepare(`
        DELETE FROM project_user_stars
        WHERE project_id = ? AND user_id = ?
      `).run(id, userId);
    }
  },

  getUserContextWhitelist: (projectId: string, userId: string): WhitelistRow => {
    const row = db.prepare(`
      SELECT skill_ids, builtin_skill_ids, memory_ids, created_at, updated_at
      FROM project_user_context_whitelists
      WHERE project_id = ? AND user_id = ?
    `).get(projectId, userId) as (Omit<WhitelistRow, 'skill_ids' | 'builtin_skill_ids' | 'memory_ids'> & { skill_ids: string | null; builtin_skill_ids: string | null; memory_ids: string | null }) | undefined;
    if (!row) {
      return {
        skill_ids: null,
        builtin_skill_ids: null,
        memory_ids: null,
        created_at: null,
        updated_at: null,
      };
    }
    return {
      skill_ids: parseOptionalIdArray(row.skill_ids),
      builtin_skill_ids: parseOptionalIdArray(row.builtin_skill_ids),
      memory_ids: parseOptionalIdArray(row.memory_ids),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  },

  setUserContextWhitelist: (projectId: string, userId: string, { skillIds = null, builtinSkillIds = null, memoryIds = null }: SetUserContextWhitelistArgs = {}): WhitelistRow => {
    const nextSkillIds = Array.isArray(skillIds) ? uniqueIds(skillIds) : null;
    const nextBuiltinSkillIds = Array.isArray(builtinSkillIds) ? uniqueIds(builtinSkillIds) : null;
    const nextMemoryIds = Array.isArray(memoryIds) ? uniqueIds(memoryIds) : null;

    if (nextSkillIds === null && nextBuiltinSkillIds === null && nextMemoryIds === null) {
      db.prepare(`
        DELETE FROM project_user_context_whitelists
        WHERE project_id = ? AND user_id = ?
      `).run(projectId, userId);
      return Projects.getUserContextWhitelist(projectId, userId);
    }

    db.prepare(`
      INSERT INTO project_user_context_whitelists (project_id, user_id, skill_ids, builtin_skill_ids, memory_ids)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, user_id) DO UPDATE SET
        skill_ids = excluded.skill_ids,
        builtin_skill_ids = excluded.builtin_skill_ids,
        memory_ids = excluded.memory_ids,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(
      projectId,
      userId,
      nextSkillIds === null ? null : JSON.stringify(nextSkillIds),
      nextBuiltinSkillIds === null ? null : JSON.stringify(nextBuiltinSkillIds),
      nextMemoryIds === null ? null : JSON.stringify(nextMemoryIds),
    );
    return Projects.getUserContextWhitelist(projectId, userId);
  },

  // 用于 canReadProject
  isOwnedOrUsedBy: (projectId: string, userId: string): { '1': number } | undefined => db.prepare(`
    SELECT 1 FROM projects WHERE id = ? AND created_by = ?
    UNION SELECT 1 FROM sessions_v2 WHERE project_id = ? AND user_id = ?
    UNION SELECT 1 FROM researches WHERE project_id = ? AND created_by = ?
    LIMIT 1
  `).get(projectId, userId, projectId, userId, projectId, userId) as { '1': number } | undefined,
};

export { Projects };
