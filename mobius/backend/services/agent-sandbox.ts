import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { db } from '../../db';
import { isWithin } from './file-access';

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
  // 越界判断统一走 file-access.isWithin, 不再手写 startsWith
  // Containment goes through file-access.isWithin instead of a local check
  return isWithin(root, target);
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
  // 说明: 这里刻意不为 temp 根加 deny. 本驱动的语义是"默认全可访问, 只排除 deny 子树",
  // 而 landlock 同一 ruleset 内的规则取并集 —— 一旦某目录下存在 deny, walk() 就不再给该
  // 目录本身授权(否则授权会覆盖 deny). 因此给 /tmp/mobius/mobius-<别人> 加 deny 会让
  // /tmp 本身失去授权, 沙箱内 agent 连在 /tmp 下 mkdir 都会 EACCES (已实测)。
  // 结论: temp 的"本人读+写"只在 Mobius API 层 (file-access) 强制, OS 层 /tmp 对同机
  // 同 OS 用户的 agent 仍是共享的。
  // Note: temp roots are deliberately NOT denied here. This driver grants everything by
  // default and only excludes deny subtrees; landlock unions rules within one ruleset, so a
  // directory holding a deny can never be granted itself. Denying a sibling temp dir would
  // therefore leave /tmp ungranted and break `mkdir /tmp/...` inside the sandbox (measured).
  // Temp isolation is enforced at the Mobius API layer instead.
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
