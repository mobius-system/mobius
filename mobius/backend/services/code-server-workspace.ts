import * as fs from 'fs';
import * as path from 'path';
import { APP_DIR, EXTENSION_ROOT } from '../config';

function normalizeAbsPath(value: any): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return path.resolve(trimmed);
}

function isWithinPath(rootPath: any, targetPath: any): boolean {
  const root = normalizeAbsPath(rootPath);
  const target = normalizeAbsPath(targetPath);
  if (!root || !target) return false;
  return target === root || target.startsWith(root + path.sep);
}

// /tmp 下的路径一律放行: 临时产物/日志/导出等不归 bind_path 管.
const TMP_ROOT = '/tmp';
function isWithinTmp(targetPath: any): boolean {
  return isWithinPath(TMP_ROOT, targetPath);
}

function isAllowedWorkspacePath(project: any, targetPath: any): boolean {
  const target = normalizeAbsPath(targetPath);
  if (isWithinTmp(target)) return true;
  const bindRoot = normalizeAbsPath(project?.bind_path);
  if (!bindRoot || !target) return false;
  if (isWithinPath(bindRoot, target)) return true;
  return target === path.dirname(bindRoot);
}

function payloadRootForWorkspace(project: any, workspacePath: any): string {
  const bindRoot = normalizeAbsPath(project?.bind_path);
  const workspaceRoot = normalizeAbsPath(workspacePath);
  if (workspaceRoot && isAllowedWorkspacePath(project, workspaceRoot)) return workspaceRoot;
  return bindRoot;
}

function extensionWorkspacePath(project: any): string {
  const extensionName = typeof project?.extension_name === 'string' ? project.extension_name.trim() : '';
  if (!extensionName || !/^[a-z][a-z0-9-]{0,31}$/.test(extensionName)) return '';
  const base = normalizeAbsPath(EXTENSION_ROOT || path.join(APP_DIR, 'mobius', 'extension'));
  const target = path.join(base, extensionName);
  return isWithinPath(base, target) ? target : '';
}

function defaultCodeServerWorkspace(project: any): string {
  if (!project?.bind_path) return '';
  if (project.kind === 'extension') {
    const extPath = extensionWorkspacePath(project);
    if (extPath) return extPath;
  }
  return normalizeAbsPath(project.bind_path);
}

function resolveCodeServerWorkspace(project: any, requestedFolder: any): { error: string; code: string } | { workspacePath: string } {
  const bindRoot = normalizeAbsPath(project?.bind_path);
  if (!bindRoot) {
    return { error: '项目未配置 bind_path', code: 'BIND_PATH_INVALID' };
  }

  const candidate = normalizeAbsPath(requestedFolder) || defaultCodeServerWorkspace(project);
  if (!candidate) {
    return { error: 'VSCode 打开路径为空', code: 'BIND_PATH_INVALID' };
  }
  if (!isAllowedWorkspacePath(project, candidate)) {
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

function validateCodeServerPayload(project: any, payloadValue: any, workspacePath: any): { ok: boolean; error?: string; code?: string } {
  const filePath = extractPayloadPath(payloadValue);
  if (!filePath) return { ok: true };
  const target = normalizeAbsPath(filePath);
  if (isWithinTmp(target)) return { ok: true };
  const allowedRoot = payloadRootForWorkspace(project, workspacePath);
  if (!allowedRoot || !target || !isWithinPath(allowedRoot, target)) {
    return { ok: false, error: 'VSCode 打开文件不在当前允许的工作区内', code: 'BIND_PATH_DENIED' };
  }
  return { ok: true };
}

export {
  defaultCodeServerWorkspace,
  resolveCodeServerWorkspace,
  validateCodeServerPayload,
  isAllowedWorkspacePath,
  isWithinPath,
};
