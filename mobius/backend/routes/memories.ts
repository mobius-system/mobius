/**
 * memories.ts — 用户级 / 项目级 Memory 管理 (文件系统驱动).
 *
 * 存储: CORE_DATA_PATH/memories/user=<userId>/{default_project|project=<projectId>}/<slug>.md
 * 内容: frontmatter (name/description) + body, 用户可任意编辑.
 *
 * 挂载位置:
 *   /api/memories                       用户级
 *   /api/projects/:projectId/memories   项目级 (跨用户合并展示, 但只能改自己创建的)
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
// @ts-ignore — multer 无 @types
import multer from 'multer';
import { auth } from '../middleware/auth';
import { Memories } from '../repositories/memories';
import { Projects } from '../repositories/projects';
// @ts-ignore — config 仍是 .js
import { UPLOAD_DIR, HIDDEN_FOLDER_NAME } from '../config';
// @ts-ignore — service 仍是 .js
import {
  PROJECT_KNOWLEDGE_SLUG,
  projectKnowledgePath,
  snapshotProjectKnowledge,
  listProjectKnowledgeHistory,
  readProjectKnowledgeHistoryFile,
} from '../services/project-knowledge';
// @ts-ignore — service 仍是 .js
import {
  MAX_MEMORY_MARKDOWN_BYTES,
  detectMarkdownFile,
  formatBytes,
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

type AccessUser = { id: string; role: string; [k: string]: any };

const memoryUpload = multer({
  dest: path.join(UPLOAD_DIR as string, 'memory-imports'),
  limits: { fileSize: MAX_MEMORY_MARKDOWN_BYTES as number },
});

// 项目知识 Memory 是 <bind_path>/.imac/project_knowledge.md 的自动同步投影
// (slug 固定为 PROJECT_KNOWLEDGE_SLUG, 由 listForProject 的同步逻辑重建).
// 对它直接 编辑/删除 会被下次列表同步覆盖/重建 → 表现为"编辑无效/删除无效".
// 前端据此把这类 Memory 标成受管理, 走专用的写入源文件/清源文件路径.
function isProjectKnowledgeMemory(row: any): boolean {
  if (!row || row.scope !== 'project') return false;
  const id = String(row.id || '');
  return id.endsWith(':' + PROJECT_KNOWLEDGE_SLUG);
}

function shape(row: any): any {
  if (!row) return row;
  const managedKind = isProjectKnowledgeMemory(row) ? 'project_knowledge' : null;
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
    managed: managedKind !== null,
    managed_kind: managedKind,
  };
}

function shapeLite(row: any): any {
  const s = shape(row);
  if (!s) return s;
  const { body, ...lite } = s;
  return { ...lite, body_length: (body || '').length };
}

function maybeList(body: any, snakeKey: string, camelKey: string): any {
  if (!body || (!Object.prototype.hasOwnProperty.call(body, snakeKey) && !Object.prototype.hasOwnProperty.call(body, camelKey))) {
    return undefined;
  }
  return uniqStringList(body[snakeKey] ?? body[camelKey]);
}

function accessBody(body: any = {}) {
  return {
    visibility: body.visibility,
    allowUserIds: maybeList(body, 'allow_user_ids', 'allowUserIds'),
    allowGroupIds: maybeList(body, 'allow_group_ids', 'allowGroupIds'),
  };
}

function shapeMemory(row: any, user: AccessUser, lite = false): any {
  const shaped = withContextAccess('memory', row, user as any);
  return lite ? shapeLite(shaped) : shape(shaped);
}

function visibleMemoryList(user: AccessUser, items: any[]): any[] {
  return filterReadableContextItems(user, 'memory', items)
    .filter((item) => !isHidden(user.id, 'memory', item.id));
}

function parseUploadedMemoryMarkdown(content: string, filename: string | undefined): any {
  if (!content.trim()) return { ok: false, error: 'Memory Markdown 文件内容不能为空' };
  if (Buffer.byteLength(content, 'utf8') > (MAX_MEMORY_MARKDOWN_BYTES as number)) {
    return { ok: false, status: 413, error: `Memory Markdown 文件不能超过 ${formatBytes(MAX_MEMORY_MARKDOWN_BYTES as number)}` };
  }
  // @ts-ignore — service 仍是 .js, 走运行时 require
  const parsed = require('../services/skill-loader').parseFrontmatter(content);
  const fallbackName = path.basename(String(filename || 'memory.md')).replace(/\.(md|markdown)$/i, '').trim();
  const name = String(parsed.meta?.name || fallbackName || 'Memory').trim();
  const description = String(parsed.meta?.description || '').trim();
  const body = parsed.body || '';
  if (!name) return { ok: false, error: '无法从文件中确定 Memory 标题' };
  return { ok: true, name, description, body };
}

function createMemoryFromMarkdownUpload({
  req,
  res,
  content,
  filename,
  projectId,
}: {
  req: express.Request;
  res: express.Response;
  content: string;
  filename: string | undefined;
  projectId?: string;
}): express.Response | void {
  const user = (req as any).user as AccessUser;
  const parsed = parseUploadedMemoryMarkdown(content, filename);
  if (!parsed.ok) return res.status(parsed.status || 400).json({ error: parsed.error });
  const result = Memories.create({
    userId: user.id,
    projectId,
    name: (req.body as any)?.name || parsed.name,
    description: (req.body as any)?.description || parsed.description,
    body: parsed.body,
  } as any);
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json({
    ok: true,
    source_type: 'markdown',
    memories: [shapeMemory(result.memory, user, true)],
    skipped: [],
  });
}

function handleMemoryFileImport(req: express.Request, res: express.Response, opts: { projectId?: string } = {}): void {
  memoryUpload.single('file')(req, res, (uploadErr: any) => {
    if (uploadErr) {
      const message = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? `Memory Markdown 文件不能超过 ${formatBytes(MAX_MEMORY_MARKDOWN_BYTES as number)}`
        : uploadErr.message || '上传失败';
      return res.status(uploadErr.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    }

    try {
      if ((req as any).file) {
        if (!detectMarkdownFile((req as any).file)) {
          return res.status(400).json({ error: 'Memory 只支持上传 .md Markdown 文件' });
        }
        const content = fs.readFileSync((req as any).file.path, 'utf8');
        return createMemoryFromMarkdownUpload({
          req,
          res,
          content,
          filename: (req as any).file.originalname,
          projectId: opts.projectId,
        });
      }

      // 兼容旧前端或脚本: JSON body 直接提交 { content, filename }。
      const content = typeof (req.body as any)?.content === 'string' ? (req.body as any).content : '';
      return createMemoryFromMarkdownUpload({
        req,
        res,
        content,
        filename: (req.body as any)?.filename || 'memory.md',
        projectId: opts.projectId,
      });
    } finally {
      if ((req as any).file) unlinkIfExists((req as any).file.path);
    }
  });
}

// ---- 用户级路由 -----------------------------------------------------------
const router = express.Router();

router.get('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  res.json(Memories.listForUser(user.id).map((m: any) => shapeMemory(m, user, true)));
});

// ---- 跨用户/项目复制目录 (全员可读) --------------------------------------
// 列出全平台所有用户级 / 项目级 memory, 供「新建时从其他用户/项目复制」浏览.
// 必须定义在 GET /:id 之前, 否则 'catalog' 会被当成 memory id.
router.get('/catalog', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  res.json(visibleMemoryList(user, Memories.listAll()).map((m: any) => shapeMemory(m, user, true)));
});

router.get('/catalog/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const m = Memories.findById(String(req.params.id));
  if (!m) return res.status(404).json({ error: '未找到' });
  if (!canReadContextItem(user, 'memory', m) || isHidden(user.id, 'memory', m.id)) {
    return res.status(404).json({ error: '未找到' });
  }
  res.json(shapeMemory(m, user));
});

// 复制目录中任意一条 memory 到我的用户级 (快照模式, 新 slug).
router.post('/copy', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const sourceId = ((req.body as any)?.source_id || '').trim();
  if (!sourceId) return res.status(400).json({ error: '缺少 source_id' });
  const source = Memories.findById(sourceId);
  if (!source || !canReadContextItem(user, 'memory', source)) return res.status(404).json({ error: '源 Memory 不可见' });
  const result = Memories.copyToScope({ sourceId, targetUserId: user.id } as any);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(shapeMemory(result.memory, user));
});

// 从服务器本地绝对路径导入自制 memory (开发者自己写的 .md, 不走复制目录).
// path 可为单个 .md 文件 或 含多个 .md 的目录 (递归批量). 必须在 GET /:id 之前.
router.post('/import-local', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const sourcePath = ((req.body as any)?.path || '').trim();
  if (!sourcePath) return res.status(400).json({ error: '请输入 memory 的服务器绝对路径' });
  const result = Memories.importLocal({ userId: user.id, sourcePath } as any);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ memories: (result.memories || []).map((m: any) => shapeMemory(m, user, true)), skipped: result.skipped || [] });
});

// 上传单个 .md 文件并创建用户级 Memory.
router.post('/import-file', auth, (req: express.Request, res: express.Response) => {
  handleMemoryFileImport(req, res);
});

router.get('/:id/access', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const m = Memories.findById(String(req.params.id));
  if (!m || !canReadContextItem(user, 'memory', m)) return res.status(404).json({ error: '未找到' });
  res.json(contextAccessPayload('memory', m));
});

router.patch('/:id/access', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const m = Memories.findById(String(req.params.id));
  if (!m || !canManageContextItem(user, 'memory', m)) return res.status(403).json({ error: '无权修改此 Memory 权限' });
  res.json(setResourcePolicy('memory', m.id, { ...accessBody(req.body), createdBy: m.created_by }));
});

router.post('/:id/hide', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const m = Memories.findById(String(req.params.id));
  if (!m || !canReadContextItem(user, 'memory', m)) return res.status(404).json({ error: '未找到' });
  setHidden(user.id, 'memory', m.id, true);
  res.json({ ok: true });
});

router.post('/:id/unhide', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const m = Memories.findById(String(req.params.id));
  if (!m || !canReadContextItem(user, 'memory', m)) return res.status(404).json({ error: '未找到' });
  setHidden(user.id, 'memory', m.id, false);
  res.json({ ok: true });
});

router.get('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const m = Memories.findById(String(req.params.id));
  if (!m || m.scope !== 'user' || !canReadContextItem(user, 'memory', m)) return res.status(404).json({ error: '未找到' });
  res.json(shapeMemory(m, user));
});

router.post('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const { name, description, body } = (req.body || {}) as { name?: string; description?: string; body?: string };
  const result = Memories.create({ userId: user.id, name, description, body } as any);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(shapeMemory(result.memory, user));
});

router.patch('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const m = Memories.findById(String(req.params.id));
  if (!m || m.scope !== 'user' || !canManageContextItem(user, 'memory', m)) return res.status(404).json({ error: '未找到' });
  const { name, description, body } = (req.body || {}) as { name?: string; description?: string; body?: string };
  const result = Memories.update({ id: m.id, name, description, body } as any);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(shapeMemory(result.memory, user));
});

router.delete('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const m = Memories.findById(String(req.params.id));
  if (!m || m.scope !== 'user' || !canManageContextItem(user, 'memory', m)) return res.status(404).json({ error: '未找到' });
  Memories.delete(m.id);
  res.json({ ok: true });
});

// 用户级 memory → 项目级 (必须指定 project_id, 校验项目存在).
router.post('/:id/move', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const m = Memories.findById(String(req.params.id));
  if (!m || m.scope !== 'user' || !canManageContextItem(user, 'memory', m)) return res.status(404).json({ error: '未找到' });
  const projectId = ((req.body as any)?.project_id || '').trim();
  if (!projectId) return res.status(400).json({ error: '请选择目标项目' });
  const targetProject = Projects.findById(projectId);
  if (!targetProject || !canContributeProjectContext(user, targetProject)) return res.status(404).json({ error: '目标项目不存在或不可写' });
  const result = Memories.move({
    id: m.id, requesterUserId: user.id, isAdmin: user.role === 'admin',
    targetScope: 'project', targetProjectId: projectId,
  } as any);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(shapeMemory(result.memory, user));
});

// ---- 项目级路由 (挂在 /api/projects/:projectId/memories) ------------------
const projectScoped = express.Router({ mergeParams: true });

function ensureProjectAccess(req: express.Request, res: express.Response): { project: any } | null {
  const user = (req as any).user as AccessUser;
  const project = Projects.findById(String(req.params.projectId));
  if (!project) { res.status(404).json({ error: '项目未找到' }); return null; }
  if (!canReadProject(user, project)) { res.status(404).json({ error: '项目未找到' }); return null; }
  return { project };
}

projectScoped.get('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  res.json(visibleMemoryList(user, Memories.listForProject(String(req.params.projectId))).map((m: any) => shapeMemory(m, user, true)));
});

// 手动刷新: 把 <project.bind_path>/.imac/project_knowledge.md 同步成
// 名为「<项目名>的项目知识」的项目级 Memory. GET 项目级 memory 时也会自动做同一同步.
projectScoped.post('/project-knowledge/refresh', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  if (!canContributeProjectContext(user, acc.project)) return res.status(403).json({ error: '无权刷新此项目的 Memory' });
  const result = Memories.syncProjectKnowledge(String(req.params.projectId), { fallbackUserId: user.id } as any);
  if (!result.ok) return res.status(400).json({ error: result.error || '刷新项目知识沉淀失败' });
  res.json({
    ok: true,
    synced: !!result.synced,
    changed: !!result.changed,
    reason: result.reason || '',
    path: result.path || '',
    memory_name: result.memory_name || '',
    body_length: result.body_length || 0,
    memory: result.memory ? shapeMemory(result.memory, user, true) : null,
  });
});

// 规划模式写入锁查询: Agent 写入 project_knowledge.md 前会创建 .planning_lock,
// 前端编辑器轮询该端点判断是否切换只读模式. 锁不存在 = 可编辑.
projectScoped.get('/project-knowledge/lock', auth, (req: express.Request, res: express.Response) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const bindPath = (acc.project.bind_path || '').trim();
  if (!bindPath) {
    return res.json({ locked: false, locked_at: null, reason: '项目未绑定路径' });
  }
  const lockPath = path.join(path.resolve(bindPath), HIDDEN_FOLDER_NAME, '.planning_lock');
  try {
    if (!fs.existsSync(lockPath)) return res.json({ locked: false, locked_at: null });
    const stat = fs.statSync(lockPath);
    let lockedAt: string | null = null;
    try { lockedAt = fs.readFileSync(lockPath, 'utf8').trim(); } catch {}
    return res.json({ locked: true, locked_at: lockedAt || stat.mtime.toISOString() });
  } catch (e) {
    return res.json({ locked: false, locked_at: null, error: (e as Error).message });
  }
});

// 规划模式读取当前 project_knowledge.md 内容 (规划编辑器初始化用).
projectScoped.get('/project-knowledge/content', auth, (req: express.Request, res: express.Response) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const filePath = projectKnowledgePath(acc.project);
  if (!filePath) return res.status(400).json({ error: '项目未绑定路径' });
  try {
    if (!fs.existsSync(filePath)) return res.json({ ok: true, content: '', exists: false });
    const content = fs.readFileSync(filePath, 'utf8');
    return res.json({ ok: true, content, exists: true });
  } catch (e) {
    return res.status(500).json({ error: `读取项目知识文件失败: ${(e as Error).message}` });
  }
});

// 上传一个 Markdown 文件到 <project.bind_path>/.imac/project_knowledge.md,
// 然后同步成项目级 Memory. 这是通用入口, Demo 只复用它。
projectScoped.post('/project-knowledge/upload', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  memoryUpload.single('file')(req, res, (uploadErr: any) => {
    if (uploadErr) {
      const message = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? `项目知识文件不能超过 ${formatBytes(MAX_MEMORY_MARKDOWN_BYTES as number)}`
        : uploadErr.message || '上传失败';
      return res.status(uploadErr.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    }

    const acc = ensureProjectAccess(req, res); if (!acc) {
      if ((req as any).file) unlinkIfExists((req as any).file.path);
      return;
    }
    if (!canContributeProjectContext(user, acc.project)) {
      if ((req as any).file) unlinkIfExists((req as any).file.path);
      return res.status(403).json({ error: '无权上传此项目的 Memory' });
    }

    try {
      if ((req as any).file && !detectMarkdownFile((req as any).file)) {
        return res.status(400).json({ error: '项目知识只支持上传 .md Markdown 文件' });
      }
      const content = (req as any).file
        ? fs.readFileSync((req as any).file.path, 'utf8')
        : (typeof (req.body as any)?.content === 'string' ? (req.body as any).content : '');
      if (!content.trim()) return res.status(400).json({ error: '项目知识文件内容不能为空' });
      if (Buffer.byteLength(content, 'utf8') > (MAX_MEMORY_MARKDOWN_BYTES as number)) {
        return res.status(413).json({ error: `项目知识文件不能超过 ${formatBytes(MAX_MEMORY_MARKDOWN_BYTES as number)}` });
      }

      const targetPath = projectKnowledgePath(acc.project);
      if (!targetPath) return res.status(400).json({ error: '项目未绑定路径' });

      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        // 覆盖前先备份当前内容 (若存在), 用户可从历史版本回滚.
        if (fs.existsSync(targetPath)) {
          try { snapshotProjectKnowledge(acc.project); } catch (e) {
            console.warn(`[memories] snapshot before upload failed: ${(e as Error).message}`);
          }
        }
        fs.writeFileSync(targetPath, content, 'utf8');
      } catch (e) {
        return res.status(500).json({ error: `写入项目知识文件失败: ${(e as Error).message}` });
      }

      const result = Memories.syncProjectKnowledge(String(req.params.projectId), { fallbackUserId: user.id } as any);
      if (!result.ok) return res.status(400).json({ error: result.error || '同步项目知识沉淀失败' });
      return res.json({
        ok: true,
        uploaded: true,
        path: targetPath,
        memory_name: result.memory_name || '',
        body_length: result.body_length || content.length,
        memory: result.memory ? shapeMemory(result.memory, user, true) : null,
      });
    } finally {
      if ((req as any).file) unlinkIfExists((req as any).file.path);
    }
  });
});

// 列出项目知识历史快照 (保留最近 30 份, 按时间倒序).
projectScoped.get('/project-knowledge/history', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  if (!canReadProject(user, acc.project)) return res.status(403).json({ error: '无权查看此项目历史' });
  const items = listProjectKnowledgeHistory(acc.project);
  res.json({ ok: true, items });
});

// 读取单个历史快照内容 (用于前端 diff/查看).
projectScoped.get('/project-knowledge/history/:filename', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  if (!canReadProject(user, acc.project)) return res.status(403).json({ error: '无权查看此项目历史' });
  const result = readProjectKnowledgeHistoryFile(acc.project, String(req.params.filename));
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, content: result.content, filename: String(req.params.filename) });
});

// 回滚到指定历史快照: 备份当前 → 用快照覆盖 → 同步 Memory.
projectScoped.post('/project-knowledge/restore', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  if (!canContributeProjectContext(user, acc.project)) return res.status(403).json({ error: '无权回滚此项目知识' });
  const { filename } = (req.body || {}) as { filename?: string };
  const read = readProjectKnowledgeHistoryFile(acc.project, filename);
  if (!read.ok) return res.status(400).json({ error: read.error });
  const targetPath = projectKnowledgePath(acc.project);
  if (!targetPath) return res.status(400).json({ error: '项目未绑定路径' });
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (fs.existsSync(targetPath)) {
      try { snapshotProjectKnowledge(acc.project); } catch (e) {
        console.warn(`[memories] snapshot before restore failed: ${(e as Error).message}`);
      }
    }
    fs.writeFileSync(targetPath, read.content as any, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: `回滚写入失败: ${(e as Error).message}` });
  }
  const sync = Memories.syncProjectKnowledge(String(req.params.projectId), { fallbackUserId: user.id } as any);
  if (!sync.ok) return res.status(400).json({ error: sync.error || '同步 Memory 失败' });
  res.json({ ok: true, restored: true, filename });
});

// 上传单个 .md 文件并创建项目级 Memory.
projectScoped.post('/import-file', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  if (!canContributeProjectContext(user, acc.project)) return res.status(403).json({ error: '无权向此项目导入 Memory' });
  handleMemoryFileImport(req, res, { projectId: String(req.params.projectId) });
});

projectScoped.get('/:id/access', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const m = Memories.findById(String(req.params.id));
  if (!m || m.scope !== 'project' || m.owner_id !== String(req.params.projectId) || !canReadContextItem(user, 'memory', m)) {
    return res.status(404).json({ error: '未找到' });
  }
  res.json(contextAccessPayload('memory', m));
});

projectScoped.patch('/:id/access', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const m = Memories.findById(String(req.params.id));
  if (!m || m.scope !== 'project' || m.owner_id !== String(req.params.projectId) || !canManageContextItem(user, 'memory', m)) {
    return res.status(403).json({ error: '无权修改此 Memory 权限' });
  }
  res.json(setResourcePolicy('memory', m.id, { ...accessBody(req.body), createdBy: m.created_by }));
});

projectScoped.post('/:id/hide', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const m = Memories.findById(String(req.params.id));
  if (!m || m.scope !== 'project' || m.owner_id !== String(req.params.projectId) || !canReadContextItem(user, 'memory', m)) {
    return res.status(404).json({ error: '未找到' });
  }
  setHidden(user.id, 'memory', m.id, true);
  res.json({ ok: true });
});

projectScoped.post('/:id/unhide', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const m = Memories.findById(String(req.params.id));
  if (!m || m.scope !== 'project' || m.owner_id !== String(req.params.projectId) || !canReadContextItem(user, 'memory', m)) {
    return res.status(404).json({ error: '未找到' });
  }
  setHidden(user.id, 'memory', m.id, false);
  res.json({ ok: true });
});

projectScoped.get('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  if (canContributeProjectContext(user, acc.project)) {
    const syncResult = Memories.syncProjectKnowledge(String(req.params.projectId), { fallbackUserId: user.id } as any);
    if (syncResult && !syncResult.ok) {
      console.warn(`[memories] project knowledge sync failed for ${String(req.params.projectId)}: ${syncResult.error}`);
    }
  }
  const m = Memories.findById(String(req.params.id));
  if (!m || m.scope !== 'project' || m.owner_id !== String(req.params.projectId)) return res.status(404).json({ error: '未找到' });
  if (!canReadContextItem(user, 'memory', m) || isHidden(user.id, 'memory', m.id)) return res.status(404).json({ error: '未找到' });
  res.json(shapeMemory(m, user));
});

projectScoped.post('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  if (!canContributeProjectContext(user, acc.project)) return res.status(403).json({ error: '无权向此项目添加 Memory' });
  const { name, description, body } = (req.body || {}) as { name?: string; description?: string; body?: string };
  const result = Memories.create({
    userId: user.id, projectId: String(req.params.projectId), name, description, body,
  } as any);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(shapeMemory(result.memory, user));
});

projectScoped.patch('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const m = Memories.findById(String(req.params.id));
  if (!m || m.scope !== 'project' || m.owner_id !== String(req.params.projectId)) return res.status(404).json({ error: '未找到' });
  if (!canManageContextItem(user, 'memory', m)) return res.status(403).json({ error: '无权修改此项目级 Memory' });
  const { name, description, body } = (req.body || {}) as { name?: string; description?: string; body?: string };
  const result = Memories.update({ id: m.id, name, description, body } as any);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(shapeMemory(result.memory, user));
});

// 复制目录中任意一条 memory 到本项目 (快照模式, 新 slug).
projectScoped.post('/copy', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  if (!canContributeProjectContext(user, acc.project)) return res.status(403).json({ error: '无权向此项目复制 Memory' });
  const sourceId = ((req.body as any)?.source_id || '').trim();
  if (!sourceId) return res.status(400).json({ error: '缺少 source_id' });
  const source = Memories.findById(sourceId);
  if (!source || !canReadContextItem(user, 'memory', source)) return res.status(404).json({ error: '源 Memory 不可见' });
  const result = Memories.copyToScope({
    sourceId, targetUserId: user.id, targetProjectId: String(req.params.projectId),
  } as any);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(shapeMemory(result.memory, user));
});

// 从服务器本地绝对路径导入自制 memory 到本项目级 (跨用户合并展示).
projectScoped.post('/import-local', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  if (!canContributeProjectContext(user, acc.project)) return res.status(403).json({ error: '无权向此项目导入 Memory' });
  const sourcePath = ((req.body as any)?.path || '').trim();
  if (!sourcePath) return res.status(400).json({ error: '请输入 memory 的服务器绝对路径' });
  const result = Memories.importLocal({
    userId: user.id, projectId: String(req.params.projectId), sourcePath,
  } as any);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ memories: (result.memories || []).map((m: any) => shapeMemory(m, user, true)), skipped: result.skipped || [] });
});

projectScoped.delete('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const m = Memories.findById(String(req.params.id));
  if (!m || m.scope !== 'project' || m.owner_id !== String(req.params.projectId)) return res.status(404).json({ error: '未找到' });
  if (!canManageContextItem(user, 'memory', m)) return res.status(403).json({ error: '无权删除此项目级 Memory' });
  // 项目知识 Memory 是 project_knowledge.md 的自动同步投影: 只删 memory .md 会被
  // 下次列表同步重建 (listForProjectWithKnowledgeSync). 删除时一并清掉源文件
  // (先快照到 history 目录, 可经 project-knowledge/restore 回滚), 让同步不再重建.
  let clearedSource = false;
  if (isProjectKnowledgeMemory(m)) {
    const sourcePath = projectKnowledgePath(acc.project);
    if (sourcePath && fs.existsSync(sourcePath)) {
      try { snapshotProjectKnowledge(acc.project); } catch (e) {
        console.warn(`[memories] snapshot before project-knowledge delete failed: ${(e as Error).message}`);
      }
      try { fs.unlinkSync(sourcePath); clearedSource = true; } catch (e) {
        console.warn(`[memories] unlink project-knowledge source failed: ${(e as Error).message}`);
      }
    }
  }
  Memories.delete(m.id);
  res.json({ ok: true, cleared_source: clearedSource });
});

// 项目级 memory → 用户级 / 另一个项目.
// body: { scope: 'user' | 'project', project_id?: string }; scope 缺省为 user.
projectScoped.post('/:id/move', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user as AccessUser;
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const m = Memories.findById(String(req.params.id));
  if (!m || m.scope !== 'project' || m.owner_id !== String(req.params.projectId)) return res.status(404).json({ error: '未找到' });
  const isAdmin = user.role === 'admin';
  if (!canManageContextItem(user, 'memory', m)) return res.status(403).json({ error: '无权移动此项目级 Memory' });

  const targetScope = ((req.body as any)?.scope || 'user').trim();
  let targetProjectId: string | null = ((req.body as any)?.project_id || '').trim() || null;
  if (targetScope === 'project') {
    if (!targetProjectId) return res.status(400).json({ error: '请选择目标项目' });
    const targetProject = Projects.findById(targetProjectId);
    if (!targetProject || !canContributeProjectContext(user, targetProject)) return res.status(404).json({ error: '目标项目不存在或不可写' });
  } else {
    targetProjectId = null;
  }
  const result = Memories.move({
    id: m.id, requesterUserId: user.id, isAdmin,
    targetScope, targetProjectId,
  } as any);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(shapeMemory(result.memory, user));
});

export { router, projectScoped };
