/**
 * rows.ts — 数据库行对象类型集中定义
 *
 * 类型来源：
 *   - mobius/schema.sql (建表 DDL，单一真相源)
 *   - 各 repository 的 hydrate() 函数 (hydrate 后的形状才是消费方实际看到的)
 *
 * 命名约定：
 *   - `XxxRawRow`：better-sqlite3 直接返回的行对象，列名 100% snake_case，布尔存为 0/1 整数
 *   - `XxxRow`：经过 hydrate 后暴露给消费方的形状（布尔已是 true/false，JSON 字段已 parse）
 *
 * 当某张表没有 hydrate 转换时，`XxxRawRow` 与 `XxxRow` 同义，只导出后者。
 */

// ===== users =====
export interface UserGroupRawRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface UserRawRow {
  id: string;
  display_name: string;
  password_hash: string;
  role: 'admin' | 'user';
  work_dir: string;
  group_id: string | null;
  deleted_at: string | null;
  created_at: string;
}

/** 仓库 JOIN 后会增加 group_name / group_description；可空 */
export interface UserRow extends UserRawRow {
  group_name?: string | null;
  group_description?: string | null;
}

// ===== projects =====
export interface ProjectRawRow {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: string;
  last_active: string;
  bind_path: string;
  /** DB 存 JSON 字符串；hydrate 后为 string[] */
  git_repos: string;
  default_use_worktree: number;
  forgotten_flag_message: string | null;
  forgotten_flag_issue_interval_minutes: number;
  forgotten_flag_research_interval_minutes: number;
  forgotten_flag_issue_init_minutes: number;
  forgotten_flag_issue_backoff: number;
  forgotten_flag_issue_patience: number;
  forgotten_flag_research_init_minutes: number;
  forgotten_flag_research_backoff: number;
  forgotten_flag_research_patience: number;
  bind_path_manual: number;
  research_enabled: number;
  visibility: 'private' | 'team' | 'public' | 'allowlist';
  can_post_issue: number;
  can_run_session: number;
  kind: 'normal' | 'extension';
  extension_name: string | null;
  disabled: number;
  default_model: string | null;
}

/** hydrate 后的 Project 行：布尔字段已转 boolean，git_repos 已 parse */
export interface ProjectRow extends Omit<ProjectRawRow,
  | 'git_repos'
  | 'default_use_worktree'
  | 'research_enabled'
  | 'bind_path_manual'
  | 'disabled'
  | 'can_post_issue'
  | 'can_run_session'> {
  git_repos: string[];
  default_use_worktree: boolean;
  research_enabled: boolean;
  bind_path_manual: boolean;
  disabled: boolean;
  can_post_issue: boolean;
  can_run_session: boolean;
  /** LEFT JOIN 注入：用户在该项目上是否星标 */
  starred?: boolean;
  /** LEFT JOIN 注入：用户是否隐藏了该项目（仅拓展真正用到；拓展一律默认可见） */
  hidden?: boolean;
  /** 计算字段：实际生效的 forgotten flag 提醒消息（取自 config 或库配置） */
  forgotten_flag_message_effective?: string;
  /** 计算字段：bind_path === APP_DIR */
  is_self_develop?: boolean;
}

// ===== issues =====
export interface IssueRawRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: 'active' | 'completed';
  created_by: string;
  created_at: string;
  last_active: string;
  message_count: number;
  completed_at: string | null;
  pinned: number;
  /** DB 存 JSON 字符串 */
  selected_skills: string;
  /** DB 存 JSON 字符串 */
  excluded_skills: string;
  use_worktree: number;
  worktree_branch: string;
  visibility: 'inherit' | 'private' | 'team' | 'public' | 'allowlist';
}

export interface IssueRow extends Omit<IssueRawRow, 'pinned' | 'use_worktree'> {
  pinned: boolean;
  use_worktree: boolean;
  /** LEFT JOIN 注入：用户在该 issue 上是否星标 */
  starred?: boolean;
}

// ===== researches =====
export interface ResearchRawRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: 'active' | 'completed';
  created_by: string;
  created_at: string;
  last_active: string;
  message_count: number;
  pinned: number;
  visibility: 'inherit' | 'private' | 'team' | 'public' | 'allowlist';
}

