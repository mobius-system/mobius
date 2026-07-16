// 原生文件编辑器右键菜单后端共享逻辑: 路径/名称校验、符号链接边界、目录递归复制。
// 纯 Node fs/path, 不依赖 Express, 供 routes/projects.ts 与测试直接复用。
//
// 安全模型 (与设计文档 §14 对齐):
//   - 写/下载接口只接收项目相对路径, 由 routes 层 resolveProjectPath 约束在 bind_path 子树。
//   - 本模块在已 resolve 的绝对路径上再做 lstat 级校验, 拒绝符号链接 (含中间目录符号链接),
//     避免通过符号链接绕过项目根目录。
//   - 目录复制使用异步 API + 数量/大小/深度上限, 失败时清理本次创建的不完整目标。
//   - 同名目标由 routes 层提前判定返回 CONFLICT, 本模块假设目标不存在。

import fs from 'fs';
import path from 'path';

// 与前端 project-file-source.ts 的 FileOperationErrorCode 保持一致, 勿随意改名。
export type FileOpErrorCode =
  | 'NOT_FOUND'
  | 'READ_ONLY'
  | 'CONFLICT'
  | 'INVALID_NAME'
  | 'OUTSIDE_ROOT'
  | 'SYMLINK_UNSUPPORTED'
  | 'TOO_LARGE'
  | 'CANCELLED'
  | 'UNKNOWN';

export class FileOpError extends Error {
  readonly code: FileOpErrorCode;
  readonly status: number;
  constructor(code: FileOpErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'FileOpError';
    this.code = code;
    this.status = status;
  }
}

// 校验单个文件/目录名 (rename 的 newName, 必须是单段路径)。
// 拒绝: 空、路径分隔符 (/ \)、控制符与 NUL、. 与 ..、Windows 保留名、过长名。
export function validateNewName(raw: unknown): string {
  if (typeof raw !== 'string') throw new FileOpError('INVALID_NAME', '新名称必须是字符串');
  const name = raw.trim();
  if (!name) throw new FileOpError('INVALID_NAME', '名称不能为空');
  if (name.length > 255) throw new FileOpError('INVALID_NAME', '名称过长 (最多 255 字符)');
  if (name === '.' || name === '..') throw new FileOpError('INVALID_NAME', '名称不能为 . 或 ..');
  // 路径分隔符 (posix + windows) 与控制字符一律拒绝, 杜绝 newName 携带子路径越界。
  if (/[\/\\\x00-\x1f]/.test(name)) throw new FileOpError('INVALID_NAME', '名称不能包含路径分隔符或控制字符');
  // Windows 保留名跨平台拒绝 (CON/PRN/AUX/NUL/COM1-9/LPT1-9), 避免在 Windows 客户端出问题。
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
    throw new FileOpError('INVALID_NAME', '名称使用了系统保留名');
  }
  return name;
}

// 从 root 逐段 lstat 到 absPath, 任一段是符号链接即拒绝。
// resolveProjectPath 已保证 absPath 落在 root 子树, 这里防御符号链接把真实路径引向子树外。
// 同时对最终段做 lstat, 因此目标自身是符号链接也会被拒。
export async function assertNoSymlink(root: string, absPath: string): Promise<void> {
  const rel = path.relative(root, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new FileOpError('OUTSIDE_ROOT', '路径越出项目根目录');
  }
  let cur = root;
  // 逐段拼接并 lstat, 捕获中间目录符号链接。
  const parts = rel.split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let lst: fs.Stats;
    try {
      lst = await fs.promises.lstat(cur);
    } catch {
      throw new FileOpError('NOT_FOUND', '路径不存在');
    }
    if (lst.isSymbolicLink()) throw new FileOpError('SYMLINK_UNSUPPORTED', '不支持操作符号链接');
  }
}

