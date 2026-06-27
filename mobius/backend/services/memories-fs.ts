/**
 * memories-fs.ts — 文件系统驱动的 Memory (记忆) 存取.
 *
 * 与 skills-fs 同构, 区别在于 memory 完全由用户编辑 (无 npx 安装), 一条 memory 即一个 .md 文件.
 *
 * 路径布局:
 *   CORE_DATA_PATH/memories/
 *     user=${userId}/
 *       default_project/<memory-id>.md         # 用户级
 *       project=${projectId}/<memory-id>.md    # 项目级
 *
 * 文件格式 (与 SKILL.md 一致, 复用 parseFrontmatter):
 *   ---
 *   name: <短标题, 必填>
 *   description: <一句话说明, 选填>
 *   ---
 *   <正文 = memory 内容>
 *
 * Memory ID 编码 (可逆, 不依赖 DB):
 *   user:${userId}:${slug}
 *   project:${userId}:${projectId}:${slug}
 *
 * slug 是文件名 (不含 .md). 创建时由后端生成 (时间戳+随机), 与 name 解耦, 便于改名而不动 id.
 *
 * 跨用户 / 跨项目复制: listAll() 枚举全平台 memory 作为可复制条目,
 * copyToScope() 把任意一条复制成调用者用户级 / 某项目级的新 memory (新 slug).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseFrontmatter } from './skill-loader';
import { CORE_DATA_PATH } from '../config';
import {
  MAX_MEMORY_MARKDOWN_BYTES,
  checkFileSize,
  formatBytes,
} from './context-import-utils';

// CORE_DATA_PATH/memories/ stores user memories outside application code.
const ROOT = path.join(CORE_DATA_PATH, 'memories');

function userDefaultDir(userId: string): string { return path.join(ROOT, `user=${userId}`, 'default_project'); }
function userProjectDir(userId: string, projectId: string): string { return path.join(ROOT, `user=${userId}`, `project=${projectId}`); }

function ensureDir(p: string): void { fs.mkdirSync(p, { recursive: true }); }

function listMemoryFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => path.join(dir, e.name));
}

function readMemoryFromFile(file: string): any {
  if (!fs.existsSync(file)) return null;
  const sizeCheck = checkFileSize(file, MAX_MEMORY_MARKDOWN_BYTES, 'Memory Markdown 文件');
  if (!sizeCheck.ok) return null;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const { meta, body } = parseFrontmatter(raw);
  const slug = path.basename(file, '.md');
  const name = (meta.name || slug || '').trim();
  if (!name) return null;
  const stat = fs.statSync(file);
  return {
    slug,
    name,
    description: (meta.description || '').trim(),
    body,
    created_at: (meta.created_at || '').trim() || stat.birthtime.toISOString(),
    updated_at: stat.mtime.toISOString(),
  };
}

function encodeUserId(userId: string, slug: string): string { return `user:${userId}:${slug}`; }
function encodeProjectId(userId: string, projectId: string, slug: string): string { return `project:${userId}:${projectId}:${slug}`; }

function parseMemoryId(id: any): any {
  if (typeof id !== 'string') return null;
  const parts = id.split(':');
  if (parts[0] === 'user' && parts.length >= 3) {
    return { scope: 'user', userId: parts[1], slug: parts.slice(2).join(':') };
  }
  if (parts[0] === 'project' && parts.length >= 4) {
    return { scope: 'project', userId: parts[1], projectId: parts[2], slug: parts.slice(3).join(':') };
  }
  return null;
}

function shapeUser(m: any, userId: string): any {
  return {
    id: encodeUserId(userId, m.slug),
    scope: 'user',
    owner_id: userId,
    name: m.name,
    description: m.description,
    body: m.body,
    created_by: userId,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}
function shapeProject(m: any, userId: string, projectId: string): any {
  return {
    id: encodeProjectId(userId, projectId, m.slug),
    scope: 'project',
    owner_id: projectId,
    name: m.name,
    description: m.description,
    body: m.body,
    created_by: userId,
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

function listForUser(userId: string): any[] {
  return listMemoryFiles(userDefaultDir(userId))
    .map(readMemoryFromFile)
    .filter(Boolean)
    .map(m => shapeUser(m, userId))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function listForProject(projectId: string): any[] {
  if (!fs.existsSync(ROOT)) return [];
  const userDirs = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('user='));
  const out = [];
  for (const ud of userDirs) {
    const userId = ud.name.slice(5);
    const dir = path.join(ROOT, ud.name, `project=${projectId}`);
    for (const f of listMemoryFiles(dir)) {
      const m = readMemoryFromFile(f);
      if (m) out.push(shapeProject(m, userId, projectId));
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// 全平台所有用户级 + 项目级 memory, 用于「从其他用户/项目复制」目录浏览.
function listAll(): any[] {
  if (!fs.existsSync(ROOT)) return [];
  const out = [];
  for (const ud of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!ud.isDirectory() || !ud.name.startsWith('user=')) continue;
    const userId = ud.name.slice(5);
    const userBase = path.join(ROOT, ud.name);
    for (const f of listMemoryFiles(userDefaultDir(userId))) {
      const m = readMemoryFromFile(f);
      if (m) out.push(shapeUser(m, userId));
    }
    for (const sub of fs.readdirSync(userBase, { withFileTypes: true })) {
      if (!sub.isDirectory() || !sub.name.startsWith('project=')) continue;
      const projectId = sub.name.slice(8);
      for (const f of listMemoryFiles(userProjectDir(userId, projectId))) {
        const m = readMemoryFromFile(f);
        if (m) out.push(shapeProject(m, userId, projectId));
      }
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function findById(id: any): any {
  const parsed = parseMemoryId(id);
  if (!parsed) return null;
  if (!isSafeSlug(parsed.slug)) return null;
  if (parsed.scope === 'user') {
    const m = readMemoryFromFile(path.join(userDefaultDir(parsed.userId), `${parsed.slug}.md`));
    return m ? shapeUser(m, parsed.userId) : null;
  }
  if (parsed.scope === 'project') {
    const m = readMemoryFromFile(path.join(userProjectDir(parsed.userId, parsed.projectId), `${parsed.slug}.md`));
    return m ? shapeProject(m, parsed.userId, parsed.projectId) : null;
  }
  return null;
}

// slug 是后端生成的, 但仍要防御性校验: 只允许 [A-Za-z0-9._-], 防止 ../ 越权.
function isSafeSlug(slug: any): boolean {
  if (typeof slug !== 'string' || !slug || slug.length > 128) return false;
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) return false;
  return /^[A-Za-z0-9._-]+$/.test(slug);
}

function newSlug(): string {
  // mem-<base36 时间戳>-<6 hex>
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(3).toString('hex');
  return `mem-${ts}-${rnd}`;
}

// frontmatter 值需要转义掉冒号开头之类的歧义. 简化方案: 强制单行 + 双引号包裹, 内部转义双引号.
function escapeYamlScalar(s: any): string {
  const oneLine = String(s || '').replace(/\r?\n/g, ' ').trim();
  return `"${oneLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildMemoryFile({ name, description, body }: any): string {
  const head = ['---', `name: ${escapeYamlScalar(name)}`];
  if (description && description.trim()) head.push(`description: ${escapeYamlScalar(description)}`);
  head.push('---', '');
  return head.join('\n') + (body || '').replace(/\r\n/g, '\n');
}

function ensureMemoryFileWithinLimit(raw: any): any {
  if (Buffer.byteLength(String(raw || ''), 'utf8') > MAX_MEMORY_MARKDOWN_BYTES) {
    return { ok: false, error: `Memory Markdown 文件不能超过 ${formatBytes(MAX_MEMORY_MARKDOWN_BYTES)}` };
  }
  return { ok: true };
}

function targetPathFor({ userId, projectId, slug }: any): string {
  const dir = projectId ? userProjectDir(userId, projectId) : userDefaultDir(userId);
  return path.join(dir, `${slug}.md`);
}

function withinRoot(p: string): boolean {
  return path.resolve(p).startsWith(path.resolve(ROOT) + path.sep);
}

function create({ userId, projectId, name, description, body }: any): any {
  const trimmedName = (name || '').trim();
  if (!trimmedName) return { ok: false, error: 'name 不能为空' };
  if (trimmedName.length > 200) return { ok: false, error: 'name 过长 (上限 200)' };
  const raw = buildMemoryFile({ name: trimmedName, description, body });
  const sizeCheck = ensureMemoryFileWithinLimit(raw);
  if (!sizeCheck.ok) return sizeCheck;
  const slug = newSlug();
  const file = targetPathFor({ userId, projectId, slug });
  if (!withinRoot(file)) return { ok: false, error: '路径非法' };
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, raw, 'utf8');
  const m = readMemoryFromFile(file);
  if (!m) return { ok: false, error: '写入后读取失败' };
  const shaped = projectId ? shapeProject(m, userId, projectId) : shapeUser(m, userId);
  return { ok: true, memory: shaped };
}

// 用确定 slug 创建/更新项目级 memory. 供系统同步类 memory 使用:
// 同一个项目只维护同一个文件, 避免每次刷新生成重复条目.
function upsertProjectMemory({ userId, projectId, slug, name, description, body }: any): any {
  const ownerId = (userId || '').trim();
  const targetProjectId = (projectId || '').trim();
  const safeSlug = (slug || '').trim();
  const trimmedName = (name || '').trim();
  if (!ownerId) return { ok: false, error: 'userId 不能为空' };
  if (!targetProjectId) return { ok: false, error: 'projectId 不能为空' };
  if (!isSafeSlug(safeSlug)) return { ok: false, error: 'slug 非法' };
  if (!trimmedName) return { ok: false, error: 'name 不能为空' };
  if (trimmedName.length > 200) return { ok: false, error: 'name 过长 (上限 200)' };

  const file = targetPathFor({ userId: ownerId, projectId: targetProjectId, slug: safeSlug });
  if (!withinRoot(file)) return { ok: false, error: '路径非法' };
  ensureDir(path.dirname(file));

  const nextRaw = buildMemoryFile({ name: trimmedName, description, body });
  const sizeCheck = ensureMemoryFileWithinLimit(nextRaw);
  if (!sizeCheck.ok) return sizeCheck;
  let shouldWrite = true;
  if (fs.existsSync(file)) {
    try { shouldWrite = fs.readFileSync(file, 'utf8') !== nextRaw; }
    catch { shouldWrite = true; }
  }
  if (shouldWrite) fs.writeFileSync(file, nextRaw, 'utf8');

  const m = readMemoryFromFile(file);
  if (!m) return { ok: false, error: '写入后读取失败' };
  return { ok: true, memory: shapeProject(m, ownerId, targetProjectId), changed: shouldWrite };
}

function update({ id, name, description, body }: any): any {
  const parsed = parseMemoryId(id);
  if (!parsed) return { ok: false, error: 'id 非法' };
  if (!isSafeSlug(parsed.slug)) return { ok: false, error: 'id 非法' };
  const existing = findById(id);
  if (!existing) return { ok: false, error: '未找到' };
  const next = {
    name: name !== undefined ? String(name).trim() : existing.name,
    description: description !== undefined ? String(description) : existing.description,
    body: body !== undefined ? String(body) : existing.body,
  };
  if (!next.name) return { ok: false, error: 'name 不能为空' };
  if (next.name.length > 200) return { ok: false, error: 'name 过长 (上限 200)' };
  const nextRaw = buildMemoryFile(next);
  const sizeCheck = ensureMemoryFileWithinLimit(nextRaw);
  if (!sizeCheck.ok) return sizeCheck;
  let file;
  if (parsed.scope === 'user') file = path.join(userDefaultDir(parsed.userId), `${parsed.slug}.md`);
  else if (parsed.scope === 'project') file = path.join(userProjectDir(parsed.userId, parsed.projectId), `${parsed.slug}.md`);
  else return { ok: false, error: 'scope 非法' };
  if (!withinRoot(file)) return { ok: false, error: '路径非法' };
  fs.writeFileSync(file, nextRaw, 'utf8');
  const m = readMemoryFromFile(file);
  if (!m) return { ok: false, error: '写入后读取失败' };
  const shaped = parsed.scope === 'user'
    ? shapeUser(m, parsed.userId)
    : shapeProject(m, parsed.userId, parsed.projectId);
  return { ok: true, memory: shaped };
}

// 跨 scope 移动 memory 文件: 用户级 ↔ 项目级.
// 约束:
//   - 只有 memory 的创建者本人 (id 里的 userId) 能调用; admin 由路由层放行.
//   - 目标位置已有同 slug.md 直接拒绝, 不静默覆盖.
//   - 路径必须在 ROOT 下.
// 返回 { ok, memory?: 新 shape (含新 id), error? }.
function moveMemory({ id, requesterUserId, isAdmin, targetScope, targetProjectId }: any): any {
  const parsed = parseMemoryId(id);
  if (!parsed) return { ok: false, error: 'id 非法' };
  if (!isSafeSlug(parsed.slug)) return { ok: false, error: 'id 非法' };
  if (!isAdmin && parsed.userId !== requesterUserId) {
    return { ok: false, error: '只能移动你自己创建的 memory' };
  }
  if (targetScope !== 'user' && targetScope !== 'project') {
    return { ok: false, error: 'targetScope 必须是 user 或 project' };
  }
  if (targetScope === 'project' && !targetProjectId) {
    return { ok: false, error: '迁移到项目级时必须提供 projectId' };
  }
  if (parsed.scope === targetScope &&
      (parsed.scope !== 'project' || parsed.projectId === targetProjectId)) {
    return { ok: false, error: '目标位置与当前相同' };
  }

  const srcFile = parsed.scope === 'user'
    ? path.join(userDefaultDir(parsed.userId), `${parsed.slug}.md`)
    : path.join(userProjectDir(parsed.userId, parsed.projectId), `${parsed.slug}.md`);
  const destDir = targetScope === 'user'
    ? userDefaultDir(parsed.userId)
    : userProjectDir(parsed.userId, targetProjectId);
  const destFile = path.join(destDir, `${parsed.slug}.md`);

  if (!withinRoot(srcFile)) return { ok: false, error: '源路径非法' };
  if (!withinRoot(destFile)) return { ok: false, error: '目标路径非法' };
  if (!fs.existsSync(srcFile)) return { ok: false, error: '源文件不存在' };
  if (fs.existsSync(destFile)) return { ok: false, error: '目标位置已存在同名 memory' };

  ensureDir(destDir);
  try {
    fs.renameSync(srcFile, destFile);
  } catch (e) {
    return { ok: false, error: `重命名失败: ${e.message}` };
  }
  const m = readMemoryFromFile(destFile);
  if (!m) return { ok: false, error: '移动后读取失败' };
  return {
    ok: true,
    memory: targetScope === 'user'
      ? shapeUser(m, parsed.userId)
      : shapeProject(m, parsed.userId, targetProjectId),
  };
}

// 把任意一条 user/project 级 memory 复制成调用者用户级 / 某项目级的新 memory.
// 复用 create(): 重新生成 slug, 避免与已有 memory 冲突; 快照模式.
function copyToScope({ sourceId, targetUserId, targetProjectId }: any): any {
  const orig = findById(sourceId);
  if (!orig) return { ok: false, error: '源 memory 不存在' };
  return create({
    userId: targetUserId,
    projectId: targetProjectId || undefined,
    name: orig.name,
    description: orig.description,
    body: orig.body,
  });
}

// 递归收集目录下的 .md 文件 (跳过隐藏项 / node_modules, 带深度与数量上限防爆).
// 顺序稳定 (按完整路径排序), 便于批量导入结果可预期.
function walkMarkdownFiles(root: string, { maxFiles = 500, maxDepth = 8 }: any = {}): string[] {
  const out: any[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const subDirs = [];
    for (const e of entries) {
      if (out.length >= maxFiles) break;
      if (e.name.startsWith('.')) continue;            // 跳过隐藏文件/目录
      const full = path.join(dir, e.name);
      if (e.isFile()) {
        if (e.name.toLowerCase().endsWith('.md')) out.push(full);
      } else if (e.isDirectory() && e.name !== 'node_modules') {
        subDirs.push(full);
      }
    }
    for (const d of subDirs.sort()) visit(d, depth + 1);
  };
  visit(root, 0);
  return out.sort();
}

// 从「服务器本地绝对路径」导入 memory (开发者自制 / 已有的 .md 笔记, 不走复制目录).
// sourcePath 可以是:
//   - 单个 .md 文件                    → 视为一条 memory
//   - 含多个 *.md 的目录 (递归子目录)  → 批量导入其下全部 .md
// 复制为快照: 重新生成 slug + 经 create() 规范化 frontmatter (name/description+body),
// 与源文件解耦, 源后续改动不影响副本. 落到调用者用户级或某项目级.
// 同名 (name 去空白后忽略大小写) 已存在的逐个跳过, 不静默重复; 平台 Memory 索引
// 文件 MEMORY.md 也跳过 (它是目录索引而非单条 memory). 返回 { ok, memories, skipped }.
function importFromLocalPath({ userId, projectId, sourcePath }: any): any {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
    return { ok: false, error: '请输入 memory 的服务器绝对路径' };
  }
  let src = sourcePath.trim();
  if (!path.isAbsolute(src)) {
    return { ok: false, error: '必须是绝对路径 (以 / 开头)' };
  }
  src = path.resolve(src);
  if (!fs.existsSync(src)) {
    return { ok: false, error: `路径不存在: ${src}` };
  }
  let stat;
  try { stat = fs.statSync(src); } catch (e) { return { ok: false, error: `无法访问该路径: ${e.message}` }; }

  // 收集候选 .md 文件
  let files;
  if (stat.isFile()) {
    if (!src.toLowerCase().endsWith('.md')) {
      return { ok: false, error: '文件必须是 .md (或改为传 memory 所在目录)' };
    }
    const sizeCheck = checkFileSize(src, MAX_MEMORY_MARKDOWN_BYTES, 'Memory Markdown 文件');
    if (!sizeCheck.ok) return { ok: false, error: sizeCheck.error };
    files = [src];
  } else if (stat.isDirectory()) {
    files = walkMarkdownFiles(src);
    if (files.length === 0) {
      return { ok: false, error: '该目录 (含子目录) 下未找到任何 .md 文件' };
    }
  } else {
    return { ok: false, error: '路径既不是文件也不是目录' };
  }

  // 目标 scope 已有 memory 的名字集合, 用于重名跳过 (同批内新建的也并入)
  const existing = projectId ? listForProject(projectId) : listForUser(userId);
  const existingNames = new Set(existing.map(m => (m.name || '').trim().toLowerCase()));

  const imported = [];
  const skipped = [];
  for (const f of files) {
    const base = path.basename(f);
    if (base.toLowerCase() === 'memory.md') {
      skipped.push({ name: base, reason: '平台 Memory 索引文件, 非单条 memory' });
      continue;
    }
    const sizeCheck = checkFileSize(f, MAX_MEMORY_MARKDOWN_BYTES, 'Memory Markdown 文件');
    if (!sizeCheck.ok) { skipped.push({ name: base, reason: sizeCheck.error }); continue; }
    const m = readMemoryFromFile(f);
    if (!m || !m.name) { skipped.push({ name: base, reason: '无法解析为 memory (内容为空或无标题)' }); continue; }
    const key = m.name.trim().toLowerCase();
    if (existingNames.has(key)) { skipped.push({ name: m.name, reason: '同名 memory 已存在, 已跳过' }); continue; }
    const result = create({
      userId, projectId: projectId || undefined,
      name: m.name, description: m.description, body: m.body,
    });
    if (!result.ok) { skipped.push({ name: m.name, reason: result.error || '创建失败' }); continue; }
    existingNames.add(key);
    imported.push(result.memory);
  }

  if (imported.length === 0) {
    const detail = skipped.map(s => `${s.name} (${s.reason})`).join('; ');
    return { ok: false, error: `没有导入任何 memory: ${detail || '无可导入项'}` };
  }
  return { ok: true, memories: imported, skipped };
}

function deleteById(id: any): boolean {
  const parsed = parseMemoryId(id);
  if (!parsed) return false;
  if (!isSafeSlug(parsed.slug)) return false;
  let file;
  if (parsed.scope === 'user') file = path.join(userDefaultDir(parsed.userId), `${parsed.slug}.md`);
  else if (parsed.scope === 'project') file = path.join(userProjectDir(parsed.userId, parsed.projectId), `${parsed.slug}.md`);
  else return false;
  if (!withinRoot(file)) return false;
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

function deleteForProject(projectId: string): number {
  if (!projectId || !fs.existsSync(ROOT)) return 0;
  let count = 0;
  const rootResolved = path.resolve(ROOT) + path.sep;
  for (const ud of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!ud.isDirectory() || !ud.name.startsWith('user=')) continue;
    const dir = path.join(ROOT, ud.name, `project=${projectId}`);
    const resolved = path.resolve(dir);
    if (resolved.startsWith(rootResolved) && fs.existsSync(resolved)) {
      fs.rmSync(resolved, { recursive: true, force: true });
      count += 1;
    }
  }
  return count;
}

export {
  ROOT,
  listForUser,
  listForProject,
  listAll,
  findById,
  create,
  upsertProjectMemory,
  update,
  deleteById,
  deleteForProject,
  copyToScope,
  importFromLocalPath,
  parseMemoryId,
  moveMemory,
};
