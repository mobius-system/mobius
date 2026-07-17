#!/usr/bin/env node
const crypto = require('crypto');
const path = require('path');

try {
  require(path.resolve(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cjs', 'index.cjs'));
} catch (e) {
  console.error('[bootstrap-self-evolve] failed to load tsx/cjs; cannot require db.ts:', e.message);
  process.exit(1);
}

function main() {
  const projectName = 'Mobius Self Evolve';
  const bindPath = process.env.APP_DIR || '/app';
  const { db } = require(path.resolve(__dirname, '..', 'db'));

  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (!admin) {
    console.log('[bootstrap-self-evolve] no admin user; skipping');
    return;
  }
  const existing = db.prepare('SELECT id FROM projects WHERE name = ? AND created_by = ?')
    .get(projectName, admin.id);
  if (existing) {
    console.log(`[bootstrap-self-evolve] project "${projectName}" already exists (id=${existing.id}); skipping`);
    return;
  }
  const projectId = crypto.randomBytes(4).toString('hex');
  db.prepare(`
    INSERT INTO projects (id, name, description, created_by, bind_path, bind_path_manual, default_use_worktree)
    VALUES (?, ?, ?, ?, ?, 1, 0)
  `).run(projectId, projectName, 'Mobius source code (seeded automatically on fresh deploy)', admin.id, bindPath);
  console.log(`[bootstrap-self-evolve] seeded "${projectName}" id=${projectId} bind_path=${bindPath} owner=${admin.id}`);
}

try { main(); } catch (e) { console.error('[bootstrap-self-evolve] FAIL:', e.message); process.exit(1); }
