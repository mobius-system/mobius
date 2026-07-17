'use strict';
/**
 *
 *
 *
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.MOBIUS_LOG_DIR || '/data/logs';
const ERROR_LOG = path.join(LOG_DIR, 'mobius-server-error.log');

function recordBootFailure(err) {
  const detail = (err && (err.stack || err.message)) || String(err);
  const msg = `[pm2-entrypoint][${new Date().toISOString()}] BOOT_FAILURE: ${detail}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(ERROR_LOG, msg);
  } catch (_) {
  }
  try {
    process.stderr.write(msg);
  } catch (_) {
    /* ignore */
  }
}

function clearEmittedTsShadows() {
  const dirs = ['backend/services', 'backend/repositories', 'backend/types'];
  for (const rel of dirs) {
    const dir = path.join(__dirname, rel);
    let names;
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const name of names) {
      if (!name.endsWith('.js')) continue;
      const jsPath = path.join(dir, name);
      const tsPath = jsPath.slice(0, -3) + '.ts';
      try { if (fs.existsSync(tsPath)) fs.unlinkSync(jsPath); } catch (_) { /* noop */ }
    }
  }
  const dbJs = path.join(__dirname, 'db.js');
  const dbTs = path.join(__dirname, 'db.ts');
  try { if (fs.existsSync(dbJs) && fs.existsSync(dbTs)) fs.unlinkSync(dbJs); } catch (_) { /* noop */ }
}
clearEmittedTsShadows();

function recordRuntimeError(tag, reason) {
  const detail = (reason && (reason.stack || reason.message)) || String(reason);
  const msg = `[${new Date().toISOString()}] ${tag}(swallowed): ${detail}\n`;
  try { fs.appendFileSync(ERROR_LOG, msg); } catch (_) { /* ignore */ }
  try { process.stderr.write(msg); } catch (_) { /* ignore */ }
}
process.on('unhandledRejection', (reason) => recordRuntimeError('unhandledRejection', reason));
process.on('uncaughtException', (err) => recordRuntimeError('uncaughtException', err));

try {
  require('./server.js');
} catch (err) {
  recordBootFailure(err);
  process.exit(1);
}
