/**
 * extension-scheduler.ts
 *
 * Generic scheduler for extension handlers.
 *
 * Contract:
 *   CORE_DATA_PATH/extension/<extension-name>/schedules/<id>.json
 *   {
 *     "id": "...",
 *     "extension_name": "<extension-name>",
 *     "user_id": "<mobius-user-id>",
 *     "enabled": true,
 *     "interval_minutes": 30,
 *     "next_run_at": "ISO timestamp",
 *     "payload": { "action": "run_scan", ... }
 *   }
 */
import * as fs from 'fs';
import * as path from 'path';
import registry from './extension-registry';
import { invokeHandler } from './extension-invoker';
import { Users } from '../repositories/users';
import { EXTENSION_DATA_ROOT } from '../config';

const DEFAULT_SCAN_MS = Number(process.env.EXTENSION_SCHEDULER_SCAN_MS || 60_000);
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const LOCK_STALE_MS = 10 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let scanning = false;

function nowIso(): string {
  return new Date().toISOString();
}

function safeReadJson(file: string): any {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function normalizeIntervalMinutes(value: any): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, Math.floor(n)));
}

function nextRunFrom(baseMs: number, intervalMinutes: any): string {
  return new Date(baseMs + normalizeIntervalMinutes(intervalMinutes) * 60_000).toISOString();
}

function listScheduleFiles(): string[] {
  const out: string[] = [];
  if (!fs.existsSync(EXTENSION_DATA_ROOT)) return out;
  for (const extDir of fs.readdirSync(EXTENSION_DATA_ROOT, { withFileTypes: true })) {
    if (!extDir.isDirectory()) continue;
    const scheduleDir = path.join(EXTENSION_DATA_ROOT, extDir.name, 'schedules');
    if (!fs.existsSync(scheduleDir)) continue;
    for (const ent of fs.readdirSync(scheduleDir, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.endsWith('.json')) out.push(path.join(scheduleDir, ent.name));
    }
  }
  return out;
}

function extensionNameFromFile(file: string): string {
  return path.basename(path.dirname(path.dirname(file)));
}

function isDue(schedule: any, atMs: number): boolean {
  if (!schedule || schedule.enabled !== true) return false;
  const next = Date.parse(schedule.next_run_at || '');
  if (!Number.isFinite(next)) return true;
  return next <= atMs;
}

function acquireLock(file: string): (() => void) | null {
  const lockFile = `${file}.lock`;
  try {
    const stat = fs.statSync(lockFile);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.rmSync(lockFile, { force: true });
    }
  } catch {}
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, locked_at: nowIso() }));
    return () => {
      try { fs.closeSync(fd); } catch {}
      try { fs.rmSync(lockFile, { force: true }); } catch {}
    };
  } catch {
    return null;
  }
}

function markSchedule(file: string, patch: any): void {
  const current = safeReadJson(file) || {};
  writeJsonAtomic(file, { ...current, ...patch, updated_at: nowIso() });
}

async function runSchedule(file: string, atMs: number): Promise<void> {
  const release = acquireLock(file);
  if (!release) return;
  try {
    const schedule = safeReadJson(file);
    if (!isDue(schedule, atMs)) return;

    const extensionName = schedule.extension_name || extensionNameFromFile(file);
    const entry = registry.get(extensionName);
    if (!entry) {
      markSchedule(file, {
        last_status: 'error',
        last_error: 'extension unavailable',
        next_run_at: nextRunFrom(atMs, schedule.interval_minutes),
      });
      return;
    }
    const user = Users.findAuthById(schedule.user_id);
    if (!user) {
      markSchedule(file, {
        last_status: 'error',
        last_error: 'user unavailable',
        next_run_at: nextRunFrom(atMs, schedule.interval_minutes),
      });
      return;
    }

    const payload = schedule.payload && typeof schedule.payload === 'object' ? schedule.payload : {};
    const result = await invokeHandler({
      entry,
      username: user.id,
      display_name: user.display_name || user.id,
      ext_main_payload: {
        ...payload,
        scheduled: true,
        schedule_id: schedule.id || path.basename(file, '.json'),
        schedule_triggered_at: nowIso(),
      },
    });

    const statusPatch = {
      last_run_at: nowIso(),
      next_run_at: nextRunFrom(Date.now(), schedule.interval_minutes),
    };
    if (result.__timeout) {
      markSchedule(file, { ...statusPatch, last_status: 'timeout', last_error: 'handler timeout' });
    } else if (result.__oversize) {
      markSchedule(file, { ...statusPatch, last_status: 'error', last_error: 'handler result too large' });
    } else if (result.__error) {
      markSchedule(file, { ...statusPatch, last_status: 'error', last_error: result.__error });
    } else if (result.value && result.value.ok === false) {
      markSchedule(file, { ...statusPatch, last_status: 'error', last_error: result.value.error || 'handler returned ok=false' });
    } else {
      markSchedule(file, { ...statusPatch, last_status: 'ok', last_error: '' });
    }
  } catch (e) {
    try {
      const schedule = safeReadJson(file) || {};
      markSchedule(file, {
        last_run_at: nowIso(),
        next_run_at: nextRunFrom(Date.now(), schedule.interval_minutes),
        last_status: 'error',
        last_error: e.message || String(e),
      });
    } catch {}
  } finally {
    release();
  }
}

async function scanOnce(): Promise<void> {
  if (scanning) return;
  scanning = true;
  const atMs = Date.now();
  try {
    const files = listScheduleFiles();
    for (const file of files) {
      await runSchedule(file, atMs);
    }
  } catch (e) {
    console.warn('[extension-scheduler] scan failed:', e.message);
  } finally {
    scanning = false;
  }
}

function startExtensionScheduler(): NodeJS.Timeout {
  if (timer) return timer;
  const scanMs = Math.max(10_000, DEFAULT_SCAN_MS);
  timer = setInterval(scanOnce, scanMs);
  if (typeof timer.unref === 'function') timer.unref();
  setTimeout(scanOnce, 5_000).unref?.();
  console.log(`[mobius] extension scheduler started (${scanMs}ms scan)`);
  return timer;
}

function stopExtensionScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export {
  startExtensionScheduler,
  stopExtensionScheduler,
  scanOnce,
};
