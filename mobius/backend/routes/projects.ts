import express from 'express';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { auth } from '../middleware/auth';
import { Projects } from '../repositories/projects';
import { ProjectTodos } from '../repositories/project-todos';
import { Issues } from '../repositories/issues';
import { Skills } from '../repositories/skills';
import { Memories } from '../repositories/memories';
import { Users } from '../repositories/users';
// @ts-ignore — service 仍是 .js
import {
  buildIssueContextPreview,
  buildIssueSelectionDefaults,
  buildProjectIssueContextPreview,
  buildProjectIssueSelectionDefaults,
} from '../services/session-context';
// @ts-ignore — service 仍是 .js
import { ensureGuidedDemoAssets } from '../services/guided-demo-assets';
// @ts-ignore — service 仍是 .js
import { defaultCodeServerWorkspace } from '../services/code-server-workspace';
// @ts-ignore — service 仍是 .js
import {
  canReadProject,
  canManageProject,
  canCreateIssue,
  isHidden,
  normalizeProjectVisibility,
  projectAllowsReaderWrite,
  projectAccessPayload,
  setHidden,
  setProjectAccess,
  uniqStringList,
} from '../services/access-control';
// @ts-ignore — service 仍是 .js
import {
  UserProjectView,
  filterProjectListForUser,
  normalizeProjectSearch,
} from '../services/user-project-view';
// @ts-ignore — service 仍是 .js
import { recordAdminAuditIfCrossUser } from '../services/admin-audit';
// @ts-ignore — service 仍是 .js
import modelRegistry from '../services/model-registry';
import {
  APP_DIR,
  BACKEND_WORKER_LOG_DIR,
  ENABLE_PASSWORD_LOGIN,
  MOBIUS_SSH_FORWARD_USER,
  MOBIUS_SSH_PORT,
  MOBIUS_SSH_PRIVATE_KEY_PATH,
  MOBIUS_SSH_URL,
  VSCODE_WEB_URL,
  FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES_MIN,
  FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES_MIN,
  FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX,
  FORGOTTEN_FLAG_BACKOFF_MIN,
  FORGOTTEN_FLAG_BACKOFF_MAX,
  FORGOTTEN_FLAG_PATIENCE_MIN,
  FORGOTTEN_FLAG_PATIENCE_MAX,
  HIDDEN_FOLDER_NAME,
} from '../config';

const router = express.Router();
const MAIN_PROJECT_PORT_REL = path.join(HIDDEN_FOLDER_NAME, 'port_forward', 'main_project_port.txt');

// 统一取当前用户 (auth 中间件已塞到 req.user)
function userOf(req: express.Request): any {
  return (req as any).user;
}

function normalizeRollbackHash(value: unknown): string {
  const hash = String(value || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) return '';
  return hash;
}

function spawnProductOtherVersion(gitHash: string): { pid: number | undefined; log_path: string } {
  const logDir = BACKEND_WORKER_LOG_DIR;
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'deploy_other_version.log');
  const out = fs.openSync(logPath, 'a');
  const child = spawn('python3', ['start.py', '--detach', '--other-versions', gitHash], {
    cwd: APP_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  // 子进程已通过 stdio 继承自己的 fd 副本, 父进程关闭自身引用防止 fd 泄漏 (长期运行致 EMFILE).
  fs.closeSync(out);
  return { pid: child.pid, log_path: logPath };
}

function normalizeProjectPort(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!/^[0-9]{1,5}$/.test(text)) return null;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

interface ParsedSshUrl {
  raw: string;
  host: string;
  port: number | null;
}

function parseMobiusSshUrl(value: unknown): ParsedSshUrl {
  const raw = String(value || '').trim();
  if (!raw) return { raw, host: '', port: null };

  if (/^ssh:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return {
        raw,
        host: parsed.hostname || '',
        port: parsed.port ? normalizeProjectPort(parsed.port) : null,
      };
    } catch {
      return { raw, host: '', port: null };
    }
  }

  const withoutUser = raw.includes('@') ? raw.slice(raw.lastIndexOf('@') + 1) : raw;
  if (withoutUser.startsWith('[')) {
    const end = withoutUser.indexOf(']');
    const host = end > 0 ? withoutUser.slice(1, end) : '';
    const rest = end > 0 ? withoutUser.slice(end + 1) : '';
    const port = rest.startsWith(':') ? normalizeProjectPort(rest.slice(1)) : null;
    return { raw, host, port };
  }

  const lastColon = withoutUser.lastIndexOf(':');
  if (lastColon > 0 && withoutUser.indexOf(':') === lastColon) {
    const host = withoutUser.slice(0, lastColon).trim();
    const port = normalizeProjectPort(withoutUser.slice(lastColon + 1));
    return { raw, host, port };
  }

  return { raw, host: withoutUser.trim(), port: null };
}

function readSshPrivateKey(): { privateKey: string; privateKeyExists: boolean } {
  const keyPath = String(MOBIUS_SSH_PRIVATE_KEY_PATH || '').trim();
  if (!keyPath) return { privateKey: '', privateKeyExists: false };
  try {
    const stat = fs.statSync(keyPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 64 * 1024) {
      return { privateKey: '', privateKeyExists: false };
    }
    return { privateKey: fs.readFileSync(keyPath, 'utf8'), privateKeyExists: true };
  } catch {
    return { privateKey: '', privateKeyExists: false };
  }
}

function mainProjectPortPath(project: any): string {
  if (!project?.bind_path) return '';
  return path.join(project.bind_path, MAIN_PROJECT_PORT_REL);
}

function spawnProductHardReset(gitHash: string): { pid: number | undefined; log_path: string } {
  const logDir = BACKEND_WORKER_LOG_DIR;
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'hard_reset_version.log');
  const out = fs.openSync(logPath, 'a');
  const child = spawn('python3', ['start.py', '--detach', '--hard-reset', gitHash], {
    cwd: APP_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  // 子进程已通过 stdio 继承自己的 fd 副本, 父进程关闭自身引用防止 fd 泄漏 (长期运行致 EMFILE).
  fs.closeSync(out);
  return { pid: child.pid, log_path: logPath };
}

// 在项目 bind_path 内解析子路径, 返回 { absPath, relPath } 或 { error }.
// 允许的字符: 任何 (用 path.resolve 规范化), 但绝对值必须落在 bind_path 子树.
function resolveProjectPath(
  bindPath: string | null | undefined,
  rawPath: unknown = '/',
): { error: string } | { root: string; relPath: string; absPath: string } {
  if (!bindPath) return { error: '项目未绑定路径' };
  const root = path.resolve(bindPath);
  const relPath = String(rawPath || '/').replace(/\.\./g, '');
  const absPath = path.resolve(root, relPath.replace(/^\/+/, ''));
  if (absPath !== root && !absPath.startsWith(root + path.sep)) return { error: 'Access denied' };
  return { root, relPath: '/' + path.relative(root, absPath).replace(/\\/g, '/'), absPath };
}

function isProjectImportDemoBindPath(bindPath: unknown): boolean {
  const normalized = path.resolve(String(bindPath || '')).replace(/\\/g, '/');
  return normalized.endsWith('/imac-demo/todomvc-import');
}

function fileIncludes(absPath: string, marker: string): boolean {
  try {
    return fs.readFileSync(absPath, 'utf8').includes(marker);
  } catch {
    return false;
  }
}

function removePathIfExists(absPath: string, root: string, removed: string[]): void {
  if (!absPath || absPath === root || !absPath.startsWith(root + path.sep)) return;
  if (!fs.existsSync(absPath)) return;
  fs.rmSync(absPath, { recursive: true, force: true });
  removed.push('/' + path.relative(root, absPath).replace(/\\/g, '/'));
}

function clearProjectImportUploadedSample(project: any): string[] {
  const resolved = resolveProjectPath(project.bind_path, '/');
  if ('error' in resolved) throw new Error(resolved.error);
  const { root } = resolved;
  const removed: string[] = [];

  removePathIfExists(path.join(root, 'vanilla-todomvc'), root, removed);
  removePathIfExists(path.join(root, 'vanilla-todomvc-upload-sample.zip'), root, removed);

  const rootLooksLikeSample = (
    fileIncludes(path.join(root, 'package.json'), 'vanilla-todomvc-upload-sample') ||
    fileIncludes(path.join(root, 'index.html'), 'todo-app') ||
    fileIncludes(path.join(root, 'src', 'app.js'), 'todoStorageKey')
  );

  if (rootLooksLikeSample) {
    for (const rel of ['index.html', 'package.json', 'src']) {
      removePathIfExists(path.join(root, rel), root, removed);
    }
  }

  return removed;
}

// 校验 bindPath：必须位于用户 work_dir 内；默认要求已存在且为目录。
// 新建项目可传 createIfMissing，在确认创建时同步创建目录。
// rawPath 可以是绝对路径（必须在 work_dir 下），或相对家目录的路径（如 "/imac-test"，会被解析到 work_dir 下）。
// 规范化 git 仓库数组：[{url, name?}, ...]。空 URL 项被丢弃；非数组抛错。
function normalizeGitRepos(raw: unknown): Array<{ url: string; name?: string }> | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new Error('git 仓库列表格式错误');
  const out: Array<{ url: string; name?: string }> = [];
  for (const item of raw) {
    if (!item) continue;
    const url = typeof item === 'string' ? item : (typeof (item as any).url === 'string' ? (item as any).url : '');
    const trimmed = url.trim();
    if (!trimmed) continue;
    if (trimmed.length > 500) throw new Error('git 仓库地址过长');
    const name = (typeof item === 'object' && typeof (item as any).name === 'string') ? (item as any).name.trim().slice(0, 100) : '';
    out.push(name ? { url: trimmed, name } : { url: trimmed });
  }
  return out;
}

interface ResolveBindPathOptions {
  createIfMissing?: boolean;
}

