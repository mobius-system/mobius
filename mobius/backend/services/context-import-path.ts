import fs from 'fs';
import path from 'path';
import { Projects } from '../repositories/projects';
import { effectiveProjectRole } from './access-control';
import { isWithin, tempRootFor } from './file-access';

function inside(root: string, target: string): boolean {
  // 越界判断统一走 file-access.isWithin, 不再手写 startsWith
  // Containment goes through file-access.isWithin instead of a local check
  return isWithin(root, target);
}

function realExisting(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return fs.realpathSync(path.resolve(value.trim()));
  } catch {
    return null;
  }
}

/**
 * Limit server-side Skill/Memory imports to paths the caller can legitimately read.
 * Admins keep the operational escape hatch; normal users never get arbitrary absolute-path reads.
 */
export function canImportLocalPath(user: any, sourcePath: unknown, projectId?: string | null): boolean {
  const target = realExisting(sourcePath);
  if (!target || !user?.id) return false;
  if (user.role === 'admin') return true;

  if (inside(user.work_dir, target)) return true;
  // temp 只认本人的 per-user 根 (原先是整个 os.tmpdir()), 与 file-access 同口径;
  // agent 侧的 TMPDIR 已指向这里, 所以"agent 产物 → 导入 skill/memory"照常可用。
  // Only the subject's own per-user temp root (was all of os.tmpdir()), matching
  // file-access; agents get TMPDIR pointed here, so their artifacts still import.
  if (inside(tempRootFor(user.id), target)) return true;

  return Projects.listAll().some((project: any) => {
    if (projectId && String(project.id) !== String(projectId)) return false;
    const role = effectiveProjectRole(user, project);
    return (role === 'owner' || role === 'developer') && project.bind_path && inside(project.bind_path, target);
  });
}

export function normalizeImportSourcePath(sourcePath: unknown): string | null {
  return realExisting(sourcePath);
}
