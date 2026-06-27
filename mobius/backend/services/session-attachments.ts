import * as fs from 'fs';
import * as path from 'path';
import { APP_DIR, HIDDEN_FOLDER_NAME } from '../config';

const SESSION_ATTACHMENT_MAX_COUNT = 6;
const SESSION_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function isPathInside(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeSessionAttachments(raw: any, user: any, extraRoots: string[] = []): any[] {
  const arr = Array.isArray(raw) ? raw : [];
  const allowedRoots = [
    ...extraRoots,
    user?.work_dir,
    path.join(APP_DIR, HIDDEN_FOLDER_NAME, 'upload'),
  ].filter(Boolean).map((item) => path.resolve(item as string));
  const out: any[] = [];
  const seen = new Set<string>();

  for (const item of arr) {
    if (out.length >= SESSION_ATTACHMENT_MAX_COUNT) break;
    if (!item || typeof item !== 'object') continue;
    const rawPath = typeof item.path === 'string' ? item.path.trim() : '';
    if (!rawPath || !path.isAbsolute(rawPath)) continue;
    const absPath = path.resolve(rawPath);
    if (seen.has(absPath)) continue;
    if (!allowedRoots.some((root) => isPathInside(root, absPath))) continue;
    const ext = path.extname(absPath).toLowerCase();
    const requestedType = item.type === 'image' ? 'image' : 'file';
    const type = SESSION_IMAGE_EXTENSIONS.has(ext) ? 'image' : requestedType;
    try {
      const stat = fs.statSync(absPath);
      if (!stat.isFile()) continue;
      out.push({
        type,
        path: absPath,
        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : path.basename(absPath),
        size: stat.size,
        mime_type: typeof item.mime_type === 'string' ? item.mime_type : undefined,
      });
      seen.add(absPath);
    } catch {
      continue;
    }
  }
  return out;
}

function sessionAttachmentPromptBlock(attachments: any): string {
  const files = Array.isArray(attachments) ? attachments.filter((item: any) => item?.path) : [];
  if (files.length === 0) return '';
  return [
    '用户随本轮消息上传了以下附件。你可以直接读取这些本机绝对路径来理解内容；图片需要向用户展示时可使用 `display_images <图片路径>`。',
    ...files.map((file: any, index: number) => {
      const label = file.name ? ` (${file.name})` : '';
      const kind = file.type === 'image' ? '图片' : '文件';
      return `${index + 1}. [${kind}] ${file.path}${label}`;
    }),
  ].join('\n');
}

function sessionContentWithAttachments(content: string, attachments: any): string {
  const block = sessionAttachmentPromptBlock(attachments);
  if (!block) return content;
  return [block, String(content || '').trim()].filter(Boolean).join('\n\n');
}

export {
  SESSION_ATTACHMENT_MAX_COUNT,
  normalizeSessionAttachments,
  sessionAttachmentPromptBlock,
  sessionContentWithAttachments,
};
