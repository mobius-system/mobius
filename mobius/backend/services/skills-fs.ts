/**
 * skills-fs.js — 文件系统驱动的 skill 存取.
 *
 * 路径布局:
 *   CORE_DATA_PATH/skills/
 *     user=${userId}/
 *       default_project/.claude/skills/<skill-dir>/SKILL.md         # 用户级
 *       project=${projectId}/.claude/skills/<skill-dir>/SKILL.md    # 项目级
 *
 * 安装: 在目标目录下执行 `npx --yes skills add <package>`, npm 包 `skills` (CLI 'skills')
 * 会按 Claude Code 约定把 skill 写到当前 cwd 的 `.claude/skills/<name>/SKILL.md`.
 * <package> 形如 `owner/repo` 或 `owner/repo@skill-name` (来源是 git 仓库).
 *
 * Skill ID 编码 (含所有上下文, 可逆解析, 不依赖 DB):
 *   user:${userId}:${dirName}
 *   project:${userId}:${projectId}:${dirName}
 *
 * 跨用户 / 跨项目复制: listAll() 枚举全平台 user/project 级 skill 作为可复制目录,
 * copyToScope() 把任意一条整目录快照复制到调用者的用户级或某项目级.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { parseFrontmatter } from './skill-loader';
import { CORE_DATA_PATH } from '../config';
import {
  MAX_SKILL_UPLOAD_BYTES,
  checkFileSize,
  detectArchiveKind,
  detectMarkdownFile,
  extractArchiveFile,
  inspectExtractedTree,
  removeIfExists,
  safeResolveUnder,
  stripArchiveOrMarkdownExtension,
} from './context-import-utils';

// CORE_DATA_PATH/skills/ stores user-installed skills outside application code.
const ROOT = path.join(CORE_DATA_PATH, 'skills');
// <repo-root>/skills/ — 莫比乌斯 AI 项目内置 skill, 与用户安装目录分离.
const BUILTIN_ROOT = path.resolve(__dirname, '..', '..', '..', 'skills');

// npx skills CLI 把 skill 安装到 cwd 的 .claude/skills/ 下 (Claude Code 约定).
const SKILL_SUBDIR = path.join('.claude', 'skills');
const skillFileCache = new Map<string, { mtimeMs: number; size: number; value: any }>();

// `cwd` = 跑 npx 的目录; `skillsHome` = 该 cwd 下实际容纳 SKILL.md 的目录.
function userDefaultCwd(userId: any): string { return path.join(ROOT, `user=${userId}`, 'default_project'); }
function userProjectCwd(userId: any, projectId: any): string { return path.join(ROOT, `user=${userId}`, `project=${projectId}`); }
function userDefaultDir(userId: any): string { return path.join(userDefaultCwd(userId), SKILL_SUBDIR); }
function userProjectDir(userId: any, projectId: any): string { return path.join(userProjectCwd(userId, projectId), SKILL_SUBDIR); }

function ensureDir(p: string): void { fs.mkdirSync(p, { recursive: true }); }

function listSkillDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(dir, e.name));
}

function readSkillFromDir(dir: string): any {
  const skillMd = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return null;
  let stat: fs.Stats;
  try { stat = fs.statSync(skillMd); } catch { return null; }
  const cached = skillFileCache.get(skillMd);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { ...cached.value };
  }
  let body = '';
  try { body = fs.readFileSync(skillMd, 'utf8'); } catch { return null; }
  const { meta } = parseFrontmatter(body);
  const dirName = path.basename(dir);
  const name = (meta.name || dirName || '').trim();
  if (!name) return null;
  const value = {
    name,
    description: (meta.description || '').trim(),
    research_role: (meta.research_role || '').trim(),
    body,
    dirName,
    created_at: stat.birthtime.toISOString(),
    updated_at: stat.mtime.toISOString(),
  };
  skillFileCache.set(skillMd, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return { ...value };
}

function encodeUserId(userId: any, dirName: string): string { return `user:${userId}:${dirName}`; }
function encodeProjectId(userId: any, projectId: any, dirName: string): string { return `project:${userId}:${projectId}:${dirName}`; }
function encodeBuiltinId(dirName: string): string { return `builtin:${dirName}`; }

function parseSkillId(id: any): any {
  if (typeof id !== 'string') return null;
  const parts = id.split(':');
  if (parts[0] === 'builtin' && parts.length >= 2) {
    return { scope: 'builtin', dirName: parts.slice(1).join(':') };
  }
  if (parts[0] === 'user' && parts.length >= 3) {
    return { scope: 'user', userId: parts[1], dirName: parts.slice(2).join(':') };
  }
  if (parts[0] === 'project' && parts.length >= 4) {
    return { scope: 'project', userId: parts[1], projectId: parts[2], dirName: parts.slice(3).join(':') };
  }
  return null;
}

function shapeUser(sk: any, userId: any): any {
  return {
    id: encodeUserId(userId, sk.dirName),
    scope: 'user',
    owner_id: userId,
    name: sk.name,
    description: sk.description,
    research_role: sk.research_role || '',
    body: sk.body,
    created_by: userId,
    created_at: sk.created_at,
    updated_at: sk.updated_at,
  };
}
function shapeProject(sk: any, userId: any, projectId: any): any {
  return {
    id: encodeProjectId(userId, projectId, sk.dirName),
    scope: 'project',
    owner_id: projectId,
    name: sk.name,
    description: sk.description,
    research_role: sk.research_role || '',
    body: sk.body,
    created_by: userId,
    created_at: sk.created_at,
    updated_at: sk.updated_at,
  };
}
function shapeBuiltin(sk: any): any {
  return {
    id: encodeBuiltinId(sk.dirName),
    scope: 'builtin',
    owner_id: 'builtin',
    name: sk.name,
    description: sk.description,
    research_role: sk.research_role || '',
    body: sk.body,
    dirName: sk.dirName,
    created_by: 'system',
    created_at: sk.created_at,
    updated_at: sk.updated_at,
  };
}

function listForUser(userId: any): any[] {
  return listSkillDirs(userDefaultDir(userId))
    .map(d => readSkillFromDir(d))
    .filter(Boolean)
    .map(sk => shapeUser(sk, userId))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function listForProject(projectId: any): any[] {
  if (!fs.existsSync(ROOT)) return [];
  const userDirs = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('user='));
  const out = [];
  for (const ud of userDirs) {
    const userId = ud.name.slice(5);
    const projDir = path.join(ROOT, ud.name, `project=${projectId}`, SKILL_SUBDIR);
    for (const d of listSkillDirs(projDir)) {
      const sk = readSkillFromDir(d);
      if (sk) out.push(shapeProject(sk, userId, projectId));
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// resolver 期望按 scope DESC 排序 (user 在前, 同名时保留 user 版本).
// 两层注入: user (个人优先) → project (项目专属).
function listForIssue(userId: any, projectId: any): any[] {
  return [...listForUser(userId), ...listForProject(projectId)];
}

function listBuiltin(): any[] {
  return listSkillDirs(BUILTIN_ROOT)
    .map(d => readSkillFromDir(d))
    .filter(Boolean)
    .map(shapeBuiltin)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// 全平台所有用户级 + 项目级 skill, 用于「从其他用户/项目复制」目录浏览.
// 不做去重 / 不做权限过滤 — 调用方(路由)决定展示与排除规则.
function listAll(): any[] {
  if (!fs.existsSync(ROOT)) return [];
  const out = [];
  for (const ud of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!ud.isDirectory() || !ud.name.startsWith('user=')) continue;
    const userId = ud.name.slice(5);
    const userBase = path.join(ROOT, ud.name);
    for (const d of listSkillDirs(userDefaultDir(userId))) {
      const sk = readSkillFromDir(d);
      if (sk) out.push(shapeUser(sk, userId));
    }
    for (const sub of fs.readdirSync(userBase, { withFileTypes: true })) {
      if (!sub.isDirectory() || !sub.name.startsWith('project=')) continue;
      const projectId = sub.name.slice(8);
      for (const d of listSkillDirs(userProjectDir(userId, projectId))) {
        const sk = readSkillFromDir(d);
        if (sk) out.push(shapeProject(sk, userId, projectId));
      }
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function findById(id: any): any {
  const parsed = parseSkillId(id);
  if (!parsed) return null;
  if (parsed.scope === 'builtin') {
    const sk = readSkillFromDir(path.join(BUILTIN_ROOT, parsed.dirName));
    return sk ? shapeBuiltin(sk) : null;
  }
  if (parsed.scope === 'user') {
    const sk = readSkillFromDir(path.join(userDefaultDir(parsed.userId), parsed.dirName));
    return sk ? shapeUser(sk, parsed.userId) : null;
  }
  if (parsed.scope === 'project') {
    const sk = readSkillFromDir(path.join(userProjectDir(parsed.userId, parsed.projectId), parsed.dirName));
    return sk ? shapeProject(sk, parsed.userId, parsed.projectId) : null;
  }
  return null;
}

// 反推一个 skill id 对应的源目录 (含 SKILL.md 与资源文件).
// 不校验目录是否存在, 调用方按需 fs.existsSync 检查.
function getSourceDir(id: any): string | null {
  const parsed = parseSkillId(id);
  if (!parsed) return null;
  if (parsed.scope === 'builtin') {
    const dir = path.resolve(BUILTIN_ROOT, parsed.dirName);
    const root = path.resolve(BUILTIN_ROOT);
    if (dir !== root && dir.startsWith(root + path.sep)) return dir;
    return null;
  }
  if (parsed.scope === 'user') return path.join(userDefaultDir(parsed.userId), parsed.dirName);
  if (parsed.scope === 'project') return path.join(userProjectDir(parsed.userId, parsed.projectId), parsed.dirName);
  return null;
}

// 跨 scope 移动 skill 目录: 用户级 ↔ 项目级.
// 约束:
//   - 只有 skill 的安装者本人 (id 里的 userId) 能调用; admin 由路由层放行.
//   - 目标位置已有同 dirName 直接拒绝, 不静默覆盖.
//   - 路径必须在 ROOT 下, 防 ../ 越权.
// 返回 { ok, skill?: 新 shape (含新 id), error? }.
function moveSkill({ id, requesterUserId, isAdmin, targetScope, targetProjectId }: any): any {
  const parsed = parseSkillId(id);
  if (!parsed) return { ok: false, error: 'id 非法' };
  if (!isAdmin && parsed.userId !== requesterUserId) {
    return { ok: false, error: '只能移动你自己安装的 skill' };
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

  const srcDir = parsed.scope === 'user'
    ? path.join(userDefaultDir(parsed.userId), parsed.dirName)
    : path.join(userProjectDir(parsed.userId, parsed.projectId), parsed.dirName);
  const destParent = targetScope === 'user'
    ? userDefaultDir(parsed.userId)
    : userProjectDir(parsed.userId, targetProjectId);
  const destDir = path.join(destParent, parsed.dirName);

  const rootResolved = path.resolve(ROOT) + path.sep;
  const srcResolved = path.resolve(srcDir);
  const destResolved = path.resolve(destDir);
  if (!srcResolved.startsWith(rootResolved)) return { ok: false, error: '源路径非法' };
  if (!destResolved.startsWith(rootResolved)) return { ok: false, error: '目标路径非法' };
  if (!fs.existsSync(srcResolved)) return { ok: false, error: '源目录不存在' };
  if (fs.existsSync(destResolved)) return { ok: false, error: '目标位置已存在同名 skill' };

  ensureDir(destParent);
  try {
    fs.renameSync(srcResolved, destResolved);
  } catch (e) {
    return { ok: false, error: `重命名失败: ${e.message}` };
  }
  const sk = readSkillFromDir(destResolved);
  if (!sk) return { ok: false, error: '移动后读取失败' };
  return {
    ok: true,
    skill: targetScope === 'user'
      ? shapeUser(sk, parsed.userId)
      : shapeProject(sk, parsed.userId, targetProjectId),
  };
}

// 把任意一条 user/project 级 skill 整目录快照复制到调用者的用户级或某项目级.
// 快照模式: 复制后两边独立, 源后续修改不影响副本.
// 约束: 目标已有同 dirName 直接拒绝; 路径必须在 ROOT 下.
function copyToScope({ sourceId, targetUserId, targetProjectId }: any): any {
  const parsed = parseSkillId(sourceId);
  if (!parsed) return { ok: false, error: 'source id 非法' };
  const srcDir = getSourceDir(sourceId);
  if (!srcDir || !fs.existsSync(srcDir)) return { ok: false, error: '源 skill 不存在' };

  const destParent = targetProjectId
    ? userProjectDir(targetUserId, targetProjectId)
    : userDefaultDir(targetUserId);
  const destDir = path.join(destParent, parsed.dirName);

  const rootResolved = path.resolve(ROOT) + path.sep;
  if (!path.resolve(srcDir).startsWith(rootResolved)) return { ok: false, error: '源路径非法' };
  if (!path.resolve(destDir).startsWith(rootResolved)) return { ok: false, error: '目标路径非法' };
  if (fs.existsSync(destDir)) return { ok: false, error: '目标位置已有同名 skill, 请先删掉再复制' };

  ensureDir(destParent);
  try {
    fs.cpSync(srcDir, destDir, { recursive: true });
    // 清理可能遗留的旧版元数据 sidecar (历史 shared 池产物)
    const metaPath = path.join(destDir, '.imac.meta.json');
    if (fs.existsSync(metaPath)) fs.rmSync(metaPath, { force: true });
  } catch (e) {
    return { ok: false, error: `复制失败: ${e.message}` };
  }
  const sk = readSkillFromDir(destDir);
  if (!sk) return { ok: false, error: '复制后读取失败' };
  return {
    ok: true,
    skill: targetProjectId
      ? shapeProject(sk, targetUserId, targetProjectId)
      : shapeUser(sk, targetUserId),
  };
}

// 目录名安全化: 去掉路径分隔符与 .. , 仅保留常见文件名字符.
function sanitizeDirName(name: any): string {
  return String(name || '')
    .trim()
    .replace(/[/\\]/g, '')
    .replace(/\.\./g, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

function listChildDirs(dir: string): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

function hasSkillMd(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'SKILL.md'));
}

function directSkillChildDirs(dir: string): string[] {
  return listChildDirs(dir).filter((child) => hasSkillMd(child));
}

function preferredSkillImportSource(root: string): string {
  if (hasSkillMd(root) || directSkillChildDirs(root).length > 0) return root;

  const skillsDir = path.join(root, 'skills');
  if (directSkillChildDirs(skillsDir).length > 0) return skillsDir;

  const childDirs = listChildDirs(root).filter((child) => {
    const name = path.basename(child);
    return name !== '__MACOSX' && !name.startsWith('.');
  });
  if (childDirs.length === 1) {
    const child = childDirs[0];
    if (hasSkillMd(child) || directSkillChildDirs(child).length > 0) return child;
    const nestedSkillsDir = path.join(child, 'skills');
    if (directSkillChildDirs(nestedSkillsDir).length > 0) return nestedSkillsDir;
  }

  return root;
}

function materializeMarkdownSkillSource(filePath: string, stagingRoot: string): any {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parseFrontmatter(content);
  const dirName = sanitizeDirName(parsed.meta?.name || stripArchiveOrMarkdownExtension(filePath) || 'local-skill');
  if (!dirName) return { ok: false, error: '无法从 Markdown 文件中确定合法的 skill 名称' };
  const sourceDir = safeResolveUnder(stagingRoot, dirName);
  if (!sourceDir) return { ok: false, error: 'skill 名称非法' };
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'SKILL.md'), content, 'utf8');
  return { ok: true, sourceDir };
}

function importFromResolvedSource({ userId, projectId, sourcePath }: any): any {
  let src = path.resolve(sourcePath);
  let stat;
  try { stat = fs.statSync(src); } catch (e) { return { ok: false, error: `无法访问该路径: ${e.message}` }; }

  // 收集候选 skill 源目录.
  let skillDirs;
  if (stat.isFile()) {
    if (path.basename(src) !== 'SKILL.md') {
      return { ok: false, error: '文件路径必须指向 .md/SKILL.md 或 skill 压缩包' };
    }
    skillDirs = [path.dirname(src)];
  } else if (stat.isDirectory()) {
    if (fs.existsSync(path.join(src, 'SKILL.md'))) {
      skillDirs = [src];
    } else {
      skillDirs = listSkillDirs(src).filter(d => fs.existsSync(path.join(d, 'SKILL.md')));
      if (skillDirs.length === 0) {
        return { ok: false, error: '该目录下未找到 SKILL.md (它既不是 skill 目录, 也不含 skill 子目录)' };
      }
    }
  } else {
    return { ok: false, error: '路径既不是文件也不是目录' };
  }

  const destParent = projectId ? userProjectDir(userId, projectId) : userDefaultDir(userId);
  const rootResolved = path.resolve(ROOT) + path.sep;
  ensureDir(destParent);

  const imported = [];
  const skipped = [];
  for (const srcDir of skillDirs) {
    const base = path.basename(srcDir);
    const meta = readSkillFromDir(srcDir);
    if (!meta) { skipped.push({ name: base, reason: 'SKILL.md 缺失或没有 name 字段' }); continue; }
    try {
      inspectExtractedTree(srcDir);
    } catch (e) {
      skipped.push({ name: base, reason: e.message || 'skill 目录超过限制' });
      continue;
    }
    const dirName = sanitizeDirName(base) || sanitizeDirName(meta.name);
    if (!dirName) { skipped.push({ name: base, reason: '无法确定合法目录名' }); continue; }
    const destDir = path.join(destParent, dirName);
    if (!path.resolve(destDir).startsWith(rootResolved)) { skipped.push({ name: dirName, reason: '目标路径非法' }); continue; }
    if (path.resolve(srcDir) === path.resolve(destDir)) { skipped.push({ name: dirName, reason: '源与目标是同一目录' }); continue; }
    if (fs.existsSync(destDir)) { skipped.push({ name: dirName, reason: '目标已存在同名 skill, 请先删除再导入' }); continue; }
    try {
      fs.cpSync(srcDir, destDir, { recursive: true });
      // 清理可能携带的旧版元数据 sidecar (历史 shared 池产物)
      const metaPath = path.join(destDir, '.imac.meta.json');
      if (fs.existsSync(metaPath)) fs.rmSync(metaPath, { force: true });
    } catch (e) {
      skipped.push({ name: dirName, reason: `复制失败: ${e.message}` });
      continue;
    }
    const sk = readSkillFromDir(destDir);
    if (!sk) { skipped.push({ name: dirName, reason: '复制后读取失败 (SKILL.md 不可解析)' }); continue; }
    imported.push(projectId ? shapeProject(sk, userId, projectId) : shapeUser(sk, userId));
  }

  if (imported.length === 0) {
    const detail = skipped.map(s => `${s.name} (${s.reason})`).join('; ');
    return { ok: false, error: `没有导入任何 skill: ${detail || '无可导入项'}` };
  }
  return { ok: true, skills: imported, skipped };
}

// 从「服务器本地绝对路径」导入 skill (开发者自制 skill, 不走 Github/npx).
// sourcePath 可以是:
//   - 直接含 SKILL.md 的目录                → 视为单个 skill
//   - 指向某个 .md/SKILL.md 文件的路径      → 视为单文件 skill
//   - 指向 .zip/.tar/.tar.gz 等压缩包        → 解压后导入 skill 目录
//   - 含多个 <子目录>/SKILL.md 的父目录     → 批量导入其下全部 skill
// 复制为快照 (与源解耦, 源后续改动不影响副本), 落到调用者用户级或某项目级.
// 目标已存在同名 dirName 的逐个跳过 (不静默覆盖), 返回 { ok, skills, skipped }.
function importFromLocalPath({ userId, projectId, sourcePath }: any): any {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
    return { ok: false, error: '请输入 skill 的服务器绝对路径' };
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

  if (!stat.isFile()) return importFromResolvedSource({ userId, projectId, sourcePath: src });

  const archiveKind = detectArchiveKind(src);
  const markdown = detectMarkdownFile(src);
  if (!archiveKind && !markdown && path.basename(src) !== 'SKILL.md') {
    return { ok: false, error: '文件路径必须指向 .md/SKILL.md、skill 压缩包，或改为传 skill 所在目录' };
  }

  if (path.basename(src) === 'SKILL.md') {
    const sizeCheck = checkFileSize(src, MAX_SKILL_UPLOAD_BYTES, 'SKILL.md');
    if (!sizeCheck.ok) return { ok: false, error: sizeCheck.error };
    return importFromResolvedSource({ userId, projectId, sourcePath: src });
  }

  if (markdown) {
    const sizeCheck = checkFileSize(src, MAX_SKILL_UPLOAD_BYTES, 'Skill Markdown 文件');
    if (!sizeCheck.ok) return { ok: false, error: sizeCheck.error };
  }

  ensureDir(ROOT);
  const tempRoot = fs.mkdtempSync(path.join(ROOT, '.local-import-'));
  try {
    let preparedSource = '';
    if (archiveKind) {
      extractArchiveFile(src, tempRoot, { kind: archiveKind });
      preparedSource = preferredSkillImportSource(tempRoot);
    } else {
      const prepared = materializeMarkdownSkillSource(src, tempRoot);
      if (!prepared.ok) return prepared;
      preparedSource = prepared.sourceDir;
    }
    return importFromResolvedSource({ userId, projectId, sourcePath: preparedSource });
  } catch (e) {
    return { ok: false, error: e.message || '导入本地 skill 失败' };
  } finally {
    removeIfExists(tempRoot);
  }
}

function deleteById(id: any): boolean {
  const parsed = parseSkillId(id);
  if (!parsed) return false;
  let dir;
  if (parsed.scope === 'user') dir = path.join(userDefaultDir(parsed.userId), parsed.dirName);
  else if (parsed.scope === 'project') dir = path.join(userProjectDir(parsed.userId, parsed.projectId), parsed.dirName);
  else return false;
  const resolved = path.resolve(dir);
  // 安全护栏: 必须落在 ROOT 之下, 防止 ../ 之类
  if (!resolved.startsWith(path.resolve(ROOT) + path.sep)) return false;
  if (!fs.existsSync(resolved)) return false;
  fs.rmSync(resolved, { recursive: true, force: true });
  return true;
}

function deleteForProject(projectId: any): number {
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

// npx 包名/标识符放宽到常见 npm 字符集. 不允许 .. 或前导斜杠.
function isSafeSkillName(name: any): boolean {
  if (typeof name !== 'string') return false;
  if (!name || name.includes('..')) return false;
  return /^[A-Za-z0-9._@/-]+$/.test(name);
}

function runNpxSkillsAdd(targetDir: string, skillName: string): Promise<any> {
  // --agent claude-code 指定只装到 .claude/skills/, --yes 跳过交互确认.
  // 不带 --agent 时 CLI 默认走 Universal (.agents/skills/), 不符合我们的扫描位置.
  // MOBIUS_SKILLS_PROXY 存在时为 npx 子进程注入 http(s)_proxy.
  // 通过 NO_PROXY 让 npm registry (npmmirror / npmjs.org) 直连, 只让 git clone github.com 走代理.
  const childEnv: any = { ...process.env };
  const proxyRaw = process.env.MOBIUS_SKILLS_PROXY;
  const proxy = proxyRaw && !/^(disabled|off|none|false)$/i.test(proxyRaw) ? proxyRaw : '';
  if (proxy) {
    childEnv.http_proxy = proxy;
    childEnv.https_proxy = proxy;
    childEnv.HTTP_PROXY = proxy;
    childEnv.HTTPS_PROXY = proxy;
    const noProxy = process.env.MOBIUS_SKILLS_NO_PROXY
      || 'registry.npmmirror.com,registry.npmjs.org,npmmirror.com,localhost,127.0.0.1';
    childEnv.no_proxy = noProxy;
    childEnv.NO_PROXY = noProxy;
  }
  return new Promise((resolve) => {
    const proc: any = spawn('npx', ['--yes', 'skills', 'add', skillName, '--agent', 'claude-code', '--yes'], {
      cwd: targetDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d: any) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: any) => { stderr += d.toString(); });
    proc.on('error', (err: any) => resolve({ ok: false, code: -1, stdout, stderr: stderr + '\n' + err.message }));
    proc.on('close', (code: any) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

// 把 URL 中的 user:pass@ 抹掉, 防止代理凭据被回写到 UI 错误信息.
function redactCreds(s: any): any {
  if (typeof s !== 'string') return s;
  return s.replace(/(https?:\/\/)[^:\s/@]+:[^@\s/]+@/g, '$1***:***@');
}

async function install({ userId, projectId, skillName }: any): Promise<any> {
  if (!isSafeSkillName(skillName)) {
    return { ok: false, error: 'skill 包名包含非法字符 (允许字符: A-Z a-z 0-9 . _ - @ /)' };
  }
  let cwd, skillsDir;
  if (projectId) {
    cwd = userProjectCwd(userId, projectId);
    skillsDir = userProjectDir(userId, projectId);
  } else {
    cwd = userDefaultCwd(userId);
    skillsDir = userDefaultDir(userId);
  }
  ensureDir(cwd);
  const before = new Set(listSkillDirs(skillsDir).map(d => path.basename(d)));
  const result = await runNpxSkillsAdd(cwd, skillName);
  if (!result.ok) {
    return {
      ok: false,
      error: redactCreds((result.stderr || result.stdout || 'npx skills add 失败').trim()).slice(-2000),
      code: result.code,
    };
  }
  const afterDirs = listSkillDirs(skillsDir);
  const newDirs = afterDirs.filter(d => !before.has(path.basename(d)));
  let skill = null;
  for (const d of newDirs) {
    const sk = readSkillFromDir(d);
    if (sk) { skill = sk; break; }
  }
  if (!skill) {
    // 更新场景: dirName 已存在, 用 basename(skillName) 兜底定位 (兼容 owner/repo@name 形式)
    const baseName = skillName.split('@').pop().split('/').pop();
    const guessed = path.join(skillsDir, baseName);
    if (fs.existsSync(guessed)) skill = readSkillFromDir(guessed);
  }
  if (!skill) {
    const dump = [
      `npx 执行成功 (exit=0), 但未在 ${skillsDir} 找到 SKILL.md.`,
      `提示: <package> 一般是 'owner/repo' 或 'owner/repo@skill-name' (例: vercel-labs/agent-skills).`,
      `--- npx stdout ---`, (result.stdout || '(empty)').trim(),
      `--- npx stderr ---`, (result.stderr || '(empty)').trim(),
    ].join('\n');
    return { ok: false, error: redactCreds(dump).slice(-4000), stdout: result.stdout, stderr: result.stderr };
  }
  const shaped = projectId ? shapeProject(skill, userId, projectId) : shapeUser(skill, userId);
  return { ok: true, skill: shaped, stdout: result.stdout };
}

export {
  ROOT,
  BUILTIN_ROOT,
  listForUser,
  listForProject,
  listForIssue,
  listBuiltin,
  listAll,
  findById,
  deleteById,
  deleteForProject,
  install,
  importFromLocalPath,
  copyToScope,
  parseSkillId,
  getSourceDir,
  moveSkill,
};
