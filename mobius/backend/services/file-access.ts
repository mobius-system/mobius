/*
 * file-access.ts — 用户文件权限判断的唯一入口 (single source of truth).
 *
 * 背景: 此前 "这个绝对路径用户能不能碰" 的判断散落在约 20 个文件里, 各写各的
 * containment 辅助函数 (inside / isWithin / isPathInside / safeResolveUnder ...),
 * realpath 与 /tmp 放行口径互不一致, 出现 "workspace 合法但文件越界" 之类的不自洽.
 *
 * 本模块把 WHERE 这一层收拢为唯一规则:
 *
 *   allow(subject, action, target) ⇔ realpath(target) 落在 subject 被授予的
 *   某个根目录内, 且该根目录对该 action 有授权; 无匹配即拒绝.
 *
 * 职责边界 (刻意为之):
 *   − 本模块回答 "在哪能碰" (WHERE); "谁能碰哪个项目" (WHO) 仍由 access-control.ts
 *     负责, 调用方把已判定的 role 作为事实传进来.
 *   − 本模块不查数据库; 根目录由调用方按 RootSpec 组装 (后端从 db, 桌面端从本地映射).
 *     规则会漂移, 事实不会 —— 需要统一的正是规则.
 *
 * 权限表 (2026-10 定稿):
 *   admin                        所有根目录 读+写
 *   user_home                    owner self 读+写
 *   project / session_dir        viewer 及以上读, developer 及以上写
 *   extension_user_data          本人读+写
 *   temp (/tmp/mobius/mobius-<uid>/) 本人读+写
 *   builtin_assets               所有人读, 仅 admin 写
 *   context_personal             本人读+写
 *   context_project              viewer 及以上读, developer 及以上写
 *   context_builtin              所有人读, 仅 admin 写
 */
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../db';
import { EXTENSION_DATA_ROOT } from '../config';
import { effectiveProjectRole } from './access-control';

// 访问动作. open 视同 read (code-server / 终端 cwd 只要求该根目录可读).
type Action = 'read' | 'list' | 'write' | 'open';

// 项目内角色. null = 非成员.
type ProjectRole = 'owner' | 'developer' | 'viewer' | null;

// 根目录种类. 每种对应权限表里的一行.
type RootKind =
  | 'user_home'
  | 'project'
  | 'session_dir'
  | 'extension_user_data'
  | 'temp'
  | 'builtin_assets'
  | 'context_personal'
  | 'context_project'
  | 'context_builtin';

interface RootSpec {
  kind: RootKind;
  path: string;
  // project / session_dir / context_project 需要; 其余可省.
  role?: ProjectRole;
}

interface Subject {
  id?: string | null;
  // 'admin' 全通; 其余按普通用户表.
  role?: string | null;
  work_dir?: string | null;
}

interface Grant {
  kind: RootKind;
  path: string;
  read: boolean;
  write: boolean;
}

interface Decision {
  allowed: boolean;
  grant?: Grant;
  reason?: string;
}

const WRITE_ROLES: Array<Exclude<ProjectRole, null>> = ['owner', 'developer'];

/*
 * Normalize a candidate path to an absolute path, or '' when it is not a usable
 * non-empty string. Used on both roots and targets so comparisons share one form.
 */
function normalizePath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return path.resolve(trimmed);
}

/*
 * Containment test: is `target` equal to or below `root`? Pure lexical check on
 * already-normalized paths; symlink resolution is handled separately by callers.
 */
function isWithin(root: unknown, target: unknown): boolean {
  const r = normalizePath(root);
  const t = normalizePath(target);
  if (!r || !t) return false;
  return t === r || t.startsWith(r + path.sep);
}

/*
 * Join segments under a root, returning null when the result would escape the
 * root. Callers use it to build a child path without re-implementing the check.
 */
function joinWithin(root: unknown, ...segments: string[]): string | null {
  const base = normalizePath(root);
  if (!base) return null;
  const abs = path.resolve(base, ...segments);
  return isWithin(base, abs) ? abs : null;
}

/*
 * Per-user temp root: /tmp/mobius/mobius-<uid>. Both the permission check and
 * the writers (agents, multer) must use this one function so they cannot drift.
 */
function tempRootFor(userId: unknown, base: string = '/tmp'): string {
  const uid = String(userId || '').replace(/[^A-Za-z0-9_.@-]/g, '_') || 'anonymous';
  return path.join(path.resolve(base), 'mobius', `mobius-${uid}`);
}

/*
 * Same root, materialized: agents get TMPDIR pointed here so the artifacts they
 * write (screenshots, recordings) land where the permission check expects them.
 * Never throws — a failed mkdir only degrades to the caller's own write error.
 */
function ensureTempRoot(userId: unknown, base: string = '/tmp'): string {
  const dir = tempRootFor(userId, base);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* 交给真正的写入方报错 */ }
  return dir;
}