function resolveBindPath(rawPath: unknown, userWorkDir: unknown, options: ResolveBindPathOptions = {}): string {
  if (rawPath === undefined || rawPath === null || rawPath === '') throw new Error('绑定路径为必填项');
  if (typeof rawPath !== 'string') throw new Error('绑定路径格式错误');
  if (!userWorkDir) throw new Error('用户尚未配置 work_dir, 无法绑定项目路径');
  const createIfMissing = !!options.createIfMissing;
  const userRoot = path.resolve(String(userWorkDir));
  let abs: string;
  if (path.isAbsolute(rawPath) && (rawPath === userRoot || rawPath.startsWith(userRoot + path.sep))) {
    abs = path.resolve(rawPath);
  } else {
    // 相对路径或相对家目录的伪绝对路径 (e.g. "/imac-test")
    abs = path.resolve(userRoot, rawPath.replace(/^\//, ''));
  }
  if (abs !== userRoot && !abs.startsWith(userRoot + path.sep)) throw new Error('绑定路径必须位于您的工作目录下');
  if (!fs.existsSync(abs)) {
    if (!createIfMissing) throw new Error('路径不存在');
    try {
      fs.mkdirSync(abs, { recursive: true });
    } catch (e) {
      throw new Error(`创建绑定路径失败: ${(e as Error).message}`);
    }
  }
  if (!fs.statSync(abs).isDirectory()) throw new Error('绑定路径必须是目录');
  return abs;
}

// 手动输入的绑定路径: 用户显式选择"不校验" —— 不检查是否存在 / 是否目录 /
// 是否落在 work_dir 内, 把控制权完全交给用户. 仅做非空与(绝对路径)规范化.
function resolveBindPathManual(rawPath: unknown): string {
  if (rawPath === undefined || rawPath === null || rawPath === '') throw new Error('绑定路径为必填项');
  if (typeof rawPath !== 'string') throw new Error('绑定路径格式错误');
  const p = rawPath.trim();
  if (!p) throw new Error('绑定路径为必填项');
  return path.isAbsolute(p) ? path.resolve(p) : p;
}

function removeDemoWorkspaceIfRequested(
  project: any,
  user: any,
  cleanupRequested: boolean,
): { removed: boolean; reason?: string; path?: string } {
  if (!cleanupRequested) return { removed: false };
  const bindPath = (project?.bind_path || '').trim();
  const workDir = (user?.work_dir || '').trim();
  if (!bindPath || !workDir) return { removed: false };

  const root = path.resolve(workDir);
  const demoRoot = path.resolve(root, 'imac-demo');
  const target = path.resolve(bindPath);
  const rel = path.relative(root, target);
  const isDemoPath = rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep)[0] === 'imac-demo';
  if (!isDemoPath || target === root || target === demoRoot) {
    return { removed: false, reason: '非演示目录, 已跳过工作区清理' };
  }
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    return { removed: true, path: target };
  }
  return { removed: false };
}

function normalizeIntervalMinutes(raw: unknown, label: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${label}必须是整数分钟`);
  if (n < min) throw new Error(`${label}不能小于 ${min} 分钟`);
  if (n > FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX) {
    throw new Error(`${label}不能超过 ${FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX} 分钟`);
  }
  return n;
}

function normalizeBackoff(raw: unknown, label: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${label}必须是数字`);
  if (n < FORGOTTEN_FLAG_BACKOFF_MIN) throw new Error(`${label}不能小于 ${FORGOTTEN_FLAG_BACKOFF_MIN}`);
  if (n > FORGOTTEN_FLAG_BACKOFF_MAX) throw new Error(`${label}不能超过 ${FORGOTTEN_FLAG_BACKOFF_MAX}`);
  return n;
}

function normalizePatience(raw: unknown, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${label}必须是整数`);
  if (n < FORGOTTEN_FLAG_PATIENCE_MIN) throw new Error(`${label}不能小于 ${FORGOTTEN_FLAG_PATIENCE_MIN}`);
  if (n > FORGOTTEN_FLAG_PATIENCE_MAX) throw new Error(`${label}不能超过 ${FORGOTTEN_FLAG_PATIENCE_MAX}`);
  return n;
}

function accessList(body: any, snakeKey: string, camelKey: string): string[] {
  return uniqStringList(body?.[snakeKey] ?? body?.[camelKey]);
}

interface ProjectAccessBodyResult {
  visibility: unknown;
  allowUserIds: string[] | undefined;
  allowGroupIds: string[] | undefined;
}

function projectAccessBody(body: any = {}): ProjectAccessBodyResult {
  const maybeList = (snakeKey: string, camelKey: string): string[] | undefined => (
    Object.prototype.hasOwnProperty.call(body, snakeKey) || Object.prototype.hasOwnProperty.call(body, camelKey)
      ? accessList(body, snakeKey, camelKey)
      : undefined
  );
  return {
    visibility: body.visibility,
    allowUserIds: maybeList('allow_user_ids', 'allowUserIds'),
    allowGroupIds: maybeList('allow_group_ids', 'allowGroupIds'),
  };
}

const TODO_TITLE_MAX_LENGTH = 500;
const TODO_DESCRIPTION_MAX_LENGTH = 4000;
const EXTENSION_DISPLAY_NAME_MAX_LENGTH = 120;
const EXTENSION_DESCRIPTION_MAX_LENGTH = 1000;

function hasOwn(obj: any, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeTodoTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('待办标题格式错误');
  const title = raw.trim();
  if (!title) throw new Error('请填写待办标题');
  if (title.length > TODO_TITLE_MAX_LENGTH) throw new Error(`待办标题不能超过 ${TODO_TITLE_MAX_LENGTH} 字符`);
  return title;
}

function normalizeTodoDescription(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new Error('待办描述格式错误');
  if (raw.length > TODO_DESCRIPTION_MAX_LENGTH) throw new Error(`待办描述不能超过 ${TODO_DESCRIPTION_MAX_LENGTH} 字符`);
  return raw;
}

function normalizeTodoSortOrder(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error('待办排序值必须是整数');
  return n;
}

function boolFromBody(body: any, snakeKey: string, camelKey: string, fallback = false): boolean {
  if (hasOwn(body, snakeKey)) return !!body[snakeKey];
  if (hasOwn(body, camelKey)) return !!body[camelKey];
  return fallback;
}

function hasBoolField(body: any, snakeKey: string, camelKey: string): boolean {
  return hasOwn(body, snakeKey) || hasOwn(body, camelKey);
}

// 项目级默认模型偏好: 接受 null/空串 (表示"未指定, 跟系统默认"), 或 model-registry
// listSessionModelOptions() 暴露的某个 key. 不在白名单 → 抛 400.
function normalizeDefaultModel(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const allowed = modelRegistry.listSessionModelOptions().map((opt: any) => opt.key);
  if (!allowed.includes(trimmed)) {
    throw new Error(`默认模型偏好必须是可选模型之一: ${allowed.join(', ') || '(暂无可选模型)'}`);
  }
  return trimmed;
}

function shapeProjectForUser(project: any, user: any, opts: { mutedIds?: Set<string> } = {}): any {
  if (!project) return project;
  const canCreate = canCreateIssue(user, project);
  const muted = opts.mutedIds
    ? opts.mutedIds.has(project.id)
    : (user?.id ? UserProjectView.isMuted(user.id, project.id) : false);
  // 可见性单一来源 = 用户屏蔽 (muted, Store B). project_user_hidden (A) 已一次性迁移并入 mute,
  // user_resource_hides (C) 对 project 恒与 mute 同步写入 → 二者都冗余, 不再参与判定.
  // project.hidden (A) 仅保留给未登录回退 (实际不会出现).
  const hidden = user?.id ? !!muted : !!project.hidden;
  return {
    ...project,
    visibility: normalizeProjectVisibility(project.visibility, 'private'),
    access: projectAccessPayload(project.id),
    can_manage: canManageProject(user, project),
    can_create_issue: canCreate,
    can_create_session: projectAllowsReaderWrite(user, project, 'can_run_session'),
    can_create_research: canCreate && !!project.research_enabled,
    muted,
    muted_label: muted ? '已屏蔽' : null,
    hidden,
  };
}

function normalizeText(value: unknown, fallback: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, maxLength);
}

function writeFileExclusive(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { flag: 'wx' });
}

interface ExtensionSkeletonArgs {
  extensionName: string;
  displayName: unknown;
  description: unknown;
}

interface ExtensionManifest {
  name: string;
  display_name: string;
  description: string;
  version: string;
}

interface ExtensionSkeletonResult {
  extRoot: string;
  manifest: ExtensionManifest;
}

interface HttpError extends Error {
  statusCode?: number;
}

function createExtensionSkeleton({ extensionName, displayName, description }: ExtensionSkeletonArgs): ExtensionSkeletonResult {
  // 局部 require 以避免顶层导入未迁移的 .js service
  const { EXTENSION_ROOT } = require('../config');
  const extRoot = path.join(EXTENSION_ROOT, extensionName);
  if (fs.existsSync(extRoot)) {
    throw Object.assign(new Error(`拓展目录已存在：mobius/extension/${extensionName}/`), { statusCode: 400 }) as HttpError;
  }

  const safeDisplayName = normalizeText(displayName, extensionName, EXTENSION_DISPLAY_NAME_MAX_LENGTH);
  const safeDescription = typeof description === 'string' ? description.trim().slice(0, EXTENSION_DESCRIPTION_MAX_LENGTH) : '';
  const manifest: ExtensionManifest = {
    name: extensionName,
    display_name: safeDisplayName,
    description: safeDescription,
    version: '0.1.0',
  };

  fs.mkdirSync(path.join(extRoot, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(extRoot, 'frontend'), { recursive: true });
  try {
    writeFileExclusive(path.join(extRoot, 'extension.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileExclusive(path.join(extRoot, 'backend', 'extension_backend_handler.js'), `/**
 * ${extensionName}/backend/extension_backend_handler.js
 *
 * CommonJS handler for /api/ext. Keep it stateless and write only under ext_data_dir.
 */
const path = require('path');
const fs = require('fs/promises');

const STATE_FILE = 'state.json';

async function readState(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = async function extensionBackendHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  extension_name,
  logger,
}) {
  const action = ext_main_payload && ext_main_payload.action;
  const stateFile = path.join(ext_data_dir, STATE_FILE);

  if (action === 'whoami') {
    return { ok: true, username, display_name, extension_name };
  }

  if (action === 'save_note') {
    const note = typeof ext_main_payload.note === 'string' ? ext_main_payload.note.slice(0, 2000) : '';
    const state = await readState(stateFile);
    state[username] = { note, updated_at: Date.now() };
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
    logger && logger.info && logger.info('save_note', { username });
    return { ok: true };
  }

  if (action === 'load_note') {
    const state = await readState(stateFile);
    return { ok: true, note: state[username]?.note || '' };
  }

  return { ok: true, message: 'Hello from ${extensionName}', action: action || null };
};
`);
    writeFileExclusive(path.join(extRoot, 'frontend', 'index.html'), `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeDisplayName.replace(/[<>&]/g, '')}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="app">
    <section class="hero">
      <p class="eyebrow">Mobius Extension</p>
      <h1>${safeDisplayName.replace(/[<>&]/g, '')}</h1>
      <p class="description">${(safeDescription || `拓展 ${extensionName} 已创建，可以从这里继续开发前端与后端 handler。`).replace(/[<>&]/g, '')}</p>
    </section>

    <section class="panel">
      <div>
        <div class="label">当前拓展</div>
        <div class="value" id="extensionName">${extensionName}</div>
      </div>
      <div>
        <div class="label">当前用户</div>
        <div class="value" id="identity">-</div>
      </div>
      <textarea id="noteInput" placeholder="写一点只有你能看到的调试备注"></textarea>
      <div class="actions">
        <button id="saveBtn" type="button">保存备注</button>
        <button id="loadBtn" type="button">读取备注</button>
      </div>
      <div id="status" class="status"></div>
    </section>
  </main>
  <script type="module" src="./main.js"></script>
