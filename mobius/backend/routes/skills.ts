/**
 * skills.ts — 用户级 / 项目级 Skill 管理 (文件系统驱动).
 *
 * 添加: POST { name: '<skill 标识符>' } → 在目标目录下执行 `npx --yes skills add <name>`.
 * 存储: CORE_DATA_PATH/skills/user=<userId>/{default_project|project=<projectId>}/<skill-dir>/SKILL.md.
 *
 * 挂载位置:
 *   /api/skills                     用户级 (落在 user=<userId>/default_project/)
 *   /api/projects/:projectId/skills 项目级 (落在 user=<userId>/project=<projectId>/, 跨用户合并展示)
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
// @ts-ignore — multer 无 @types
import multer from 'multer';
import { auth } from '../middleware/auth';
import { Skills } from '../repositories/skills';
import { Projects } from '../repositories/projects';
import { UPLOAD_DIR } from '../config';
// @ts-ignore — service 仍是 .js
import { parseFrontmatter } from '../services/skill-loader';
// @ts-ignore — service 仍是 .js
import {
  MAX_SKILL_UPLOAD_BYTES,
  detectContextFileKind,
  extractArchiveFile,
  formatBytes,
  removeIfExists,
  safeOriginalName,
  safeResolveUnder,
  stripArchiveOrMarkdownExtension,
  unlinkIfExists,
} from '../services/context-import-utils';
// @ts-ignore — service 仍是 .js
import {
  canContributeProjectContext,
  canManageContextItem,
  canReadContextItem,
  canReadProject,
  contextAccessPayload,
  filterReadableContextItems,
  isHidden,
  setHidden,
  setResourcePolicy,
  uniqStringList,
  withContextAccess,
} from '../services/access-control';

const skillUpload = multer({
  dest: path.join(UPLOAD_DIR, 'skill-imports'),
  limits: { fileSize: MAX_SKILL_UPLOAD_BYTES },
});

type SkillRow = any;

function shape(row: SkillRow): SkillRow {
  if (!row) return row;
  return {
    id: row.id,
    scope: row.scope,
    owner_id: row.owner_id,
    name: row.name,
    description: row.description || '',
    body: row.body || '',
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    visibility: row.visibility,
    access: row.access,
    can_manage: !!row.can_manage,
    hidden: !!row.hidden,
  };
}

function shapeLite(row: SkillRow): SkillRow {
  const s = shape(row);
  if (!s) return s;
  const { body, ...lite } = s;
  return { ...lite, body_length: (body || '').length };
}

function sanitizeSkillDirName(name: unknown): string {
  return String(name || '')
    .trim()
    .replace(/[/\\]/g, '')
    .replace(/\.\./g, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uploadedSkillBaseName(filename: unknown): string {
  return sanitizeSkillDirName(stripArchiveOrMarkdownExtension(filename));
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

function preferredArchiveImportSource(root: string): string {
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

function materializeRootSkillSource({ sourceDir, uploadRoot, filename }: {
  sourceDir: string;
  uploadRoot: string;
  filename: unknown;
}): string {
  const skillMdPath = path.join(sourceDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return sourceDir;

  let content = '';
  try { content = fs.readFileSync(skillMdPath, 'utf8'); } catch { return sourceDir; }
  const parsed = parseFrontmatter(content) as any;
  const metaName = parsed?.meta?.name;
  const dirName = sanitizeSkillDirName(metaName || uploadedSkillBaseName(filename) || 'uploaded-skill');
  if (!dirName || path.basename(sourceDir) === dirName) return sourceDir;

  const target = safeResolveUnder(uploadRoot, dirName);
  if (!target) return sourceDir;
  removeIfExists(target);
  fs.cpSync(sourceDir, target, { recursive: true });
  return target;
}

function maybeList(body: any, snakeKey: string, camelKey: string): string[] | undefined {
  if (!body || (!Object.prototype.hasOwnProperty.call(body, snakeKey) && !Object.prototype.hasOwnProperty.call(body, camelKey))) {
    return undefined;
  }
  return uniqStringList(body[snakeKey] ?? body[camelKey]);
}

function accessBody(body: any = {}): {
  visibility: unknown;
  allowUserIds: string[] | undefined;
  allowGroupIds: string[] | undefined;
} {
  return {
    visibility: body.visibility,
    allowUserIds: maybeList(body, 'allow_user_ids', 'allowUserIds'),
    allowGroupIds: maybeList(body, 'allow_group_ids', 'allowGroupIds'),
  };
}

function shapeSkill(row: SkillRow, user: any, lite = false): SkillRow {
  const shaped = withContextAccess('skill', row, user);
  return lite ? shapeLite(shaped) : shape(shaped);
}

function visibleSkillList(user: any, items: SkillRow[]): SkillRow[] {
  return filterReadableContextItems(user, 'skill', items)
    .filter((item) => !isHidden(user.id, 'skill', item.id));
}

// ---- 用户级路由 -----------------------------------------------------------
const router = express.Router();

router.get('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  res.json(Skills.listForUser(user.id).map((sk: SkillRow) => shapeSkill(sk, user, true)));
});

// ---- 跨用户/项目复制目录 (全员可读) --------------------------------------
// 列出全平台所有用户级 / 项目级 skill, 供「新建时从其他用户/项目复制」浏览.
// 必须定义在 GET /:id 之前, 否则 'catalog' 会被当成 skill id.
router.get('/catalog', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  res.json(visibleSkillList(user, Skills.listAll()).map((sk: SkillRow) => shapeSkill(sk, user, true)));
});

router.get('/catalog/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const sk = Skills.findById(req.params.id);
  if (!sk) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  if (!canReadContextItem(user, 'skill', sk) || isHidden(user.id, 'skill', sk.id)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  res.json(shapeSkill(sk, user));
});

// 复制目录中任意一条 skill 到我的用户级 (快照模式, 与源独立).
router.post('/copy', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const body = (req.body || {}) as { source_id?: string };
  const sourceId = (body.source_id || '').trim();
  if (!sourceId) {
    res.status(400).json({ error: '缺少 source_id' });
    return;
  }
  const source = Skills.findById(sourceId);
  if (!source || !canReadContextItem(user, 'skill', source)) {
    res.status(404).json({ error: '源 Skill 不可见' });
    return;
  }
  const result = Skills.copyToScope({ sourceId, targetUserId: user.id });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(shapeSkill(result.skill, user));
});

router.get('/:id/access', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const sk = Skills.findById(req.params.id);
  if (!sk || !canReadContextItem(user, 'skill', sk)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  res.json(contextAccessPayload('skill', sk));
});

router.patch('/:id/access', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const sk = Skills.findById(req.params.id);
  if (!sk || !canManageContextItem(user, 'skill', sk)) {
    res.status(403).json({ error: '无权修改此 Skill 权限' });
    return;
  }
  res.json(setResourcePolicy('skill', sk.id, { ...accessBody(req.body), createdBy: sk.created_by }));
});

router.post('/:id/hide', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const sk = Skills.findById(req.params.id);
  if (!sk || !canReadContextItem(user, 'skill', sk)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  setHidden(user.id, 'skill', sk.id, true);
  res.json({ ok: true });
});

router.post('/:id/unhide', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const sk = Skills.findById(req.params.id);
  if (!sk || !canReadContextItem(user, 'skill', sk)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  setHidden(user.id, 'skill', sk.id, false);
  res.json({ ok: true });
});

router.get('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'user' || !canReadContextItem(user, 'skill', sk)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  res.json(shapeSkill(sk, user));
});

router.post('/', auth, async (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const body = (req.body || {}) as { name?: string };
  const name = (body.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'skill 名称不能为空' });
    return;
  }
  const result = await Skills.install({ userId: user.id, skillName: name });
  if (!result.ok) {
    res.status(400).json({ error: result.error, stdout: result.stdout });
    return;
  }
  res.json(shapeSkill(result.skill, user));
});

// 从服务器本地绝对路径导入自制 skill (开发者自己写的 skill, 不走 Github/npx).
router.post('/import-local', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const body = (req.body || {}) as { path?: string };
  const sourcePath = (body.path || '').trim();
  if (!sourcePath) {
    res.status(400).json({ error: '请输入 skill 的服务器绝对路径' });
    return;
  }
  const result = Skills.importLocal({ userId: user.id, sourcePath });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({
    skills: (result.skills || []).map((sk: SkillRow) => shapeSkill(sk, user)),
    skipped: result.skipped || [],
  });
});

function skillUploadRoot({ userId, project }: { userId: string; project?: any }): { ok: true; uploadRoot: string } | { ok: false; error: string } {
  if (project) {
    const bindPath = (project.bind_path || '').trim();
    if (!bindPath) return { ok: false, error: '项目未绑定路径' };
    const uploadRoot = safeResolveUnder(bindPath, '.imac', 'uploaded-skills');
    if (!uploadRoot) return { ok: false, error: '项目路径非法' };
    return { ok: true, uploadRoot };
  }
  const uploadRoot = safeResolveUnder(path.join(UPLOAD_DIR, 'user-skill-imports'), `user=${userId}`);
  if (!uploadRoot) return { ok: false, error: '用户上传路径非法' };
  return { ok: true, uploadRoot };
}

function skillListForTarget({ userId, projectId }: { userId: string; projectId?: string }): SkillRow[] {
  return projectId ? Skills.listForProject(projectId) : Skills.listForUser(userId);
}

function duplicateSkillReason(projectId?: string): string {
  return projectId ? '项目已存在同名 skill' : '用户级已存在同名 skill';
}

interface SkillFileImportCtx {
  projectId?: string;
  project?: any;
}

function importMarkdownSkillFile({ req, res, content, filename, projectId, project }: {
  req: express.Request;
  res: express.Response;
  content: string;
  filename: unknown;
  projectId?: string;
  project?: any;
}): void {
  const user = (req as any).user;
  if (!content.trim()) {
    res.status(400).json({ error: 'SKILL.md 内容不能为空' });
    return;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_UPLOAD_BYTES) {
    res.status(413).json({ error: `SKILL.md 不能超过 ${formatBytes(MAX_SKILL_UPLOAD_BYTES)}` });
    return;
  }

  const parsed = parseFrontmatter(content) as any;
  const metaName = parsed?.meta?.name;
  const requestedName = (((req.body || {}) as { name?: string }).name || metaName || uploadedSkillBaseName(filename) || '').trim();
  const dirName = sanitizeSkillDirName(requestedName);
  if (!dirName) {
    res.status(400).json({ error: '无法从文件中确定合法的 skill 名称' });
    return;
  }

  const existing = skillListForTarget({ userId: user.id, projectId }).find((skill: SkillRow) => {
    const id = typeof skill.id === 'string' ? skill.id : '';
    return skill.name === requestedName || id.endsWith(`:${dirName}`);
  });
  if (existing) {
    res.json({
      ok: true,
      already_exists: true,
      source_type: 'markdown',
      skills: [shapeSkill(existing, user)],
      skipped: [{ name: requestedName || dirName, reason: duplicateSkillReason(projectId) }],
    });
    return;
  }

  const rootResult = skillUploadRoot({ userId: user.id, project });
  if (!rootResult.ok) {
    res.status(400).json({ error: rootResult.error });
    return;
  }
  const uploadRoot = rootResult.uploadRoot;
  const sourceDir = safeResolveUnder(uploadRoot, dirName);
  if (!sourceDir) {
    res.status(400).json({ error: 'skill 名称非法' });
    return;
  }
  const skillPath = path.join(sourceDir, 'SKILL.md');
  try {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(skillPath, content, 'utf8');
  } catch (e) {
    const err = e as Error;
    res.status(500).json({ error: `写入 SKILL.md 失败: ${err.message}` });
    return;
  }

  const result = Skills.importLocal({
    userId: user.id,
    projectId,
    sourcePath: sourceDir,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error || '导入 skill 失败' });
    return;
  }
  res.json({
    ok: true,
    source_type: 'markdown',
    source_path: sourceDir,
    skills: (result.skills || []).map((sk: SkillRow) => shapeSkill(sk, user)),
    skipped: result.skipped || [],
  });
}

function importArchiveSkillFile({ req, res, file, projectId, project }: {
  req: express.Request;
  res: express.Response;
  file: { path: string; originalname: string };
  projectId?: string;
  project?: any;
}): void {
  const user = (req as any).user;
  const rootResult = skillUploadRoot({ userId: user.id, project });
  if (!rootResult.ok) {
    res.status(400).json({ error: rootResult.error });
    return;
  }
  const uploadRoot = rootResult.uploadRoot;
  const safeName = safeOriginalName(file.originalname, 'skill-archive');
  const stagingName = `_archive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const stagingDir = safeResolveUnder(uploadRoot, stagingName);
  if (!stagingDir) {
    res.status(400).json({ error: '上传文件名非法' });
    return;
  }

  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    extractArchiveFile(file.path, stagingDir, { kind: detectContextFileKind(file) });
    const selectedSource = preferredArchiveImportSource(stagingDir);
    const sourcePath = materializeRootSkillSource({
      sourceDir: selectedSource,
      uploadRoot,
      filename: file.originalname,
    });
    const result = Skills.importLocal({
      userId: user.id,
      projectId,
      sourcePath,
    });
    if (!result.ok) {
      res.status(400).json({ error: result.error || '导入 skill 压缩包失败' });
      return;
    }
    res.json({
      ok: true,
      source_type: 'archive',
      source_path: sourcePath,
      skills: (result.skills || []).map((sk: SkillRow) => shapeSkill(sk, user)),
      skipped: result.skipped || [],
    });
  } catch (e) {
    const err = e as Error;
    removeIfExists(stagingDir);
    res.status(400).json({ error: err.message || '导入 skill 压缩包失败' });
  }
}

function handleSkillFileImport(req: express.Request, res: express.Response, ctx: SkillFileImportCtx = {}): void {
  const { projectId, project } = ctx;
  skillUpload.single('file')(req, res, (uploadErr: any) => {
    if (uploadErr) {
      const message = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? `Skill 文件不能超过 ${formatBytes(MAX_SKILL_UPLOAD_BYTES)}`
        : uploadErr.message || '上传失败';
      res.status(uploadErr.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
      return;
    }

    try {
      const file = (req as any).file as { path: string; originalname: string } | undefined;
      if (file) {
        const kind = detectContextFileKind(file);
        if (kind === 'markdown') {
          const content = fs.readFileSync(file.path, 'utf8');
          importMarkdownSkillFile({ req, res, content, filename: file.originalname, projectId, project });
          return;
        }
        if (kind === 'zip' || kind === 'tar') {
          importArchiveSkillFile({ req, res, file, projectId, project });
          return;
        }
        res.status(400).json({ error: '只支持上传 .md、.zip、.tar、.tar.gz、.tgz 等 Skill 文件' });
        return;
      }

      // 兼容旧前端: JSON body 直接提交 { content, filename }。
      const body = (req.body || {}) as { content?: string; filename?: string };
      const content = typeof body.content === 'string' ? body.content : '';
      importMarkdownSkillFile({ req, res, content, filename: body.filename || 'SKILL.md', projectId, project });
    } finally {
      const file = (req as any).file as { path: string } | undefined;
      if (file) unlinkIfExists(file.path);
    }
  });
}

// 上传 SKILL.md 或 skill 压缩包, 导入为用户级 Skill。
router.post('/import-file', auth, (req: express.Request, res: express.Response) => {
  handleSkillFileImport(req, res);
});

router.delete('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'user' || !canManageContextItem(user, 'skill', sk)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  Skills.delete(sk.id);
  res.json({ ok: true });
});

// 用户级 skill → 项目级 (必须指定 project_id, 校验项目存在).
router.post('/:id/move', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as { id: string; role: string; [k: string]: any };
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'user' || !canManageContextItem(user, 'skill', sk)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  const body = (req.body || {}) as { project_id?: string };
  const projectId = (body.project_id || '').trim();
  if (!projectId) {
    res.status(400).json({ error: '请选择目标项目' });
    return;
  }
  const targetProject = Projects.findById(projectId);
  if (!targetProject || !canContributeProjectContext(user, targetProject)) {
    res.status(404).json({ error: '目标项目不存在或不可写' });
    return;
  }
  const result = Skills.move({
    id: sk.id, requesterUserId: user.id, isAdmin: user.role === 'admin',
    targetScope: 'project', targetProjectId: projectId,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(shapeSkill(result.skill, user));
});

// ---- 项目级路由 (挂在 /api/projects/:projectId/skills) --------------------
const projectScoped = express.Router({ mergeParams: true });

function ensureProjectAccess(req: express.Request, res: express.Response): { project: any } | null {
  const user = (req as any).user;
  const project = Projects.findById(String(req.params.projectId));
  if (!project) {
    res.status(404).json({ error: '项目未找到' });
    return null;
  }
  if (!canReadProject(user, project)) {
    res.status(404).json({ error: '项目未找到' });
    return null;
  }
  return { project };
}

projectScoped.get('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const acc = ensureProjectAccess(req, res);
  if (!acc) return;
  res.json(visibleSkillList(user, Skills.listForProject(req.params.projectId)).map((sk: SkillRow) => shapeSkill(sk, user, true)));
});

// 上传 SKILL.md 或 skill 压缩包, 写入项目目录后导入为项目级 Skill.
// Markdown 适合单文件 skill; 压缩包适合携带 scripts/assets/templates 等资源文件, 也支持批量导入多个 skill 子目录。
projectScoped.post('/import-file', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const acc = ensureProjectAccess(req, res);
  if (!acc) return;
  if (!canContributeProjectContext(user, acc.project)) {
    res.status(403).json({ error: '无权向此项目导入 Skill' });
    return;
  }
  handleSkillFileImport(req, res, { projectId: req.params.projectId, project: acc.project } as any);
});

projectScoped.get('/:id/access', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const acc = ensureProjectAccess(req, res);
  if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId || !canReadContextItem(user, 'skill', sk)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  res.json(contextAccessPayload('skill', sk));
});

projectScoped.patch('/:id/access', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const acc = ensureProjectAccess(req, res);
  if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId || !canManageContextItem(user, 'skill', sk)) {
    res.status(403).json({ error: '无权修改此 Skill 权限' });
    return;
  }
  res.json(setResourcePolicy('skill', sk.id, { ...accessBody(req.body), createdBy: sk.created_by }));
});

projectScoped.post('/:id/hide', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const acc = ensureProjectAccess(req, res);
  if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId || !canReadContextItem(user, 'skill', sk)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  setHidden(user.id, 'skill', sk.id, true);
  res.json({ ok: true });
});

projectScoped.post('/:id/unhide', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const acc = ensureProjectAccess(req, res);
  if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId || !canReadContextItem(user, 'skill', sk)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  setHidden(user.id, 'skill', sk.id, false);
  res.json({ ok: true });
});

projectScoped.get('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const acc = ensureProjectAccess(req, res);
  if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  if (!canReadContextItem(user, 'skill', sk) || isHidden(user.id, 'skill', sk.id)) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  res.json(shapeSkill(sk, user));
});

projectScoped.post('/', auth, async (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const acc = ensureProjectAccess(req, res);
  if (!acc) return;
  if (!canContributeProjectContext(user, acc.project)) {
    res.status(403).json({ error: '无权向此项目添加 Skill' });
    return;
  }
  const body = (req.body || {}) as { name?: string };
  const name = (body.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'skill 名称不能为空' });
    return;
  }
  const result = await Skills.install({
    userId: user.id, projectId: req.params.projectId, skillName: name,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error, stdout: result.stdout });
    return;
  }
  res.json(shapeSkill(result.skill, user));
});

// 从服务器本地绝对路径导入自制 skill 到本项目级 (跨用户合并展示).
projectScoped.post('/import-local', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const acc = ensureProjectAccess(req, res);
  if (!acc) return;
  if (!canContributeProjectContext(user, acc.project)) {
    res.status(403).json({ error: '无权向此项目导入 Skill' });
    return;
  }
  const body = (req.body || {}) as { path?: string };
  const sourcePath = (body.path || '').trim();
  if (!sourcePath) {
    res.status(400).json({ error: '请输入 skill 的服务器绝对路径' });
    return;
  }
  const result = Skills.importLocal({
    userId: user.id, projectId: req.params.projectId, sourcePath,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({
    skills: (result.skills || []).map((sk: SkillRow) => shapeSkill(sk, user)),
    skipped: result.skipped || [],
  });
});

// 复制目录中任意一条 skill 到本项目 (快照模式).
projectScoped.post('/copy', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const acc = ensureProjectAccess(req, res);
  if (!acc) return;
  if (!canContributeProjectContext(user, acc.project)) {
    res.status(403).json({ error: '无权向此项目复制 Skill' });
    return;
  }
  const body = (req.body || {}) as { source_id?: string };
  const sourceId = (body.source_id || '').trim();
  if (!sourceId) {
    res.status(400).json({ error: '缺少 source_id' });
    return;
  }
  const source = Skills.findById(sourceId);
  if (!source || !canReadContextItem(user, 'skill', source)) {
    res.status(404).json({ error: '源 Skill 不可见' });
    return;
  }
  const result = Skills.copyToScope({
    sourceId, targetUserId: user.id, targetProjectId: req.params.projectId,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(shapeSkill(result.skill, user));
});

projectScoped.delete('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const acc = ensureProjectAccess(req, res);
  if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  if (!canManageContextItem(user, 'skill', sk)) {
    res.status(403).json({ error: '无权删除此项目级 Skill' });
    return;
  }
  Skills.delete(sk.id);
  res.json({ ok: true });
});

// 项目级 skill → 用户级 (回到自己的 default_project); 也支持跨项目搬迁 (传 target_project_id).
// 默认搬到当前用户的用户级.
projectScoped.post('/:id/move', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as { id: string; role: string; [k: string]: any };
  const acc = ensureProjectAccess(req, res);
  if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId) {
    res.status(404).json({ error: '未找到' });
    return;
  }
  const isAdmin = user.role === 'admin';
  if (!canManageContextItem(user, 'skill', sk)) {
    res.status(403).json({ error: '无权移动此项目级 Skill' });
    return;
  }

  const body = (req.body || {}) as { scope?: string; project_id?: string };
  const targetScope = (body.scope || 'user').trim();
  let targetProjectId = (body.project_id || '').trim() || null;
  if (targetScope === 'project') {
    if (!targetProjectId) {
      res.status(400).json({ error: '请选择目标项目' });
      return;
    }
    const targetProject = Projects.findById(targetProjectId);
    if (!targetProject || !canContributeProjectContext(user, targetProject)) {
      res.status(404).json({ error: '目标项目不存在或不可写' });
      return;
    }
  } else {
    targetProjectId = null;
  }
  const result = Skills.move({
    id: sk.id, requesterUserId: user.id, isAdmin,
    targetScope, targetProjectId,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(shapeSkill(result.skill, user));
});

export { router, projectScoped };
