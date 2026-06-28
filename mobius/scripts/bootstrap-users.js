#!/usr/bin/env node
// bootstrap-users.js — docker-compose env 初始化链路 (与 zip 迁移链路并存)
//
// 输入: 环境变量 MOBIUS_BOOTSTRAP_USERS
//   格式: "id1:password1:role:display_name;id2:password2;..."
//   字段分隔 ':'  用户分隔 ';'  role/display_name 可省 (默认 user / 同 id)
//   密码不允许含 ':' 或 ';' (有需要可改 base64; 本期不做)
//
// 语义: INSERT OR IGNORE — 只为空缺 seed, 已存在用户原样保留, 不覆盖密码 / preferences.
//      想"强制重置"请走 zip 链路 (UPSERT) 或 API 改密.
//
// 复用 db.ts 的 schema bootstrap (空库自动建表), 所以可在 backend 起来之前调.
// 容器内由 docker-entrypoint.sh 调用; 宿主机也能跑 (cd mobius && node scripts/bootstrap-users.js).
//
// db 层是 TypeScript (mobius/db.ts), 后端运行时靠 tsx/cjs 即时转译; 本脚本走纯 node 启动,
// 必须先挂 tsx/cjs require hook, 否则 require('./db') 找不到 db.js (项目里只有 db.ts).
const path = require('path');
// tsx 的 subpath export "./cjs" 物理文件是 dist/cjs/index.cjs, 直接走绝对路径绕开
// exports map, 容器内外行为一致. require('tsx/cjs') 也行, 但需要 mobius 本身在
// node 的模块解析路径上, 容器里 cwd=/app/mobius 时成立, 宿主直接拉脚本时不一定成立.
try {
  require(path.resolve(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cjs', 'index.cjs'));
} catch (e) {
  console.error('[bootstrap-users] 加载 tsx/cjs 失败, 无法 require db.ts:', e.message);
  process.exit(1);
}

const bcrypt = require('bcryptjs');

function parseUsers(raw) {
  if (!raw) return [];
  const items = [];
  for (const chunk of String(raw).split(';')) {
    const s = chunk.trim();
    if (!s) continue;
    const parts = s.split(':');
    if (parts.length < 2) throw new Error(`格式错误 (至少 id:password): ${s}`);
    const [id, password, role = 'user', display_name = ''] = parts;
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`非法 id (仅 a-zA-Z0-9_-): ${id}`);
    if (password.length < 1)           throw new Error(`密码不能为空: ${id}`);
    if (!['admin', 'user'].includes(role)) throw new Error(`role 必须是 admin|user: ${id}=${role}`);
    items.push({ id, password, role, display_name: display_name || id });
  }
  return items;
}

function main() {
  const raw = process.env.MOBIUS_BOOTSTRAP_USERS || '';
  const users = parseUsers(raw);
  if (users.length === 0) { console.log('[bootstrap-users] MOBIUS_BOOTSTRAP_USERS 未设置, 跳过'); return; }

  // 复用 db.ts (会跑 schema.sql bootstrap); 上面已挂 tsx/cjs hook, 这里不带扩展名,
  // 让 require 解析到 mobius/db.ts.
  const { db } = require(path.resolve(__dirname, '..', 'db'));
  const workspaceRoot = process.env.WORKSPACE_ROOT || '/data/workspace';

  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (id, display_name, password_hash, role, work_dir)
    VALUES (@id, @display_name, @password_hash, @role, @work_dir)
  `);
  const insertPref = db.prepare(`
    INSERT OR IGNORE INTO user_preferences (user_id, response_style, language, tone, personal_prompt)
    VALUES (@user_id, 'detailed', 'auto', 'professional', '')
  `);

  let seeded = 0, skipped = 0;
  const txn = db.transaction(() => {
    for (const u of users) {
      const hash = bcrypt.hashSync(u.password, 10);
      const r = insertUser.run({
        id: u.id,
        display_name: u.display_name,
        password_hash: hash,
        role: u.role,
        work_dir: path.posix.join(workspaceRoot, u.id),
      });
      if (r.changes > 0) {
        insertPref.run({ user_id: u.id });
        seeded += 1;
      } else {
        skipped += 1;
      }
    }
  });
  txn();
  console.log(`[bootstrap-users] seeded=${seeded} skipped(已存在)=${skipped} total=${users.length} workspace_root=${workspaceRoot}`);
}

try { main(); } catch (e) { console.error('[bootstrap-users] FAIL:', e.message); process.exit(1); }
