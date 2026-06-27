import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const MB = 1024 * 1024;
const GB = 1024 * MB;

const MAX_SKILL_UPLOAD_BYTES = 1 * GB;
const MAX_SKILL_EXTRACTED_BYTES = 1 * GB;
const MAX_SKILL_EXTRACTED_FILES = 50000;
const MAX_MEMORY_MARKDOWN_BYTES = 50 * MB;

function formatBytes(bytes: any): string {
  const n = Number(bytes) || 0;
  if (n >= GB && n % GB === 0) return `${n / GB}GB`;
  if (n >= GB) return `${(n / GB).toFixed(1)}GB`;
  if (n >= MB && n % MB === 0) return `${n / MB}MB`;
  if (n >= MB) return `${(n / MB).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function safeResolveUnder(root: string, ...parts: string[]): string | null {
  const base = path.resolve(root);
  const abs = path.resolve(base, ...parts);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

function safeOriginalName(name: any, fallback = 'upload'): string {
  const base = path.basename(String(name || fallback)).replace(/[^\w一-鿿 .@()+,-]/g, '_').trim();
  return (base || fallback).slice(0, 180);
}

function stripArchiveOrMarkdownExtension(filename: any): string {
  let base = path.basename(String(filename || ''));
  base = base.replace(/\.tar\.(gz|bz2|xz)$/i, '');
  base = base.replace(/\.(tgz|tbz2?|txz|zip|tar|md|markdown)$/i, '');
  return base;
}

function detectMarkdownFile(input: any): boolean {
  const name = String(input?.originalname || input?.name || input || '').toLowerCase();
  const mime = String(input?.mimetype || '').toLowerCase();
  return name.endsWith('.md') || name.endsWith('.markdown') || mime === 'text/markdown' || mime === 'text/plain';
}

function detectArchiveKind(input: any): string | null {
  const name = String(input?.originalname || input?.name || input || '').toLowerCase();
  const mime = String(input?.mimetype || '').toLowerCase();
  if (name.endsWith('.zip') || mime.includes('zip')) return 'zip';
  if (
    name.endsWith('.tar') ||
    name.endsWith('.tgz') ||
    name.endsWith('.tar.gz') ||
    name.endsWith('.tbz') ||
    name.endsWith('.tbz2') ||
    name.endsWith('.tar.bz2') ||
    name.endsWith('.txz') ||
    name.endsWith('.tar.xz') ||
    mime.includes('tar') ||
    mime.includes('gzip') ||
    mime.includes('x-bzip2') ||
    mime.includes('x-xz')
  ) return 'tar';
  return null;
}

function detectContextFileKind(input: any): string | null {
  if (detectMarkdownFile(input)) return 'markdown';
  return detectArchiveKind(input);
}

function removeIfExists(target?: string | null): void {
  if (!target) return;
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

function unlinkIfExists(target?: string | null): void {
  if (!target) return;
  try { fs.unlinkSync(target); } catch {}
}

function archiveEntriesFromCommand(command: string, args: string[], encoding: BufferEncoding = 'utf8'): string[] {
  const result = spawnSync(command, args, {
    encoding,
    maxBuffer: 50 * MB,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} 读取压缩包失败`).trim().slice(-1000));
  }
  return String(result.stdout || '').split(/\r?\n/).filter(Boolean);
}

function validateArchiveEntries(entries: string[]): void {
  if (!entries.length) throw new Error('压缩包为空');
  for (const entry of entries) {
    const normalized = String(entry || '').replace(/\\/g, '/');
    if (!normalized || normalized.includes('\0')) throw new Error('压缩包包含非法文件名');
    if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
      throw new Error(`压缩包包含绝对路径: ${entry}`);
    }
    const parts = normalized.split('/').filter(Boolean);
    if (parts.some((part) => part === '..')) {
      throw new Error(`压缩包包含越界路径: ${entry}`);
    }
  }
}

function runExtractCommand(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 50 * MB,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} 解压失败`).trim().slice(-1000));
  }
}

function inspectExtractedTree(root: string, {
  maxBytes = MAX_SKILL_EXTRACTED_BYTES,
  maxFiles = MAX_SKILL_EXTRACTED_FILES,
}: {
  maxBytes?: number;
  maxFiles?: number;
} = {}): { fileCount: number; totalBytes: number } {
  let fileCount = 0;
  let totalBytes = 0;
  const base = path.resolve(root);
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const resolved = path.resolve(abs);
      if (resolved !== base && !resolved.startsWith(base + path.sep)) {
        throw new Error(`压缩包解压路径越界: ${entry.name}`);
      }
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) throw new Error('压缩包不能包含符号链接');
      if (stat.isDirectory()) {
        walk(abs);
      } else if (stat.isFile()) {
        fileCount += 1;
        totalBytes += stat.size;
        if (fileCount > maxFiles) throw new Error(`压缩包文件数量不能超过 ${maxFiles}`);
        if (totalBytes > maxBytes) throw new Error(`压缩包解压后内容不能超过 ${formatBytes(maxBytes)}`);
      }
    }
  };
  walk(base);
  return { fileCount, totalBytes };
}

function extractArchiveFile(filePath: string, destDir: string, {
  kind = detectArchiveKind(filePath),
  maxBytes = MAX_SKILL_EXTRACTED_BYTES,
  maxFiles = MAX_SKILL_EXTRACTED_FILES,
}: {
  kind?: string | null;
  maxBytes?: number;
  maxFiles?: number;
} = {}): { fileCount: number; totalBytes: number } {
  if (kind === 'zip') {
    const entries = archiveEntriesFromCommand('unzip', ['-Z1', filePath]);
    validateArchiveEntries(entries);
    runExtractCommand('unzip', ['-q', filePath, '-d', destDir]);
  } else if (kind === 'tar') {
    const entries = archiveEntriesFromCommand('tar', ['-tf', filePath]);
    validateArchiveEntries(entries);
    runExtractCommand('tar', ['--no-same-owner', '-xf', filePath, '-C', destDir]);
  } else {
    throw new Error('只支持 .zip、.tar、.tar.gz、.tgz 等压缩包');
  }
  return inspectExtractedTree(destDir, { maxBytes, maxFiles });
}

function checkFileSize(filePath: string, maxBytes: number, label?: string): { ok: boolean; size?: number; error?: string } {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { ok: false, error: `${label || '文件'}不是普通文件` };
  if (stat.size > maxBytes) {
    return { ok: false, error: `${label || '文件'}不能超过 ${formatBytes(maxBytes)}` };
  }
  return { ok: true, size: stat.size };
}

export {
  MAX_MEMORY_MARKDOWN_BYTES,
  MAX_SKILL_EXTRACTED_BYTES,
  MAX_SKILL_EXTRACTED_FILES,
  MAX_SKILL_UPLOAD_BYTES,
  checkFileSize,
  detectArchiveKind,
  detectContextFileKind,
  detectMarkdownFile,
  extractArchiveFile,
  formatBytes,
  inspectExtractedTree,
  removeIfExists,
  safeOriginalName,
  safeResolveUnder,
  stripArchiveOrMarkdownExtension,
  unlinkIfExists,
};
