import fs from 'fs';
import os from 'os';
import path from 'path';
import { APP_DIR, HIDDEN_FOLDER_NAME } from '../config';
import { Projects } from '../repositories/projects';
import { effectiveProjectRole } from './access-control';

function inside(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t === r || t.startsWith(r + path.sep);
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
  const uploadRoots = [
    path.join(os.tmpdir()),
    path.join(APP_DIR, HIDDEN_FOLDER_NAME, 'upload'),
  ];
  if (uploadRoots.some((root) => inside(root, target))) return true;

  return Projects.listAll().some((project: any) => {
    if (projectId && String(project.id) !== String(projectId)) return false;
    const role = effectiveProjectRole(user, project);
    return (role === 'owner' || role === 'developer') && project.bind_path && inside(project.bind_path, target);
  });
}

export function normalizeImportSourcePath(sourcePath: unknown): string | null {
  return realExisting(sourcePath);
}