/*
 * Resolve a path to its real location when it exists, else null. Symlinks are
 * followed so a link inside an allowed root cannot point outside it.
 */
function realOrNull(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function isAdmin(user: Subject | null | undefined): boolean {
  return user?.role === 'admin';
}

/*
 * The permission table in executable form: given a root kind and the subject,
 * decide read/write. This is the ONLY place the table is written down.
 */
function capabilitiesFor(spec: RootSpec, user: Subject | null | undefined): { read: boolean; write: boolean } {
  // 管理员所有根目录全通 (全库唯一一处 admin 特判)
  // Admin bypass lives here and nowhere else
  if (isAdmin(user)) return { read: true, write: true };
  switch (spec.kind) {
    case 'user_home':
    case 'context_personal':
    case 'extension_user_data':
    case 'temp':
      // 这些根在组装时已限定为"本人", 因此读+写都放给本人
      // These roots are already scoped to the subject, so both directions are granted
      return { read: true, write: true };
    case 'builtin_assets':
    case 'context_builtin':
      // 内置资源所有人可读, 只有 admin 可写 (admin 已在上方返回)
      // Built-ins are world-readable, admin-writable
      return { read: true, write: false };
    case 'project':
    case 'session_dir':
    case 'context_project': {
      const role = spec.role ?? null;
      // viewer 及以上可读, developer 及以上可写
      // Viewer and above may read; developer and above may write
      return { read: !!role, write: WRITE_ROLES.includes(role as any) };
    }
    default:
      return { read: false, write: false };
  }
}

/*
 * Expand root specs into concrete grants for a subject, dropping unusable paths
 * and roots that grant no capability at all.
 */
function grantsFor(user: Subject | null | undefined, roots: Array<RootSpec | null | undefined>): Grant[] {
  const out: Grant[] = [];
  for (const spec of roots || []) {
    if (!spec || !spec.path) continue;
    const abs = normalizePath(spec.path);
    if (!abs) continue;
    const cap = capabilitiesFor(spec, user);
    if (!cap.read && !cap.write) continue;
    out.push({ kind: spec.kind, path: abs, read: cap.read, write: cap.write });
  }
  return out;
}

/*
 * The single authorization decision. Resolves symlinks on both sides so a link
 * cannot smuggle a target out of its root, then requires a grant that carries
 * the requested capability. Deny by default.
 */
function authorize(
  user: Subject | null | undefined,
  action: Action,
  target: unknown,
  roots: Array<RootSpec | null | undefined>,
  opts: { realpath?: boolean } = {},
): Decision {
  if (!user?.id) return { allowed: false, reason: 'UNAUTHENTICATED' };
  // 管理员不受限: 不依赖调用方构造的根目录
  // Admins are unrestricted, independent of the roots the caller assembled
  if (isAdmin(user)) return { allowed: true, reason: 'ADMIN' };
  const raw = normalizePath(target);
  if (!raw) return { allowed: false, reason: 'EMPTY_PATH' };

  // 两侧都先 realpath, 防止符号链接把目标引到根目录之外
  // Realpath both sides so a symlink cannot escape the root
  const useReal = opts.realpath !== false;
  const targetResolved = useReal ? realOrNull(raw) : null;
  const targetAbs = targetResolved || raw;
  const needWrite = action === 'write';
  let insideButDenied = false;

  for (const spec of roots || []) {
    if (!spec || !spec.path) continue;
    const rootRaw = normalizePath(spec.path);
    if (!rootRaw) continue;
    const rootReal = useReal ? realOrNull(rootRaw) : null;
    const rootAbs = rootReal || rootRaw;
    // 目标已存在时以 realpath 结果为准, 杜绝符号链接越界; 目标尚不存在才退回字面路径
    // Realpath wins whenever the target exists; the lexical form is only a fallback
    let inside = isWithin(rootAbs, targetAbs);
    if (!inside && !targetResolved) inside = isWithin(rootRaw, raw);
    if (!inside) continue;
    const cap = capabilitiesFor(spec, user);
    const grant: Grant = { kind: spec.kind, path: rootAbs, read: cap.read, write: cap.write };
    // ✨ 命中根目录且能力足够 → 放行; 否则记账继续找下一个根
    // Hit a root with enough capability; otherwise keep scanning other roots
    if (needWrite ? cap.write : cap.read) return { allowed: true, grant };
    insideButDenied = true;
  }

  return {
    allowed: false,
    reason: insideButDenied ? 'ACTION_DENIED' : 'OUTSIDE_ALLOWED_ROOTS',
  };
}

/*
 * Convenience wrapper returning a boolean, for call sites that only branch.
 */
function canAccess(
  user: Subject | null | undefined,
  action: Action,
  target: unknown,
  roots: Array<RootSpec | null | undefined>,
  opts: { realpath?: boolean } = {},
): boolean {
  return authorize(user, action, target, roots, opts).allowed;
}

/*
 * ============================ backend 取事实层 ============================
 * 以下函数只负责"把事实凑齐"(查库 / 读配置), 不含任何权限判断 —— 判断全在上面.
 * 之所以放在同一文件: 让"规则 + 它的后端接线"只有一处, 不再各路由各写一遍.
 */

interface BackendRootsOptions {
  // 限定只装某个项目 (已知目标属于某项目时用, 避免全表扫描).
  projectId?: string | null;
  // 是否附带 skill/memory 与内置资源根 (上下文相关路由才需要).
  includeContext?: boolean;
}

const USER_LEVEL_SKILL_DIR = 'skills';
const USER_LEVEL_MEMORY_DIR = 'memories';

/*
 * Per-extension user data dirs owned by `userId`: <EXTENSION_DATA_ROOT>/<name>/users/<uid>.
 * A normal user only ever receives their own uid here, so the rule stays "self only".
 */
function extensionUserRoots(userId: string): RootSpec[] {
  const out: RootSpec[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(EXTENSION_DATA_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of names) {
    out.push({ kind: 'extension_user_data', path: path.join(EXTENSION_DATA_ROOT, name, 'users', userId) });
  }
  return out;
}

/*
 * The full root set a backend request may use, derived from the DB and config.
 * Admin short-circuits (authorize already grants everything), so we skip the
 * project / extension scans for admins.
 */
function backendRoots(user: Subject | null | undefined, opts: BackendRootsOptions = {}): RootSpec[] {
  const roots: RootSpec[] = [];
  if (!user?.id) return roots;
  const uid = String(user.id);
  if (user.work_dir) roots.push({ kind: 'user_home', path: String(user.work_dir) });
  if (isAdmin(user)) return roots;

  // 用户能读的项目: 角色决定读/写 (viewer 只读, developer/owner 读写)
  // Projects the user belongs to; the role decides read vs write
  try {
    const rows = db.prepare(
      "SELECT id, bind_path FROM projects WHERE bind_path IS NOT NULL AND bind_path <> ''",
    ).all() as Array<{ id: string; bind_path: string }>;
    for (const row of rows) {
      if (opts.projectId && String(row.id) !== String(opts.projectId)) continue;
      const role = effectiveProjectRole(user, String(row.id));
      if (!role) continue;
      roots.push({ kind: 'project', path: row.bind_path, role: role as ProjectRole });
    }
  } catch { /* 迁移未完成等场景下跳过项目根, 不阻断其他根 */ }

  roots.push(...extensionUserRoots(uid));
  // 上传产物落在项目 bind_path/.imac/upload 或 user.work_dir/uploads, 已分别被
  // project / user_home 两个根覆盖, 不再单列一个"全员可读"的上传根。
  // Uploaded files live under the project's .imac/upload or the user's work_dir,
  // already covered by the project / user_home roots.
  roots.push({ kind: 'temp', path: tempRootFor(uid) });

  if (opts.includeContext) {
    const core = process.env.CORE_DATA_PATH || '/data/protected_data';
    const builtin = path.resolve(__dirname, '..', '..', '..', 'skills');
    roots.push({ kind: 'context_personal', path: path.join(core, USER_LEVEL_SKILL_DIR, uid, 'skills') });
    roots.push({ kind: 'context_personal', path: path.join(core, USER_LEVEL_MEMORY_DIR, `user=${uid}`, 'default_project') });
    roots.push({ kind: 'context_builtin', path: builtin });
    if (opts.projectId) {
      const role = effectiveProjectRole(user, String(opts.projectId));
      if (role) {
        roots.push({ kind: 'context_project', path: path.join(core, USER_LEVEL_SKILL_DIR, uid, `project=${opts.projectId}`, 'skills'), role: role as ProjectRole });
        roots.push({ kind: 'context_project', path: path.join(core, USER_LEVEL_MEMORY_DIR, `user=${uid}`, `project=${opts.projectId}`), role: role as ProjectRole });
      }
    }
  }
  return roots;
}

/*
 * Legacy-shaped helper kept for drop-in replacement: may this user download
 * `absPath`? Equivalent to the old routes/files.ts canDownloadPath union.
 */
function canDownloadPath(user: Subject | null | undefined, absPath: unknown): boolean {
  return canAccess(user, 'read', absPath, backendRoots(user));
}

export {
  normalizePath,
  isWithin,
  joinWithin,
  tempRootFor,
  ensureTempRoot,
  capabilitiesFor,
  grantsFor,
  authorize,
  canAccess,
  backendRoots,
  extensionUserRoots,
  canDownloadPath,
};
export type { Action, ProjectRole, RootKind, RootSpec, Subject, Grant, Decision, BackendRootsOptions };
