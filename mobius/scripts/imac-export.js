#!/usr/bin/env node
//
//   node scripts/imac-export.js \
//     --db data/mobuis.db \
//     --protected protected_data \
//     --staging /tmp/imac-bundle-staging \
//
//   manifest.yaml
//   users.yaml
//   skills/<userId>/<skillName>/...
//   memories/<userId>/<file>.md

const path = require('path');
const fs = require('fs');
const os = require('os');
const yaml = require('js-yaml');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--no-password') { out.noPassword = true; continue; }
    const v = argv[++i];
    if (k === '--db') out.db = v;
    else if (k === '--protected') out.protectedDir = v;
    else if (k === '--staging') out.staging = v;
    else if (k === '--users') out.users = v.split(',').map(s => s.trim()).filter(Boolean);
    else throw new Error(`unknown flag: ${k}`);
  }
  return out;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

const SKILL_GARBAGE = new Set(['.pytest_cache', '__pycache__', 'node_modules', '.venv', 'venv', 'dist', '.next', '.cache']);

function copyDirIfExists(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (s) => !SKILL_GARBAGE.has(path.basename(s)),
  });
  return true;
}

function main() {
  const args = parseArgs(process.argv);
  const dataRoot = process.env.MOBIUS_DATA_PATH || 'data';
  const dbPath = path.resolve(args.db || process.env.DB_PATH || path.join(dataRoot, 'mobuis.db'));
  const protectedDir = path.resolve(args.protectedDir || process.env.CORE_DATA_PATH || 'protected_data');
  const staging = path.resolve(args.staging || path.join(os.tmpdir(), `imac-bundle-${Date.now()}`));
  if (!fs.existsSync(dbPath)) { console.error(`[export] db not found: ${dbPath}`); process.exit(2); }
  if (!fs.existsSync(protectedDir)) { console.error(`[export] protected dir not found: ${protectedDir}`); process.exit(2); }

  rmrf(staging);
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(path.join(staging, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(staging, 'memories'), { recursive: true });

  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });

  let userRows = db.prepare('SELECT * FROM users').all();
  if (args.users && args.users.length) {
    const want = new Set(args.users);
    userRows = userRows.filter(u => want.has(u.id));
  }
  if (userRows.length === 0) { console.error('[export] no users selected'); process.exit(3); }

  const prefStmt = db.prepare('SELECT * FROM user_preferences WHERE user_id = ?');
  const users = userRows.map(u => {
    const p = prefStmt.get(u.id) || {};
    const obj = {
      id: u.id,
      display_name: u.display_name,
      role: u.role,
      work_dir: null,
      created_at: u.created_at,
      preferences: {
        response_style: p.response_style || 'detailed',
        language: p.language || 'auto',
        tone: p.tone || 'professional',
        personal_prompt: p.personal_prompt || '',
      },
    };
    if (!args.noPassword) obj.password_hash = u.password_hash;
    return obj;
  });

  fs.writeFileSync(path.join(staging, 'users.yaml'), yaml.dump({ users }, { lineWidth: 120 }));

  const stats = { skills_users: 0, memories_users: 0, skill_dirs: 0, memory_files: 0 };
  for (const u of users) {
    const sSrc = path.join(protectedDir, 'skills',   `user=${u.id}`, 'default_project', '.claude', 'skills');
    const mSrc = path.join(protectedDir, 'memories', `user=${u.id}`, 'default_project');
    const sDst = path.join(staging, 'skills', u.id);
    const mDst = path.join(staging, 'memories', u.id);

    if (copyDirIfExists(sSrc, sDst)) {
      stats.skills_users += 1;
      try { stats.skill_dirs += fs.readdirSync(sDst, { withFileTypes: true }).filter(d => d.isDirectory()).length; } catch {}
    }
    if (fs.existsSync(mSrc) && fs.statSync(mSrc).isDirectory()) {
      fs.mkdirSync(mDst, { recursive: true });
      let cnt = 0;
      for (const f of fs.readdirSync(mSrc)) {
        const src = path.join(mSrc, f);
        if (fs.statSync(src).isFile() && f.endsWith('.md')) {
          fs.copyFileSync(src, path.join(mDst, f));
          cnt += 1;
        } else if (fs.statSync(src).isDirectory()) {
          fs.cpSync(src, path.join(mDst, f), { recursive: true });
        }
      }
      if (cnt > 0 || fs.readdirSync(mDst).length > 0) stats.memories_users += 1;
      stats.memory_files += cnt;
    }
  }

  const manifest = {
    bundle_version: 1,
    bundle_scope: 'user+skill+memory',
    created_at: new Date().toISOString(),
    source_host: os.hostname(),
    user_count: users.length,
    contains_password_hash: !args.noPassword,
    users: users.map(u => u.id),
    stats,
    note: 'project/issue/session/messages are not included; recreate projects on the target machine',
  };
  fs.writeFileSync(path.join(staging, 'manifest.yaml'), yaml.dump(manifest, { lineWidth: 120 }));

  console.log(`[export] staging ready: ${staging}`);
  console.log(`[export] users=${users.length} skills_users=${stats.skills_users} memories_users=${stats.memories_users}`);
  console.log(`[export]   skill_dirs=${stats.skill_dirs} memory_files=${stats.memory_files}`);
  console.log(`[export] contains_password_hash=${manifest.contains_password_hash}`);
}

try { main(); } catch (e) { console.error('[export] FAIL:', e.message); process.exit(1); }