</body>
</html>
`);
    writeFileExclusive(path.join(extRoot, 'frontend', 'main.js'), `import { extCall, extName } from '/extension/_sdk/ext.js';

const identityEl = document.getElementById('identity');
const noteInput = document.getElementById('noteInput');
const saveBtn = document.getElementById('saveBtn');
const loadBtn = document.getElementById('loadBtn');
const statusEl = document.getElementById('status');

function setStatus(text, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

async function refreshIdentity() {
  try {
    const data = await extCall({ action: 'whoami' });
    identityEl.textContent = data.display_name || data.username || '-';
    document.getElementById('extensionName').textContent = extName();
  } catch (err) {
    setStatus(err.message || '加载用户信息失败', true);
  }
}

async function saveNote() {
  try {
    await extCall({ action: 'save_note', note: noteInput.value });
    setStatus('已保存');
  } catch (err) {
    setStatus(err.message || '保存失败', true);
  }
}

async function loadNote() {
  try {
    const data = await extCall({ action: 'load_note' });
    noteInput.value = data.note || '';
    setStatus('已读取');
  } catch (err) {
    setStatus(err.message || '读取失败', true);
  }
}

saveBtn.addEventListener('click', saveNote);
loadBtn.addEventListener('click', loadNote);
refreshIdentity();
`);
    writeFileExclusive(path.join(extRoot, 'frontend', 'styles.css'), `:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #0f172a;
  color: #e5e7eb;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(circle at 20% 20%, rgba(59, 130, 246, 0.22), transparent 32rem),
    linear-gradient(135deg, #0f172a 0%, #111827 52%, #172554 100%);
}

.app {
  width: min(920px, calc(100vw - 40px));
  margin: 0 auto;
  padding: 56px 0;
}

.hero {
  margin-bottom: 22px;
}

.eyebrow {
  margin: 0 0 10px;
  font-size: 12px;
  letter-spacing: 0;
  color: #93c5fd;
}

h1 {
  margin: 0;
  font-size: 34px;
  line-height: 1.15;
}

.description {
  max-width: 680px;
  color: #cbd5e1;
  line-height: 1.7;
}

.panel {
  display: grid;
  gap: 14px;
  padding: 18px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.72);
}

.label {
  margin-bottom: 4px;
  font-size: 12px;
  color: #94a3b8;
}

.value {
  font-size: 14px;
  color: #f8fafc;
}

