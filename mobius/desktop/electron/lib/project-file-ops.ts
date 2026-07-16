// 原生文件编辑器右键菜单: Electron 主进程侧的路径/名称校验与目录递归复制。
// 与 backend/services/project-file-ops.ts 逻辑一致 (主进程必须独立重新校验, 设计文档 §13)。
// 纯 Node fs/path, 不依赖 electron, 便于单测。保持两份同步。
import * as fs from "node:fs";
import * as path from "node:path";

export type FileOpErrorCode =
  | "NOT_FOUND"
  | "READ_ONLY"
  | "CONFLICT"
  | "INVALID_NAME"
  | "OUTSIDE_ROOT"
  | "SYMLINK_UNSUPPORTED"
  | "TOO_LARGE"
  | "CANCELLED"
  | "UNKNOWN";

export class FileOpError extends Error {
  readonly code: FileOpErrorCode;
  constructor(code: FileOpErrorCode, message: string) {
    super(message);
    this.name = "FileOpError";
    this.code = code;
  }
}

// 校验单个文件/目录名: 拒绝空、路径分隔符、控制符、. / ..、Windows 保留名、过长。
export function validateNewName(raw: unknown): string {
  if (typeof raw !== "string") throw new FileOpError("INVALID_NAME", "新名称必须是字符串");
  const name = raw.trim();
  if (!name) throw new FileOpError("INVALID_NAME", "名称不能为空");
  if (name.length > 255) throw new FileOpError("INVALID_NAME", "名称过长 (最多 255 字符)");
  if (name === "." || name === "..") throw new FileOpError("INVALID_NAME", "名称不能为 . 或 ..");
  if (/[\/\\\x00-\x1f]/.test(name)) throw new FileOpError("INVALID_NAME", "名称不能包含路径分隔符或控制字符");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
    throw new FileOpError("INVALID_NAME", "名称使用了系统保留名");
  }
  return name;
}

// 从 root 逐段 lstat 到 absPath, 任一段是符号链接即拒绝 (含目标自身)。
export async function assertNoSymlink(root: string, absPath: string): Promise<void> {
  const rel = path.relative(root, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new FileOpError("OUTSIDE_ROOT", "路径越出项目根目录");
  }
  let cur = root;
  const parts = rel.split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let lst: fs.Stats;
    try {
      lst = await fs.promises.lstat(cur);
    } catch {
      throw new FileOpError("NOT_FOUND", "路径不存在");
    }
    if (lst.isSymbolicLink()) throw new FileOpError("SYMLINK_UNSUPPORTED", "不支持操作符号链接");
  }
}

// targetDirAbs 是否等于 srcAbs 或位于其子树 (拒绝把目录复制到自身/子目录)。
export function isDirEqualOrChild(srcAbs: string, targetDirAbs: string): boolean {
  if (path.resolve(srcAbs) === path.resolve(targetDirAbs)) return true;
  const rel = path.relative(path.resolve(srcAbs), path.resolve(targetDirAbs));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export const COPY_MAX_FILES = 10000;
export const COPY_MAX_BYTES = 1024 * 1024 * 1024; // 1GB
export const COPY_MAX_DEPTH = 50;

type CopyLimits = { maxFiles: number; maxBytes: number; maxDepth: number };

// 异步递归复制, 不跟随符号链接, 失败时清理本次创建的内容。
export async function copyEntryRecursive(
  srcAbs: string,
  dstAbs: string,
  limits: CopyLimits = { maxFiles: COPY_MAX_FILES, maxBytes: COPY_MAX_BYTES, maxDepth: COPY_MAX_DEPTH },
): Promise<{ files: number; bytes: number }> {
  const created: string[] = [];
  let files = 0;
  let bytes = 0;

  async function copyOne(src: string, dst: string, depth: number): Promise<void> {
    if (depth > limits.maxDepth) throw new FileOpError("TOO_LARGE", `目录嵌套超过 ${limits.maxDepth} 层`);
    let lst: fs.Stats;
    try {
      lst = await fs.promises.lstat(src);
    } catch {
      throw new FileOpError("NOT_FOUND", "源路径不存在");
    }
    if (lst.isSymbolicLink()) throw new FileOpError("SYMLINK_UNSUPPORTED", "不支持操作符号链接");

    if (lst.isFile()) {
      files++;
      if (files > limits.maxFiles) throw new FileOpError("TOO_LARGE", `文件数量超过 ${limits.maxFiles} 上限`);
      bytes += lst.size;
      if (bytes > limits.maxBytes) throw new FileOpError("TOO_LARGE", "目录总大小超过上限");
      try {
        await fs.promises.copyFile(src, dst);
      } catch (e) {
        throw new FileOpError("UNKNOWN", `复制文件失败: ${(e as Error).message}`);
      }
      created.push(dst);
      return;
    }

    if (!lst.isDirectory()) throw new FileOpError("INVALID_NAME", "不支持的文件类型");

    let entries: fs.Dirent[];
    try {
      await fs.promises.mkdir(dst, { recursive: false });
    } catch (e) {
      throw new FileOpError("UNKNOWN", `创建目录失败: ${(e as Error).message}`);
    }
    created.push(dst);
    try {
      entries = await fs.promises.readdir(src, { withFileTypes: true });
    } catch (e) {
      throw new FileOpError("UNKNOWN", `读取目录失败: ${(e as Error).message}`);
    }
    for (const ent of entries) {
      await copyOne(path.join(src, ent.name), path.join(dst, ent.name), depth + 1);
    }
  }

  try {
    await copyOne(srcAbs, dstAbs, 0);
    return { files, bytes };
  } catch (e) {
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
