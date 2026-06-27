/**
 * extension-registry.ts — 拓展系统的内存注册表 + DB 同步.
 *
 * 启动时 (server.js 末尾) + 管理员调 POST /api/admin/extensions/reload 时:
 *   1. 扫描 mobius/extension/<name>/extension.json
 *   2. 校验 manifest (slug, 必填字段, 文件存在性)
 *   3. 与 projects WHERE kind='extension' diff:
 *        - 新拓展 → upsertExtension (插入 / 重新启用)
 *        - 目录消失的拓展 → setExtensionDisabled(true) (不删 DB 行, 保留用户数据)
 *   4. 内存表暴露给 /api/extensions、/api/ext、/extension/*。
 *
 * 注意:
 *   - extension_name 只接受 ^[a-z][a-z0-9-]{0,31}$ (防路径穿越/避免大小写文件系统坑)
 *   - manifest 失败的拓展不入注册表, 但不阻塞其他拓展 (记错误)
 *   - 同时 mkdir -p CORE_DATA_PATH/extension/<name>/, 让 handler 第一次跑时即可写
 */
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../db';
import { Projects } from '../repositories/projects';
import {
  APP_DIR,
  EXTENSION_ROOT,
  EXTENSION_DATA_ROOT,
  EXTENSION_SYSTEM_USER_ID,
} from '../config';

const EXT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MANIFEST_FILENAME = 'extension.json';
const HANDLER_RELATIVE = path.join('backend', 'extension_backend_handler.js');
const FRONTEND_RELATIVE = 'frontend';

// in-memory registry: Map<name, RegistryEntry>
// RegistryEntry: {
//   name, display_name, description, version, icon, icon_url?,
//   dir, handler_path, frontend_dir, data_dir,
//   project: { sync, default_hidden },
//   manifest_mtime, errors: []
// }
const registry = new Map<string, any>();
// 错误列表 (manifest 解析失败 / handler 缺失 等), 启动日志用
let lastReloadErrors: any[] = [];

function ensureSystemUser(): void {
  // 拓展项目挂 created_by=EXTENSION_SYSTEM_USER_ID; FK 要求 users 里有这行.
  // INSERT OR IGNORE, 已存在则不动. work_dir 给个不可能的占位, 避免误用.
  db.prepare(`
    INSERT OR IGNORE INTO users (id, display_name, password_hash, role, work_dir)
    VALUES (?, ?, '', 'admin', ?)
  `).run(EXTENSION_SYSTEM_USER_ID, '系统(拓展)', '/__extension_system__');
}

function ensureDirSync(p: string): void {
  try { fs.mkdirSync(p, { recursive: true }); } catch { /* noop */ }
}

function safeReadJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { __error: e.message }; }
}

function validateManifest(name: string, manifest: any, dir: string): string[] {
  const errs: string[] = [];
  if (!manifest || typeof manifest !== 'object') {
    errs.push('manifest 不是 JSON 对象');
    return errs;
  }
  if (manifest.name !== name) {
    errs.push(`manifest.name "${manifest.name}" 与目录名 "${name}" 不一致`);
  }
  if (!manifest.display_name || typeof manifest.display_name !== 'string') {
    errs.push('display_name 必填');
  }
  if (manifest.version && typeof manifest.version !== 'string') {
    errs.push('version 必须是字符串');
  }
  // handler 文件必须存在
  const handler = path.join(dir, HANDLER_RELATIVE);
  if (!fs.existsSync(handler)) {
    errs.push(`handler 文件缺失: ${HANDLER_RELATIVE}`);
  }
  // frontend 目录必须存在 (即使 dist/ 未编译也行)
  const frontendDir = path.join(dir, FRONTEND_RELATIVE);
  if (!fs.existsSync(frontendDir)) {
    errs.push(`frontend 目录缺失: ${FRONTEND_RELATIVE}`);
  }
  return errs;
}