// 判断 targetDirAbs 是否等于 srcAbs 或位于其子树, 用于拒绝"把目录复制到自身/子目录"。
export function isDirEqualOrChild(srcAbs: string, targetDirAbs: string): boolean {
  if (path.resolve(srcAbs) === path.resolve(targetDirAbs)) return true;
  const rel = path.relative(path.resolve(srcAbs), path.resolve(targetDirAbs));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// 目录递归复制上限 (设计文档 §14.4): 达到任一上限在创建目标前/中返回 TOO_LARGE。
export const COPY_MAX_FILES = 10000;
export const COPY_MAX_BYTES = 1024 * 1024 * 1024; // 1GB
export const COPY_MAX_DEPTH = 50;

type CopyLimits = { maxFiles: number; maxBytes: number; maxDepth: number };

// 异步递归复制 src -> dst。调用方需保证 dst 不存在 (同名冲突已在 routes 层返回 CONFLICT)。
// 不跟随符号链接: 遇到符号链接直接拒绝 (与 assertNoSymlink 一致)。失败时清理本次创建的内容。
export async function copyEntryRecursive(
  srcAbs: string,
  dstAbs: string,
  limits: CopyLimits = { maxFiles: COPY_MAX_FILES, maxBytes: COPY_MAX_BYTES, maxDepth: COPY_MAX_DEPTH },
): Promise<{ files: number; bytes: number }> {
  const created: string[] = []; // 本次操作新建的路径, 失败时逆序清理
  let files = 0;
  let bytes = 0;

  async function copyOne(src: string, dst: string, depth: number): Promise<void> {
    if (depth > limits.maxDepth) throw new FileOpError('TOO_LARGE', `目录嵌套超过 ${limits.maxDepth} 层`);
    let lst: fs.Stats;
    try {
      lst = await fs.promises.lstat(src);
    } catch {
      throw new FileOpError('NOT_FOUND', '源路径不存在');
    }
    if (lst.isSymbolicLink()) throw new FileOpError('SYMLINK_UNSUPPORTED', '不支持操作符号链接');

    if (lst.isFile()) {
      files++;
      if (files > limits.maxFiles) throw new FileOpError('TOO_LARGE', `文件数量超过 ${limits.maxFiles} 上限`);
      bytes += lst.size;
      if (bytes > limits.maxBytes) throw new FileOpError('TOO_LARGE', `目录总大小超过上限`);
      try {
        await fs.promises.copyFile(src, dst);
      } catch (e) {
        throw new FileOpError('UNKNOWN', `复制文件失败: ${(e as Error).message}`, 500);
      }
      created.push(dst);
      return;
    }

    if (!lst.isDirectory()) throw new FileOpError('INVALID_NAME', '不支持的文件类型');

    let entries: fs.Dirent[];
    try {
      await fs.promises.mkdir(dst, { recursive: false });
    } catch (e) {
      // dst 已存在等; 由 routes 层提前判 CONFLICT, 到这里多为意外错误。
      throw new FileOpError('UNKNOWN', `创建目录失败: ${(e as Error).message}`, 500);
    }
    created.push(dst);
    try {
      entries = await fs.promises.readdir(src, { withFileTypes: true });
    } catch (e) {
      throw new FileOpError('UNKNOWN', `读取目录失败: ${(e as Error).message}`, 500);
    }
    for (const ent of entries) {
      await copyOne(path.join(src, ent.name), path.join(dst, ent.name), depth + 1);
    }
  }

  try {
    await copyOne(srcAbs, dstAbs, 0);
    return { files, bytes };
  } catch (e) {
    // 清理本次创建的不完整目标, 逆序保证子先于父 (recursive force 兜底)。
    for (let i = created.length - 1; i >= 0; i--) {
      try {
        await fs.promises.rm(created[i], { recursive: true, force: true });
      } catch {
        /* 清理失败不掩盖原错误 */
      }
    }
    throw e;
  }
}

// Content-Disposition filename 编码 (RFC 5987), 同时给一个 ASCII fallback。
// 防止中文/特殊文件名破坏响应头或注入。
export function contentDispositionAttachment(name: string): string {
  const fallback = String(name || 'download').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').slice(0, 100) || 'download';
  const encoded = encodeURIComponent(name).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// 常见类型 -> Content-Type, 其余回退 application/octet-stream (设计文档 §8.1)。
const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  ts: 'text/plain', py: 'text/x-python', sh: 'text/x-shellscript',
  xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml', toml: 'application/toml',
  csv: 'text/csv',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
};
export function contentTypeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}
