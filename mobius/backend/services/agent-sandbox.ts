import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { db } from '../../db';

const DRIVER = path.join(__dirname, '..', 'agents', 'mobius-landlock');
let cached: boolean | null = null;

export function landlockAvailable(): boolean {
  if (cached !== null) return cached;
  try {
    const result = spawnSync(DRIVER, ['--check'], { encoding: 'utf8', timeout: 15000 });
    cached = result.status === 0;
    if (!cached) console.warn(`[agent-sandbox] Landlock unavailable: ${(result.stderr || result.stdout || '').trim()}`);
  } catch (e) {
    cached = false;
    console.warn(`[agent-sandbox] Landlock self-check failed: ${(e as Error).message}`);
  }
  return cached;
}

export function assertUserSandboxAvailable(user: any): void {
  if (user?.role !== 'admin' && !landlockAvailable()) {
    const e = new Error('当前服务器不支持普通用户 Agent 沙盒，普通用户暂时不能登录或使用 Agent') as Error & { status?: number };
    e.status = 503;
    throw e;
  }
}

function inside(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
}

function exceptionPathsFor(userId: string, projectId: string | null): string[] {
  if (!projectId) return [];
  const project = db.prepare('SELECT bind_path FROM projects WHERE id = ?').get(projectId) as { bind_path?: string } | undefined;
  if (!project?.bind_path) return [];
  const row = db.prepare('SELECT role FROM project_memberships WHERE project_id = ? AND user_id = ?').get(projectId, userId) as { role?: string } | undefined;
  const creator = db.prepare('SELECT created_by FROM projects WHERE id = ?').get(projectId) as { created_by?: string } | undefined;
  if (creator?.created_by !== userId && row?.role !== 'developer' && row?.role !== 'owner') return [];
  try { return [fs.realpathSync(path.resolve(project.bind_path))]; } catch { return []; }
}

function compileDeniedChildren(root: string, allowed: string[], out: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { out.push(root); return; }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (allowed.some((p) => inside(child, p))) {
      if (entry.isDirectory() && !allowed.includes(path.resolve(child))) compileDeniedChildren(child, allowed, out);
      continue;
    }
    out.push(child);
  }
}

export function writeSandboxPolicy({ userId, projectId, workDir }: { userId: string; projectId?: string | null; workDir: string }): string | null {
  if (!landlockAvailable()) return null;
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role?: string } | undefined;
  if (user?.role === 'admin') return null;
  const exceptions = exceptionPathsFor(userId, projectId || null);
  const deny: string[] = [];
  const others = db.prepare("SELECT work_dir FROM users WHERE id <> ? AND (deleted_at IS NULL OR deleted_at = '') AND work_dir <> ''").all(userId) as Array<{ work_dir: string }>;
  for (const row of others) {
    let root: string;
    try { root = fs.realpathSync(path.resolve(row.work_dir)); } catch { root = path.resolve(row.work_dir); }
    if (exceptions.some((p) => inside(root, p))) compileDeniedChildren(root, exceptions, deny);
    else deny.push(root);
  }
  const file = path.join(os.tmpdir(), `mobius-landlock-${userId}-${process.pid}-${Date.now()}.policy`);
  fs.writeFileSync(file, deny.map((p) => `deny ${p}`).join('\n') + (deny.length ? '\n' : ''), { mode: 0o600 });
  return file;
}

export function sandboxCommand(policyFile: string | null, command: string): string {
  if (!policyFile) return command;
  return `${shellQuote(DRIVER)} --policy ${shellQuote(policyFile)} -- bash -lc ${shellQuote(command)}`;
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export { DRIVER };
