#!/usr/bin/env node
// bootstrap-self-evolve.js — 全新部署时为第一个 admin seed 一个名为 "Mobius Self Evolve"
// 的项目, bind_path 指向 imac 代码自身 (容器内 = $APP_DIR, 默认 /app).
// 幂等: 同名+同 owner 已存在则跳过.
const crypto = require('crypto');
const path = require('path');

// db 层是 TypeScript (mobius/db.ts), 后端运行时靠 tsx/cjs 即时转译; 本脚本走纯 node 启动,
// 必须先挂 tsx/cjs require hook, 否则 require('./db') 找不到 db.js (项目里只有 db.ts).
// 与 scripts/bootstrap-users.js 同样的处理.
try {
  require(path.resolve(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cjs', 'index.cjs'));
} catch (e) {
  console.error('[bootstrap-self-evolve] 加载 tsx/cjs 失败, 无法 require db.ts:', e.message);
  process.exit(1);
}

function main() {
  const projectName = 'Mobius Self Evolve';
  const bindPath = process.env.APP_DIR || '/app';
  // 不带后缀, 让 tsx/cjs hook 解析到 mobius/db.ts (项目里没有 db.js 编译产物).
  const { db } = require(path.resolve(__dirname, '..', 'db'));

  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (!admin) {
    console.log('[bootstrap-self-evolve] 无 admin 用户, 跳过');
    return;
  }
  const existing = db.prepare('SELECT id FROM projects WHERE name = ? AND created_by = ?')
    .get(projectName, admin.id);
  if (existing) {
    console.log(`[bootstrap-self-evolve] 项目 "${projectName}" 已存在 (id=${existing.id}), 跳过`);
    return;
  }
  const projectId = crypto.randomBytes(4).toString('hex');
  db.prepare(`
    INSERT INTO projects (id, name, description, created_by, bind_path, bind_path_manual)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(projectId, projectName, 'Mobius 自身代码 (全新部署自动 seed)', admin.id, bindPath);
  console.log(`[bootstrap-self-evolve] seeded "${projectName}" id=${projectId} bind_path=${bindPath} owner=${admin.id}`);
}

try { main(); } catch (e) { console.error('[bootstrap-self-evolve] FAIL:', e.message); process.exit(1); }
