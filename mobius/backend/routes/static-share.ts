/*
 * static-share.ts — upload + serve endpoints for static pages and files.
 *
 * Routes (mounted at /static_share, outside /api on purpose):
 *   POST   /static_share/upload                     multipart upload
 *   GET    /static_share/open_access/<path>/<name>  anyone with the link
 *   GET    /static_share/private_access/<path>/<name> owner only (Bearer or ?token=)
 *   GET    /static_share/api/files                  caller's own uploads
 *   DELETE /static_share/api/files/:id              caller's own upload
 *
 * Security model:
 *   - files are resolved through the static_share_files row, never by joining the URL to disk;
 *   - every path/name segment is whitelisted (CJK / ASCII letters / digits / underscore / dot);
 *   - HTML/SVG/XML are served with `Content-Security-Policy: sandbox` (no allow-same-origin)
 *     so uploaded markup can never read the SPA's localStorage JWT;
 *   - unique indexes enforce duplicate detection atomically.
 */
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
// @ts-ignore — multer ships no type declarations
import multer from 'multer';
import { auth, downloadAuth } from '../middleware/auth';
import { MOBIUS_DATA_PATH, UPLOAD_DIR } from '../config';
import { StaticShareFiles } from '../repositories/static-share-files';
import type { StaticShareFileRow, StaticShareScope } from '../repositories/static-share-files';
import { contentTypeFor } from '../services/project-file-ops';
import { joinWithin } from '../services/file-access';

const router = express.Router();

// ===== limits =====
const SHARE_ROOT = path.join(MOBIUS_DATA_PATH, 'static_share');
const MAX_NAME_CHARS = 50;
const MAX_PATH_CHARS = 50;
const MAX_PATH_DEPTH = 6;
const MAX_PUBLIC_BYTES = 10 * 1024 * 1024;
const MAX_PRIVATE_BYTES = 500 * 1024 * 1024;
const MAX_EXPIRE_DAYS = 3650;
const USER_QUOTA_BYTES = Number(process.env.STATIC_SHARE_USER_QUOTA_BYTES || 2 * 1024 * 1024 * 1024);
const USER_QUOTA_FILES = Number(process.env.STATIC_SHARE_USER_QUOTA_FILES || 500);
const MIN_FREE_BYTES = 1024 * 1024 * 1024;
const UPLOAD_WINDOW_MS = 10 * 60 * 1000;
const UPLOAD_WINDOW_MAX = 60;

// 中文英文数字下划线 + 单点; 每段点之间必须非空, 因此 ".."/"..." / 首尾点 天然被拒
// CJK / latin letters / digits / underscore + single dots; empty dot segments are rejected
const SEGMENT_RE = /^[\p{Script=Han}A-Za-z0-9_]+(?:\.[\p{Script=Han}A-Za-z0-9_]+)*$/u;

const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
]);

const INLINE_CONTENT_TYPES = new Set([
  'application/pdf',
  'application/json',
  'application/javascript',
  'text/javascript',
]);

const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';

interface ScopedUser {
  id: string;
  display_name: string;
  role: string;
  [k: string]: unknown;
}

interface ShareError extends Error {
  status: number;
}

function shareError(message: string, status = 400): ShareError {
  const err = new Error(message) as ShareError;
  err.status = status;
  return err;
}

/* Count Unicode code points so a 50-char rule means 50 visible characters, not 50 bytes. */
function charLength(value: string): number {
  return Array.from(value).length;
}

/* Map a login id onto a filesystem-safe directory name, most ids pass through unchanged. */
function ownerDirFor(userId: string): string {
  const safe = String(userId || '').replace(/[^A-Za-z0-9_.@-]/g, '_').replace(/^\.+$/, '_');
  if (safe === userId && safe !== '' && safe !== '.' && safe !== '..') return safe;
  const digest = crypto.createHash('sha1').update(String(userId)).digest('hex').slice(0, 8);
  return `${safe || 'user'}-${digest}`;
}

/*
 * Validate one user-supplied path/name segment. Returns the NFC form or throws a
 * 400 with a human-readable reason.
 */
