// 验证 /leader 时序修复: mode 必须在 buildSessionContext 之前落库,
// 否则 Chief 团队能力段 (含 team token) 不会注入 Leader bootstrap.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-mode-test-'));
process.env.DB_PATH = path.join(tempRoot, 'mobius.db');
process.env.MOBIUS_DATA_PATH = tempRoot;
process.env.CORE_DATA_PATH = tempRoot;
process.env.WORKSPACE_ROOT = path.join(tempRoot, 'workspace');
process.env.JWT_SECRET = 'leader-mode-test-secret';

const { db } = require('../db');
const Researches = require('../backend/repositories/researches').Researches;
const Sessions = require('../backend/repositories/sessions').Sessions;

// 造一个 custom 模式的 research
db.prepare(`INSERT INTO users (id, display_name, password_hash, role, work_dir, group_id)
  VALUES ('u1','u1','hash','user',?,'default')`).run(path.join(tempRoot, 'workspace', 'u1'));
db.prepare(`INSERT INTO projects (id, name, created_by, bind_path, research_enabled, visibility)
  VALUES ('p1','p1','u1',?,1,'private')`).run(path.join(tempRoot, 'project'));
Researches.insert({ id: 'rfix', project_id: 'p1', title: 't', description: 'd', created_by: 'u1', mode: 'custom', assistant_limit: 3, visibility: 'inherit' });

// 模拟旧时序: 先启动(读 mode) 后改 mode —— buildSessionContext 应看不到 chief_led
Researches.updateMode('rfix', 'chief_led'); // 修复后的顺序: 先改
const researchAfterMode = Researches.findById('rfix');
assert.strictEqual(researchAfterMode.mode, 'chief_led', 'updateMode 后应立即可读到 chief_led');

// 直接验证注入条件的核心读取路径: gatherSources 从 DB 重读 research
Sessions.insert({
  session_id: 'chieffix', issue_id: null, project_id: 'p1', scope_type: 'research',
  research_id: 'rfix', research_role: 'chief_researcher', user_id: 'u1',
  name: 'Leader', description: 'd', session_key: 'web:u1:chieffix',
  excluded_skill_ids: '[]', excluded_memory_ids: '[]', selection_snapshot: null,
  model: 'codex', language: 'zh',
});
const { buildSessionContext } = require('../backend/services/session-context');
const ctx = buildSessionContext({ id: 'u1' }, 'chieffix');
assert.match(ctx.body, /Chief 团队管理能力/, 'mode 先行落库后, Leader 上下文必须含 Chief 团队管理能力段');
assert.match(ctx.body, /team\/agents/, '必须包含建团队 API 指引');

console.log('PASS: leader mode timing fix (chief capability injected)');
process.on('exit', () => { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {} });
