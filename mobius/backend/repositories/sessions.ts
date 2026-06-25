import { db } from '../../db';
import { MODELS, DEFAULT_MODEL_KEY } from '../config';
import type { SessionRow } from '../types/rows';

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
      s.completed_at`;

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

  listActiveByIssue: (issueId: string): SessionRow[] => db.prepare("SELECT * FROM sessions_v2 WHERE issue_id = ? AND scope_type = 'issue' AND status = 'active'").all(issueId) as SessionRow[],
  listAllByIssue: (issueId: string): SessionRow[] => db.prepare("SELECT * FROM sessions_v2 WHERE issue_id = ? AND scope_type = 'issue' ORDER BY created_at ASC").all(issueId) as SessionRow[],
  listActiveByResearch: (researchId: string): SessionRow[] => db.prepare("SELECT * FROM sessions_v2 WHERE research_id = ? AND scope_type = 'research' AND status = 'active'").all(researchId) as SessionRow[],
  listAllByResearch: (researchId: string): SessionRow[] => db.prepare("SELECT * FROM sessions_v2 WHERE research_id = ? AND scope_type = 'research' ORDER BY created_at ASC").all(researchId) as SessionRow[],
  findChiefForResearch: (researchId: string): SessionRow | undefined => db.prepare("SELECT * FROM sessions_v2 WHERE research_id = ? AND scope_type = 'research' AND research_role = 'chief_researcher' LIMIT 1").get(researchId) as SessionRow | undefined,

  findLatestReusableSelectionForIssue: (issueId: string): ReusableSelectionRow | undefined => db.prepare(`
    SELECT session_id, name, created_at, last_active,
      session_excluded_skills, session_excluded_memories,
      session_selection_snapshot, session_selection_snapshot_at
    FROM sessions_v2
    WHERE issue_id = ? AND scope_type = 'issue' AND status IN ('active','completed','archived')
    ORDER BY created_at DESC, last_active DESC
    LIMIT 1
  `).get(issueId) as ReusableSelectionRow | undefined,

  findLatestReusableSelectionForResearch: (researchId: string): ReusableSelectionRow | undefined => db.prepare(`
    SELECT session_id, name, created_at, last_active,
      session_excluded_skills, session_excluded_memories,
      session_selection_snapshot, session_selection_snapshot_at
    FROM sessions_v2
    WHERE research_id = ? AND scope_type = 'research' AND status IN ('active','completed','archived')
    ORDER BY created_at DESC, last_active DESC
    LIMIT 1
  `).get(researchId) as ReusableSelectionRow | undefined,

  insert: (args: InsertArgs): void => {
    const { session_id, issue_id, project_id, scope_type, research_id, research_role, user_id, name, description, session_key, excluded_skill_ids, excluded_memory_ids, selection_snapshot, model, language } = args;
    const exSk = Array.isArray(excluded_skill_ids) && excluded_skill_ids.length > 0 ? JSON.stringify(excluded_skill_ids) : null;
    const exMm = Array.isArray(excluded_memory_ids) && excluded_memory_ids.length > 0 ? JSON.stringify(excluded_memory_ids) : null;
    const selSnap = selection_snapshot ? JSON.stringify(selection_snapshot) : null;
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
      model, language
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)`)
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
      );
  },

  updateName: (id: string, name: string) => db.prepare('UPDATE sessions_v2 SET name = ? WHERE session_id = ?').run(name, id),
  updateStatus: (id: string, status: SessionStatus) => db.prepare('UPDATE sessions_v2 SET status = ? WHERE session_id = ?').run(status, id),
  updateDescription: (id: string, description: string) => db.prepare('UPDATE sessions_v2 SET description = ? WHERE session_id = ?').run(description, id),
  updateRiskLevel: (id: string, risk: string) => db.prepare('UPDATE sessions_v2 SET risk_level = ? WHERE session_id = ?').run(risk, id),
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

  touchActive: (id: string) => db.prepare("UPDATE sessions_v2 SET last_active = strftime('%Y-%m-%dT%H:%M:%fZ','now'), message_count = message_count + 1, agent_status = 'running' WHERE session_id = ?").run(id),

  touchAssistantConversation: (id: string) => db.prepare(`
    UPDATE sessions_v2
    SET last_active = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        agent_status = 'idle',
        message_count = (SELECT COUNT(*) FROM messages_v2 WHERE task_id = ?),
        turn_count = COALESCE((SELECT MAX(turn_number) FROM messages_v2 WHERE task_id = ?), turn_count)
    WHERE session_id = ?
  `).run(id, id, id),

  resetAssistantConversation: (id: string) => db.prepare(`
    UPDATE sessions_v2
    SET last_active = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        agent_status = 'idle',
        message_count = 0,
        turn_count = 0
    WHERE session_id = ?
  `).run(id),

  // stop 信号: 强制把 agent 状态切回 idle, 同时更新 last_agent_event
  setIdle: (id: string, userId: string) => db.prepare(
    "UPDATE sessions_v2 SET agent_status = 'idle', last_agent_event = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE session_id = ? AND user_id = ?"
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
