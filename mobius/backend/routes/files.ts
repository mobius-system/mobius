import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
// @ts-ignore — multer 没有 TS 类型声明
import multer from 'multer';
import { auth, downloadAuth } from '../middleware/auth';
import { Projects } from '../repositories/projects';
// @ts-ignore — service 仍是 .js
import { canReadProject } from '../services/access-control';
import {
  APP_DIR,
  UPLOAD_DIR,
  EXTENSION_DATA_ROOT,
} from '../config';

const router = express.Router();
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

interface ScopedUser {
  id: string;
  work_dir: string;
  role: string;
  [k: string]: any;
}

type ResolveResult =
  | { error: string }
  | { root: string; relPath: string; absPath: string };

// 解析 path query 到绝对路径并做 root 越界检查 (限制在用户 work_dir 内)
function resolveScopedPath(req: express.Request, rawPath: string = '/'): ResolveResult {
  const user = (req as any).user as ScopedUser;
  const root = path.resolve(user.work_dir);
  const relPath = String(rawPath || '/').replace(/\.\./g, '');
  const absPath = path.resolve(root, relPath.replace(/^\//, ''));
  if (absPath !== root && !absPath.startsWith(root + path.sep)) {
    return { error: 'Access denied' };
  }
  return { root, relPath, absPath };
}

function isExtensionUserDataPath(absPath: string, userId: string | number): boolean {
  const resolved = path.resolve(absPath);
  const root = path.resolve(EXTENSION_DATA_ROOT);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  return parts.length >= 4 && parts[1] === 'users' && parts[2] === String(userId);
}

function isMobiusUploadPath(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  const root = path.resolve(APP_DIR, '.imac', 'upload');
  return resolved === root || resolved.startsWith(root + path.sep);
}

function isSystemTempPath(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  const tmpRoot = path.resolve(os.tmpdir());
  return resolved === tmpRoot || resolved.startsWith(tmpRoot + path.sep);
}

function canDownloadPath(req: express.Request, absPath: string): boolean {
  const user = (req as any).user as ScopedUser;
  const userRoot = path.resolve(user.work_dir);
  return absPath === userRoot
    || absPath.startsWith(userRoot + path.sep)
    || isExtensionUserDataPath(absPath, user.id)
    || isMobiusUploadPath(absPath)
    || isSystemTempPath(absPath);
}

router.post('/upload', auth, upload.single('file'), (req: express.Request, res: express.Response) => {
  const user = (req as any).user as ScopedUser;
  const file = (req as any).file as { path: string; originalname: string; size: number } | undefined;
  if (!file) {
    res.status(400).json({ error: 'No file' });
    return;
  }
  const tempPath = file.path;
  const cleanupTemp = (): void => { try { fs.unlinkSync(tempPath); } catch { /* ignore */ } };

  const projectId = String((req.query.project_id as string | undefined) || (req.body as any)?.project_id || '').trim();
  let uploadDir: string;
  if (projectId) {
    const project = Projects.findById(projectId);
    if (!project) { cleanupTemp(); res.status(404).json({ error: '项目未找到' }); return; }
    if (!canReadProject(user, project)) { cleanupTemp(); res.status(403).json({ error: '无权访问此项目' }); return; }
    const bindPath = (project.bind_path || '').trim();
    if (!bindPath) { cleanupTemp(); res.status(400).json({ error: '项目未配置 bind_path' }); return; }
    uploadDir = path.join(bindPath, '.imac', 'upload');
  } else {
    uploadDir = path.join(user.work_dir, 'uploads');
  }
  fs.mkdirSync(uploadDir, { recursive: true });

  // 文件名 = 毫秒时间戳 + 原扩展名. 同毫秒并发再追加 _<n> 避免覆盖.
  const ext = path.extname(file.originalname) || '';
  const baseTs = Date.now();
  let dest = path.join(uploadDir, `${baseTs}${ext}`);
  let suffix = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(uploadDir, `${baseTs}_${suffix}${ext}`);
    suffix += 1;
  }

  fs.copyFileSync(tempPath, dest);
  cleanupTemp();
  res.json({ path: dest, name: file.originalname, size: file.size });
});

router.get('/download', downloadAuth, (req: express.Request, res: express.Response) => {
  const filePath = req.query.path as string | undefined;
  if (!filePath) {
    res.status(400).json({ error: 'Path required' });
    return;
  }
  const absPath = path.resolve(filePath);
  if (!canDownloadPath(req, absPath)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  if (!fs.existsSync(absPath)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.download(absPath);
});

router.get('/files/download', downloadAuth, (req: express.Request, res: express.Response) => {
  const filePath = req.query.path as string | undefined;
  if (!filePath) {
    res.status(400).json({ error: 'Path required' });
    return;
  }
  const absPath = path.resolve(filePath);
  if (!canDownloadPath(req, absPath)) {
    res.status(403).json({ error: 'Access denied' });
    return;
  }
  if (!fs.existsSync(absPath)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.download(absPath);
});

router.get('/files', auth, (req: express.Request, res: express.Response) => {
  const resolved = resolveScopedPath(req, (req.query.path as string | undefined) || '/');
  if ('error' in resolved) {
    res.status(403).json({ error: resolved.error });
    return;
  }
  const { relPath, absPath } = resolved;
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  try {
    const entries = fs.readdirSync(absPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => {
        const stat = fs.statSync(path.join(absPath, e.name));
        return {
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size: e.isFile() ? stat.size : null,
          modified: stat.mtime,
        };
      })
      .sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
    res.json({ path: relPath, entries });
  } catch {
    res.status(500).json({ error: 'Read failed' });
  }
});

// POST /api/files/mkdir  body: { path: "/sub/dir" }
// 在用户 work_dir 下创建目录(递归)。已存在则视为成功。
router.post('/files/mkdir', auth, (req: express.Request, res: express.Response) => {
  const { path: rawPath } = (req.body || {}) as { path?: string };
  if (!rawPath || typeof rawPath !== 'string') {
    res.status(400).json({ error: 'Path required' });
    return;
  }
  if (rawPath === '/' || rawPath === '') {
    res.status(400).json({ error: '请输入目录名' });
    return;
  }
  const resolved = resolveScopedPath(req, rawPath);
  if ('error' in resolved) {
    res.status(403).json({ error: resolved.error });
    return;
  }
  const { absPath, relPath } = resolved;
  try {
    if (fs.existsSync(absPath)) {
      if (!fs.statSync(absPath).isDirectory()) {
        res.status(400).json({ error: '同名文件已存在' });
        return;
      }
    } else {
      fs.mkdirSync(absPath, { recursive: true });
    }
    res.json({ ok: true, path: relPath });
  } catch {
    res.status(500).json({ error: '创建失败' });
  }
});

router.get('/files/read', auth, (req: express.Request, res: express.Response) => {
  const resolved = resolveScopedPath(req, (req.query.path as string | undefined) || '');
  if ('error' in resolved) {
    res.status(403).json({ error: resolved.error });
    return;
  }
  const { absPath } = resolved;
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const stat = fs.statSync(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'];
  if (imageExts.includes(ext)) {
    res.json({ type: 'image', url: `/api/download?path=${encodeURIComponent(absPath)}`, size: stat.size, ext });
    return;
  }
  if (stat.size > 1024 * 1024) {
    res.status(413).json({ error: 'File too large (>1MB)' });
    return;
  }
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    res.json({ type: 'text', content, size: stat.size, ext });
  } catch {
    res.status(500).json({ error: 'Read failed' });
  }
});

export = router;