function validateSegment(raw: unknown, label: string, maxChars: number): string {
  const value = String(raw ?? '').normalize('NFC');
  if (!value) throw shareError(`${label}不能为空`);
  if (charLength(value) > maxChars) throw shareError(`${label}长度不得超过 ${maxChars} 个字符`);
  if (value === '.' || value === '..' || value.includes('..')) throw shareError(`${label}不允许包含连续的点`);
  if (!SEGMENT_RE.test(value)) throw shareError(`${label}只允许中文、英文、数字、下划线和单点(.)`);
  return value;
}

/*
 * Validate the whole logical directory path ("a/b/c"). Empty means files live at
 * the owner root. Each segment obeys the same character/length rules.
 */
function validateFilePath(raw: unknown): string {
  const value = String(raw ?? '').trim().normalize('NFC').replace(/^\/+|\/+$/g, '');
  if (!value) return '';
  if (charLength(value) > MAX_PATH_CHARS) throw shareError(`文件路径长度不得超过 ${MAX_PATH_CHARS} 个字符`);
  const segments = value.split('/');
  if (segments.length > MAX_PATH_DEPTH) throw shareError(`文件路径层级不得超过 ${MAX_PATH_DEPTH} 层`);
  return segments.map((seg) => validateSegment(seg, '文件路径', MAX_PATH_CHARS)).join('/');
}

function normalizeScope(raw: unknown): StaticShareScope {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'public' || value === 'anyone' || value === '任何人' || value === '公开') return 'public';
  if (value === 'private' || value === 'self' || value === '仅自己' || value === '私有') return 'private';
  throw shareError('访问范围只能是 private(仅自己) 或 public(任何人)');
}

function parseExpireDays(raw: unknown): number {
  const text = String(raw ?? '').trim();
  if (!text) throw shareError('文件有效期(天数)不能为空');
  const days = Number(text);
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRE_DAYS) {
    throw shareError(`文件有效期必须是 1-${MAX_EXPIRE_DAYS} 之间的整数天数`);
  }
  return days;
}

/* Percent-encode bytes the GBK/Windows browsers cannot send in a header, keep a safe fallback name. */
function contentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 80) || 'download';
  const encoded = encodeURIComponent(fileName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function shouldInline(mime: string): boolean {
  return mime.startsWith('text/')
    || mime.startsWith('image/')
    || mime.startsWith('video/')
    || mime.startsWith('audio/')
    || INLINE_CONTENT_TYPES.has(mime);
}

/* Remove the on-disk file plus its row; used by expiry, delete and error rollback. */
function purgeRow(row: StaticShareFileRow): void {
  const abs = joinWithin(SHARE_ROOT, row.storage_rel);
  if (abs) {
    try { fs.unlinkSync(abs); } catch { /* missing file is fine */ }
    // 自下而上清掉变空的目录, 停在分享根之前
    // Walk upward removing empty directories, stopping before the share root
    let dir = path.dirname(abs);
    while (dir !== SHARE_ROOT && dir.startsWith(SHARE_ROOT + path.sep)) {
      try { fs.rmdirSync(dir); } catch { break; }
      dir = path.dirname(dir);
    }
  }
  StaticShareFiles.deleteById(row.id);
}

function freeDiskBytes(): number {
  try {
    const stat = fs.statfsSync(SHARE_ROOT);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// 单用户上传限流: 10 分钟内最多 60 次, 防止配额内快速刷盘
// Per-user upload rate limit, in memory only (single-process worker is enough here)
const uploadHits = new Map<string, number[]>();

function assertUploadRate(userId: string): void {
  const now = Date.now();
  const recent = (uploadHits.get(userId) || []).filter((ts) => now - ts < UPLOAD_WINDOW_MS);
  if (recent.length >= UPLOAD_WINDOW_MAX) {
    throw shareError('上传过于频繁, 请稍后再试', 429);
  }
  recent.push(now);
  uploadHits.set(userId, recent);
}

// ===== upload =====
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_PRIVATE_BYTES, files: 1, fields: 16, fieldSize: 4096 },
});

function uploadSingle(req: express.Request, res: express.Response, next: express.NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) { next(); return; }
    const code = String((err as { code?: string } | null)?.code || '');
    if (code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: '文件过大: 仅自己最多 500MB, 任何人最多 10MB' });
      return;
    }
    res.status(400).json({ error: '上传解析失败: ' + ((err as Error)?.message || 'bad multipart body') });
  });
}