function scanFilesystem(): { found: Map<string, any>; errors: any[] } {
  const out = new Map<string, any>();
  const errors: any[] = [];
  if (!fs.existsSync(EXTENSION_ROOT)) {
    return { found: out, errors };
  }
  for (const entry of fs.readdirSync(EXTENSION_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (!EXT_NAME_RE.test(name)) {
      errors.push({ name, error: `目录名不符合 slug 规则 ${EXT_NAME_RE} -- 已跳过` });
      continue;
    }
    const dir = path.join(EXTENSION_ROOT, name);
    const manifestPath = path.join(dir, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) {
      errors.push({ name, error: 'extension.json 缺失' });
      continue;
    }
    const manifest = safeReadJson(manifestPath);
    if (manifest.__error) {
      errors.push({ name, error: `extension.json 解析失败: ${manifest.__error}` });
      continue;
    }
    const validateErrs = validateManifest(name, manifest, dir);
    if (validateErrs.length) {
      errors.push({ name, error: validateErrs.join('; ') });
      continue;
    }
    const manifestStat = fs.statSync(manifestPath);
    const dataDir = path.join(EXTENSION_DATA_ROOT, name);
    ensureDirSync(dataDir);
    // icon 字段是相对路径, 拼到 /extension/<name>/<icon> (前端静态走 frontend/dist/)
    const iconUrl = (typeof manifest.icon === 'string' && manifest.icon)
      ? `/extension/${name}/${manifest.icon.replace(/^[./]+/, '')}`
      : null;
    out.set(name, {
      name,
      display_name: String(manifest.display_name).slice(0, 200),
      description: typeof manifest.description === 'string' ? manifest.description.slice(0, 2000) : '',
      version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
      icon_url: iconUrl,
      project: {
        sync: !manifest.project || manifest.project.sync !== false,
        default_hidden: !!(manifest.project && manifest.project.default_hidden === true),
      },
      dir,
      handler_path: path.join(dir, HANDLER_RELATIVE),
      frontend_dir: path.join(dir, FRONTEND_RELATIVE),
      data_dir: dataDir,
      manifest_mtime_ms: manifestStat.mtimeMs,
    });
  }
  return { found: out, errors };
}

function syncWithDb(found: Map<string, any>): void {
  ensureSystemUser();
  // 1. upsert 当前发现的拓展
  for (const [name, entry] of found.entries()) {
    if (entry.project && entry.project.sync === false) continue;
    Projects.upsertExtension({
      id: `ext_${name}`,
      name: entry.display_name,
      description: entry.description,
      createdBy: EXTENSION_SYSTEM_USER_ID,
      bindPath: APP_DIR,
      extensionName: name,
      defaultHidden: !!(entry.project && entry.project.default_hidden),
    });
  }
  // 2. 目录已消失的拓展 → 标 disabled, 保留行 (用户数据不丢)
  const dbRows = Projects.listExtensions();
  for (const row of dbRows) {
    const entry = row!.extension_name ? found.get(row!.extension_name) : null;
    const stillThere = !!(entry && (!entry.project || entry.project.sync !== false));
    const shouldDisable = !stillThere;
    if (shouldDisable !== row!.disabled) {
      Projects.setExtensionDisabled(row!.extension_name || '', shouldDisable);
    }
  }
}

function reload(): { count: number; errors: any[] } {
  const { found, errors } = scanFilesystem();
  registry.clear();
  for (const [k, v] of found.entries()) registry.set(k, v);
  lastReloadErrors = errors;
  try {
    syncWithDb(found);
  } catch (e) {
    lastReloadErrors.push({ name: '__db_sync__', error: e.message });
  }
  return { count: registry.size, errors: lastReloadErrors };
}

function getAll(): any[] {
  return Array.from(registry.values()).map((e) => ({
    name: e.name,
    display_name: e.display_name,
    description: e.description,
    version: e.version,
    icon_url: e.icon_url,
    entry_url: `/extension/${e.name}/`,
  }));
}

function get(name: any): any {
  return registry.get(name) || null;
}

function getLastReloadErrors(): any[] {
  return lastReloadErrors.slice();
}

export {
  reload,
  getAll,
  get,
  getLastReloadErrors,
  EXT_NAME_RE,
};