textarea {
  width: 100%;
  min-height: 120px;
  resize: vertical;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(15, 23, 42, 0.88);
  color: #f8fafc;
  font: inherit;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

button {
  height: 34px;
  border: 1px solid rgba(96, 165, 250, 0.35);
  border-radius: 8px;
  padding: 0 14px;
  background: rgba(59, 130, 246, 0.18);
  color: #bfdbfe;
  cursor: pointer;
}

button:hover {
  background: rgba(59, 130, 246, 0.28);
}

.status {
  min-height: 18px;
  font-size: 12px;
  color: #86efac;
}

.status.error {
  color: #fca5a5;
}
`);
    return { extRoot, manifest };
  } catch (e) {
    try { fs.rmSync(extRoot, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

function loadReadableProject(req: express.Request, res: express.Response, id: string, notFoundText = '项目未找到'): any | null {
  const user = userOf(req);
  const project = Projects.findById(id, user?.id);
  if (!project || !canReadProject(user, project)) {
    res.status(404).json({ error: notFoundText });
    return null;
  }
  recordAdminAuditIfCrossUser(user, 'read_project', 'project', project.id, project.created_by);
  return project;
}

function loadManageableProject(req: express.Request, res: express.Response, id: string): any | null {
  const project = loadReadableProject(req, res, id);
  if (!project) return null;
  const user = userOf(req);
  if (!canManageProject(user, project)) {
    res.status(403).json({ error: '只有项目 owner/admin 可以修改项目待办' });
    return null;
  }
  return project;
}

const GIT_REPO_SCAN_MAX_DEPTH = 3;
const GIT_REPO_SCAN_MAX_DIRS = 500;
const GIT_COMMIT_LIMIT_DEFAULT = 12;
const GIT_COMMIT_LIMIT_MAX = 30;
const ARCHITECTURE_ISSUE_TITLE = '项目结构绘制';
const ARCHITECTURE_ISSUE_DESCRIPTION = [
  '自动生成或刷新项目系统结构剖析图。',
  `请分析当前项目结构，优先输出单文件 HTML/SVG 架构图到项目绑定路径下的 ${HIDDEN_FOLDER_NAME}/generated_figures/arch.html。`,
  '如需兼容截图或封面，也可以额外输出 arch.svg、arch.png、arch.jpg、arch.jpeg、arch.webp 等常见预览格式。',
].join('\n');
const FIXED_LOGO_REVIEW_PROJECT_ID = '9986bdc3';
const ARCHITECTURE_FIGURE_EXTENSIONS = ['.html', '.htm', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const GIT_FIELD_SEPARATOR = '\x1f';
const GIT_RECORD_SEPARATOR = '\x1e';
const PACKAGE_ZIP_RELATIVE_DIR = path.join(HIDDEN_FOLDER_NAME, 'package_zip');
const PACKAGE_SIZE_WARNING_BYTES = 500 * 1024 * 1024;
const GIT_SCAN_SKIP_DIRS = new Set([
  '.git',
  HIDDEN_FOLDER_NAME,
  '.cache',
  '.next',
  '.nuxt',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'uploads',
  'vendor',
]);

function normalizeCommitLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return GIT_COMMIT_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.floor(n), 1), GIT_COMMIT_LIMIT_MAX);
}

function isWithinPath(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function packageZipDir(root: string): string {
  return path.join(root, PACKAGE_ZIP_RELATIVE_DIR);
}

function isPackageZipPath(root: string, target: string): boolean {
  return isWithinPath(packageZipDir(root), target);
}

function packageEntryType(dirent: fs.Dirent, absPath: string): 'symlink' | 'dir' | 'file' | 'other' {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return 'file';
  try {
    const st = fs.lstatSync(absPath);
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
  } catch {}
  return 'other';
}

function safePackageName(name: unknown): string {
  const raw = String(name || 'project').trim() || 'project';
  const cleaned = raw
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'project';
}

function normalizePackageEntryNames(rawNames: unknown): string[] {
  if (!Array.isArray(rawNames)) throw new Error('请选择要打包的文件或文件夹');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawNames) {
    const name = String(raw || '').trim();
    if (!name || name === '.' || name === '..') continue;
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
      throw new Error('打包条目只能选择项目根目录下的表层文件或文件夹');
    }
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  if (out.length === 0) throw new Error('请至少选择一个文件或文件夹');
  return out;
}

function directorySizeWithoutPackageZip(root: string, target: string): number {
  if (isPackageZipPath(root, target)) return 0;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) {
    try {
      return Buffer.byteLength(fs.readlinkSync(target));
    } catch {
      return 0;
    }
  }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  let children: string[] = [];
  try {
    children = fs.readdirSync(target);
  } catch {
    return 0;
  }
  for (const child of children) {
    total += directorySizeWithoutPackageZip(root, path.join(target, child));
  }
  return total;
}

function projectPackageRoot(project: any): string {
  if (!project?.bind_path) throw new Error('项目未绑定路径');
  const root = path.resolve(project.bind_path);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('项目绑定路径不存在或不是目录');
  return root;
}

interface PackageListEntry {
  name: string;
  type: 'symlink' | 'dir' | 'file' | 'other';
  size: number;
  modified: Date;
  default_selected: boolean;
  excluded_children: string[];
}

function listPackageEntries(project: any): { root: string; entries: PackageListEntry[] } {
  const root = projectPackageRoot(project);
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .map((dirent): PackageListEntry | null => {
      const absPath = path.join(root, dirent.name);
      const type = packageEntryType(dirent, absPath);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(absPath);
      } catch {
        return null;
      }
      return {
        name: dirent.name,
        type,
        size: directorySizeWithoutPackageZip(root, absPath),
        modified: st.mtime,
        default_selected: dirent.name !== HIDDEN_FOLDER_NAME,
        excluded_children: dirent.name === HIDDEN_FOLDER_NAME ? [PACKAGE_ZIP_RELATIVE_DIR.replace(/\\/g, '/')] : [],
      } as PackageListEntry;
    })
    .filter((x): x is PackageListEntry => x !== null)
    .sort((a, b) => {
      const aDir = a.type === 'dir';
      const bDir = b.type === 'dir';
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  return { root, entries };
}

interface PackageSelectionEntry {
  name: string;
  size: number;
}

interface EstimatePackageResult {
  names: string[];
  selected: PackageSelectionEntry[];
  total_size: number;
  warning_threshold: number;
  over_warning_threshold: boolean;
}

function estimatePackageSelection(project: any, rawNames: unknown): EstimatePackageResult {
  const root = projectPackageRoot(project);
  const names = normalizePackageEntryNames(rawNames);
  let totalSize = 0;
  const selected: PackageSelectionEntry[] = [];
  for (const name of names) {
    const absPath = path.join(root, name);
    if (!isWithinPath(root, absPath) || !fs.existsSync(absPath)) {
      throw new Error(`打包条目不存在: ${name}`);
    }
    const size = directorySizeWithoutPackageZip(root, absPath);
    selected.push({ name, size });
    totalSize += size;
  }
  return {
    names,
    selected,
    total_size: totalSize,
    warning_threshold: PACKAGE_SIZE_WARNING_BYTES,
    over_warning_threshold: totalSize > PACKAGE_SIZE_WARNING_BYTES,
  };
}

const PYTHON_ZIP_SCRIPT = String.raw`
import json
import os
import stat
import sys
import time
import zipfile

payload = json.load(sys.stdin)
root = os.path.abspath(payload["root"])
out_path = os.path.abspath(payload["out_path"])
names = payload["names"]
package_dir = os.path.realpath(os.path.join(root, "${HIDDEN_FOLDER_NAME}", "package_zip"))

def is_inside_package(path):
    real = os.path.realpath(path)
    return real == package_dir or real.startswith(package_dir + os.sep)

def zip_info(name, mode, is_dir=False, is_symlink=False):
    archive_name = name.replace(os.sep, "/")
    if is_dir and not archive_name.endswith("/"):
        archive_name += "/"
    info = zipfile.ZipInfo(archive_name, time.localtime()[:6])
    kind = stat.S_IFLNK if is_symlink else (stat.S_IFDIR if is_dir else stat.S_IFREG)
    info.external_attr = (kind | mode) << 16
    return info

def add_symlink(zf, abs_path, arcname):
    try:
        target = os.readlink(abs_path)
    except OSError:
        return
    zf.writestr(zip_info(arcname, 0o777, is_symlink=True), target)

def add_file(zf, abs_path, arcname):
    if is_inside_package(abs_path):
        return
    try:
        st = os.lstat(abs_path)
    except OSError:
        return
    mode = stat.S_IMODE(st.st_mode) or 0o644
    if stat.S_ISLNK(st.st_mode):
        add_symlink(zf, abs_path, arcname)
    elif stat.S_ISREG(st.st_mode):
        zf.write(abs_path, arcname)
    elif stat.S_ISDIR(st.st_mode):
        add_dir(zf, abs_path, arcname)

def add_dir(zf, abs_path, arcname):
    if is_inside_package(abs_path):
        return
    try:
        st = os.lstat(abs_path)
    except OSError:
        return
    zf.writestr(zip_info(arcname, stat.S_IMODE(st.st_mode) or 0o755, is_dir=True), b"")
    for current, dirs, files in os.walk(abs_path, topdown=True, followlinks=False):
        if is_inside_package(current):
            dirs[:] = []
            continue
        keep_dirs = []
        for dirname in dirs:
            child = os.path.join(current, dirname)
            child_arc = os.path.relpath(child, root)
            if is_inside_package(child):
                continue
            if os.path.islink(child):
                add_symlink(zf, child, child_arc)
            else:
                keep_dirs.append(dirname)
        dirs[:] = keep_dirs
        if current != abs_path:
            rel_dir = os.path.relpath(current, root)
            try:
                dir_st = os.lstat(current)
                zf.writestr(zip_info(rel_dir, stat.S_IMODE(dir_st.st_mode) or 0o755, is_dir=True), b"")
            except OSError:
                pass
        for filename in files:
            child = os.path.join(current, filename)
            child_arc = os.path.relpath(child, root)
            add_file(zf, child, child_arc)

compression = zipfile.ZIP_DEFLATED
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with zipfile.ZipFile(out_path, "w", compression=compression, allowZip64=True) as zf:
    for name in names:
        abs_path = os.path.abspath(os.path.join(root, name))
        if not (abs_path == root or abs_path.startswith(root + os.sep)):
            raise SystemExit(f"invalid path: {name}")
        if not os.path.lexists(abs_path):
            raise SystemExit(f"missing path: {name}")
        add_file(zf, abs_path, name)
print(json.dumps({"ok": True, "size": os.path.getsize(out_path)}))
`;

interface CreatePackageZipResult extends EstimatePackageResult {
  file_name: string;
  file_path: string;
  zip_size: number | null;
}

function createPackageZip(project: any, rawNames: unknown): CreatePackageZipResult {
  const estimate = estimatePackageSelection(project, rawNames);
  const root = projectPackageRoot(project);
  const outDir = packageZipDir(root);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const fileName = `${safePackageName(project.name)}-${stamp}-${uuid().slice(0, 8)}.zip`;
  const outPath = path.join(outDir, fileName);
  const result = spawnSync('python3', ['-c', PYTHON_ZIP_SCRIPT], {
    input: JSON.stringify({ root, out_path: outPath, names: estimate.names }),
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`创建压缩包失败: ${(result.error as Error).message}`);
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    throw new Error(stderr || stdout || `创建压缩包失败: python3 exited ${result.status}`);
  }
  return {
    ...estimate,
    file_name: fileName,
    file_path: outPath,
    zip_size: fs.existsSync(outPath) ? fs.statSync(outPath).size : null,
  };
}

interface GitRunOptions {
  timeout?: number;
  maxBuffer?: number;
}

interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status?: number;
  error?: string;
}

function runGit(cwd: string, args: string[], opts: GitRunOptions = {}): GitRunResult {
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: opts.timeout || 5000,
      maxBuffer: opts.maxBuffer || 1024 * 1024,
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (result.error) {
      return { ok: false, stdout, stderr, error: (result.error as Error).message };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        stdout,
        stderr,
        status: result.status ?? undefined,
        error: stderr.trim() || `git exited with status ${result.status}`,
      };
    }
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: '', stderr: '', error: (e as Error).message };
  }
}

interface GitActionSpec {
  label: string;
  args: string[];
  timeout: number;
}

const PROJECT_GIT_ACTIONS = Object.freeze<Record<string, GitActionSpec>>({
  pull: {
    label: '拉取',
    args: ['pull', '--ff-only'],
    timeout: 60 * 1000,
  },
  push: {
    label: '推送',
    args: ['push'],
    timeout: 60 * 1000,
  },
  stage: {
    label: '暂存',
    args: ['add', '-A'],
    timeout: 30 * 1000,
  },
});

function compactGitOutput(...parts: unknown[]): string {
  const text = parts.map((part) => String(part || '').trim()).filter(Boolean).join('\n');
  if (!text) return '';
  return text.length > 4000 ? `${text.slice(0, 4000)}\n...` : text;
}

function projectGitActionError(message: string, statusCode = 400): HttpError {
  return Object.assign(new Error(message), { statusCode }) as HttpError;
}

function runProjectGitAction(project: any, action: string): any {
  const spec = PROJECT_GIT_ACTIONS[action];
  if (!spec) {
    throw projectGitActionError('不支持的 Git 操作');
  }

  const discovered = discoverGitRepo(project.bind_path);
  if (!discovered.available) {
    throw projectGitActionError(discovered.reason || '绑定路径下未检测到 Git 仓库');
  }

  const result = runGit(discovered.repo_path!, spec.args, {
    timeout: spec.timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = compactGitOutput(result.stdout, result.stderr);
  if (!result.ok) {
    throw projectGitActionError(
      `${spec.label}失败${result.error ? `: ${result.error}` : ''}${output ? `\n${output}` : ''}`,
      409,
    );
  }

  return {
    ok: true,
    action,
    label: spec.label,
    repo_path: discovered.repo_path,
    output,
    message: output ? `${spec.label}完成` : `${spec.label}完成，没有额外输出`,
    tracking: readProjectGitTracking(project, 12),
  };
}

function hasGitMarker(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function discoverNestedGitRepo(root: string): string | null {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const seen = new Set<string>();
  let scanned = 0;

  while (queue.length > 0 && scanned < GIT_REPO_SCAN_MAX_DIRS) {
    const { dir, depth } = queue.shift()!;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    scanned += 1;

    if (hasGitMarker(resolved)) {
      const top = runGit(resolved, ['rev-parse', '--show-toplevel']);
      if (top.ok && top.stdout.trim()) {
        const repoPath = path.resolve(top.stdout.trim());
        if (isWithinPath(root, repoPath)) return repoPath;
      }
    }

    if (depth >= GIT_REPO_SCAN_MAX_DEPTH) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || GIT_SCAN_SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(resolved, entry.name);
      if (!isWithinPath(root, child)) continue;
      queue.push({ dir: child, depth: depth + 1 });
    }
  }
  return null;
}

interface DiscoveredGitRepo {
  available: boolean;
  bind_path?: string;
  repo_path?: string;
  source?: string;
  reason?: string;
}

function discoverGitRepo(bindPath: unknown): DiscoveredGitRepo {
  if (!bindPath) {
    return { available: false, reason: '项目未绑定路径' };
  }
  const root = path.resolve(String(bindPath));
  try {
    if (!fs.existsSync(root)) {
      return { available: false, bind_path: root, reason: '绑定路径不存在' };
    }
    if (!fs.statSync(root).isDirectory()) {
      return { available: false, bind_path: root, reason: '绑定路径不是目录' };
    }
  } catch (e) {
    return { available: false, bind_path: root, reason: `无法读取绑定路径: ${(e as Error).message}` };
  }

  const containing = runGit(root, ['rev-parse', '--show-toplevel']);
  if (containing.ok && containing.stdout.trim()) {
    return {
      available: true,
      bind_path: root,
      repo_path: path.resolve(containing.stdout.trim()),
      source: 'containing',
    };
  }

  const nested = discoverNestedGitRepo(root);
  if (nested) {
    return {
      available: true,
      bind_path: root,
      repo_path: nested,
      source: nested === root ? 'root' : 'nested',
    };
  }

  return { available: false, bind_path: root, reason: '绑定路径下未检测到 Git 仓库' };
}

interface GitStatusSummary {
  dirty_count: number;
  staged_count: number;
  unstaged_count: number;
  untracked_count: number;
}

function parseGitStatus(stdout: unknown): GitStatusSummary {
  const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
  const summary: GitStatusSummary = { dirty_count: lines.length, staged_count: 0, unstaged_count: 0, untracked_count: 0 };
  for (const line of lines) {
    if (line.startsWith('??')) {
      summary.untracked_count += 1;
      continue;
    }
    if (line[0] && line[0] !== ' ') summary.staged_count += 1;
    if (line[1] && line[1] !== ' ') summary.unstaged_count += 1;
  }
  return summary;
}

interface GitCommitInfo {
  hash: string;
  short_hash: string;
  author_name: string;
  author_email: string;
  date: string;
  relative_date: string;
  subject: string;
  refs: string[];
}

function parseGitCommits(stdout: unknown): GitCommitInfo[] {
  return String(stdout || '')
    .split(GIT_RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const fields = record.split(GIT_FIELD_SEPARATOR);
      const refs = String(fields[7] || '')
        .split(',')
        .map((ref) => ref.trim())
        .filter(Boolean);
      return {
        hash: fields[0] || '',
        short_hash: fields[1] || '',
        author_name: fields[2] || '',
        author_email: fields[3] || '',
        date: fields[4] || '',
        relative_date: fields[5] || '',
        subject: fields[6] || '',
        refs,
      };
    })
    .filter((commit) => commit.hash);
}

function readProjectGitTracking(project: any, rawLimit: unknown): any {
  const limit = normalizeCommitLimit(rawLimit);
  const discovered = discoverGitRepo(project.bind_path);
  const base = {
    available: false,
    bind_path: discovered.bind_path || project.bind_path || '',
    repo_path: '',
    repo_name: '',
    source: discovered.source || '',
    branch: '',
    head: '',
    remote: '',
    dirty: false,
    dirty_count: 0,
    staged_count: 0,
    unstaged_count: 0,
    untracked_count: 0,
    commits: [] as GitCommitInfo[],
    updated_at: new Date().toISOString(),
  };
  if (!discovered.available) {
    return { ...base, reason: discovered.reason || '未检测到 Git 仓库' };
  }

  const repoPath = discovered.repo_path!;
  const branch = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = runGit(repoPath, ['rev-parse', '--short', 'HEAD']);
  const remote = runGit(repoPath, ['config', '--get', 'remote.origin.url']);
  const status = runGit(repoPath, ['status', '--porcelain=v1'], { maxBuffer: 512 * 1024 });
  const log = runGit(repoPath, [
    'log',
    `-${limit}`,
    '--date=iso-strict',
    `--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%ar%x1f%s%x1f%D%x1e`,
  ]);

  const statusSummary = status.ok ? parseGitStatus(status.stdout) : parseGitStatus('');
  const commits = log.ok ? parseGitCommits(log.stdout) : [];
  const logError = log.ok || /does not have any commits|bad default revision/i.test(log.error || '')
    ? ''
    : (log.error || '读取提交历史失败');

  return {
    ...base,
    available: true,
    repo_path: repoPath,
    repo_name: path.basename(repoPath),
    source: discovered.source || '',
    branch: branch.ok ? branch.stdout.trim() : '',
    head: head.ok ? head.stdout.trim() : '',
    remote: remote.ok ? remote.stdout.trim() : '',
    dirty: statusSummary.dirty_count > 0,
    ...statusSummary,
    commits,
    ...(logError ? { log_error: logError } : {}),
  };
}

interface ContextItemRow {
  id: string;
  scope: string;
  owner_id: string;
  name: string;
  description?: string | null;
}

function shapeContextItem(row: ContextItemRow): ContextItemRow {
  return {
    id: row.id,
    scope: row.scope,
    owner_id: row.owner_id,
    name: row.name,
    description: row.description || '',
  };
}

function idsAllowedByAvailable(raw: unknown, available: ContextItemRow[]): string[] {
  const allowed = new Set(available.map((item) => item.id));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of Array.isArray(raw) ? raw : []) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || !allowed.has(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

interface UserContextWhitelistPayload {
  skill_whitelist_enabled: boolean;
  builtin_skill_whitelist_enabled: boolean;
  memory_whitelist_enabled: boolean;
  skill_ids: string[];
  builtin_skill_ids: string[];
  memory_ids: string[];
  available_skills: ContextItemRow[];
  available_builtin_skills: ContextItemRow[];
  available_memories: ContextItemRow[];
  updated_at: string | null;
}

function buildUserContextWhitelistPayload(projectId: string, userId: string): UserContextWhitelistPayload {
  const whitelist = Projects.getUserContextWhitelist(projectId, userId);
  const availableSkills = Skills.listForUser(userId).map(shapeContextItem);
  const availableBuiltinSkills = Skills.listBuiltin().map(shapeContextItem);
  const availableMemories = Memories.listForUser(userId).map(shapeContextItem);
  const skillIds = Array.isArray(whitelist.skill_ids)
    ? idsAllowedByAvailable(whitelist.skill_ids, availableSkills)
    : [];
  const builtinSkillIds = Array.isArray(whitelist.builtin_skill_ids)
    ? idsAllowedByAvailable(whitelist.builtin_skill_ids, availableBuiltinSkills)
    : [];
  const memoryIds = Array.isArray(whitelist.memory_ids)
    ? idsAllowedByAvailable(whitelist.memory_ids, availableMemories)
    : [];
  return {
    skill_whitelist_enabled: Array.isArray(whitelist.skill_ids),
    builtin_skill_whitelist_enabled: Array.isArray(whitelist.builtin_skill_ids),
    memory_whitelist_enabled: Array.isArray(whitelist.memory_ids),
    skill_ids: skillIds,
    builtin_skill_ids: builtinSkillIds,
    memory_ids: memoryIds,
    available_skills: availableSkills,
    available_builtin_skills: availableBuiltinSkills,
    available_memories: availableMemories,
    updated_at: whitelist.updated_at || null,
  };
}

function findArchitectureIssue(projectId: string): any {
  return Issues.findByProjectAndTitle(projectId, ARCHITECTURE_ISSUE_TITLE);
}

function ensureArchitectureIssue(projectId: string, userId: string): { issue: any; created: boolean } {
  const existing = findArchitectureIssue(projectId);
  if (existing) return { issue: existing, created: false };
  const issueId = uuid().slice(0, 8);
  Issues.insert({
    id: issueId,
    project_id: projectId,
    title: ARCHITECTURE_ISSUE_TITLE,
    description: ARCHITECTURE_ISSUE_DESCRIPTION,
    created_by: userId,
    use_worktree: false,
    worktree_branch: '',
  } as any);
  return { issue: Issues.findById(issueId), created: true };
}

function toIdList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v: any) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.length > 0) {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

function contentTypeForFigure(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml; charset=utf-8';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

function figureKind(file: string): 'html' | 'svg' | 'image' {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.svg') return 'svg';
  return 'image';
}

interface ArchitectureFigure {
  absPath: string;
  name: string;
  ext: string;
  stat: fs.Stats;
}

function findArchitectureFigure(project: any): ArchitectureFigure | null {
  const bindPath = (project?.bind_path || '').trim();
  if (!bindPath) return null;
  const dir = path.resolve(bindPath, HIDDEN_FOLDER_NAME, 'generated_figures');
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map((entry): ArchitectureFigure | null => {
        const absPath = path.join(dir, entry.name);
        const ext = path.extname(entry.name).toLowerCase();
        if (!ARCHITECTURE_FIGURE_EXTENSIONS.includes(ext)) return null;
        if (path.basename(entry.name, ext).toLowerCase() !== 'arch') return null;
        const stat = fs.statSync(absPath);
        return { absPath, name: entry.name, ext, stat };
      })
      .filter((x): x is ArchitectureFigure => x !== null)
      .sort((a, b) => {
        const pa = ARCHITECTURE_FIGURE_EXTENSIONS.indexOf(a.ext);
        const pb = ARCHITECTURE_FIGURE_EXTENSIONS.indexOf(b.ext);
        if (pa !== pb) return pa - pb;
        return b.stat.mtimeMs - a.stat.mtimeMs;
      });
    return entries[0] || null;
  } catch {
    return null;
  }
}

function readableProjectsForUser(user: any): any[] {
  return Projects.listAll(user.id).filter((project: any) => canReadProject(user, project));
}

function shapeProjectList(projects: any[], req: express.Request): any[] {
  const user = userOf(req);
  const mutedIds = UserProjectView.mutedIds(user.id);
  return projects.map((project) => shapeProjectForUser(project, user, { mutedIds }));
}

function auditAdminProjectList(req: express.Request, action: string, projects: any[]): void {
  const user = userOf(req);
  if (user?.role !== 'admin') return;
  if (!projects.some((project) => project.created_by && project.created_by !== user.id)) return;
  recordAdminAuditIfCrossUser(user, action, 'project', '*', '');
}

function projectSearchResults(req: express.Request): any[] {
  const user = userOf(req);
  const query = req.query.q ?? req.query.search ?? '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  return filterProjectListForUser(readableProjectsForUser(user), user, { query: String(query) } as any)
    .slice(0, limit);
}

function sendProjectSearch(req: express.Request, res: express.Response): void {
  const projects = projectSearchResults(req);
  auditAdminProjectList(req, 'search_projects', projects);
  res.json(shapeProjectList(projects, req));
}

router.get('/', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  if (normalizeProjectSearch(req.query.q ?? req.query.search ?? '')) {
    return sendProjectSearch(req, res);
  }
  // ?all=true: 跳过 user_view_prefs.hide_others_projects, 让当前用户拿到自己可见的全部项目
  // (默认 /api/projects 仍然尊重该偏好, 用于 chip 筛选等窄视角场景).
  const showAll = String(req.query.all || '').toLowerCase() === 'true' || req.query.all === '1';
  const projects = filterProjectListForUser(readableProjectsForUser(user), user, { showAll })
    .filter((project: any) => !isHidden(user.id, 'project', project.id));
  auditAdminProjectList(req, 'list_projects', projects);
  res.json(shapeProjectList(projects, req));
});

router.get('/search', auth, sendProjectSearch);

router.get('/view-prefs', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  res.json(UserProjectView.getPrefs(user.id));
});

router.patch('/view-prefs', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  if (!hasBoolField(req.body || {}, 'hide_others_projects', 'hideOthersProjects')) {
    return res.status(400).json({ error: 'hide_others_projects 必须是布尔值' });
  }
  res.json(UserProjectView.setPrefs(user.id, {
    hideOthersProjects: boolFromBody(req.body || {}, 'hide_others_projects', 'hideOthersProjects'),
  }));
});

router.get('/muted', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const mutedIds = UserProjectView.mutedIds(user.id);
  const projects = readableProjectsForUser(user).filter((project: any) => mutedIds.has(project.id));
  res.json(shapeProjectList(projects, req));
});

router.post('/', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const {
    name,
    description,
    bindPath,
    bindPathManual,
    gitRepos,
    defaultUseWorktree,
    researchEnabled,
    guidedDemoKind,
    kind,
    extensionName,
  } = (req.body || {}) as {
    name?: string;
    description?: string;
    bindPath?: string;
    bindPathManual?: boolean;
    gitRepos?: unknown;
    defaultUseWorktree?: boolean;
    researchEnabled?: boolean;
    guidedDemoKind?: string;
    kind?: string;
    extensionName?: string;
  };
  if (!name) return res.status(400).json({ error: '请填写项目名称' });
  const visibility = normalizeProjectVisibility(req.body?.visibility, 'private');
  const canPostIssue = boolFromBody(req.body || {}, 'can_post_issue', 'canPostIssue', false);
  const canRunSession = boolFromBody(req.body || {}, 'can_run_session', 'canRunSession', false);

  // ── 莫比乌斯拓展项目 ──────────────────────────────────────────────────────
  if (kind === 'extension') {
    if (user.role !== 'admin') {
      return res.status(403).json({ error: '只有管理员可以创建莫比乌斯拓展项目' });
    }
    if (hasBoolField(req.body || {}, 'can_post_issue', 'canPostIssue')
      || hasBoolField(req.body || {}, 'can_run_session', 'canRunSession')) {
      return res.status(400).json({ error: '拓展项目的写权限开关由系统管理, 不可手动修改' });
    }
    if (req.body?.default_model !== undefined || req.body?.defaultModel !== undefined) {
      return res.status(400).json({ error: '拓展项目的默认模型偏好由 manifest 管理, 不可手动修改' });
    }
    const registry = require('../services/extension-registry');
    const normalizedExtensionName = typeof extensionName === 'string' ? extensionName.trim().toLowerCase() : '';
    if (!normalizedExtensionName || !registry.EXT_NAME_RE.test(normalizedExtensionName)) {
      return res.status(400).json({ error: '拓展标识名格式不符：需以小写字母开头，可含小写字母、数字和连字符，1-32字符' });
    }
    try {
      createExtensionSkeleton({
        extensionName: normalizedExtensionName,
        displayName: name,
        description,
      });
      const reloadResult = registry.reload();
      const project = Projects.findByExtensionName(normalizedExtensionName, user.id);
      if (!project) {
        const error = reloadResult?.errors?.find((item: any) => item?.name === normalizedExtensionName)?.error || '拓展注册失败';
        return res.status(500).json({ error });
      }
      setProjectAccess(project.id, { ...projectAccessBody(req.body), visibility });
      return res.json({
        ...shapeProjectForUser(Projects.findById(project.id, user.id), user),
        extension_reload: reloadResult,
      });
    } catch (e) {
      const err = e as HttpError;
      return res.status(err.statusCode || 500).json({ error: '创建拓展项目失败：' + err.message });
    }
  }

  // ── 普通 / Research 项目 ──────────────────────────────────────────────────
  let resolvedPath = '';
  let repos: Array<{ url: string; name?: string }> = [];
  let normalizedDefaultModel: string | null | undefined;
  try {
    resolvedPath = bindPathManual
      ? resolveBindPathManual(bindPath)
      : resolveBindPath(bindPath, user.work_dir, { createIfMissing: true });
    repos = normalizeGitRepos(gitRepos) || [];
    normalizedDefaultModel = normalizeDefaultModel(req.body?.default_model ?? req.body?.defaultModel);
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
  const projectId = uuid().slice(0, 8);
  // 未显式传则默认 true (保持存量行为: 新建 Issue 时 worktree 勾选框默认打钩)
  let defWt = defaultUseWorktree === undefined ? true : !!defaultUseWorktree;
  const nextResearchEnabled = researchEnabled === undefined ? false : !!researchEnabled;
  // 项目级规则: Research 启用时强制禁用 worktree (research 流程不走 worktree)
  if (nextResearchEnabled) defWt = false;
  // 项目级规则: 自迭代项目 (bind_path === APP_DIR, 即 is_self_develop) 强制禁用 worktree ——
  // 莫比乌斯自身源码仓由 PM2 单进程托管, agent 必须直接在主 checkout 上改再用 `python3 start.py`
  // 部署; worktree 会切到独立工作副本导致部署拿不到改动.
  if (resolvedPath && APP_DIR && path.resolve(resolvedPath) === path.resolve(APP_DIR)) defWt = false;
  Projects.insert({
    id: projectId,
    name,
    description,
    createdBy: user.id,
    bindPath: resolvedPath,
    bindPathManual: !!bindPathManual,
    gitRepos: repos as any,
    defaultUseWorktree: defWt,
    researchEnabled: nextResearchEnabled,
    visibility: visibility as any,
    canPostIssue,
    canRunSession,
    defaultModel: normalizedDefaultModel,
  });
  setProjectAccess(projectId, { ...projectAccessBody(req.body), visibility });
  const project = Projects.findById(projectId, user.id);
  const guidedKind = typeof guidedDemoKind === 'string' ? guidedDemoKind.trim() : '';
  let guidedDemoAssets: any = null;
  if (guidedKind) {
    guidedDemoAssets = ensureGuidedDemoAssets({ kind: guidedKind, project, user });
    if (!guidedDemoAssets.ok) {
      try {
        Skills.deleteForProject(projectId);
        Memories.deleteForProject(projectId);
        removeDemoWorkspaceIfRequested(project, user, true);
        Projects.delete(projectId);
      } catch {}
      return res.status(400).json({ error: guidedDemoAssets.error || '演示项目资料准备失败' });
    }
  }
  res.json({ ...shapeProjectForUser(project, user), guided_demo_assets: guidedDemoAssets });
});

router.delete('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  const project = Projects.findById(id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (project.created_by !== user.id) {
    return res.status(403).json({ error: '只有项目创建者可以删除项目' });
  }
  if (project.id === FIXED_LOGO_REVIEW_PROJECT_ID) {
    return res.status(400).json({
      error: '这个项目是引导系统固定完成案例，用于“验收完成案例”路线，不能删除。其他同名临时演示项目仍可删除。',
    });
  }
  if (project.kind === 'extension') {
    return res.status(400).json({ error: '拓展项目由 mobius/extension/ 目录管理, 请删除对应目录后 reload' });
  }

  const { password, confirm } = req.body || {} as { password?: string; confirm?: string };
  const normalizedConfirm = String(confirm || '').trim();
  const accepted = new Set([project.name, project.id].filter(Boolean).map(String));
  if (!accepted.has(normalizedConfirm)) {
    return res.status(400).json({ error: '请输入项目名或项目 ID 确认' });
  }

  if (ENABLE_PASSWORD_LOGIN) {
    if (!password) return res.status(400).json({ error: '请输入密码' });
    const fullUser = Users.findById(user.id);
    if (!fullUser?.password_hash || !bcrypt.compareSync(password, fullUser.password_hash)) {
      return res.status(401).json({ error: '密码错误' });
    }
  }

  try {
    const contextCleanup = {
      skills: Skills.deleteForProject(id),
      memories: Memories.deleteForProject(id),
    };
    const workspaceCleanup = removeDemoWorkspaceIfRequested(project, user, !!req.body?.cleanup_demo_workspace);
    recordAdminAuditIfCrossUser(user, 'delete_project', 'project', project.id, project.created_by);
    Projects.delete(id);
    res.json({ ok: true, context_cleanup: contextCleanup, workspace_cleanup: workspaceCleanup });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message || '删除项目失败' });
  }
});

// 拓展项目: 每用户隐藏 (隐藏卡片, 不动数据). 可被同一用户自己撤销, 也可被管理员撤销.
router.post('/:id/hide', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  const project = Projects.findById(id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canReadProject(user, project)) return res.status(404).json({ error: '未找到' });
  if (project.kind === 'extension') Projects.setHidden(id, user.id, true);
  UserProjectView.mute(user.id, id);
  setHidden(user.id, 'project', id, true);
  recordAdminAuditIfCrossUser(user, 'mute_project', 'project', project.id, project.created_by);
  res.json({ ok: true, muted: true });
});

router.post('/:id/unhide', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  const project = Projects.findById(id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canReadProject(user, project)) return res.status(404).json({ error: '未找到' });
  if (project.kind === 'extension') Projects.setHidden(id, user.id, false);
  UserProjectView.unmute(user.id, id);
  setHidden(user.id, 'project', id, false);
  recordAdminAuditIfCrossUser(user, 'unmute_project', 'project', project.id, project.created_by);
  res.json({ ok: true, muted: false });
});

router.post('/:id/mute', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  const project = Projects.findById(id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canReadProject(user, project)) return res.status(404).json({ error: '未找到' });
  UserProjectView.mute(user.id, id);
  setHidden(user.id, 'project', id, true);
  recordAdminAuditIfCrossUser(user, 'mute_project', 'project', project.id, project.created_by);
  res.json({ ok: true, muted: true });
});

router.post('/:id/unmute', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  const project = Projects.findById(id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canReadProject(user, project)) return res.status(404).json({ error: '未找到' });
  UserProjectView.unmute(user.id, id);
  setHidden(user.id, 'project', id, false);
  // /hide 对拓展同时写了 project_user_hidden; 这里一并清掉, 使"恢复显示"对拓展也完整生效.
  if (project.kind === 'extension') Projects.setHidden(id, user.id, false);
  recordAdminAuditIfCrossUser(user, 'unmute_project', 'project', project.id, project.created_by);
  res.json({ ok: true, muted: false });
});

router.patch('/:id/star', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  const project = Projects.findById(id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canReadProject(user, project)) return res.status(404).json({ error: '未找到' });
  if (typeof req.body?.starred !== 'boolean') {
    return res.status(400).json({ error: '星标状态格式错误' });
  }
  Projects.setStarred(id, user.id, req.body.starred);
  res.json(shapeProjectForUser(Projects.findById(id, user.id), user));
});

router.patch('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  const project = Projects.findById(id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canManageProject(user, project)) return res.status(403).json({ error: '只有项目 owner/admin 可以修改项目设置' });
  const {
    name,
    description,
    bindPath,
    bindPathManual,
    gitRepos,
    defaultUseWorktree,
    researchEnabled,
    canPostIssue,
    canRunSession,
    visibility,
    defaultModel,
    forgottenFlagMessage,
    forgottenFlagIssueIntervalMinutes,
    forgottenFlagResearchIntervalMinutes,
    forgottenFlagIssueInitMinutes,
    forgottenFlagIssueBackoff,
    forgottenFlagIssuePatience,
    forgottenFlagResearchInitMinutes,
    forgottenFlagResearchBackoff,
    forgottenFlagResearchPatience,
  } = (req.body || {}) as {
    name?: string;
    description?: string;
    bindPath?: string;
    bindPathManual?: boolean;
    gitRepos?: unknown;
    defaultUseWorktree?: boolean;
    researchEnabled?: boolean;
    canPostIssue?: unknown;
    canRunSession?: unknown;
    visibility?: unknown;
    defaultModel?: unknown;
    forgottenFlagMessage?: string;
    forgottenFlagIssueIntervalMinutes?: unknown;
    forgottenFlagResearchIntervalMinutes?: unknown;
    forgottenFlagIssueInitMinutes?: unknown;
    forgottenFlagIssueBackoff?: unknown;
    forgottenFlagIssuePatience?: unknown;
    forgottenFlagResearchInitMinutes?: unknown;
    forgottenFlagResearchBackoff?: unknown;
    forgottenFlagResearchPatience?: unknown;
  };
  // 拓展项目: name/description/bindPath/gitRepos/defaultUseWorktree/researchEnabled 由 registry 锁定,
  // 任何尝试修改这些字段的请求都拒掉. forgotten_flag.* 与星标仍允许.
  if (project.kind === 'extension') {
    const locked: Array<[string, unknown]> = [
      ['name', name],
      ['description', description],
      ['bindPath', bindPath],
      ['bindPathManual', bindPathManual],
      ['gitRepos', gitRepos],
      ['defaultUseWorktree', defaultUseWorktree],
      ['researchEnabled', researchEnabled],
      ['canPostIssue', canPostIssue],
      ['can_run_session', req.body?.can_run_session],
      ['canRunSession', canRunSession],
      ['can_post_issue', req.body?.can_post_issue],
      ['visibility', visibility],
      ['default_model', req.body?.default_model],
      ['defaultModel', defaultModel],
    ];
    const offender = locked.find(([, v]) => v !== undefined);
    if (offender) {
      return res.status(400).json({ error: `拓展项目的 ${offender[0]} 由 manifest 管理, 不可手动修改` });
    }
  }
  if (defaultModel !== undefined || req.body?.default_model !== undefined) {
    try {
      const normalized = normalizeDefaultModel(defaultModel ?? req.body?.default_model);
      Projects.updateDefaultModel(id, normalized as any);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
  }
  if (forgottenFlagMessage !== undefined) {
    if (typeof forgottenFlagMessage !== 'string') {
      return res.status(400).json({ error: '被遗忘 flag 提醒消息格式错误' });
    }
    if (forgottenFlagMessage.length > 4000) {
      return res.status(400).json({ error: '被遗忘 flag 提醒消息过长 (上限 4000 字符)' });
    }
    Projects.updateForgottenFlagMessage(id, forgottenFlagMessage);
  }
  const issuePolicyTouched = (
    forgottenFlagIssueIntervalMinutes !== undefined ||
    forgottenFlagIssueInitMinutes !== undefined ||
    forgottenFlagIssueBackoff !== undefined ||
    forgottenFlagIssuePatience !== undefined
  );
  if (issuePolicyTouched) {
    try {
      const initRaw = forgottenFlagIssueInitMinutes !== undefined
        ? forgottenFlagIssueInitMinutes
        : (forgottenFlagIssueIntervalMinutes !== undefined
          ? forgottenFlagIssueIntervalMinutes
          : project.forgotten_flag_issue_init_minutes);
      const policy = {
        initMinutes: normalizeIntervalMinutes(initRaw, 'Issue Session Init', FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES_MIN),
        backoff: normalizeBackoff(
          forgottenFlagIssueBackoff !== undefined ? forgottenFlagIssueBackoff : project.forgotten_flag_issue_backoff,
          'Issue Session Backoff',
        ),
        patience: normalizePatience(
          forgottenFlagIssuePatience !== undefined ? forgottenFlagIssuePatience : project.forgotten_flag_issue_patience,
          'Issue Session Patience',
        ),
      };
      Projects.updateForgottenFlagIssuePolicy(id, policy);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
  }
  const researchPolicyTouched = (
    forgottenFlagResearchIntervalMinutes !== undefined ||
    forgottenFlagResearchInitMinutes !== undefined ||
    forgottenFlagResearchBackoff !== undefined ||
    forgottenFlagResearchPatience !== undefined
  );
  if (researchPolicyTouched) {
    try {
      const initRaw = forgottenFlagResearchInitMinutes !== undefined
        ? forgottenFlagResearchInitMinutes
        : (forgottenFlagResearchIntervalMinutes !== undefined
          ? forgottenFlagResearchIntervalMinutes
          : project.forgotten_flag_research_init_minutes);
      const policy = {
        initMinutes: normalizeIntervalMinutes(initRaw, 'Research Agent Init', FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES_MIN),
        backoff: normalizeBackoff(
          forgottenFlagResearchBackoff !== undefined ? forgottenFlagResearchBackoff : project.forgotten_flag_research_backoff,
          'Research Agent Backoff',
        ),
        patience: normalizePatience(
          forgottenFlagResearchPatience !== undefined ? forgottenFlagResearchPatience : project.forgotten_flag_research_patience,
          'Research Agent Patience',
        ),
      };
      Projects.updateForgottenFlagResearchPolicy(id, policy);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
  }
  let resolvedBindPath: string | undefined;
  if (bindPath !== undefined) {
    try {
      resolvedBindPath = bindPathManual
        ? resolveBindPathManual(bindPath)
        : resolveBindPath(bindPath, user.work_dir);
      Projects.updateBindPath(id, resolvedBindPath, !!bindPathManual);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
  }
  if (gitRepos !== undefined) {
    try {
      const repos = normalizeGitRepos(gitRepos);
      if (repos !== null) Projects.updateGitRepos(id, repos as any);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
  }
  // 项目级规则: Research 启用时强制禁用 worktree.
  // 先算出本次 PATCH 后 research 的最终值, 再据此决定 worktree 是否要强制 false.
  const nextResearchEnabled = (researchEnabled !== undefined) ? !!researchEnabled : !!project.research_enabled;
  if (researchEnabled !== undefined) Projects.updateResearchEnabled(id, nextResearchEnabled);
  // 项目级规则: Research 启用 或 自迭代项目 (bind_path === APP_DIR) 时强制禁用 worktree.
  // 用本次 PATCH 后的生效 bind_path 判断 (改 bind_path 到 APP_DIR 也立即生效), 与 research 同理.
  const effectiveBindPath = resolvedBindPath ?? project.bind_path;
  const forceNoWorktree = nextResearchEnabled
    || !!(effectiveBindPath && APP_DIR && path.resolve(effectiveBindPath) === path.resolve(APP_DIR));
  if (forceNoWorktree) {
    Projects.updateDefaultUseWorktree(id, false);
  } else if (defaultUseWorktree !== undefined) {
    Projects.updateDefaultUseWorktree(id, !!defaultUseWorktree);
  }
  if (hasBoolField(req.body || {}, 'can_post_issue', 'canPostIssue')) {
    Projects.updateCanPostIssue(id, boolFromBody(req.body || {}, 'can_post_issue', 'canPostIssue'));
  }
  if (hasBoolField(req.body || {}, 'can_run_session', 'canRunSession')) {
    Projects.updateCanRunSession(id, boolFromBody(req.body || {}, 'can_run_session', 'canRunSession'));
  }
  if (name) Projects.updateName(id, name);
  if (description !== undefined) Projects.updateDescription(id, description);
  if (visibility !== undefined
    || req.body?.allow_user_ids !== undefined || req.body?.allowUserIds !== undefined
    || req.body?.allow_group_ids !== undefined || req.body?.allowGroupIds !== undefined) {
    setProjectAccess(id, projectAccessBody(req.body));
  }
  recordAdminAuditIfCrossUser(user, 'write_project', 'project', project.id, project.created_by);
  res.json(shapeProjectForUser(Projects.findById(id, user.id), user));
});

router.get('/:id/git-tracking', auth, (req: express.Request, res: express.Response) => {
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  try {
    res.json(readProjectGitTracking(project, req.query.limit));
  } catch (e) {
    res.status(500).json({ error: (e as Error).message || '读取 Git 追踪信息失败' });
  }
});

router.post('/:id/git-action', auth, (req: express.Request, res: express.Response) => {
  const project = loadManageableProject(req, res, String(req.params.id));
  if (!project) return;
  const action = String(req.body?.action || '').trim();
  try {
    res.json(runProjectGitAction(project, action));
  } catch (e) {
    const err = e as HttpError;
    res.status(err.statusCode || 500).json({ error: err.message || '执行 Git 操作失败' });
  }
});

router.post('/:id/deploy-version', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  if (!project.is_self_develop) return res.status(400).json({ error: '只有 Mobius 自迭代项目可以回退版本' });
  if (user?.role !== 'admin') return res.status(403).json({ error: '只有管理员可以回退 Mobius 版本' });

  const gitHash = normalizeRollbackHash(req.body?.git_hash || req.body?.hash || req.body?.commit);
  if (!gitHash) return res.status(400).json({ error: 'git_hash 必须是 7-40 位 commit hash' });

  try {
    const spawned = spawnProductOtherVersion(gitHash);
    res.json({
      ok: true,
      git_hash: gitHash,
      pid: spawned.pid,
      log_path: spawned.log_path,
      message: `已开始回退到 ${gitHash}`,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message || '启动版本回退失败' });
  }
});

router.post('/:id/hard-reset-version', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  if (!project.is_self_develop) return res.status(400).json({ error: '只有 Mobius 自迭代项目可以硬回退版本' });
  if (user?.role !== 'admin') return res.status(403).json({ error: '只有管理员可以硬回退 Mobius 版本' });

  const gitHash = normalizeRollbackHash(req.body?.git_hash || req.body?.hash || req.body?.commit);
  if (!gitHash) return res.status(400).json({ error: 'git_hash 必须是 7-40 位 commit hash' });

  try {
    const spawned = spawnProductHardReset(gitHash);
    res.json({
      ok: true,
      git_hash: gitHash,
      pid: spawned.pid,
      log_path: spawned.log_path,
      message: `已开始硬回退到 ${gitHash}, 当前版本会先保存到 discard/<timestamp> 分支`,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message || '启动版本硬回退失败' });
  }
});

router.get('/:id/todos', auth, (req: express.Request, res: express.Response) => {
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  res.json({ items: ProjectTodos.listForProject(project.id) });
});

router.post('/:id/todos', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const project = loadManageableProject(req, res, String(req.params.id));
  if (!project) return;

  let title: string;
  let descriptionValue: string;
  try {
    title = normalizeTodoTitle(req.body?.title);
    descriptionValue = normalizeTodoDescription(req.body?.description);
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }

  const completed = typeof req.body?.completed === 'boolean' ? req.body.completed : false;
  let sortOrder: number | undefined;
  if (hasOwn(req.body, 'sort_order') || hasOwn(req.body, 'sortOrder')) {
    try {
      sortOrder = normalizeTodoSortOrder(req.body.sort_order ?? req.body.sortOrder);
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
  }

  const todoId = uuid().slice(0, 8);
  res.json(ProjectTodos.insert({
    id: todoId,
    projectId: project.id,
    title,
    description: descriptionValue,
    completed,
    sortOrder,
    createdBy: user.id,
  } as any));
});

router.patch('/:id/todos/:todoId', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const project = loadManageableProject(req, res, String(req.params.id));
  if (!project) return;

  const patch: any = {};
  try {
    if (hasOwn(req.body, 'title')) patch.title = normalizeTodoTitle(req.body.title);
    if (hasOwn(req.body, 'description')) patch.description = normalizeTodoDescription(req.body.description);
    if (hasOwn(req.body, 'completed')) {
      if (typeof req.body.completed !== 'boolean') throw new Error('待办完成状态格式错误');
      patch.completed = req.body.completed;
    }
    if (hasOwn(req.body, 'sort_order') || hasOwn(req.body, 'sortOrder')) {
      patch.sortOrder = normalizeTodoSortOrder(req.body.sort_order ?? req.body.sortOrder);
    }
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }

  const todo = ProjectTodos.update(project.id, String(req.params.todoId), patch, user.id);
  if (!todo) return res.status(404).json({ error: '待办不存在' });
  res.json(todo);
});

router.delete('/:id/todos/:todoId', auth, (req: express.Request, res: express.Response) => {
  const project = loadManageableProject(req, res, String(req.params.id));
  if (!project) return;
  const result = ProjectTodos.delete(project.id, String(req.params.todoId));
  if (result.changes === 0) return res.status(404).json({ error: '待办不存在' });
  res.json({ ok: true });
});

router.put('/:id/todos/reorder', auth, (req: express.Request, res: express.Response) => {
  const project = loadManageableProject(req, res, String(req.params.id));
  if (!project) return;
  if (!Array.isArray(req.body?.ids)) return res.status(400).json({ error: '待办排序列表格式错误' });
  try {
    res.json({ items: ProjectTodos.reorder(project.id, req.body.ids) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message || '待办排序失败' });
  }
});

router.get('/:id/package/items', auth, (req: express.Request, res: express.Response) => {
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  try {
    const { root, entries } = listPackageEntries(project);
    res.json({
      bind_path: root,
      package_dir: packageZipDir(root),
      excluded_path: PACKAGE_ZIP_RELATIVE_DIR.replace(/\\/g, '/'),
      warning_threshold: PACKAGE_SIZE_WARNING_BYTES,
      entries,
    });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message || '读取可打包文件失败' });
  }
});

router.post('/:id/package/estimate', auth, (req: express.Request, res: express.Response) => {
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  try {
    res.json(estimatePackageSelection(project, req.body?.names));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message || '统计打包大小失败' });
  }
});

router.post('/:id/package/download', auth, (req: express.Request, res: express.Response) => {
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  let created: CreatePackageZipResult;
  try {
    created = createPackageZip(project, req.body?.names);
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message || '创建压缩包失败' });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.download(created.file_path, created.file_name, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: (err as Error).message || '下载压缩包失败' });
    }
  });
});

function handleArchitectureSessionPresetContextPreview(req: express.Request, res: express.Response): void {
  const user = userOf(req);
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  const src = (req.method === 'POST' && req.body && typeof req.body === 'object')
    ? req.body : req.query;
  const draftSession = {
    name: typeof src.name === 'string' ? src.name : '',
    description: typeof src.description === 'string' ? src.description : '',
    pc_client_metadata: src.pc_client_metadata ?? null,
  };
  const excludedSkillIds = toIdList(src.excluded_skill_ids);
  const excludedMemoryIds = toIdList(src.excluded_memory_ids);
  const language = src.language === 'en' ? 'en' : 'zh';
  const existingIssue = findArchitectureIssue(project.id);
  const ctx = existingIssue
    ? buildIssueContextPreview(user, existingIssue.id, draftSession, excludedSkillIds, excludedMemoryIds, language)
    : buildProjectIssueContextPreview(
      user,
      project.id,
      { title: ARCHITECTURE_ISSUE_TITLE, description: ARCHITECTURE_ISSUE_DESCRIPTION },
      draftSession,
      excludedSkillIds,
      excludedMemoryIds,
      language,
    );
  res.json({ body: ctx.body, sources: ctx.sources });
}

router.get('/:id/architecture-session-preset/context-preview', auth, handleArchitectureSessionPresetContextPreview);
router.post('/:id/architecture-session-preset/context-preview', auth, handleArchitectureSessionPresetContextPreview);

router.get('/:id/architecture-session-preset/session-selection-defaults', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  const existingIssue = findArchitectureIssue(project.id);
  if (existingIssue) return res.json(buildIssueSelectionDefaults(user, existingIssue.id));
  res.json(buildProjectIssueSelectionDefaults(user, project.id, {
    title: ARCHITECTURE_ISSUE_TITLE,
    description: ARCHITECTURE_ISSUE_DESCRIPTION,
  }));
});

router.post('/:id/architecture-issue', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  if (!canCreateIssue(user, project)) return res.status(403).json({ error: '无权在此项目创建 Issue' });
  const result = ensureArchitectureIssue(project.id, user.id);
  res.json(result);
});

router.get('/:id/architecture-figure', auth, (req: express.Request, res: express.Response) => {
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  const figure = findArchitectureFigure(project);
  if (!figure) return res.status(404).json({ error: '项目结构图不存在或正在绘制中' });
  const kind = figureKind(figure.name);
  res.setHeader('Content-Type', contentTypeForFigure(figure.name));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Architecture-Figure-Name', encodeURIComponent(figure.name));
  res.setHeader('X-Architecture-Figure-Kind', kind);
  res.setHeader('X-Architecture-Figure-Updated-At', figure.stat.mtime.toISOString());
  if (kind === 'html' || kind === 'svg') {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; script-src 'none'"
    );
  }
  res.sendFile(figure.absPath);
});

// 项目设置中的"用户级 Skill 与 Memory 白名单".
// 只影响当前用户的用户级条目和平台内置 Skill; 项目级 Skill/Memory 始终保留.
router.get('/:id/user-context-whitelist', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  const project = loadReadableProject(req, res, id);
  if (!project) return;
  res.json(buildUserContextWhitelistPayload(id, user.id));
});

router.patch('/:id/user-context-whitelist', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  const project = loadReadableProject(req, res, id);
  if (!project) return;

  const availableSkills = Skills.listForUser(user.id).map(shapeContextItem);
  const availableBuiltinSkills = Skills.listBuiltin().map(shapeContextItem);
  const availableMemories = Memories.listForUser(user.id).map(shapeContextItem);
  const skillEnabled = !!req.body?.skill_whitelist_enabled;
  const builtinSkillEnabled = !!req.body?.builtin_skill_whitelist_enabled;
  const memoryEnabled = !!req.body?.memory_whitelist_enabled;
  const skillIds = skillEnabled ? idsAllowedByAvailable(req.body?.skill_ids, availableSkills) : null;
  const builtinSkillIds = builtinSkillEnabled ? idsAllowedByAvailable(req.body?.builtin_skill_ids, availableBuiltinSkills) : null;
  const memoryIds = memoryEnabled ? idsAllowedByAvailable(req.body?.memory_ids, availableMemories) : null;

  Projects.setUserContextWhitelist(id, user.id, { skillIds, builtinSkillIds, memoryIds });
  res.json(buildUserContextWhitelistPayload(id, user.id));
});

router.post('/:id/guided-demo/import/clear-upload-sample', auth, (req: express.Request, res: express.Response) => {
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  if (!isProjectImportDemoBindPath(project.bind_path)) {
    return res.status(400).json({ error: '只能清理导入演示项目的上传样例' });
  }
  try {
    const removed = clearProjectImportUploadedSample(project);
    res.json({ ok: true, removed });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message || '清理上传样例失败' });
  }
});

// 项目 bind_path 下的文件浏览 + VSCode Web 反代入口.
// v1.9 主栈版: vscode_web_url 改为相对路径 `/code-server/<userId>__<projectId>`,
// 走 mobius 反代 + JWT, 每(用户, 项目)独立 code-server 进程 (services/code-server-pool.js).
// 旧 VSCODE_WEB_URL env (绝对 URL) 仅 fallback (vscode_web_url_legacy).
//
// 新增字段:
//   - bind_path_writable: bind_path 对服务进程是否可写 (不可写则前端屏蔽"打开"按钮)
//   - cs_url_token_required: 前端首次 navigate 必须把 JWT 当 ?_jwt=<token> 拼上
router.get('/:id/files', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  if (!project.bind_path) {
    return res.json({
      bind_path: '', vscode_web_url: '', vscode_web_url_legacy: VSCODE_WEB_URL || '',
      vscode_workspace_path: '',
      bind_path_writable: false, cs_url_token_required: true,
      path: '/', entries: [],
    });
  }

  let writable = false;
  try { fs.accessSync(project.bind_path, fs.constants.W_OK); writable = true; } catch {}

  const csUrl = `/code-server/${user.id}__${project.id}`;
  const vscodeWorkspacePath = defaultCodeServerWorkspace(project);

  const resolved = resolveProjectPath(project.bind_path, req.query.path || '/');
  if ('error' in resolved) return res.status(400).json({ error: resolved.error });
  const { absPath, relPath } = resolved;
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) return res.status(404).json({ error: 'Not found' });
  try {
    const entries = fs.readdirSync(absPath, { withFileTypes: true })
      .filter((e: fs.Dirent) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e: fs.Dirent) => {
        const full = path.join(absPath, e.name);
        let stat: fs.Stats;
        try { stat = fs.statSync(full); } catch { return null; }
        return {
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size: e.isFile() ? stat.size : null,
          modified: stat.mtime,
          abs_path: full,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
    res.json({
      bind_path: project.bind_path,
      vscode_web_url: csUrl,
      vscode_web_url_legacy: VSCODE_WEB_URL || '',
      vscode_workspace_path: vscodeWorkspacePath,
      bind_path_writable: writable,
      cs_url_token_required: true,
      path: relPath,
      entries,
    });
  } catch {
    res.status(500).json({ error: 'Read failed' });
  }
});

router.get('/:id/main-project-port', auth, (req: express.Request, res: express.Response) => {
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  const filePath = mainProjectPortPath(project);
  if (!filePath) return res.json({ port: null, valid: false, exists: false });
  try {
    if (!fs.existsSync(filePath)) {
      return res.json({ port: null, valid: false, exists: false });
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const port = normalizeProjectPort(raw);
    return res.json({ port, valid: port !== null, exists: true });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message || '读取项目端口失败' });
  }
});

router.get('/:id/ssh-forward-config', auth, (req: express.Request, res: express.Response) => {
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;

  const parsed = parseMobiusSshUrl(MOBIUS_SSH_URL);
  const invalidUrlPort = parsed.port === 443;
  const sshPort = invalidUrlPort ? null : (parsed.port || MOBIUS_SSH_PORT || null);
  const key = readSshPrivateKey();
  const missing: string[] = [];
  if (!parsed.host) missing.push('MOBIUS_SSH_URL');
  if (invalidUrlPort) missing.push('MOBIUS_SSH_URL_port_must_not_be_443');
  if (!sshPort) missing.push('MOBIUS_SSH_PORT');
  if (!key.privateKeyExists) missing.push('ssh_private_key');

  res.json({
    enabled: missing.length === 0,
    ssh_url: MOBIUS_SSH_URL || '',
    host: parsed.host,
    port: sshPort,
    mobius_ssh_port: MOBIUS_SSH_PORT || null,
    user: MOBIUS_SSH_FORWARD_USER,
    private_key: key.privateKey,
    private_key_path: MOBIUS_SSH_PRIVATE_KEY_PATH || '',
    private_key_exists: key.privateKeyExists,
    missing,
  });
});

router.post('/:id/main-project-port', auth, (req: express.Request, res: express.Response) => {
  const project = loadReadableProject(req, res, String(req.params.id));
  if (!project) return;
  if (!project.bind_path) return res.status(400).json({ error: '项目未配置 bind_path' });
  const port = normalizeProjectPort(req.body?.port);
  if (port === null) return res.status(400).json({ error: '端口必须是 1-65535 的整数' });
  const filePath = mainProjectPortPath(project);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${port}\n`, 'utf8');
    return res.json({ port, valid: true, exists: true });
  } catch (e) {
    return res.status(500).json({ error: (e as Error).message || '保存项目端口失败' });
  }
});

export = router;