router.post('/upload', auth, (req, res, next) => {
  // 早于 multer 的硬上限检查, 直接拒绝明显的超大请求
  // Reject obvious oversize bodies before multer streams them to disk
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_PRIVATE_BYTES + 1024 * 1024) {
    res.status(413).json({ error: '文件过大: 仅自己最多 500MB, 任何人最多 10MB' });
    return;
  }
  uploadSingle(req, res, next);
}, (req, res) => {
  const user = (req as any).user as ScopedUser;
  const file = (req as any).file as { path: string; originalname: string; size: number } | undefined;
  if (!file) {
    res.status(400).json({ error: '缺少文件 (multipart 字段名应为 file)' });
    return;
  }

  let tempPath: string | null = file.path;
  const cleanupTemp = (): void => {
    if (!tempPath) return;
    try { fs.unlinkSync(tempPath); } catch { /* already gone */ }
    tempPath = null;
  };

  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const scope = normalizeScope(body.scope);
    const days = parseExpireDays(body.expires_in_days ?? body.days ?? body.expire_days);
    const filePath = validateFilePath(body.file_path ?? body.path ?? '');

    // 优先用表单里的 filename (multipart 的 originalname 在部分客户端会被按 latin1 解码)
    // Prefer the explicit filename field; originalname is latin1-decoded by some clients
    const rawName = body.filename ?? body.file_name ?? file.originalname;
    const fileName = validateSegment(rawName, '文件名', MAX_NAME_CHARS);

    if (scope === 'public' && file.size > MAX_PUBLIC_BYTES) {
      throw shareError('访问范围为"任何人"时文件不得超过 10MB', 413);
    }
    if (scope === 'private' && file.size > MAX_PRIVATE_BYTES) {
      throw shareError('访问范围为"仅自己"时文件不得超过 500MB', 413);
    }
    if (file.size <= 0) throw shareError('文件为空');

    assertUploadRate(user.id);
    const usage = StaticShareFiles.usage(user.id);
    if (usage.files + 1 > USER_QUOTA_FILES) throw shareError(`最多保存 ${USER_QUOTA_FILES} 个分享文件`, 429);
    if (usage.bytes + file.size > USER_QUOTA_BYTES) throw shareError('分享文件总容量已超限', 429);
    if (freeDiskBytes() < MIN_FREE_BYTES + file.size) throw shareError('服务器磁盘空间不足', 507);

    const relPath = filePath ? `${filePath}/${fileName}` : fileName;
    const ownerDir = ownerDirFor(user.id);
    const storageRel = filePath
      ? `${ownerDir}/${filePath.split('/').join('/')}/${fileName}`
      : `${ownerDir}/${fileName}`;
    const absPath = joinWithin(SHARE_ROOT, storageRel);
    if (!absPath) throw shareError('非法的文件路径', 400);

    // 重复: DB 已有同 owner 同路径记录, 或磁盘上已有同名文件
    // Duplicate: same owner+path in DB, or a leftover file already sits at the target
    if (StaticShareFiles.findOwned(user.id, filePath, fileName)) {
      throw shareError('同名文件已存在, 请更换文件名或路径', 409);
    }
    if (fs.existsSync(absPath)) throw shareError('同名文件已存在, 请更换文件名或路径', 409);

    const mimeType = contentTypeFor(fileName);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    fs.mkdirSync(path.dirname(absPath), { recursive: true, mode: 0o750 });

    // 先占 DB 唯一键, 再落盘: 并发同名只会有一条记录活下来
    // Claim the unique row first, then move bytes; concurrent duplicates lose at the index
    const row = StaticShareFiles.create({
      id: crypto.randomUUID(),
      ownerId: user.id,
      ownerName: user.display_name || user.id,
      filePath,
      fileName,
      relPath,
      storageRel,
      sizeBytes: file.size,
      mimeType,
      scope,
      expiresAt,
    });

    try {
      try {
        // 同分区直接 rename, 跨分区(容器数据卷)回落为复制
        // rename on one filesystem, fall back to copy+unlink across volumes
        fs.renameSync(tempPath, absPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        fs.copyFileSync(tempPath, absPath);
        fs.unlinkSync(tempPath);
      }
      tempPath = null;
    } catch (err) {
      StaticShareFiles.deleteById(row.id);
      throw err;
    }

    const accessPath = scope === 'public'
      ? `/static_share/open_access/${relPath}`
      : `/static_share/private_access/${relPath}`;
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();

    res.status(201).json({
      ok: true,
      id: row.id,
      file_path: filePath,
      file_name: fileName,
      scope,
      size: file.size,
      mime_type: mimeType,
      expires_at: expiresAt,
      access_url: accessPath,
      absolute_url: host ? `${proto}://${host}${accessPath}` : accessPath,
      // 私有文件需要身份: 浏览器直接打开时把登录 token 拼在 query 上
      // Private links need identity: append ?token=<jwt> when opening in a browser
      token_required: scope === 'private',
      warning: scope === 'private' ? null : '公开文件任何人凭链接可访问, 请勿上传含敏感信息的文件',
    });
  } catch (err) {
    cleanupTemp();
    const status = (err as ShareError)?.status || 500;
    res.status(status).json({ error: (err as Error)?.message || '上传失败' });
  }
});

