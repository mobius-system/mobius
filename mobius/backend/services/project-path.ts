// 项目相对路径解析 (从 routes/projects.ts 抽出, 便于单测路径穿越防护)。
// 在项目 bind_path 内解析子路径, 返回 { absPath, relPath } 或 { error }。
// 允许任何字符 (用 path.resolve 规范化), 但最终绝对值必须落在 bind_path 子树。
// 安全要点: 1) 先剔除 ".." 字面; 2) path.resolve 后交给 file-access.isWithin 判定,
//           拒绝绝对路径输入与任何越界结果 (不依赖字符串替换做唯一防线)。
import path from 'path';
import { isWithin } from './file-access';

export function resolveProjectPath(
  bindPath: string | null | undefined,
  rawPath: unknown = '/',
): { error: string } | { root: string; relPath: string; absPath: string } {
  if (!bindPath) return { error: '项目未绑定路径' };
  const root = path.resolve(bindPath);
  const relPath = String(rawPath || '/').replace(/\.\./g, '');
  const absPath = path.resolve(root, relPath.replace(/^\/+/, ''));
  if (!isWithin(root, absPath)) return { error: 'Access denied' };
  return { root, relPath: '/' + path.relative(root, absPath).replace(/\\/g, '/'), absPath };
}
