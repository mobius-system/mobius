/**
 * db.ts — DB 层 (现在是主栈, 不再"实验").
 *
 * 主 SQLite 在 <repo-root>/data/mobius.db (v1.9 起从旧 gateway/data/ 提升到根).
 * 共享 users / projects / issues 与 sessions_v2 / messages_v2 并存.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {
  DB_PATH,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE,
} from './backend/config';

console.log(`[mobius/db] using shared SQLite at: ${DB_PATH}`);

// 容器/新机首次启动时 DB_PATH 的父目录(如 /data)可能尚未创建,
// better-sqlite3 不会自动建目录, 否则报 "Cannot open database because the directory does not exist"。
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db: Database.Database = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ===== 共享表 bootstrap (transfer.md 阻塞 #1) =====
// 空库(新机/容器)自建 users/projects/issues/sessions/messages/skills 等"共享表";
// 全部 IF NOT EXISTS, 对存量库是 no-op。必须在 researches/迁移函数之前执行
// (那些迁移会 ALTER issues/projects, 前提是表已存在)。
(function bootstrapSharedSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
  console.log('[mobius/db] ✅ schema.sql bootstrap 完成 (共享表已就位)');
})();

// ===== 共享 users 表轻量迁移: 员工账号软删除 =====
// 历史项目 / Session / 消息都引用 users.id, 直接硬删会破坏外键和审计链路。
// deleted_at 非空表示账号不可登录, 管理员列表默认不显示, 历史数据仍保留。
function migrateUsersDeletedAt() {
  try {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c: any) => c.name);
    if (!cols.includes('deleted_at')) {
      db.exec('ALTER TABLE users ADD COLUMN deleted_at TEXT');
      console.log('[mobius/db] migrate: users.deleted_at 已加 (NULL=启用, 非空=已删除)');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at)');
  } catch (e) {
    console.warn('[mobius/db] ⚠️  users deleted_at 迁移失败:', e.message);
  }
}
migrateUsersDeletedAt();

// ===== 用户群组轻量迁移 =====
// 第一版群组只作为员工组织分类, 不参与权限判定。存量用户统一挂到"默认组"。
function migrateUserGroups() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      INSERT OR IGNORE INTO user_groups (id, name, description)
      VALUES ('default', '默认组', '未指定群组的员工默认归属');
    `);
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c: any) => c.name);
    if (!cols.includes('group_id')) {
      db.exec(`ALTER TABLE users ADD COLUMN group_id TEXT DEFAULT 'default'`);
      console.log('[mobius/db] migrate: users.group_id 已加 (默认组)');
    }
    db.exec(`
      UPDATE users
      SET group_id = 'default'
      WHERE group_id IS NULL OR group_id = '';
      CREATE INDEX IF NOT EXISTS idx_users_group_id ON users(group_id);
    `);
  } catch (e) {
    console.warn('[mobius/db] ⚠️  user_groups 迁移失败:', e.message);
  }
}
migrateUserGroups();

// ===== researches: 与 issues 并列的项目级研究对象 =====
db.exec(`
  CREATE TABLE IF NOT EXISTS researches (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_active TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    message_count INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'inherit' CHECK(visibility IN ('inherit','private','team','public','allowlist')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
`);

// ===== 资源访问控制 =====
// 老项目迁移成 public, 新建项目由 POST /api/projects 显式写入默认 private.
function migrateResourceAccessControl() {
  try {
    const projectCols = db.prepare('PRAGMA table_info(projects)').all().map((c: any) => c.name);
    if (!projectCols.includes('visibility')) {
      db.exec("ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
      console.log("[mobius/db] migrate: projects.visibility 已加 (存量默认 public)");
    }
    const issueCols = db.prepare('PRAGMA table_info(issues)').all().map((c: any) => c.name);
    if (!issueCols.includes('visibility')) {
      db.exec("ALTER TABLE issues ADD COLUMN visibility TEXT NOT NULL DEFAULT 'inherit'");
      console.log("[mobius/db] migrate: issues.visibility 已加 (默认继承项目)");
    }
    const researchCols = db.prepare('PRAGMA table_info(researches)').all().map((c: any) => c.name);
    if (!researchCols.includes('visibility')) {
      db.exec("ALTER TABLE researches ADD COLUMN visibility TEXT NOT NULL DEFAULT 'inherit'");
      console.log("[mobius/db] migrate: researches.visibility 已加 (默认继承项目)");
    }
    db.exec(`
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
    `);
  } catch (e) {
    console.warn('[mobius/db] ⚠️  resource access control 迁移失败:', e.message);
  }
}
migrateResourceAccessControl();

// ===== 用户隔离策略 v3: 写权限开关 / 视图偏好 / 屏蔽名单 / admin 审计 =====
function migrateUserIsolationV3Schema() {
  try {
    const projectCols = db.prepare('PRAGMA table_info(projects)').all().map((c: any) => c.name);
    if (!projectCols.includes('can_post_issue')) {
      db.exec('ALTER TABLE projects ADD COLUMN can_post_issue INTEGER NOT NULL DEFAULT 0');
      console.log('[mobius/db] migrate: projects.can_post_issue 已加 (默认关闭)');
    }
    if (!projectCols.includes('can_run_session')) {
      db.exec('ALTER TABLE projects ADD COLUMN can_run_session INTEGER NOT NULL DEFAULT 0');
      console.log('[mobius/db] migrate: projects.can_run_session 已加 (默认关闭)');
    }
    db.exec(`
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
    `);
  } catch (e) {
    console.warn('[mobius/db] ⚠️  user isolation v3 迁移失败:', e.message);
  }
}
migrateUserIsolationV3Schema();

// ===== sessions_v2: 实验栈专属会话表 =====
// 字段语义跟生产 sessions 表一致, 缺一些用不到的列(integration / risk_level), 加一些 v2 特性列.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions_v2 (
    session_id TEXT PRIMARY KEY,
    issue_id TEXT,
    project_id TEXT,
    scope_type TEXT NOT NULL DEFAULT 'issue' CHECK(scope_type IN ('issue','research')),
    research_id TEXT,
    research_role TEXT CHECK(research_role IS NULL OR research_role IN ('chief_researcher','research_assistant')),
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    session_key TEXT NOT NULL UNIQUE,
    -- Agent SDK 自己管的 session id (--resume 用)
    claude_session_id TEXT,
    -- per-session model: 新建 Session 时由前端选 (opus/sonnet/codex), 缺省回退 config.DEFAULT_MODEL_KEY
    model TEXT DEFAULT 'gpt-5.5',
    -- DEPRECATED: per-session 代理偏好已下线, 改由管理员在面板按 backend 全局配
    -- (data/admin-settings.json, 见 services/admin-settings.js). 列保留避免 migration 风险,
    -- 新行落 DB default=1, 后端 _spawnWindow 不再读它.
    use_proxy INTEGER NOT NULL DEFAULT 1 CHECK(use_proxy IN (0,1)),
    -- per-session 注入上下文语言: 新建 Session 时由前端选 (zh/en), 缺省中文
    language TEXT NOT NULL DEFAULT 'zh' CHECK(language IN ('zh','en')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','archived')),
    agent_status TEXT NOT NULL DEFAULT 'idle' CHECK(agent_status IN ('idle','running','stale','completed','failed','waiting')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_active TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_agent_event TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    turn_count INTEGER NOT NULL DEFAULT 0,
    -- 上下文快照, 与生产 sessions 表对齐
    context_snapshot_body TEXT,
    context_snapshot_sources TEXT,
    context_snapshot_at TEXT,
    -- Session 创建时用户确认启用的 Skill / Memory 快照.
    -- 这份快照用于创建后的只读展示, 也用于首轮注入, 避免全局 Skill/Memory 后续变化影响本 Session.
    session_selection_snapshot TEXT,
    session_selection_snapshot_at TEXT,
    session_excluded_skills TEXT,
    session_excluded_memories TEXT,
    -- 累计成本(SDK 提供, 生产栈拿不到)
    total_cost_usd REAL NOT NULL DEFAULT 0,
    -- 历史软删追踪字段: 回收站机制已下线, 新删除不再写这些列.
    original_issue_id TEXT,
    original_project_id TEXT,
    deleted_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
    FOREIGN KEY (research_id) REFERENCES researches(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ===== messages_v2 =====
// 跟生产 messages 表结构对齐, 但是单独一张
db.exec(`
  CREATE TABLE IF NOT EXISTS messages_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system','thinking','raw')),
    content TEXT NOT NULL,
    -- Claude SDK 事件原文 (JSON), 仅 role='raw' 时使用
    raw_event TEXT,
    -- tool 调用相关
    tool_summary TEXT,
    tool_status TEXT,
    tool_exit_code INTEGER,
    -- 轮次
    turn_number INTEGER,
    turn_summary TEXT,
    -- 收藏
    bookmarked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

// ===== agent_prompt_events =====
// 管理员面板统计用: 每次真正 paste 到 tmux TUI 并提交成功后记录一行.
// 不保存 prompt 内容, 只保存 backend/session/长度, 避免把对话正文复制到审计表.
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_prompt_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    backend_name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    content_length INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);

// 索引
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_v2_task ON messages_v2(task_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_v2_issue ON sessions_v2(issue_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_v2_user ON sessions_v2(user_id);
  CREATE INDEX IF NOT EXISTS idx_researches_project ON researches(project_id);
  CREATE INDEX IF NOT EXISTS idx_agent_prompt_events_created ON agent_prompt_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_prompt_events_session_created ON agent_prompt_events(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_agent_prompt_events_backend_created ON agent_prompt_events(backend_name, created_at);
`);

// 自检: 生产栈表存在(只读), 不动它们.
// 注意: skills/memories 在 v1.7 起改为文件系统存储 (protected_data/), 不再是 SQLite 表, 故不查.
function verifySharedTables() {
  const want = ['users', 'projects', 'issues', 'researches', 'sessions', 'messages'];
  const got = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
  const missing = want.filter(t => !got.includes(t));
  if (missing.length) {
    console.warn(`[mobius/db] ⚠️  生产表缺失(可能影响共享读): ${missing.join(',')}`);
  } else {
    console.log(`[mobius/db] ✅ 共享表全部就位 (${want.join(',')})`);
  }
  console.log(`[mobius/db] ✅ sessions_v2 / messages_v2 已建`);
  console.log(`[mobius/db]    skills/memories 走 protected_data/ 文件系统, 与 DB 无关`);
}
verifySharedTables();

function ensureSessionResearchIndexes() {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_v2_research ON sessions_v2(research_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_v2_one_chief_per_research
      ON sessions_v2(research_id)
      WHERE research_id IS NOT NULL AND research_role = 'chief_researcher';
  `);
}

// ===== sessions_v2 轻量迁移: 每个 Session 是否使用 proxychains =====
// 存量 session 默认 1, 保持此前 Claude Code 默认走 proxychains 的行为; 新建
// Session 会由前端/路由按模型默认值显式写入。
function migrateSessionsUseProxy() {
  try {
    const cols = db.prepare('PRAGMA table_info(sessions_v2)').all().map((c: any) => c.name);
    if (!cols.includes('use_proxy')) {
      db.exec('ALTER TABLE sessions_v2 ADD COLUMN use_proxy INTEGER NOT NULL DEFAULT 1');
      console.log('[mobius/db] migrate: sessions_v2.use_proxy 已加 (默认 1, 存量保持代理行为)');
    }
  } catch (e) {
    console.warn('[mobius/db] ⚠️  sessions use_proxy 迁移失败:', e.message);
  }
}
migrateSessionsUseProxy();

// ===== sessions_v2 轻量迁移: Session 创建时的 Skill / Memory 选择快照 =====
// 旧字段 session_excluded_* 只能表达 "排除了哪些 id", 不能抵抗后续全局
// Skill/Memory 改名、删除或内容变化. 新字段保存创建时最终启用的条目快照.
function migrateSessionsSelectionSnapshot() {
  try {
    const cols = db.prepare('PRAGMA table_info(sessions_v2)').all().map((c: any) => c.name);
    if (!cols.includes('session_selection_snapshot')) {
      db.exec('ALTER TABLE sessions_v2 ADD COLUMN session_selection_snapshot TEXT');
      console.log('[mobius/db] migrate: sessions_v2.session_selection_snapshot 已加');
    }
    if (!cols.includes('session_selection_snapshot_at')) {
      db.exec('ALTER TABLE sessions_v2 ADD COLUMN session_selection_snapshot_at TEXT');
      console.log('[mobius/db] migrate: sessions_v2.session_selection_snapshot_at 已加');
    }
  } catch (e) {
    console.warn('[mobius/db] ⚠️  sessions selection snapshot 迁移失败:', e.message);
  }
}
migrateSessionsSelectionSnapshot();

// ===== sessions_v2 清理: 回收站机制下线, 历史 deleted Session 不再保留 =====
function purgeDeletedSessionsTrashData() {
  try {
    const cols = db.prepare('PRAGMA table_info(sessions_v2)').all().map((c: any) => c.name);
    if (!cols.includes('status')) return;
    const count = (db.prepare("SELECT COUNT(*) AS c FROM sessions_v2 WHERE status = 'deleted'").get() as any).c;
    if (!count) return;
    const tx = db.transaction(() => {
      db.prepare(`
        DELETE FROM messages_v2
        WHERE task_id IN (SELECT session_id FROM sessions_v2 WHERE status = 'deleted')
      `).run();
      db.prepare("DELETE FROM sessions_v2 WHERE status = 'deleted'").run();
    });
    tx();
    console.log(`[mobius/db] migrate: 已清理 ${count} 条历史回收站 Session (status=deleted)`);
  } catch (e) {
    console.warn('[mobius/db] ⚠️  历史回收站 Session 清理失败:', e.message);
  }
}
purgeDeletedSessionsTrashData();

// ===== sessions_v2 结构迁移: 支持 issue / research 双归属 =====
// 旧表把 issue_id / project_id 做成 NOT NULL, 且 session 只能挂在 issue 下.
// research agent 需要 issue_id=NULL + research_id/role, SQLite 无法 ALTER
// 删除 NOT NULL 约束, 因此这里做一次幂等表重建并保留所有既有列数据.
function migrateSessionsResearchScope() {
  try {
    const info = db.prepare('PRAGMA table_info(sessions_v2)').all() as any[];
    const cols = info.map((c: any) => c.name);
    const issueCol = info.find((c) => c.name === 'issue_id');
    const projectCol = info.find((c) => c.name === 'project_id');
    const needsRebuild =
      !cols.includes('scope_type') ||
      !cols.includes('research_id') ||
      !cols.includes('research_role') ||
      (issueCol && issueCol.notnull) ||
      (projectCol && projectCol.notnull);

    if (!needsRebuild) {
      ensureSessionResearchIndexes();
      return;
    }

    const has = (name: string) => cols.includes(name);
    const expr = (name: string, fallback: string) => has(name) ? name : fallback;
    const targetCols = [
      'session_id', 'issue_id', 'project_id', 'scope_type', 'research_id', 'research_role',
      'user_id', 'name', 'description', 'session_key', 'claude_session_id',
      'model', 'use_proxy', 'status', 'agent_status', 'created_at', 'last_active',
      'last_agent_event', 'message_count', 'turn_count',
      'context_snapshot_body', 'context_snapshot_sources', 'context_snapshot_at',
      'session_selection_snapshot', 'session_selection_snapshot_at',
      'session_excluded_skills', 'session_excluded_memories',
      'total_cost_usd', 'original_issue_id', 'original_project_id',
      'deleted_at', 'completed_at',
    ];
    const selectExprs = [
      expr('session_id', 'NULL'),
      expr('issue_id', 'NULL'),
      expr('project_id', 'NULL'),
      expr('scope_type', "'issue'"),
      expr('research_id', 'NULL'),
      expr('research_role', 'NULL'),
      expr('user_id', 'NULL'),
      expr('name', "''"),
      expr('description', "''"),
      expr('session_key', 'session_id'),
      expr('claude_session_id', 'NULL'),
      expr('model', "'gpt-5.5'"),
      expr('use_proxy', '1'),
      expr('status', "'active'"),
      expr('agent_status', "'idle'"),
      expr('created_at', "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
      expr('last_active', "strftime('%Y-%m-%dT%H:%M:%fZ','now')"),
      expr('last_agent_event', 'NULL'),
      expr('message_count', '0'),
      expr('turn_count', '0'),
      expr('context_snapshot_body', 'NULL'),
      expr('context_snapshot_sources', 'NULL'),
      expr('context_snapshot_at', 'NULL'),
      expr('session_selection_snapshot', 'NULL'),
      expr('session_selection_snapshot_at', 'NULL'),
      expr('session_excluded_skills', 'NULL'),
      expr('session_excluded_memories', 'NULL'),
      expr('total_cost_usd', '0'),
      expr('original_issue_id', 'NULL'),
      expr('original_project_id', 'NULL'),
      expr('deleted_at', 'NULL'),
      expr('completed_at', 'NULL'),
    ];

    db.pragma('foreign_keys = OFF');
    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE sessions_v2_new (
          session_id TEXT PRIMARY KEY,
          issue_id TEXT,
          project_id TEXT,
          scope_type TEXT NOT NULL DEFAULT 'issue' CHECK(scope_type IN ('issue','research')),
          research_id TEXT,
          research_role TEXT CHECK(research_role IS NULL OR research_role IN ('chief_researcher','research_assistant')),
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          session_key TEXT NOT NULL UNIQUE,
          claude_session_id TEXT,
          model TEXT DEFAULT 'gpt-5.5',
          -- DEPRECATED, 见上方 schema 同名列的注释.
          use_proxy INTEGER NOT NULL DEFAULT 1 CHECK(use_proxy IN (0,1)),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','archived')),
          agent_status TEXT NOT NULL DEFAULT 'idle' CHECK(agent_status IN ('idle','running','stale','completed','failed','waiting')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          last_active TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          last_agent_event TEXT,
          message_count INTEGER NOT NULL DEFAULT 0,
          turn_count INTEGER NOT NULL DEFAULT 0,
          context_snapshot_body TEXT,
          context_snapshot_sources TEXT,
          context_snapshot_at TEXT,
          session_selection_snapshot TEXT,
          session_selection_snapshot_at TEXT,
          session_excluded_skills TEXT,
          session_excluded_memories TEXT,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          original_issue_id TEXT,
          original_project_id TEXT,
          deleted_at TEXT,
          completed_at TEXT,
          FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
          FOREIGN KEY (research_id) REFERENCES researches(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `);
      db.prepare(`
        INSERT INTO sessions_v2_new (${targetCols.join(', ')})
        SELECT ${selectExprs.join(', ')}
        FROM sessions_v2
      `).run();
      db.exec('DROP TABLE sessions_v2;');
      db.exec('ALTER TABLE sessions_v2_new RENAME TO sessions_v2;');
    });
    tx();
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_v2_task ON messages_v2(task_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_v2_issue ON sessions_v2(issue_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_v2_user ON sessions_v2(user_id);
    `);
    ensureSessionResearchIndexes();
    console.log('[mobius/db] migrate: sessions_v2 已迁移为 issue/research 双归属结构');
  } catch (e) {
    try { db.pragma('foreign_keys = ON'); } catch {}
    console.warn('[mobius/db] ⚠️  sessions research scope 迁移失败:', e.message);
  }
}
migrateSessionsResearchScope();

// ===== sessions_v2 结构迁移: 扩展 agent_status 枚举值 =====
// 旧表 agent_status CHECK 只允许 ('idle','running','stale'). 现新增 'completed' /
// 'failed' / 'waiting' (由 backend/services/agent-status-syncer.ts 写入), 需放宽 CHECK.
// SQLite 无法 ALTER 修改 CHECK, 这里做一次幂等表重建, 复用 migrateSessionsResearchScope
// 的重建模式: 列结构不变, 仅放宽 agent_status CHECK.
function migrateSessionsV2AgentStatusEnum() {
  try {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions_v2'"
    ).get() as { sql?: string } | undefined;
    const ddl = row?.sql || '';
    if (!ddl) return; // 表尚未建 (db.ts bootstrap 会建), 跳过
    if (ddl.includes("'completed'") && ddl.includes("'failed'") && ddl.includes("'waiting'")) {
      return; // 已迁移过
    }

    // 列结构不变: 用 PRAGMA 动态拿列名做全列复制 (新表包含旧表所有列)
    const info = db.prepare('PRAGMA table_info(sessions_v2)').all() as any[];
    const colList = info.map((c: any) => c.name).join(', ');

    db.pragma('foreign_keys = OFF');
    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE sessions_v2_new (
          session_id TEXT PRIMARY KEY,
          issue_id TEXT,
          project_id TEXT,
          scope_type TEXT NOT NULL DEFAULT 'issue' CHECK(scope_type IN ('issue','research')),
          research_id TEXT,
          research_role TEXT CHECK(research_role IS NULL OR research_role IN ('chief_researcher','research_assistant')),
          user_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          session_key TEXT NOT NULL UNIQUE,
          claude_session_id TEXT,
          model TEXT DEFAULT 'gpt-5.5',
          use_proxy INTEGER NOT NULL DEFAULT 1 CHECK(use_proxy IN (0,1)),
          language TEXT NOT NULL DEFAULT 'zh' CHECK(language IN ('zh','en')),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','archived')),
          agent_status TEXT NOT NULL DEFAULT 'idle' CHECK(agent_status IN ('idle','running','stale','completed','failed','waiting')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          last_active TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          last_agent_event TEXT,
          message_count INTEGER NOT NULL DEFAULT 0,
          turn_count INTEGER NOT NULL DEFAULT 0,
          context_snapshot_body TEXT,
          context_snapshot_sources TEXT,
          context_snapshot_at TEXT,
          session_selection_snapshot TEXT,
          session_selection_snapshot_at TEXT,
          session_excluded_skills TEXT,
          session_excluded_memories TEXT,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          original_issue_id TEXT,
          original_project_id TEXT,
          deleted_at TEXT,
          completed_at TEXT,
          FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
          FOREIGN KEY (research_id) REFERENCES researches(id) ON DELETE CASCADE,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `);
      db.prepare(`INSERT INTO sessions_v2_new (${colList}) SELECT ${colList} FROM sessions_v2`).run();
      db.exec('DROP TABLE sessions_v2;');
      db.exec('ALTER TABLE sessions_v2_new RENAME TO sessions_v2;');
    });
    tx();
    db.pragma('foreign_keys = ON');
    // DROP TABLE 会连带删除索引, 重建
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_v2_issue ON sessions_v2(issue_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_v2_user ON sessions_v2(user_id);
    `);
    ensureSessionResearchIndexes();
    console.log('[mobius/db] migrate: sessions_v2 agent_status 枚举已扩展 (idle/running/stale/completed/failed/waiting)');
  } catch (e) {
    try { db.pragma('foreign_keys = ON'); } catch {}
    console.warn('[mobius/db] ⚠️  sessions_v2 agent_status 枚举迁移失败:', e.message);
  }
}
migrateSessionsV2AgentStatusEnum();

// ===== sessions_v2 轻量迁移: 每个 Session 的注入上下文语言 =====
// 存量 session 默认 'zh', 保持此前中文注入行为; 新建 Session 由前端/路由显式写入。
function migrateSessionsLanguage() {
  try {
    const cols = db.prepare('PRAGMA table_info(sessions_v2)').all().map((c: any) => c.name);
    if (!cols.includes('language')) {
      db.exec("ALTER TABLE sessions_v2 ADD COLUMN language TEXT NOT NULL DEFAULT 'zh'");
      console.log("[mobius/db] migrate: sessions_v2.language 已加 (默认 'zh', 存量保持中文注入)");
    }
  } catch (e) {
    console.warn('[mobius/db] ⚠️  sessions language 迁移失败:', e.message);
  }
}
migrateSessionsLanguage();

// ===== 共享 issues 表轻量迁移: git worktree 支持 =====
// v1 已退役, v2 是唯一栈, issues 表本就被 v2 读写 (insert/updateStatus/...),
// 这里幂等补两列. 缺列才 ALTER, 不重复.
function migrateIssuesWorktree() {
  try {
    const cols = db.prepare('PRAGMA table_info(issues)').all().map((c: any) => c.name);
    if (!cols.includes('use_worktree')) {
      // 列默认 0: 存量 issue 保持原行为 (不动其 session cwd, 不注入 worktree 提示).
      // "新建 Issue 默认开 worktree" 由应用层保证 (前端勾选默认 true + POST 缺省 true).
      db.exec('ALTER TABLE issues ADD COLUMN use_worktree INTEGER NOT NULL DEFAULT 0');
      console.log('[mobius/db] migrate: issues.use_worktree 已加 (存量=0, 新建由应用层默认开)');
    }
    if (!cols.includes('worktree_branch')) {
      db.exec("ALTER TABLE issues ADD COLUMN worktree_branch TEXT NOT NULL DEFAULT ''");
      console.log('[mobius/db] migrate: issues.worktree_branch 已加');
    }
    // 规范化兜底: use_worktree=1 但分支为空 = 非法状态, 只可能来自旧的
    // "ADD COLUMN DEFAULT 1" 把存量行一刀切成 1. 合法的 worktree issue 必有分支
    // (POST 总会写 branch). 故把这类行回正为 0, 保护存量 issue/session 原行为. 幂等.
    const fixed = db.prepare(
      "UPDATE issues SET use_worktree = 0 WHERE use_worktree = 1 AND (worktree_branch IS NULL OR trim(worktree_branch) = '')"
    ).run();
    if (fixed.changes > 0) {
      console.log(`[mobius/db] migrate: 规范化 ${fixed.changes} 条存量 issue use_worktree → 0`);
    }
  } catch (e) {
    console.warn('[mobius/db] ⚠️  issues worktree 迁移失败:', e.message);
  }
}
migrateIssuesWorktree();

// ===== 共享 issues 表轻量迁移: 系统宏观规划模式 =====
// is_planning=1 表示这是一个"规划 Issue", 创建时自动绑定一个预配置规划 Session,
// 仅启用 mobius-planner SKILL + 全量 Memory, 前端隐藏执行控件改为 Markdown 编辑器.
// 缺列才 ALTER, 幂等.
function migrateIssuesIsPlanning() {
  try {
    const cols = db.prepare('PRAGMA table_info(issues)').all().map((c: any) => c.name);
    if (!cols.includes('is_planning')) {
      db.exec('ALTER TABLE issues ADD COLUMN is_planning INTEGER NOT NULL DEFAULT 0');
      console.log('[mobius/db] migrate: issues.is_planning 已加 (默认 0, 存量=普通 Issue)');
    }
  } catch (e) {
    console.warn('[mobius/db] ⚠️  issues is_planning 迁移失败:', e.message);
  }
}
migrateIssuesIsPlanning();

// ===== 共享 projects 表轻量迁移: 项目级 "默认是否使用 git worktree" 开关 =====
// 新建 Issue 时, worktree 勾选框的默认勾选状态取自所属项目的该字段.
// 缺列才 ALTER, 幂等.
function migrateProjectsDefaultWorktree() {
  try {
    const cols = db.prepare('PRAGMA table_info(projects)').all().map((c: any) => c.name);
    if (!cols.includes('default_use_worktree')) {
      // 默认 1: 保持存量行为 —— 旧前端新建 Issue 时 worktree 勾选框 useState(true) 默认打钩,
      // 故存量项目沿用 "默认勾选". 项目创建/设置页可改成 0 (默认不勾选).
      db.exec('ALTER TABLE projects ADD COLUMN default_use_worktree INTEGER NOT NULL DEFAULT 1');
      console.log('[mobius/db] migrate: projects.default_use_worktree 已加 (默认 1, 保持存量行为)');
    }
  } catch (e) {
    console.warn('[mobius/db] ⚠️  projects default_use_worktree 迁移失败:', e.message);
  }
}
migrateProjectsDefaultWorktree();

// ===== 共享 projects 表轻量迁移: Research 系统开关 =====
// 默认关闭. 只有开启后项目页才展示 Research 入口, 后端也拒绝创建 research.
function migrateProjectsResearchEnabled() {
  try {
    const cols = db.prepare('PRAGMA table_info(projects)').all().map((c: any) => c.name);
    if (!cols.includes('research_enabled')) {
      db.exec('ALTER TABLE projects ADD COLUMN research_enabled INTEGER NOT NULL DEFAULT 0');
      console.log('[mobius/db] migrate: projects.research_enabled 已加 (默认关闭)');
    }
  } catch (e) {
    console.warn('[mobius/db] ⚠️  projects research_enabled 迁移失败:', e.message);
  }
}
migrateProjectsResearchEnabled();

// ===== 共享 projects 表数据规范化: Research 启用时强制禁用 worktree =====
// 业务规则: 项目启用 Research 系统时, default_use_worktree 必须为 0. 修正存量脏数据.
// (routes/projects.js 在 POST/PATCH 已强制写入, 这里覆盖迁移之前的历史行.)
function normalizeProjectsResearchWorktreeRule() {
  try {
    const res = db.prepare(
      'UPDATE projects SET default_use_worktree = 0 WHERE research_enabled = 1 AND default_use_worktree = 1'
    ).run();
    if (res.changes > 0) {
      console.log(`[mobius/db] normalize: ${res.changes} project(s) research_enabled=1 → default_use_worktree=0`);
    }
  } catch (e) {
    console.warn('[mobius/db] ⚠️  projects research↔worktree 规范化失败:', e.message);
  }
}
normalizeProjectsResearchWorktreeRule();

// ===== 共享 projects 表轻量迁移: 每项目可配置的 "被遗忘 running.flag 提醒消息" =====
// forgotten-flag-scanner 检测到 "agent 停工但 running.flag 未删" 时, 自动给该
// session 发这条消息. NULL/空 → 用 scanner 内置默认文案. 缺列才 ALTER, 幂等.
function migrateProjectsForgottenFlagMessage() {
  try {
    const cols = db.prepare('PRAGMA table_info(projects)').all().map((c: any) => c.name);
    if (!cols.includes('forgotten_flag_message')) {
      db.exec('ALTER TABLE projects ADD COLUMN forgotten_flag_message TEXT');
      console.log('[mobius/db] migrate: projects.forgotten_flag_message 已加 (NULL=用默认文案)');
    }
  } catch (e) {
    console.warn('[mobius/db] ⚠️  projects forgotten_flag_message 迁移失败:', e.message);
  }
}
migrateProjectsForgottenFlagMessage();

// ===== 共享 projects 表轻量迁移: running.flag 提醒策略 =====
// 同一 flag 实例按 session 归属区分: init 决定首次提醒等待, backoff 决定后续
// 等待倍数, patience 决定最多提醒次数. 旧 interval 列保留为 init 的兼容别名.
function migrateProjectsForgottenFlagIntervals() {
  try {
    const cols = db.prepare('PRAGMA table_info(projects)').all().map((c: any) => c.name);
    if (!cols.includes('forgotten_flag_issue_interval_minutes')) {
      db.exec(`ALTER TABLE projects ADD COLUMN forgotten_flag_issue_interval_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES}`);
      console.log(`[mobius/db] migrate: projects.forgotten_flag_issue_interval_minutes 已加 (默认 ${DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES} 分钟)`);
    }
    if (!cols.includes('forgotten_flag_research_interval_minutes')) {
      db.exec(`ALTER TABLE projects ADD COLUMN forgotten_flag_research_interval_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES}`);
      console.log(`[mobius/db] migrate: projects.forgotten_flag_research_interval_minutes 已加 (默认 ${DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES} 分钟)`);
    }
    const colsAfterLegacy = db.prepare('PRAGMA table_info(projects)').all().map((c: any) => c.name);
    if (!colsAfterLegacy.includes('forgotten_flag_issue_init_minutes')) {
      db.exec(`ALTER TABLE projects ADD COLUMN forgotten_flag_issue_init_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES}`);
      db.exec('UPDATE projects SET forgotten_flag_issue_init_minutes = forgotten_flag_issue_interval_minutes');
      console.log(`[mobius/db] migrate: projects.forgotten_flag_issue_init_minutes 已加 (默认 ${DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES} 分钟)`);
    }
    if (!colsAfterLegacy.includes('forgotten_flag_issue_backoff')) {
      db.exec(`ALTER TABLE projects ADD COLUMN forgotten_flag_issue_backoff REAL NOT NULL DEFAULT ${DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF}`);
      console.log(`[mobius/db] migrate: projects.forgotten_flag_issue_backoff 已加 (默认 ${DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF})`);
    }
    if (!colsAfterLegacy.includes('forgotten_flag_issue_patience')) {
      db.exec(`ALTER TABLE projects ADD COLUMN forgotten_flag_issue_patience INTEGER NOT NULL DEFAULT ${DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE}`);
      console.log(`[mobius/db] migrate: projects.forgotten_flag_issue_patience 已加 (默认 ${DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE} 次)`);
    }
    if (!colsAfterLegacy.includes('forgotten_flag_research_init_minutes')) {
      db.exec(`ALTER TABLE projects ADD COLUMN forgotten_flag_research_init_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES}`);
      db.exec('UPDATE projects SET forgotten_flag_research_init_minutes = forgotten_flag_research_interval_minutes');
      console.log(`[mobius/db] migrate: projects.forgotten_flag_research_init_minutes 已加 (默认 ${DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES} 分钟)`);
    }
    if (!colsAfterLegacy.includes('forgotten_flag_research_backoff')) {
      db.exec(`ALTER TABLE projects ADD COLUMN forgotten_flag_research_backoff REAL NOT NULL DEFAULT ${DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF}`);
      console.log(`[mobius/db] migrate: projects.forgotten_flag_research_backoff 已加 (默认 ${DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF})`);
    }
    if (!colsAfterLegacy.includes('forgotten_flag_research_patience')) {
      db.exec(`ALTER TABLE projects ADD COLUMN forgotten_flag_research_patience INTEGER NOT NULL DEFAULT ${DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE}`);
      console.log(`[mobius/db] migrate: projects.forgotten_flag_research_patience 已加 (默认 ${DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE} 次)`);
    }
  } catch (e) {
    console.warn('[mobius/db] ⚠️  projects forgotten_flag policy 迁移失败:', e.message);
  }
}
migrateProjectsForgottenFlagIntervals();

// ===== 共享 projects 表轻量迁移: 绑定路径是否为"手动输入(不校验)" =====
// 手动输入的路径(work_dir 外/不存在亦可)必须记住其 manual 属性, 否则后续
// 任意一次保存(哪怕没动路径)会重新走严格 resolveBindPath, 把路径静默重写/回撤.
// 缺列才 ALTER, 幂等. 默认 0: 存量路径都是经严格校验进来的, 按非手动处理.
function migrateProjectsBindPathManual() {
  try {
    const cols = db.prepare('PRAGMA table_info(projects)').all().map((c: any) => c.name);
    if (!cols.includes('bind_path_manual')) {
      db.exec('ALTER TABLE projects ADD COLUMN bind_path_manual INTEGER NOT NULL DEFAULT 0');
      console.log('[mobius/db] migrate: projects.bind_path_manual 已加 (默认 0, 存量按严格校验路径处理)');
    }
  } catch (e) {
    console.warn('[mobius/db] ⚠️  projects bind_path_manual 迁移失败:', e.message);
  }
}
migrateProjectsBindPathManual();

// ===== 共享 projects 表轻量迁移: 拓展系统 (kind / extension_name / disabled / default hidden) =====
// kind='extension' 的项目由 mobius/extension/<name>/ 目录自动 upsert; bind_path 强制为 APP_DIR,
// worktree/research 强制关闭. disabled=1 表示拓展目录已删除但 DB 行保留 (用户数据不丢).
// 缺列才 ALTER, 幂等.
function migrateProjectsExtensionColumns() {
  try {
    const cols = db.prepare('PRAGMA table_info(projects)').all().map((c: any) => c.name);
    if (!cols.includes('kind')) {
      // SQLite ALTER ADD COLUMN 不支持 CHECK 子句 (会直接报 syntax error); 约束放在
      // schema.sql 的空库建表里, 存量迁移只保证列存在 + 默认值正确.
      db.exec("ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'");
      console.log("[mobius/db] migrate: projects.kind 已加 (默认 'normal')");
    }
    if (!cols.includes('extension_name')) {
      db.exec('ALTER TABLE projects ADD COLUMN extension_name TEXT');
      console.log('[mobius/db] migrate: projects.extension_name 已加 (默认 NULL)');
    }
    if (!cols.includes('disabled')) {
      db.exec('ALTER TABLE projects ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
      console.log('[mobius/db] migrate: projects.disabled 已加 (默认 0)');
    }
    if (!cols.includes('extension_default_hidden')) {
      db.exec('ALTER TABLE projects ADD COLUMN extension_default_hidden INTEGER NOT NULL DEFAULT 0');
      console.log('[mobius/db] migrate: projects.extension_default_hidden 已加 (默认 0)');
    }
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_extension_name ' +
      'ON projects(extension_name) WHERE extension_name IS NOT NULL'
    );
  } catch (e) {
    console.warn('[mobius/db] ⚠️  projects extension 迁移失败:', e.message);
  }
}
migrateProjectsExtensionColumns();

// ===== 共享 projects 表轻量迁移: 项目级默认模型偏好 =====
// 新建 Session 时, 模型下拉的初始值取自该字段. NULL = 未指定 (跟系统全局默认).
// 缺列才 ALTER, 幂等.
function migrateProjectsDefaultModel() {
  try {
    const cols = db.prepare('PRAGMA table_info(projects)').all().map((c: any) => c.name);
    if (!cols.includes('default_model')) {
      db.exec('ALTER TABLE projects ADD COLUMN default_model TEXT');
      console.log('[mobius/db] migrate: projects.default_model 已加 (默认 NULL, 跟随系统默认)');
    }
  } catch (e) {
    console.warn('[mobius/db] ⚠️  projects default_model 迁移失败:', e.message);
  }
}
migrateProjectsDefaultModel();

// ===== 每用户的项目星标 =====
// 星标是用户自己的排序偏好, 不改变项目本身的所有权或元数据.
function migrateProjectUserStars() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_user_stars (
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (project_id, user_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_project_user_stars_user ON project_user_stars(user_id);
    `);
  } catch (e) {
    console.warn('[mobius/db] ⚠️  project user stars 迁移失败:', e.message);
  }
}
migrateProjectUserStars();

// ===== 每用户的 issue 星标 =====
// 用户在 issue 上的个人收藏, 用于列表排序 (区别于 issues.pinned 的项目级全局置顶,
// 后者是 manager 权限设置, 所有用户共享).
function migrateIssueUserStars() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS issue_user_stars (
        issue_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (issue_id, user_id),
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_issue_user_stars_user ON issue_user_stars(user_id);
    `);
  } catch (e) {
    console.warn('[mobius/db] ⚠️  issue user stars 迁移失败:', e.message);
  }
}
migrateIssueUserStars();
// ===== 每项目、每用户的用户级 Skill/Memory 与内置 Skill 白名单 =====
// 行不存在 = 两类白名单都不存在, 创建 Session 时沿用原行为展示全部用户级条目.
// 某列为 NULL = 该类白名单不存在; 某列为 JSON 数组 = 该类白名单已启用.
function migrateProjectUserContextWhitelists() {
  try {
    db.exec(`
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
    `);
    const cols = db.prepare('PRAGMA table_info(project_user_context_whitelists)').all().map((c: any) => c.name);
    if (!cols.includes('builtin_skill_ids')) {
      db.exec('ALTER TABLE project_user_context_whitelists ADD COLUMN builtin_skill_ids TEXT');
      console.log('[mobius/db] migrate: project_user_context_whitelists.builtin_skill_ids 已加');
    }
  } catch (e) {
    console.warn('[mobius/db] ⚠️  project user context whitelist 迁移失败:', e.message);
  }
}
migrateProjectUserContextWhitelists();

// ===== 每用户的"拓展项目隐藏"标记 =====
// 拓展项目是全局共享的 (一个 mobius/extension/<name>/ 目录, 一行 DB), 每个用户都能在
// 项目页看到. 该表让用户把不想看到的拓展卡片"隐藏"起来 (隐藏不影响其它用户). 管理员
// 面板可列出全部 (user, project) 隐藏对并撤销隐藏. "彻底删除"语义由路由层负责:
// 在 insert 这张表之前事务性删掉该用户在该拓展上的 sessions/issues/stars/whitelist.
function migrateProjectUserHidden() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_user_hidden (
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        hidden_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (project_id, user_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_project_user_hidden_user ON project_user_hidden(user_id);
    `);
  } catch (e) {
    console.warn('[mobius/db] ⚠️  project_user_hidden 迁移失败:', e.message);
  }
}
migrateProjectUserHidden();

// ===== 项目待办 =====
// 项目设置右侧的轻量 checklist。与 issues/researches 分离, 只表示项目级待办,
// 不创建会话、不参与 agent 执行链路。后端和 agent 可通过 HTTP endpoint 或 repository 读取。
function migrateProjectTodos() {
  try {
    db.exec(`
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
    `);
  } catch (e) {
    console.warn('[mobius/db] ⚠️  project_todos 迁移失败:', e.message);
  }
}
migrateProjectTodos();

export { db, DB_PATH };