// ===== list / delete (own files only) =====
router.get('/api/files', auth, (req, res) => {
  const user = (req as any).user as ScopedUser;
  const usage = StaticShareFiles.usage(user.id);
  const files = StaticShareFiles.listByOwner(user.id).map((row) => ({
    id: row.id,
    file_path: row.file_path,
    file_name: row.file_name,
    scope: row.scope,
    size: row.size_bytes,
    mime_type: row.mime_type,
    expires_at: row.expires_at,
    expired: Date.parse(row.expires_at) <= Date.now(),
    access_url: row.scope === 'public'
      ? `/static_share/open_access/${row.rel_path}`
      : `/static_share/private_access/${row.rel_path}`,
    created_at: row.created_at,
  }));
  res.json({
    files,
    usage: { files: usage.files, bytes: usage.bytes, quota_bytes: USER_QUOTA_BYTES, quota_files: USER_QUOTA_FILES },
    limits: { public_bytes: MAX_PUBLIC_BYTES, private_bytes: MAX_PRIVATE_BYTES, max_days: MAX_EXPIRE_DAYS },
  });
});

router.delete('/api/files/:id', auth, (req, res) => {
  const user = (req as any).user as ScopedUser;
  const row = StaticShareFiles.deleteOwned(String(req.params.id), user.id);
  if (!row) {
    res.status(404).json({ error: '文件不存在或无权删除' });
    return;
  }
  purgeRow(row);
  res.json({ ok: true });
});

// ===== serving =====
/* Read the `*` wildcard tail as one string (express may type it as string[]). */
function wildcardTail(req: express.Request): string {
  const raw = (req.params as unknown as Record<string, string | string[]>)[0];
  return Array.isArray(raw) ? raw.join('/') : String(raw || '');
}

/*
 * Turn the URL tail into (dir path, file name). Express already percent-decoded
 * the wildcard once; our whitelist forbids '%' so no second decode is needed.
 */
function splitAccessPath(rawTail: string): { filePath: string; fileName: string } {
  const tail = String(rawTail || '').replace(/^\/+|\/+$/g, '');
  if (!tail) throw shareError('文件不存在', 404);
  const idx = tail.lastIndexOf('/');
  const dirRaw = idx >= 0 ? tail.slice(0, idx) : '';
  const nameRaw = idx >= 0 ? tail.slice(idx + 1) : tail;
  const fileName = validateSegment(nameRaw, '文件名', MAX_NAME_CHARS);
  const filePath = dirRaw ? dirRaw.split('/').map((seg) => validateSegment(seg, '文件路径', MAX_PATH_CHARS)).join('/') : '';
  return { filePath, fileName };
}

