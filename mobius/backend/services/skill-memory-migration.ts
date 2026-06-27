/**
 * skill-memory-migration.ts — Skill 与 Memory 的备份/迁移序列化层.
 *
 * 把分散在不同 user/scope/project 目录下的 Skill 与 Memory 打包成「不分级、不分项目」
 * 的扁平 JSON, 再以 base64 字符串呈现给用户. 反向则从 base64 解析并按用户选择写入
 * 目标 scope (用户级 / 指定项目级).
 *
 * Bundle JSON 结构:
 *   {
 *     "format": "imac-skill-memory-bundle",
 *     "version": 1,
 *     "exported_at": "<ISO8601>",
 *     "exported_by": "<userId>",
 *     "items": [
 *       { "kind": "memory", "name": "...", "description": "...", "body": "..." },
 *       { "kind": "skill",  "name": "...", "description": "...", "dir_name": "...",
 *         "files": [ { "path": "SKILL.md", "content_base64": "..." }, ... ] }
 *     ]
 *   }
 *
 * 安全限制 (导入端):
 *   - bundle 字符串 ≤ 20MB (base64 后)
 *   - 单个 skill 文件 ≤ 2MB, 单条 skill 文件总和 ≤ 8MB, 文件数 ≤ 200
 *   - 跳过常见臃肿目录 (.venv/node_modules/__pycache__/.git) 的导出与导入
 *   - dir_name 必须是合法目录名 (与 skills-fs 一致的字符集), name 必填.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as memoriesFs from './memories-fs';
import * as skillsFs from './skills-fs';
import * as accessControl from './access-control';

const FORMAT_TAG = 'imac-skill-memory-bundle';
const FORMAT_VERSION = 1;

const SKIP_DIR_NAMES = new Set(['.venv', 'node_modules', '__pycache__', '.git', '.DS_Store']);
const MAX_BUNDLE_BASE64_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_SKILL_FILES = 200;
const MAX_PATH_LENGTH = 256;

function sanitizeDirName(name: any): string {
  return String(name || '')
    .trim()
    .replace(/[/\\]/g, '')
    .replace(/\.\./g, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sanitizeRelativePath(rel: any): string | null {
  if (typeof rel !== 'string' || !rel) return null;
  if (rel.length > MAX_PATH_LENGTH) return null;
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return null;
  const parts = normalized.split('/');
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..') return null;
    if (SKIP_DIR_NAMES.has(seg)) return null;
    if (seg.length > 128) return null;
    if (!/^[A-Za-z0-9._\- ]+$/.test(seg)) return null;
  }
  return parts.join('/');
}

// 递归收集 skill 目录内的相对路径 (跳过臃肿目录).
function walkSkillFiles(dir: string): { full: string; rel: string }[] {
  const out: { full: string; rel: string }[] = [];
  const visit = (current: string, rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIR_NAMES.has(e.name)) continue;
      const full = path.join(current, e.name);
      const nextRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile()) out.push({ full, rel: nextRel });
      else if (e.isDirectory()) visit(full, nextRel);
    }
  };
  visit(dir, '');
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function readSkillFiles(sourceDir: string): { ok: true; files: { path: string; content_base64: string }[] } | { ok: false; error: string } {
  const fileList = walkSkillFiles(sourceDir);
  if (fileList.length === 0) return { ok: false, error: 'skill 目录为空' };
  if (fileList.length > MAX_SKILL_FILES) return { ok: false, error: `skill 文件过多 (上限 ${MAX_SKILL_FILES})` };
  let total = 0;
  const files: { path: string; content_base64: string }[] = [];
  for (const item of fileList) {
    let stat: fs.Stats;
    try { stat = fs.statSync(item.full); } catch { continue; }
    if (stat.size > MAX_SKILL_FILE_BYTES) {
      return { ok: false, error: `文件 ${item.rel} 超过 ${MAX_SKILL_FILE_BYTES} 字节, 无法打包` };
    }
    total += stat.size;
    if (total > MAX_SKILL_TOTAL_BYTES) {
      return { ok: false, error: `skill 内容超过 ${MAX_SKILL_TOTAL_BYTES} 字节, 无法打包` };
    }
    let buf: Buffer;
    try { buf = fs.readFileSync(item.full); } catch (e) {
      return { ok: false, error: `读取文件 ${item.rel} 失败: ${e.message}` };
    }
    files.push({ path: item.rel, content_base64: buf.toString('base64') });
  }
  return { ok: true, files };
}

// ---- Inventory -----------------------------------------------------------
// 列出当前管理员能用于导出的所有 Skill 与 Memory.
// 用户级: 只列出请求者 (userId) 自己的; 项目级: 跨用户合并的全部.
function buildInventory({ userId, user, projects }: { userId: string; user: any; projects: any[] }): any {
  const projectMap = new Map((projects || []).map((p) => [p.id, p]));
  const inventory: any = {
    current_user_id: userId,
    user_scope: {
      user_id: userId,
      memories: memoriesFs.listForUser(userId).map((m: any) => shapeInventoryMemory(m, user)),
      skills: skillsFs.listForUser(userId).map((s: any) => shapeInventorySkill(s, user)),
    },
    others_user_scopes: [],
    project_scopes: [],
  };
  // 他人用户级: 全平台合并, 但用 canReadContextItem 过滤隐私.
  const allUserMemories = memoriesFs.listAll();
  const allUserSkills = skillsFs.listAll();
  const grouped = new Map<string, any>();
  const pushInto = (ownerId: string, kind: string, item: any): void => {
    if (!grouped.has(ownerId)) grouped.set(ownerId, { owner_id: ownerId, memories: [], skills: [] });
    grouped.get(ownerId)![kind === 'memory' ? 'memories' : 'skills'].push(item);
  };
  for (const m of allUserMemories) {
    if (m.scope !== 'user') continue;
    if (m.created_by === userId) continue;
    if (user && !accessControl.canReadContextItem(user, 'memory', m)) continue;
    pushInto(m.created_by, 'memory', shapeInventoryMemory(m, user));
  }
  for (const s of allUserSkills) {
    if (s.scope !== 'user') continue;
    if (s.created_by === userId) continue;
    if (user && !accessControl.canReadContextItem(user, 'skill', s)) continue;
    pushInto(s.created_by, 'skill', shapeInventorySkill(s, user));
  }
  for (const [ownerId, payload] of grouped) {
    inventory.others_user_scopes.push(payload);
  }
  inventory.others_user_scopes.sort((a: any, b: any) => a.owner_id.localeCompare(b.owner_id));

  for (const p of projects) {
    inventory.project_scopes.push({
      project_id: p.id,
      project_name: p.name,
      project_created_by: p.created_by || null,
      is_own_project: !!p.created_by && p.created_by === userId,
      memories: memoriesFs.listForProject(p.id).map((m: any) => shapeInventoryMemory(m, user, p)),
      skills: skillsFs.listForProject(p.id).map((s: any) => shapeInventorySkill(s, user, p)),
    });
  }
  return inventory;
}

function shapeInventoryMemory(m: any, user: any, project?: any): any {
  const access = user ? accessControl.contextAccessPayload('memory', m) : null;
  const canManage = user ? accessControl.canManageContextItem(user, 'memory', m) : false;
  return {
    id: m.id,
    scope: m.scope,
    owner_id: m.owner_id,
    name: m.name,
    description: m.description || '',
    body_length: (m.body || '').length,
    created_by: m.created_by,
    created_at: m.created_at,
    updated_at: m.updated_at,
    visibility: access ? access.visibility : null,
    can_manage: canManage,
    project_id: project ? project.id : (m.scope === 'project' ? m.owner_id : null),
  };
}

function shapeInventorySkill(sk: any, user: any, project?: any): any {
  const access = user ? accessControl.contextAccessPayload('skill', sk) : null;
  const canManage = user ? accessControl.canManageContextItem(user, 'skill', sk) : false;
  return {
    id: sk.id,
    scope: sk.scope,
    owner_id: sk.owner_id,
    name: sk.name,
    description: sk.description || '',
    body_length: (sk.body || '').length,
    created_by: sk.created_by,
    created_at: sk.created_at,
    updated_at: sk.updated_at,
    visibility: access ? access.visibility : null,
    can_manage: canManage,
    project_id: project ? project.id : (sk.scope === 'project' ? sk.owner_id : null),
  };
}

// ---- Export --------------------------------------------------------------
// 根据用户勾选的 memory_ids / skill_ids 生成 bundle, 返回 base64 字符串.
function buildExportBundle({ userId, memoryIds, skillIds }: { userId: string; memoryIds?: string[]; skillIds?: string[] }): any {
  const memIds = Array.from(new Set((memoryIds || []).filter(Boolean)));
  const skIds = Array.from(new Set((skillIds || []).filter(Boolean)));
  if (memIds.length === 0 && skIds.length === 0) {
    return { ok: false, error: '请至少勾选一条 skill 或 memory' };
  }

  const items: any[] = [];
  const skippedSources: any[] = [];

  for (const id of memIds) {
    const m = memoriesFs.findById(id);
    if (!m) { skippedSources.push({ id, kind: 'memory', reason: '不存在或不可访问' }); continue; }
    items.push({
      kind: 'memory',
      name: m.name,
      description: m.description || '',
      body: m.body || '',
    });
  }

  for (const id of skIds) {
    const sk = skillsFs.findById(id);
    if (!sk) { skippedSources.push({ id, kind: 'skill', reason: '不存在或不可访问' }); continue; }
    const dir = skillsFs.getSourceDir(id);
    if (!dir || !fs.existsSync(dir)) { skippedSources.push({ id, kind: 'skill', reason: '源目录不存在' }); continue; }
    const filesResult = readSkillFiles(dir);
    if (!filesResult.ok) { skippedSources.push({ id, kind: 'skill', reason: filesResult.error }); continue; }
    const parsed = skillsFs.parseSkillId(id);
    items.push({
      kind: 'skill',
      name: sk.name,
      description: sk.description || '',
      dir_name: parsed && parsed.dirName ? parsed.dirName : sanitizeDirName(sk.name),
      files: filesResult.files,
    });
  }

  if (items.length === 0) {
    return { ok: false, error: '勾选项均无法导出', skipped: skippedSources };
  }

  const bundle = {
    format: FORMAT_TAG,
    version: FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    exported_by: userId,
    items,
  };
  const json = JSON.stringify(bundle);
  const base64 = Buffer.from(json, 'utf8').toString('base64');
  if (base64.length > MAX_BUNDLE_BASE64_BYTES) {
    return { ok: false, error: '导出包过大 (上限 20MB), 请减少勾选项' };
  }
  return {
    ok: true,
    base64,
    summary: {
      total: items.length,
      memories: items.filter((it) => it.kind === 'memory').length,
      skills: items.filter((it) => it.kind === 'skill').length,
      bytes: base64.length,
    },
    skipped: skippedSources,
  };
}

// ---- Preview -------------------------------------------------------------
function decodeBundle(base64: any): any {
  if (typeof base64 !== 'string' || !base64.trim()) {
    return { ok: false, error: '请输入备份字符串' };
  }
  const cleaned = base64.replace(/\s+/g, '');
  if (cleaned.length > MAX_BUNDLE_BASE64_BYTES) {
    return { ok: false, error: '备份字符串过大 (上限 20MB)' };
  }
  let json: string;
  try {
    json = Buffer.from(cleaned, 'base64').toString('utf8');
  } catch (e) {
    return { ok: false, error: `base64 解码失败: ${e.message}` };
  }
  let obj: any;
  try { obj = JSON.parse(json); }
  catch (e) { return { ok: false, error: `不是合法的备份 JSON: ${e.message}` }; }
  if (!obj || typeof obj !== 'object') return { ok: false, error: '备份内容为空' };
  if (obj.format !== FORMAT_TAG) return { ok: false, error: '不是 imac skill-memory 备份字符串' };
  if (obj.version !== FORMAT_VERSION) return { ok: false, error: `不支持的版本: ${obj.version}` };
  if (!Array.isArray(obj.items)) return { ok: false, error: '备份缺少 items 列表' };
  if (obj.items.length === 0) return { ok: false, error: '备份不包含任何条目' };

  const items: any[] = [];
  for (let i = 0; i < obj.items.length; i++) {
    const it = obj.items[i] || {};
    const kind = it.kind;
    const name = typeof it.name === 'string' ? it.name.trim() : '';
    if (!name) continue;
    if (kind === 'memory') {
      items.push({
        index: items.length,
        kind: 'memory',
        name,
        description: typeof it.description === 'string' ? it.description : '',
        body: typeof it.body === 'string' ? it.body : '',
      });
    } else if (kind === 'skill') {
      const files = Array.isArray(it.files) ? it.files : [];
      if (files.length === 0 || files.length > MAX_SKILL_FILES) continue;
      const cleanFiles: { path: string; buffer: Buffer }[] = [];
      let total = 0;
      let bad = false;
      for (const f of files) {
        if (!f || typeof f !== 'object') { bad = true; break; }
        const rel = sanitizeRelativePath(typeof f.path === 'string' ? f.path : '');
        if (!rel) { bad = true; break; }
        const b64 = typeof f.content_base64 === 'string' ? f.content_base64.replace(/\s+/g, '') : '';
        if (!b64) { bad = true; break; }
        let buf: Buffer;
        try { buf = Buffer.from(b64, 'base64'); } catch { bad = true; break; }
        if (buf.length > MAX_SKILL_FILE_BYTES) { bad = true; break; }
        total += buf.length;
        if (total > MAX_SKILL_TOTAL_BYTES) { bad = true; break; }
        cleanFiles.push({ path: rel, buffer: buf });
      }
      if (bad) continue;
      // 必须包含 SKILL.md
      if (!cleanFiles.some((f) => f.path === 'SKILL.md')) continue;
      items.push({
        index: items.length,
        kind: 'skill',
        name,
        description: typeof it.description === 'string' ? it.description : '',
        dir_name: sanitizeDirName(it.dir_name || name),
        files: cleanFiles,
      });
    }
  }
  if (items.length === 0) return { ok: false, error: '备份未解析出任何合法条目' };
  return {
    ok: true,
    exported_at: typeof obj.exported_at === 'string' ? obj.exported_at : '',
    exported_by: typeof obj.exported_by === 'string' ? obj.exported_by : '',
    items,
  };
}

function previewBundle(base64: any): any {
  const decoded = decodeBundle(base64);
  if (!decoded.ok) return decoded;
  return {
    ok: true,
    exported_at: decoded.exported_at,
    exported_by: decoded.exported_by,
    items: decoded.items.map((it: any) => ({
      index: it.index,
      kind: it.kind,
      name: it.name,
      description: it.description,
      dir_name: it.kind === 'skill' ? it.dir_name : null,
      file_count: it.kind === 'skill' ? it.files.length : null,
      body_length: it.kind === 'memory' ? it.body.length : null,
    })),
  };
}

// ---- Import --------------------------------------------------------------
// target: { scope: 'user'|'project', project_id?: '...' }
function importBundle({ requesterUserId, base64, target, selectedIndexes }: { requesterUserId: string; base64: any; target: { scope: string; project_id?: string }; selectedIndexes?: any[] }): any {
  const decoded = decodeBundle(base64);
  if (!decoded.ok) return decoded;
  const scope = target && target.scope === 'project' ? 'project' : 'user';
  const projectId = scope === 'project' ? String(target.project_id || '').trim() : null;
  if (scope === 'project' && !projectId) return { ok: false, error: '导入到项目级时必须指定 project_id' };

  let indexes: any[] = Array.isArray(selectedIndexes) ? selectedIndexes : null as any;
  if (indexes === null) indexes = decoded.items.map((it: any) => it.index); // 默认全选
  const pickSet = new Set<number>(indexes.map(Number).filter((n) => Number.isInteger(n) && n >= 0));
  const picked = decoded.items.filter((it: any) => pickSet.has(it.index));
  if (picked.length === 0) return { ok: false, error: '没有勾选任何条目' };

  const imported: any[] = [];
  const skipped: any[] = [];

  for (const it of picked) {
    if (it.kind === 'memory') {
      const result = memoriesFs.create({
        userId: requesterUserId,
        projectId: scope === 'project' ? projectId : undefined,
        name: it.name,
        description: it.description,
        body: it.body,
      });
      if (!result.ok) {
        skipped.push({ kind: 'memory', name: it.name, reason: result.error || '创建失败' });
        continue;
      }
      imported.push({ kind: 'memory', name: result.memory.name, id: result.memory.id });
    } else if (it.kind === 'skill') {
      const skillResult = writeSkillFromBundle({
        requesterUserId,
        projectId: scope === 'project' ? projectId : null,
        item: it,
      });
      if (!skillResult.ok) {
        skipped.push({ kind: 'skill', name: it.name, reason: skillResult.error });
        continue;
      }
      imported.push({ kind: 'skill', name: skillResult.skill.name, id: skillResult.skill.id });
    }
  }

  if (imported.length === 0) {
    return { ok: false, error: '没有导入任何条目', skipped };
  }
  return { ok: true, imported, skipped };
}

function writeSkillFromBundle({ requesterUserId, projectId, item }: { requesterUserId: string; projectId: string | null; item: any }): any {
  const skillsRoot = (skillsFs as any).ROOT;
  const userBase = projectId
    ? path.join(skillsRoot, `user=${requesterUserId}`, `project=${projectId}`, '.claude', 'skills')
    : path.join(skillsRoot, `user=${requesterUserId}`, 'default_project', '.claude', 'skills');

  let dirName = sanitizeDirName(item.dir_name || item.name);
  if (!dirName) return { ok: false, error: '无法生成合法的 skill 目录名' };
  let destDir = path.join(userBase, dirName);
  const rootResolved = path.resolve(skillsRoot) + path.sep;
  if (!path.resolve(destDir).startsWith(rootResolved)) return { ok: false, error: '目标路径非法' };
  if (fs.existsSync(destDir)) {
    // 自动追加 -import 后缀避免覆盖, 最多尝试 50 次
    let candidate: string | null = null;
    for (let i = 1; i <= 50; i++) {
      const trial = path.join(userBase, `${dirName}-import-${i}`);
      if (!fs.existsSync(trial)) { candidate = trial; break; }
    }
    if (!candidate) return { ok: false, error: '目标位置已存在同名 skill 且自动重命名超过上限' };
    destDir = candidate;
    dirName = path.basename(destDir);
  }

  try {
    fs.mkdirSync(destDir, { recursive: true });
    for (const f of item.files) {
      const dest = path.join(destDir, f.path);
      const destResolved = path.resolve(dest);
      if (!destResolved.startsWith(path.resolve(destDir) + path.sep) && destResolved !== path.resolve(destDir)) {
        return { ok: false, error: `非法相对路径: ${f.path}` };
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.buffer);
    }
  } catch (e) {
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: `写入失败: ${e.message}` };
  }

  // 用 skills-fs 重新读取 + shape
  const id = projectId
    ? `project:${requesterUserId}:${projectId}:${dirName}`
    : `user:${requesterUserId}:${dirName}`;
  const shaped = skillsFs.findById(id);
  if (!shaped) return { ok: false, error: '写入后读取失败 (SKILL.md 可能损坏)' };
  return { ok: true, skill: shaped };
}

export {
  FORMAT_TAG,
  FORMAT_VERSION,
  buildInventory,
  buildExportBundle,
  previewBundle,
  importBundle,
};