export interface ResearchRow extends Omit<ResearchRawRow, 'pinned'> {
  pinned: boolean;
}

// ===== sessions_v2 (生产主栈) =====
export interface SessionRawRow {
  session_id: string;
  issue_id: string | null;
  project_id: string | null;
  scope_type: 'issue' | 'research';
  research_id: string | null;
  research_role: 'chief_researcher' | 'research_assistant' | null;
  user_id: string;
  name: string;
  description: string | null;
  session_key: string;
  claude_session_id: string | null;
  model: string | null;
  /** DEPRECATED，保留以避免 migration 风险 */
  use_proxy: number;
  language: 'zh' | 'en';
  status: 'active' | 'completed' | 'archived';
  agent_status: 'idle' | 'running' | 'stale';
  created_at: string;
  last_active: string;
  last_agent_event: string | null;
  message_count: number;
  turn_count: number;
  context_snapshot_body: string | null;
  context_snapshot_sources: string | null;
  context_snapshot_at: string | null;
  session_selection_snapshot: string | null;
  session_selection_snapshot_at: string | null;
  session_excluded_skills: string | null;
  session_excluded_memories: string | null;
  total_cost_usd: number;
  original_issue_id: string | null;
  original_project_id: string | null;
  deleted_at: string | null;
  completed_at: string | null;
  /** PC 任务模式元数据 (JSON 字符串 {work_mode, aimux_id, local_path?}); 仅桌面端 session 非空, web 端恒 null */
  pc_client_metadata: string | null;
}

export type SessionRow = SessionRawRow;

// ===== messages_v2 =====
export interface MessageRawRow {
  id: number;
  task_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system' | 'thinking' | 'raw';
  content: string;
  raw_event: string | null;
  tool_summary: string | null;
  tool_status: string | null;
  tool_exit_code: number | null;
  turn_number: number | null;
  turn_summary: string | null;
  bookmarked: number;
  created_at: string;
}

export interface MessageRow extends Omit<MessageRawRow, 'bookmarked'> {
  bookmarked: boolean;
}

// ===== project_todos =====
export interface ProjectTodoRawRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  completed: number;
  sort_order: number;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ProjectTodoRow extends Omit<ProjectTodoRawRow, 'completed'> {
  completed: boolean;
}

// ===== changes (session_changes) =====
export interface SessionChangeRawRow {
  id: string;
  session_id: string;
  issue_id: string;
  project_id: string;
  base_revision: string | null;
  worktree_path: string | null;
  status: 'draft' | 'checking' | 'ready' | 'conflict' | 'integrated' | 'abandoned';
  summary: string | null;
  check_status: 'pending' | 'running' | 'passed' | 'failed';
  check_detail: string | null;
  created_at: string;
  updated_at: string;
}

export type ChangeRow = SessionChangeRawRow;

// ===== admin_audit_log =====
export interface AdminAuditLogRawRow {
  id: number;
  admin_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  occurred_at: string;
}

export type AdminAuditLogRow = AdminAuditLogRawRow;

// ===== audit (integration_audit_logs) =====
export interface AuditLogRawRow {
  id: number;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  detail: string | null;
  created_at: string;
}

export type AuditRow = AuditLogRawRow;

// ===== skills (DB 表，v1.7 起正文走 protected_data/ 文件树，此表现网 0 行) =====
export interface SkillRawRow {
  id: string;
  scope: 'user' | 'project';
  owner_id: string;
  name: string;
  description: string | null;
  body: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type SkillRow = SkillRawRow;

// ===== memories (DB 表；正文同样走 protected_data/) =====
export interface MemoryRawRow {
  id: string;
  scope: 'user' | 'project';
  owner_id: string;
  name: string;
  description: string | null;
  body: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export type MemoryRow = MemoryRawRow;

// ===== user_project_view (聚合视图行；具体形状见 repositories/user-project-view.js) =====
export interface UserProjectViewRow {
  project_id: string;
  user_id: string;
  hide_others_projects: number;
  updated_at: string;
}

// ===== PRAGMA table_info 返回的行（db.ts 内部使用，repo 一般用不到） =====
export interface PragmaTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}