/* Serve a row after the caller has proven access. Expired files are purged and reported as gone. */
function sendShareFile(res: express.Response, row: StaticShareFileRow): void {
  if (Date.parse(row.expires_at) <= Date.now()) {
    purgeRow(row);
    res.status(410).json({ error: '文件已过期' });
    return;
  }

  const absPath = joinWithin(SHARE_ROOT, row.storage_rel);
  if (!absPath) {
    res.status(404).json({ error: '文件不存在' });
    return;
  }
  let stat: fs.Stats;
  try {
    // 拒绝符号链接, 只认普通文件 (目录也一律拒绝)
    // Reject symlinks and directories, only regular files are served
    stat = fs.lstatSync(absPath);
  } catch {
    StaticShareFiles.deleteById(row.id);
    res.status(404).json({ error: '文件不存在' });
    return;
  }
  if (!stat.isFile()) {
    res.status(404).json({ error: '文件不存在' });
    return;
  }

  const mime = row.mime_type || contentTypeFor(row.file_name);
  // 文本类补 charset, 否则中文 HTML/CSS 会被浏览器按 windows-1252 解成乱码
  // Text types need an explicit charset or CJK markup renders as mojibake
  const isTextual = mime.startsWith('text/') || mime === 'application/json'
    || mime === 'application/javascript' || mime.endsWith('+xml');
  const headers: Record<string, string> = {
    'Content-Type': isTextual ? `${mime}; charset=utf-8` : mime,
    'Content-Disposition': contentDisposition(row.file_name, shouldInline(mime)),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-cache',
  };
  // 上传的 HTML/SVG/XML 必须跑在无源沙箱里, 否则同源脚本能读走 SPA 的 localStorage JWT
  // Uploaded markup runs in an opaque-origin sandbox so it cannot read the SPA's JWT
  if (ACTIVE_CONTENT_TYPES.has(mime)) {
    headers['Content-Security-Policy'] = SANDBOX_CSP;
    headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
  }

  res.sendFile(absPath, {
    headers,
    etag: true,
    lastModified: true,
    cacheControl: false,
    // 存储根可能含点目录 (如 .deploy_data), 目标文件本身已校验, 这里放行点段
    // The storage root may contain dot dirs (e.g. .deploy_data); the target is already validated
    dotfiles: 'allow',
  }, (err) => {
    if (!err) return;
    console.error('[static-share] sendFile failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: '读取文件失败' });
  });
}

router.get('/open_access/*', (req, res) => {
  try {
    const { filePath, fileName } = splitAccessPath(wildcardTail(req));
    const row = StaticShareFiles.findPublic(filePath, fileName);
    if (!row || row.scope !== 'public') {
      res.status(404).json({ error: '文件不存在' });
      return;
    }
    sendShareFile(res, row);
  } catch (err) {
    res.status((err as ShareError)?.status || 404).json({ error: (err as Error)?.message || '文件不存在' });
  }
});

router.get('/private_access/*', downloadAuth, (req, res) => {
  try {
    const user = (req as any).user as ScopedUser;
    const { filePath, fileName } = splitAccessPath(wildcardTail(req));
    const row = StaticShareFiles.findOwned(user.id, filePath, fileName);
    if (!row) {
      // 不区分 "不存在" 和 "不是你的", 避免枚举他人文件
      // Do not distinguish missing from not-yours, prevents enumeration
      res.status(404).json({ error: '文件不存在或无权访问' });
      return;
    }
    sendShareFile(res, row);
  } catch (err) {
    res.status((err as ShareError)?.status || 404).json({ error: (err as Error)?.message || '文件不存在' });
  }
});

// ===== upload page =====
const PAGE_FILE = path.join(__dirname, '..', 'static', 'static-share.html');

router.get(['/', '/index.html'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.sendFile(PAGE_FILE, (err) => {
    if (err && !res.headersSent) res.status(500).send('static share page missing');
  });
});

// ===== expiry sweeper =====
/* Delete expired rows and their bytes so disk usage tracks the visible file list. */
function sweepExpired(): void {
  try {
    const now = new Date().toISOString();
    for (const row of StaticShareFiles.listExpired(now)) purgeRow(row);
  } catch (err) {
    console.error('[static-share] sweep failed:', (err as Error)?.message);
  }
}

try {
  fs.mkdirSync(SHARE_ROOT, { recursive: true, mode: 0o750 });
} catch (err) {
  console.error('[static-share] cannot create share root:', (err as Error)?.message);
}
sweepExpired();
const sweeper = setInterval(sweepExpired, 30 * 60 * 1000);
if (typeof sweeper.unref === 'function') sweeper.unref();

export = router;
