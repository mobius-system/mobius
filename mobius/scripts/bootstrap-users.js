#!/usr/bin/env node
//
//
//
//
const path = require('path');
try {
  require(path.resolve(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cjs', 'index.cjs'));
} catch (e) {
  console.error('[bootstrap-users] failed to load tsx/cjs; cannot require db.ts:', e.message);
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
    if (parts.length < 2) throw new Error(`invalid format (at least id:password required): ${s}`);
    const [id, password, role = 'user', display_name = ''] = parts;
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`invalid id (only a-zA-Z0-9_- allowed): ${id}`);
    if (password.length < 1)           throw new Error(`password must not be empty: ${id}`);
    if (!['admin', 'user'].includes(role)) throw new Error(`role must be admin|user: ${id}=${role}`);
    items.push({ id, password, role, display_name: display_name || id });
  }
  return items;
}

function main() {
  const raw = process.env.MOBIUS_BOOTSTRAP_USERS || '';
  const users = parseUsers(raw);
  if (users.length === 0) { console.log('[bootstrap-users] MOBIUS_BOOTSTRAP_USERS is not set; skipping'); return; }

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
  console.log(`[bootstrap-users] seeded=${seeded} skipped(existing)=${skipped} total=${users.length} workspace_root=${workspaceRoot}`);
}

try { main(); } catch (e) { console.error('[bootstrap-users] FAIL:', e.message); process.exit(1); }
