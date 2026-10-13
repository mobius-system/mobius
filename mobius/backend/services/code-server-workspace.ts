import * as fs from 'fs';
import * as path from 'path';
import { APP_DIR, EXTENSION_ROOT } from '../config';
import { db } from '../../db';
import { isWithin, normalizePath, tempRootFor } from './file-access';
import { isolationActiveFor } from './user-isolation/docker-sandbox';

function isSystemTempPath(targetPath: any, userId?: string): boolean {
  const target = normalizePath(targetPath);
  if (!target) return false;
  // 只放行本人的 per-user 临时目录 (与 file-access 的 temp 根同口径)
  // Only the subject's own per-user temp dir is allowed, matching file-access
  if (!userId) return false;
  return isWithin(tempRootFor(userId), target);
}

/*
 * Docker isolation: the sandbox container sees exactly the owner's work dir
 * (its HOME is <work_dir>/.sbx-home, same bind mount), so every path under it is
 * reachable inside the container and belongs to the same user. code-server (which
 * runs in that container) may therefore open any of them; the bind root's parent
 * rule below is far too narrow — it rejects .sbx-home, a direct child of work_dir.
 */
function isOwnWorkDirPath(userId: string | undefined, target: string): boolean {
  if (!userId || !isolationActiveFor(userId)) return false;
  const row = db.prepare('SELECT work_dir FROM users WHERE id = ?').get(String(userId)) as { work_dir?: string } | undefined;
  const workDir = normalizePath(row?.work_dir);
  if (!workDir) return false;
  let root = workDir;
  try { if (fs.existsSync(workDir)) root = fs.realpathSync(workDir); } catch { /* 保持字面路径 */ }
  return isWithin(root, target);
}

/*
 * A path is an allowed VSCode workspace when it sits inside the project bind
 * root, is the bind root's direct parent (so sibling projects stay editable),
 * is the caller's own temp dir, or (in docker isolation) lives anywhere under
 * the caller's own work dir. Admins run code-server on the host outside any
 * sandbox, so the workspace allowlist never applies to them — any real path is
 * openable.
 */
function isAllowedWorkspacePath(project: any, targetPath: any, userId?: string, isAdmin?: boolean): boolean {
  const rawTarget = normalizePath(targetPath);
  if (!rawTarget) return false;
  if (isAdmin) return true;
  const rawRoot = normalizePath(project?.bind_path);
  if (!rawRoot) return false;
  let target = rawTarget;
  let bindRoot = rawRoot;
  try {
    if (fs.existsSync(rawRoot)) bindRoot = fs.realpathSync(rawRoot);
    if (fs.existsSync(rawTarget)) target = fs.realpathSync(rawTarget);
  } catch { return false; }
  if (!bindRoot || !target) return false;
  // code-server 允许打开绑定仓库的直接父目录，便于同一工作区中的多项目编辑；
  // 但不允许父目录下的任意兄弟目录作为独立入口。
  const parent = path.dirname(bindRoot);
  if (isWithin(bindRoot, target) || target === parent) return true;
  if (isOwnWorkDirPath(userId, target)) return true;
  return isSystemTempPath(target, userId);
}

function payloadRootForWorkspace(project: any, workspacePath: any, userId?: string, isAdmin?: boolean): string {
  const bindRoot = normalizePath(project?.bind_path);
  const workspaceRoot = normalizePath(workspacePath);
  if (workspaceRoot && isAllowedWorkspacePath(project, workspaceRoot, userId, isAdmin)) return workspaceRoot;
  return bindRoot;
}

function extensionWorkspacePath(project: any): string {
  const extensionName = typeof project?.extension_name === 'string' ? project.extension_name.trim() : '';
  if (!extensionName || !/^[a-z][a-z0-9-]{0,31}$/.test(extensionName)) return '';
  const base = normalizePath(EXTENSION_ROOT || path.join(APP_DIR, 'mobius', 'extension'));
  const target = path.join(base, extensionName);
  return isWithin(base, target) ? target : '';
}

function defaultCodeServerWorkspace(project: any): string {
  if (!project?.bind_path) return '';
  if (project.kind === 'extension') {
    const extPath = extensionWorkspacePath(project);
    if (extPath) return extPath;
  }
  return normalizePath(project.bind_path);
}

/*
 * Resolve the folder code-server should open: the requested folder when it is an
 * allowed workspace, otherwise the project bind root. Caller must have already
 * authorized the user against the project.
 */
function resolveCodeServerWorkspace(
  project: any,
  requestedFolder: any,
  userId?: string,
  isAdmin?: boolean,
): { error: string; code: string } | { workspacePath: string } {
  const bindRoot = normalizePath(project?.bind_path);
  if (!bindRoot) {
    return { error: '项目未配置 bind_path', code: 'BIND_PATH_INVALID' };
  }

  const candidate = normalizePath(requestedFolder) || defaultCodeServerWorkspace(project);
  if (!candidate) {
    return { error: 'VSCode 打开路径为空', code: 'BIND_PATH_INVALID' };
  }
  if (!isAllowedWorkspacePath(project, candidate, userId, isAdmin)) {
    return { error: 'VSCode 打开路径不在项目绑定路径或其上一级目录内', code: 'BIND_PATH_DENIED' };
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    return { error: `VSCode 打开路径不存在: ${candidate}`, code: 'BIND_PATH_INVALID' };
  }
  return { workspacePath: candidate };
}

function extractPayloadPath(value: any): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const payload = JSON.parse(value);
    if (!Array.isArray(payload)) return '';
    for (const command of payload) {
      if (!Array.isArray(command) || command[0] !== 'openFile') continue;
      const target = typeof command[1] === 'string' ? command[1] : '';
      if (!target) continue;
      const remoteMatch = target.match(/^vscode-remote:\/\/[^/]+(\/.*)$/);
      return remoteMatch ? remoteMatch[1] : target;
    }
  } catch {
    return '';
  }
  return '';
}

/*
 * Validate the `payload` openFile command against the workspace that will be
 * opened. Deny files outside that workspace so a link cannot pull code-server
 * into reading an arbitrary host path.
 */
function validateCodeServerPayload(
  project: any,
  payloadValue: any,
  workspacePath: any,
  userId?: string,
  isAdmin?: boolean,
): { ok: boolean; error?: string; code?: string } {
  // 管理员不受工作区约束: 打开的文件同样不设限
  // Admins are unrestricted, so files they open are too
  if (isAdmin) return { ok: true };
  const filePath = extractPayloadPath(payloadValue);
  if (!filePath) return { ok: true };
  const target = normalizePath(filePath);
  const allowedRoot = payloadRootForWorkspace(project, workspacePath, userId, isAdmin);
  if (!allowedRoot || !target) {
    return { ok: false, error: 'VSCode 打开文件不在当前允许的工作区内', code: 'BIND_PATH_DENIED' };
  }
  // ✨ 文件必须落在工作区内; 目标是"本人 temp"时同样放行
  // The file must sit inside the workspace, or the caller's own temp dir
  if (!isWithin(allowedRoot, target) && !isSystemTempPath(target, userId)) {
    return { ok: false, error: 'VSCode 打开文件不在当前允许的工作区内', code: 'BIND_PATH_DENIED' };
  }
  return { ok: true };
}

export {
  defaultCodeServerWorkspace,
  resolveCodeServerWorkspace,
  validateCodeServerPayload,
  isAllowedWorkspacePath,
  isSystemTempPath,
};
