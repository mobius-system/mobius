-- schema.sql — MOBIUS 共享表完整 DDL (单一真相源, 供空库自建表)
--
-- 背景: db.js 只 CREATE researches / sessions_v2 / messages_v2, 并对 issues/projects
-- 做幂等 ALTER 迁移; 但 users/projects/issues/sessions/messages/skills 等"共享表"原本
-- 只存在于历史 data/mobuis.db 里, 源码无建表语句。迁移到新机/容器时目标库为空,
-- 缺这些表后端首查即崩 (transfer.md 阻塞 #1)。
--
-- 本文件抽自现网库的当前 .schema (已包含所有历史 ALTER 后的列), 全部改写为
-- IF NOT EXISTS:
--   - 空库: 一次建成"已迁移完成"的全表, 随后 db.js 的 ALTER 迁移均为 no-op (列已在);
--   - 存量库: 全部 no-op, 不动任何现有数据。
--
-- 由 db.js 在 pragma 之后、researches 之前执行。

-- ===== 用户 =====
CREATE TABLE IF NOT EXISTS user_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO user_groups (id, name, description)
VALUES ('default', '默认组', '未指定群组的员工默认归属');

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
  work_dir TEXT NOT NULL,
  group_id TEXT DEFAULT 'default',
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (group_id) REFERENCES user_groups(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  response_style TEXT NOT NULL DEFAULT 'detailed' CHECK(response_style IN ('concise','detailed','very_detailed')),
  language TEXT NOT NULL DEFAULT 'auto' CHECK(language IN ('auto','zh','en')),
  tone TEXT NOT NULL DEFAULT 'professional' CHECK(tone IN ('professional','casual','friendly')),
  personal_prompt TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ===== 项目 / Issue =====
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_active TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  bind_path TEXT NOT NULL DEFAULT '',
  git_repos TEXT NOT NULL DEFAULT '[]',
  default_use_worktree INTEGER NOT NULL DEFAULT 1,
  forgotten_flag_message TEXT,
  forgotten_flag_issue_interval_minutes INTEGER NOT NULL DEFAULT 10,
  forgotten_flag_research_interval_minutes INTEGER NOT NULL DEFAULT 30,
  forgotten_flag_issue_init_minutes INTEGER NOT NULL DEFAULT 10,
  forgotten_flag_issue_backoff REAL NOT NULL DEFAULT 2,
  forgotten_flag_issue_patience INTEGER NOT NULL DEFAULT 3,
  forgotten_flag_research_init_minutes INTEGER NOT NULL DEFAULT 30,
  forgotten_flag_research_backoff REAL NOT NULL DEFAULT 1.25,
  forgotten_flag_research_patience INTEGER NOT NULL DEFAULT 64,
  bind_path_manual INTEGER NOT NULL DEFAULT 0,
  research_enabled INTEGER NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','team','public','allowlist')),
  can_post_issue INTEGER NOT NULL DEFAULT 0,
  can_run_session INTEGER NOT NULL DEFAULT 0,
  -- 拓展系统: 'normal' = 普通项目; 'extension' = 由 mobius/extension/<name>/ 自动同步出来的特殊拓展项目.
  -- extension_name 仅 kind='extension' 时有值, 应与 mobius/extension/<name>/ 的目录名一致.
  -- disabled=1: 拓展目录已删除但 DB 行保留 (因为用户在该项目下可能有 issues/sessions, 不能丢).
  kind TEXT NOT NULL DEFAULT 'normal' CHECK(kind IN ('normal','extension')),
  extension_name TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  -- extension_default_hidden=1: 由 extension.json 的 project.default_hidden 控制, 默认从项目列表隐藏.
  extension_default_hidden INTEGER NOT NULL DEFAULT 0,
  -- 项目级默认模型偏好: 新建 Session 时模型下拉的初始值. NULL = 未指定 (跟随系统全局默认).
  -- 存的是 model-registry 暴露的短键 (opus / codex / 管理员导入模型的 key), 与 sessions_v2.model 的 id 不同.
  default_model TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- 拓展项目 extension_name 唯一索引由 db.js 的 migrateProjectsExtensionColumns 创建,
-- 不放在这里 -- 存量库走 ALTER 加列时列尚未存在, 这里建 partial index 会崩.

-- 每个用户自己的项目星标, 用于项目列表排序与高亮。
CREATE TABLE IF NOT EXISTS project_user_stars (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_user_stars_user ON project_user_stars(user_id);

-- 每个用户在某个 issue 上的星标, 用于 issue 列表排序与高亮 (区别于 issues.pinned 的项目级全局置顶)。
CREATE TABLE IF NOT EXISTS issue_user_stars (
  issue_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (issue_id, user_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_issue_user_stars_user ON issue_user_stars(user_id);

-- 每个项目下、每个用户自己的用户级 Skill/Memory 与内置 Skill 白名单。
-- NULL 表示该类白名单不存在, 创建 Session 时沿用原行为展示全部用户级条目;
-- JSON 数组表示该类白名单已启用, 空数组则表示不展示任何用户级条目。
CREATE TABLE IF NOT EXISTS project_user_context_whitelists (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  skill_ids TEXT,
  builtin_skill_ids TEXT,
  memory_ids TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 每用户的"拓展项目隐藏"标记: 拓展卡片是全局共享的, 这张表让单个用户把不想看到的
-- 拓展从自己的项目页隐藏起来 (不影响别人). 管理员面板可撤销隐藏.
CREATE TABLE IF NOT EXISTS project_user_hidden (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  hidden_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_user_hidden_user ON project_user_hidden(user_id);

-- 项目待办: 项目级轻量 checklist, 独立于 Issue/Research/Session 执行链路。
CREATE TABLE IF NOT EXISTS project_todos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_project_todos_project_order
ON project_todos(project_id, completed, sort_order, created_at);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_active TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  message_count INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  selected_skills TEXT NOT NULL DEFAULT '[]',
  excluded_skills TEXT NOT NULL DEFAULT '[]',
  use_worktree INTEGER NOT NULL DEFAULT 1,
  worktree_branch TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'inherit' CHECK(visibility IN ('inherit','private','team','public','allowlist')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- ===== 资源访问控制 =====
-- resource_policies 覆盖文件系统资源或子资源默认可见性:
--   - project 可见性主字段在 projects.visibility, 本表主要给 skill/memory 使用;
--   - user 级 skill/memory 默认 private, project 级 skill/memory 默认 inherit;
--   - issue/research/session 预留给后续单条覆盖.
CREATE TABLE IF NOT EXISTS resource_policies (
  resource_type TEXT NOT NULL CHECK(resource_type IN ('project','issue','research','session','skill','memory')),
  resource_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('inherit','private','team','public','allowlist')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (resource_type, resource_id)
);

CREATE TABLE IF NOT EXISTS resource_acl_entries (
  resource_type TEXT NOT NULL CHECK(resource_type IN ('project','issue','research','session','skill','memory')),
  resource_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('user','group')),
  subject_id TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('allow')),
  capabilities TEXT NOT NULL DEFAULT '["read"]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (resource_type, resource_id, subject_type, subject_id, effect)
);
CREATE INDEX IF NOT EXISTS idx_resource_acl_subject ON resource_acl_entries(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS user_resource_hides (
  user_id TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('project','issue','research','session','skill','memory')),
  resource_id TEXT NOT NULL,
  hidden_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, resource_type, resource_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_resource_hides_resource ON user_resource_hides(resource_type, resource_id);

-- 用户隔离策略 v3: 项目列表偏好、屏蔽项目、管理员跨用户访问审计。
CREATE TABLE IF NOT EXISTS user_view_prefs (
  user_id TEXT PRIMARY KEY,
  hide_others_projects INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_muted_projects (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  muted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_muted_user ON user_muted_projects(user_id, muted_at DESC);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

-- ===== v1 会话 / 消息 (历史栈; 新机为空, 但 db-check / 部分读路径仍引用, 须存在) =====
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  session_key TEXT NOT NULL UNIQUE,
  claude_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),
  agent_status TEXT NOT NULL DEFAULT 'idle' CHECK(agent_status IN ('idle','running','stale','completed','failed','waiting')),
  risk_level TEXT NOT NULL DEFAULT 'medium',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_active TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_agent_event TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  original_issue_id TEXT,
  original_project_id TEXT,
  deleted_at TEXT,
  completed_at TEXT,
  context_snapshot_body TEXT,
  context_snapshot_sources TEXT,
  context_snapshot_at TEXT,
  session_excluded_skills TEXT,
  session_excluded_memories TEXT,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system','thinking')),
  content TEXT NOT NULL,
  tool_name TEXT,
  tool_summary TEXT,
  metadata TEXT,
  turn_number INTEGER,
  turn_summary TEXT,
  bookmarked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (task_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

-- messages 全文检索 (FTS5 外部内容表; 影子表 messages_fts_{data,idx,docsize,config} 由引擎自建)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(task_id, role, content, content=messages, content_rowid=id);

-- ===== 技能 (DB 表; v1.7 起正文走 protected_data/ 文件树, 此表现网 0 行, 仍保留以防引用) =====
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('user','project')),
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, owner_id, name)
);

-- ===== 集成 / 变更 / 冲突 (issue 集成流水线) =====
CREATE TABLE IF NOT EXISTS integration_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS issue_integrations (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'collecting' CHECK(status IN ('collecting','checking','ready','integrated','blocked','released')),
  internal_conflict_count INTEGER NOT NULL DEFAULT 0,
  external_conflict_count INTEGER NOT NULL DEFAULT 0,
  build_status TEXT NOT NULL DEFAULT 'pending' CHECK(build_status IN ('pending','running','passed','failed')),
  acceptance_status TEXT NOT NULL DEFAULT 'pending' CHECK(acceptance_status IN ('pending','passed','failed')),
  release_note TEXT DEFAULT '',
  integrated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_integration_queue (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','blocked','integrating','integrated','skipped')),
  reason TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  UNIQUE(project_id, issue_id)
);

CREATE TABLE IF NOT EXISTS session_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  issue_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  base_revision TEXT,
  worktree_path TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','checking','ready','conflict','integrated','abandoned')),
  summary TEXT DEFAULT '',
  check_status TEXT NOT NULL DEFAULT 'pending' CHECK(check_status IN ('pending','running','passed','failed')),
  check_detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_change_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  change_type TEXT NOT NULL DEFAULT 'modified' CHECK(change_type IN ('modified','added','deleted','renamed')),
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  symbols TEXT DEFAULT '[]',
  risk_level TEXT NOT NULL DEFAULT 'medium' CHECK(risk_level IN ('low','medium','high','config','schema')),
  FOREIGN KEY (change_id) REFERENCES session_changes(id) ON DELETE CASCADE,
  UNIQUE(change_id, file_path)
);

CREATE TABLE IF NOT EXISTS session_conflicts (
  id TEXT PRIMARY KEY,
  left_change_id TEXT NOT NULL,
  right_change_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  conflict_type TEXT NOT NULL DEFAULT 'same_file' CHECK(conflict_type IN ('same_file','same_region','same_symbol','schema','config','build')),
  severity TEXT NOT NULL DEFAULT 'warn' CHECK(severity IN ('info','warn','blocking')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','ignored')),
  detail TEXT DEFAULT '',
  resolution_note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT,
  FOREIGN KEY (left_change_id) REFERENCES session_changes(id) ON DELETE CASCADE,
  FOREIGN KEY (right_change_id) REFERENCES session_changes(id) ON DELETE CASCADE
);

-- ===== 索引 =====
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_issue ON sessions(issue_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id);
CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(task_id, turn_number);
CREATE INDEX IF NOT EXISTS idx_skills_owner ON skills(scope, owner_id);
CREATE INDEX IF NOT EXISTS idx_issue_integrations_project ON issue_integrations(project_id);
CREATE INDEX IF NOT EXISTS idx_project_queue_project ON project_integration_queue(project_id);
CREATE INDEX IF NOT EXISTS idx_session_changes_issue ON session_changes(issue_id);
CREATE INDEX IF NOT EXISTS idx_session_changes_project ON session_changes(project_id);
CREATE INDEX IF NOT EXISTS idx_session_changes_session ON session_changes(session_id);
CREATE INDEX IF NOT EXISTS idx_change_files_path ON session_change_files(file_path);
CREATE INDEX IF NOT EXISTS idx_conflicts_left ON session_conflicts(left_change_id);
CREATE INDEX IF NOT EXISTS idx_conflicts_right ON session_conflicts(right_change_id);

-- ===== messages_fts 同步触发器 =====
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, task_id, role, content)
  VALUES (new.id, new.task_id, new.role, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, task_id, role, content)
  VALUES('delete', old.id, old.task_id, old.role, old.content);
END;
