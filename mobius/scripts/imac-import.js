#!/usr/bin/env node
//
//   node scripts/imac-import.js \
//     --staging /tmp/imac-bundle-extracted \
//     --db data/mobuis.db \
//     --protected protected_data \
//     --workspace-root /data/workspace \

const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--skip-password') { out.skipPassword = true; continue; }
    if (k === '--reset-prompt')  { out.resetPrompt = true;  continue; }
    const v = argv[++i];
    if (k === '--staging') out.staging = v;
    else if (k === '--db') out.db = v;
    else if (k === '--protected') out.protectedDir = v;
    else if (k === '--workspace-root') out.workspaceRoot = v;
    else throw new Error(`unknown flag: ${k}`);
  }
  return out;
}

function copyDirIfExists(src, dst) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  return true;
}

function main() {
  const args = parseArgs(process.argv);
  const staging = path.resolve(args.staging || '');
  const dataRoot = process.env.MOBIUS_DATA_PATH || 'data';
  const dbPath = path.resolve(args.db || process.env.DB_PATH || path.join(dataRoot, 'mobuis.db'));
  const protectedDir = path.resolve(args.protectedDir || process.env.CORE_DATA_PATH || 'protected_data');
  const workspaceRoot = args.workspaceRoot || process.env.WORKSPACE_ROOT || '/data/workspace';

  if (!fs.existsSync(staging)) { console.error(`[import] staging not found: ${staging}`); process.exit(2); }
  const manifestPath = path.join(staging, 'manifest.yaml');
  const usersPath    = path.join(staging, 'users.yaml');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(usersPath)) {
    console.error('[import] bundle invalid: manifest.yaml / users.yaml missing'); process.exit(2);
  }

  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  const usersDoc = yaml.load(fs.readFileSync(usersPath, 'utf8'));
  if (!usersDoc || !Array.isArray(usersDoc.users)) {
    console.error('[import] users.yaml malformed'); process.exit(2);
  }

  process.env.DB_PATH = dbPath;
  const { db } = require(path.resolve(__dirname, '..', 'db.js'));

  const upsertUser = db.prepare(`
    INSERT INTO users (id, display_name, password_hash, role, work_dir, created_at)
    VALUES (@id, @display_name, @password_hash, @role, @work_dir, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      role         = excluded.role,
      work_dir     = excluded.work_dir
      ${args.skipPassword ? '' : ', password_hash = excluded.password_hash'}
  `);
  const upsertPref = db.prepare(`
    INSERT INTO user_preferences (user_id, response_style, language, tone, personal_prompt)
    VALUES (@user_id, @response_style, @language, @tone, @personal_prompt)
    ON CONFLICT(user_id) DO UPDATE SET
      response_style  = excluded.response_style,
      language        = excluded.language,
      tone            = excluded.tone,
      personal_prompt = ${args.resetPrompt ? "''" : 'excluded.personal_prompt'},
      updated_at      = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);

  let stats = { users: 0, prefs: 0, skills_users: 0, memories_users: 0, password_imported: 0 };
  const txn = db.transaction(() => {
    for (const u of usersDoc.users) {
      const hash = (!args.skipPassword && u.password_hash) ? u.password_hash : 'IMPORT_NO_PASSWORD';
      if (!args.skipPassword && u.password_hash) stats.password_imported += 1;
      upsertUser.run({
        id: u.id,
        display_name: u.display_name || u.id,
        password_hash: hash,
        role: u.role === 'admin' ? 'admin' : 'user',
        work_dir: path.posix.join(workspaceRoot, String(u.id)),
        created_at: u.created_at || new Date().toISOString(),
      });
      stats.users += 1;
      const p = u.preferences || {};
      upsertPref.run({
        user_id: u.id,
        response_style: p.response_style || 'detailed',
        language: p.language || 'auto',
        tone: p.tone || 'professional',
        personal_prompt: p.personal_prompt || '',
      });
      stats.prefs += 1;
    }
  });
  txn();

  for (const u of usersDoc.users) {
    const sSrc = path.join(staging,  'skills',   u.id);
    const mSrc = path.join(staging,  'memories', u.id);
    const sDst = path.join(protectedDir, 'skills',   `user=${u.id}`, 'default_project', '.claude', 'skills');
    const mDst = path.join(protectedDir, 'memories', `user=${u.id}`, 'default_project');
    if (copyDirIfExists(sSrc, sDst)) stats.skills_users += 1;
    if (copyDirIfExists(mSrc, mDst)) stats.memories_users += 1;
  }

  console.log(`[import] bundle: ${manifest.bundle_scope} v${manifest.bundle_version}, src=${manifest.source_host}`);
  console.log(`[import] users=${stats.users} (pwd=${stats.password_imported}) prefs=${stats.prefs}`);
  console.log(`[import] skills_users=${stats.skills_users} memories_users=${stats.memories_users}`);
  console.log(`[import] work_dir reset to ${workspaceRoot}/<userId>`);
}

try { main(); } catch (e) { console.error('[import] FAIL:', e.message); console.error(e.stack); process.exit(1); }
