import { db } from '../../db';
import { MODELS, DEFAULT_MODEL_KEY } from '../config';
import type { SessionRow } from '../types/rows';

// migration: PC 任务模式 pc_client_metadata 列 (幂等; 新旧库都安全; web 端该列恒 null 不影响任何行为).
(() => {
  const cols = db.prepare("PRAGMA table_info(sessions_v2)").all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === 'pc_client_metadata')) {
    db.exec("ALTER TABLE sessions_v2 ADD COLUMN pc_client_metadata TEXT");
  }
})();

type SessionLanguage = 'zh' | 'en';
type SessionStatus = 'active' | 'completed' | 'archived';
type SessionScopeType = 'issue' | 'research';
type SessionResearchRole = 'chief_researcher' | 'research_assistant';

function normalizeLanguage(value: unknown, fallback: SessionLanguage = 'zh'): SessionLanguage {
  return value === 'en' ? 'en' : (value === 'zh' ? 'zh' : fallback);
}

interface SessionWithJoinsRow extends SessionRow {
  issue_title?: string | null;
  research_title?: string | null;
  project_name?: string | null;
}

interface SessionListRow {
  session_id: string;
  issue_id: string | null;
  project_id: string | null;
  scope_type: SessionScopeType;
  research_id: string | null;
  research_role: SessionResearchRole | null;
  user_id: string;
  name: string;
  description: string | null;
  session_key: string;
  claude_session_id: string | null;
  model: string | null;
  use_proxy: number;
  language: SessionLanguage;
  status: SessionStatus;
  agent_status: 'idle' | 'running' | 'stale';
  created_at: string;
  last_active: string;
  last_agent_event: string | null;
  message_count: number;
  turn_count: number;
  total_cost_usd: number;
  original_issue_id: string | null;
  original_project_id: string | null;
  deleted_at: string | null;
  completed_at: string | null;
  user_display_name?: string;
  raw_entry_count?: number;
}

interface ReusableSelectionRow {
  session_id: string;
  name: string;
  model: string | null;
  created_at: string;
  last_active: string;
  session_excluded_skills: string | null;
  session_excluded_memories: string | null;
  session_selection_snapshot: string | null;
  session_selection_snapshot_at: string | null;
}

interface InsertArgs {
  session_id: string;
  issue_id?: string | null;
  project_id?: string | null;
  scope_type: SessionScopeType;
  research_id?: string | null;
  research_role?: SessionResearchRole | null;
  user_id: string;
  name: string;
  description?: string | null;
  session_key: string;
  excluded_skill_ids?: string[];
  excluded_memory_ids?: string[];
  selection_snapshot?: unknown;
  model?: string;
  language?: SessionLanguage;
  // PC 任务模式 (仅桌面端): { work_mode, aimux_id }; web 端 null/缺省.
  pc_client_metadata?: { work_mode: string; aimux_id: string } | null;
}

// Session list endpoints feed cards/sidebars. Keep heavy snapshots out of these
// responses; detail endpoints still use SELECT * when they need full context.
const SESSION_LIST_COLUMNS = `
      s.session_id,
      s.issue_id,
      s.project_id,
      s.scope_type,
      s.research_id,
      s.research_role,
      s.user_id,
      s.name,
      s.description,
      s.session_key,
      s.claude_session_id,
      s.model,
      s.use_proxy,
      s.language,
      s.status,
      s.agent_status,
      s.created_at,
      s.last_active,
      s.last_agent_event,
      s.message_count,
      s.turn_count,
      s.total_cost_usd,
      s.original_issue_id,
      s.original_project_id,
      s.deleted_at,
      s.completed_at,
      s.pc_client_metadata`;

const Sessions = {
  findById: (id: string): SessionRow | undefined => db.prepare('SELECT * FROM sessions_v2 WHERE session_id = ?').get(id) as SessionRow | undefined,
  findByIdForUser: (id: string, userId: string): SessionRow | undefined => db.prepare('SELECT * FROM sessions_v2 WHERE session_id = ? AND user_id = ?').get(id, userId) as SessionRow | undefined,
  findRiskById: (id: string): { risk_level?: string } | undefined => db.prepare('SELECT risk_level FROM sessions_v2 WHERE session_id = ?').get(id) as { risk_level?: string } | undefined,

  // 用于 integration 模块, 带 issue/project 名
  findByIdWithJoins: (id: string): SessionWithJoinsRow | undefined => db.prepare(`
    SELECT s.*, i.title as issue_title, r.title as research_title, p.name as project_name
    FROM sessions_v2 s
    LEFT JOIN issues i ON s.issue_id = i.id
    LEFT JOIN researches r ON s.research_id = r.id
    LEFT JOIN projects p ON s.project_id = p.id
    WHERE s.session_id = ?
  `).get(id) as SessionWithJoinsRow | undefined,

  listForUser: (userId: string): SessionWithJoinsRow[] => db.prepare(`
    SELECT s.*, i.title as issue_title, r.title as research_title, p.name as project_name
    FROM sessions_v2 s
    LEFT JOIN issues i ON s.issue_id = i.id
    LEFT JOIN researches r ON s.research_id = r.id
    LEFT JOIN projects p ON s.project_id = p.id
    WHERE s.user_id = ?
    ORDER BY s.last_active DESC
  `).all(userId) as SessionWithJoinsRow[],

  listRecentForUser: (userId: string, limit: number): SessionWithJoinsRow[] => db.prepare(`
    SELECT ${SESSION_LIST_COLUMNS}, i.title as issue_title, r.title as research_title, p.name as project_name
    FROM sessions_v2 s
    LEFT JOIN issues i ON s.issue_id = i.id
    LEFT JOIN researches r ON s.research_id = r.id
    LEFT JOIN projects p ON s.project_id = p.id
    WHERE s.user_id = ?
      AND s.status != 'archived'
      AND s.deleted_at IS NULL
      AND s.session_key NOT LIKE 'assistant-question:%'
      AND NOT (i.title = '小莫对话' AND p.name LIKE '%小莫助理')
    ORDER BY s.last_active DESC
    LIMIT ?
  `).all(userId, limit) as SessionWithJoinsRow[],

  // raw_entry_count: 该 session 在 messages_v2 里的原始数据条目数 (每条 SDK
  // 事件/消息落库为一行). 替代一直显示 0 的 turn_count —— turn_count 列从未被
  // 任何写路径自增, 故 IssuePage 卡片改用本字段反映真实数据量.
  listForIssue: (issueId: string): SessionListRow[] => db.prepare(`
    SELECT ${SESSION_LIST_COLUMNS}, u.display_name as user_display_name,
      (SELECT COUNT(*) FROM messages_v2 WHERE task_id = s.session_id) AS raw_entry_count
    FROM sessions_v2 s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.issue_id = ? AND s.scope_type = 'issue' AND s.status = 'active'
    ORDER BY s.last_active DESC
  `).all(issueId) as SessionListRow[],

  listForResearch: (researchId: string): SessionListRow[] => db.prepare(`
    SELECT ${SESSION_LIST_COLUMNS}, u.display_name as user_display_name,
      (SELECT COUNT(*) FROM messages_v2 WHERE task_id = s.session_id) AS raw_entry_count
    FROM sessions_v2 s
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.research_id = ? AND s.scope_type = 'research' AND s.status = 'active'
    ORDER BY
      CASE s.research_role WHEN 'chief_researcher' THEN 0 ELSE 1 END,
      s.last_active DESC
  `).all(researchId) as SessionListRow[],

  listActiveForProjectCardIds: (projectId: string, issueIds: string[] = [], researchIds: string[] = [], previewLimit = 4): SessionListRow[] => {
    const cleanIssueIds = Array.from(new Set(issueIds.map((id) => String(id || '').trim()).filter(Boolean))).slice(0, 100);
    const cleanResearchIds = Array.from(new Set(researchIds.map((id) => String(id || '').trim()).filter(Boolean))).slice(0, 100);
    const clauses: string[] = [];
    const params: string[] = [projectId];
    if (cleanIssueIds.length > 0) {
      clauses.push(`(s.scope_type = 'issue' AND s.issue_id IN (${cleanIssueIds.map(() => '?').join(',')}))`);
      params.push(...cleanIssueIds);
    }
    if (cleanResearchIds.length > 0) {
      clauses.push(`(s.scope_type = 'research' AND s.research_id IN (${cleanResearchIds.map(() => '?').join(',')}))`);
      params.push(...cleanResearchIds);
    }
    if (clauses.length === 0) return [];
    const rows = db.prepare(`
      SELECT ${SESSION_LIST_COLUMNS}, u.display_name as user_display_name
      FROM sessions_v2 s
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.project_id = ?
        AND s.status = 'active'
        AND (${clauses.join(' OR ')})
      ORDER BY
        s.scope_type ASC,
        COALESCE(s.issue_id, s.research_id) ASC,
        CASE s.research_role WHEN 'chief_researcher' THEN 0 ELSE 1 END,
        s.last_active DESC
    `).all(...params) as SessionListRow[];
    const limit = Math.max(1, Math.min(Number(previewLimit) || 4, 500));
    const seen = new Map<string, number>();
    return rows.filter((row: any) => {
      const parentId = row.scope_type === 'research' ? row.research_id : row.issue_id;
      const key = `${row.scope_type}:${parentId || ''}`;
      const count = seen.get(key) || 0;
      if (count >= limit) return false;
      seen.set(key, count + 1);
      return true;
    });
  },

  listActiveByIssue: (issueId: string): SessionRow[] => db.prepare("SELECT * FROM sessions_v2 WHERE issue_id = ? AND scope_type = 'issue' AND status = 'active'").all(issueId) as SessionRow[],
  listAllByIssue: (issueId: string): SessionRow[] => db.prepare("SELECT * FROM sessions_v2 WHERE issue_id = ? AND scope_type = 'issue' ORDER BY created_at ASC").all(issueId) as SessionRow[],
  listActiveByResearch: (researchId: string): SessionRow[] => db.prepare("SELECT * FROM sessions_v2 WHERE research_id = ? AND scope_type = 'research' AND status = 'active'").all(researchId) as SessionRow[],
  listAllByResearch: (researchId: string): SessionRow[] => db.prepare("SELECT * FROM sessions_v2 WHERE research_id = ? AND scope_type = 'research' ORDER BY created_at ASC").all(researchId) as SessionRow[],
  findChiefForResearch: (researchId: string): SessionRow | undefined => db.prepare("SELECT * FROM sessions_v2 WHERE research_id = ? AND scope_type = 'research' AND research_role = 'chief_researcher' LIMIT 1").get(researchId) as SessionRow | undefined,

  findLatestReusableSelectionForIssue: (issueId: string): ReusableSelectionRow | undefined => db.prepare(`
    SELECT session_id, name, model, created_at, last_active,
      session_excluded_skills, session_excluded_memories,
      session_selection_snapshot, session_selection_snapshot_at
    FROM sessions_v2
    WHERE issue_id = ? AND scope_type = 'issue' AND status IN ('active','completed','archived')
    ORDER BY created_at DESC, last_active DESC
    LIMIT 1
  `).get(issueId) as ReusableSelectionRow | undefined,

  findLatestReusableSelectionForResearch: (researchId: string): ReusableSelectionRow | undefined => db.prepare(`
    SELECT session_id, name, model, created_at, last_active,
      session_excluded_skills, session_excluded_memories,
      session_selection_snapshot, session_selection_snapshot_at
    FROM sessions_v2
    WHERE research_id = ? AND scope_type = 'research' AND status IN ('active','completed','archived')
    ORDER BY created_at DESC, last_active DESC
    LIMIT 1
  `).get(researchId) as ReusableSelectionRow | undefined,

  insert: (args: InsertArgs): void => {
    const { session_id, issue_id, project_id, scope_type, research_id, research_role, user_id, name, description, session_key, excluded_skill_ids, excluded_memory_ids, selection_snapshot, model, language, pc_client_metadata } = args;
    const exSk = Array.isArray(excluded_skill_ids) && excluded_skill_ids.length > 0 ? JSON.stringify(excluded_skill_ids) : null;
    const exMm = Array.isArray(excluded_memory_ids) && excluded_memory_ids.length > 0 ? JSON.stringify(excluded_memory_ids) : null;
    const selSnap = selection_snapshot ? JSON.stringify(selection_snapshot) : null;
    const pcMeta = pc_client_metadata ? JSON.stringify(pc_client_metadata) : null;
    // model 缺省/非法时回退到配置里的默认模型 (单一真相源在 config.MODELS).
    const mdl = (typeof model === 'string' && model.length > 0) ? model : MODELS[DEFAULT_MODEL_KEY];
    const lang = normalizeLanguage(language);
    const scope = scope_type === 'research' ? 'research' : 'issue';
    // use_proxy 列已 deprecated (改由 admin-settings 全局配置), 不再写入, DB schema default=1 兜底.
    db.prepare(`INSERT INTO sessions_v2(
      session_id, issue_id, project_id, scope_type, research_id, research_role,
      user_id, name, description, session_key,
      session_excluded_skills, session_excluded_memories,
      session_selection_snapshot, session_selection_snapshot_at,
      model, language, pc_client_metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?)`)
      .run(
        session_id,
        scope === 'issue' ? (issue_id ?? null) : null,
        project_id || null,
        scope,
        scope === 'research' ? (research_id ?? null) : null,
        scope === 'research' ? (research_role ?? null) : null,
        user_id,
        name,
        description || '',
        session_key,
        exSk,
        exMm,
        selSnap,
        mdl,
        lang,
        pcMeta,
      );
  },

  updateName: (id: string, name: string) => db.prepare('UPDATE sessions_v2 SET name = ? WHERE session_id = ?').run(name, id),
  updateStatus: (id: string, status: SessionStatus) => db.prepare('UPDATE sessions_v2 SET status = ? WHERE session_id = ?').run(status, id),
  updateDescription: (id: string, description: string) => db.prepare('UPDATE sessions_v2 SET description = ? WHERE session_id = ?').run(description, id),
  updateRiskLevel: (id: string, risk: string) => db.prepare('UPDATE sessions_v2 SET risk_level = ? WHERE session_id = ?').run(risk, id),
  // 原地更换会话模型 (需求: 模型被管理员删除后会话进入只读, 点"更换模型并继续"用此).
  updateModel: (id: string, model: string) => db.prepare('UPDATE sessions_v2 SET model = ? WHERE session_id = ?').run(model, id),
  // session 级 skill / memory 排除集. 空数组写 null 跟初始一致.
  updateExcludedSkills: (id: string, ids: string[] | null): void => {
    const v = Array.isArray(ids) && ids.length > 0 ? JSON.stringify(ids) : null;
    db.prepare('UPDATE sessions_v2 SET session_excluded_skills = ? WHERE session_id = ?').run(v, id);
  },
  updateExcludedMemories: (id: string, ids: string[] | null): void => {
    const v = Array.isArray(ids) && ids.length > 0 ? JSON.stringify(ids) : null;
    db.prepare('UPDATE sessions_v2 SET session_excluded_memories = ? WHERE session_id = ?').run(v, id);
  },
  archive: (id: string) => db.prepare("UPDATE sessions_v2 SET status = 'archived' WHERE session_id = ?").run(id),
  restoreFromArchive: (id: string) => db.prepare("UPDATE sessions_v2 SET status = 'active' WHERE session_id = ?").run(id),

  permanentDelete: (id: string): void => {
    db.prepare('DELETE FROM messages_v2 WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM sessions_v2 WHERE session_id = ?').run(id);
  },

  // agent_status 现由 backend/services/agent-status-syncer.ts 统一重算写入,
  // 这里只刷新 last_active / message_count (发消息活动痕迹).
  touchActive: (id: string) => db.prepare("UPDATE sessions_v2 SET last_active = strftime('%Y-%m-%dT%H:%M:%fZ','now'), message_count = message_count + 1 WHERE session_id = ?").run(id),

  // stop 信号: 不再写 agent_status (由 syncer 统一管), 只刷新 last_agent_event 留痕.
  setIdle: (id: string, userId: string) => db.prepare(
    "UPDATE sessions_v2 SET last_agent_event = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE session_id = ? AND user_id = ?"
  ).run(id, userId),

  // Admin
  listAllForAdmin: ({ status, limit }: { status?: string; limit: number }): Array<SessionRow & { user_display_name: string }> => {
    let query = `SELECT t.*, u.display_name as user_display_name FROM sessions_v2 t JOIN users u ON t.user_id = u.id`;
    const params: Array<string | number> = [];
    if (status && status !== 'all') {
      query += ' WHERE t.status = ?';
      params.push(status);
    }
    query += ' ORDER BY t.last_active DESC LIMIT ?';
    params.push(limit);
    return db.prepare(query).all(...params) as Array<SessionRow & { user_display_name: string }>;
  },

  countByStatus: (status: SessionStatus): number => (db.prepare("SELECT COUNT(*) as c FROM sessions_v2 WHERE status = ?").get(status) as { c: number }).c,
  countAll: (): number => (db.prepare('SELECT COUNT(*) as c FROM sessions_v2').get() as { c: number }).c,
  countArchived: (): number => (db.prepare("SELECT COUNT(*) as c FROM sessions_v2 WHERE status='archived'").get() as { c: number }).c,

  findNameById: (id: string): { name: string } | undefined => db.prepare('SELECT name FROM sessions_v2 WHERE session_id = ?').get(id) as { name: string } | undefined,

  // 自动生成标题候选: 非删除 + 有足够消息 + 非 claude-code 后端(codex/gpt-5.5 等, 这些 agent
  // 不产 type=ai-title, 由 session-title-generator 兜底). 默认名(含时间戳)的过滤放 JS 层.
  listTitleGenCandidates: (minMessages: number, limit: number): Array<{ session_id: string; name: string; model: string; message_count: number }> => db.prepare(
    `SELECT session_id, name, model, message_count FROM sessions_v2
     WHERE deleted_at IS NULL AND message_count >= ?
       AND (model LIKE 'codex:%' OR model IN ('gpt-5.5', 'codex'))
     ORDER BY last_active DESC LIMIT ?`
  ).all(minMessages, limit) as Array<{ session_id: string; name: string; model: string; message_count: number }>,

  // 上下文快照: 首次发消息时由 chat.js 写入, 此后不再覆盖.
  getContextSnapshot: (id: string): { context_snapshot_body: string | null; context_snapshot_sources: string | null; context_snapshot_at: string | null } | undefined => db.prepare(
    'SELECT context_snapshot_body, context_snapshot_sources, context_snapshot_at FROM sessions_v2 WHERE session_id = ?'
  ).get(id) as { context_snapshot_body: string | null; context_snapshot_sources: string | null; context_snapshot_at: string | null } | undefined,
  getSelectionSnapshot: (id: string): { session_selection_snapshot: string | null; session_selection_snapshot_at: string | null } | undefined => db.prepare(
    'SELECT session_selection_snapshot, session_selection_snapshot_at FROM sessions_v2 WHERE session_id = ?'
  ).get(id) as { session_selection_snapshot: string | null; session_selection_snapshot_at: string | null } | undefined,
  writeContextSnapshot: (id: string, body: string, sourcesJson: string) => db.prepare(`
    UPDATE sessions_v2
    SET context_snapshot_body = ?,
        context_snapshot_sources = ?,
        context_snapshot_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE session_id = ? AND context_snapshot_at IS NULL
  `).run(body, sourcesJson, id),
};

export { Sessions };
