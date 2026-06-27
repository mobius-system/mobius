/**
 * project-knowledge.ts — 把项目绑定路径下的 .imac/project_knowledge.md
 * 同步成一条确定 slug 的项目级 Memory.
 */
import * as fs from 'fs';
import * as path from 'path';
import memoriesFs from './memories-fs';
import { Projects } from '../repositories/projects';
import {
  MAX_MEMORY_MARKDOWN_BYTES,
  formatBytes,
} from './context-import-utils';

const PROJECT_KNOWLEDGE_SLUG = 'project-knowledge';
const HISTORY_DIR_NAME = 'history';
const HISTORY_RETAIN = 30;
const HISTORY_FILE_PREFIX = 'project_knowledge.';
const HISTORY_FILE_SUFFIX = '.bak.md';

function projectKnowledgeMemoryName(project: any): string {
  const projectName = (project?.name || project?.id || '项目').trim();
  return `${projectName}的项目知识`;
}

function projectKnowledgePath(project: any): string {
  const bindPath = (project?.bind_path || '').trim();
  if (!bindPath) return '';
  return path.resolve(bindPath, '.imac', 'project_knowledge.md');
}

function projectKnowledgeHistoryDir(project: any): string {
  const bindPath = (project?.bind_path || '').trim();
  if (!bindPath) return '';
  return path.resolve(bindPath, '.imac', HISTORY_DIR_NAME);
}

function formatHistoryTimestamp(date: Date = new Date()): string {
  // ISO 时间但把冒号替换成连字符, 避免文件名非法字符.
  return date.toISOString().replace(/[:.]/g, '-');
}

function parseHistoryTimestamp(filename: any): Date | null {
  // project_knowledge.2026-06-18T12-00-00-000Z.bak.md → Date
  const m = String(filename || '').match(/^project_knowledge\.(.+)\.bak\.md$/);
  if (!m) return null;
  const restored = m[1].replace(/-(\d{2})-(\d{2})-(\d{2})-/, '-$1:$2:$3.').replace(/-(\d{3})Z$/, '.$1Z');
  const d = new Date(restored);
  return isNaN(d.getTime()) ? null : d;
}

// 把当前 project_knowledge.md 内容快照到 history 目录.
// 同时清理超过 HISTORY_RETAIN 份的旧快照. 失败不抛错, 只返回 {ok, error}.
function snapshotProjectKnowledge(project: any, content?: any): any {
  const dir = projectKnowledgeHistoryDir(project);
  if (!dir) return { ok: false, error: '项目未绑定路径' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = formatHistoryTimestamp();
    const filename = `${HISTORY_FILE_PREFIX}${stamp}${HISTORY_FILE_SUFFIX}`;
    const filePath = path.join(dir, filename);
    if (typeof content === 'string') {
      fs.writeFileSync(filePath, content, 'utf8');
    } else {
      const sourcePath = projectKnowledgePath(project);
      if (!sourcePath || !fs.existsSync(sourcePath)) {
        return { ok: false, error: '源文件不存在, 无法生成快照' };
      }
      fs.copyFileSync(sourcePath, filePath);
    }
    cleanupHistorySnapshots(dir);
    return { ok: true, path: filePath, filename };
  } catch (e) {
    return { ok: false, error: `生成快照失败: ${e.message}` };
  }
}

function cleanupHistorySnapshots(dir: string): void {
  try {
    const entries = fs.readdirSync(dir)
      .map((filename: string) => {
        const fullPath = path.join(dir, filename);
        let mtime: Date;
        try { mtime = fs.statSync(fullPath).mtime; } catch { return null; }
        return { filename, fullPath, mtime };
      })
      .filter(Boolean)
      .filter((e: any) => e.filename.startsWith(HISTORY_FILE_PREFIX) && e.filename.endsWith(HISTORY_FILE_SUFFIX));
    if (entries.length <= HISTORY_RETAIN) return;
    entries.sort((a: any, b: any) => b.mtime.getTime() - a.mtime.getTime());
    const toDelete = entries.slice(HISTORY_RETAIN);
    for (const e of toDelete) {
      try { fs.unlinkSync(e.fullPath); } catch {}
    }
  } catch {}
}

function listProjectKnowledgeHistory(project: any): any[] {
  const dir = projectKnowledgeHistoryDir(project);
  if (!dir) return [];
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f: string) => f.startsWith(HISTORY_FILE_PREFIX) && f.endsWith(HISTORY_FILE_SUFFIX))
      .map((filename: string) => {
        const fullPath = path.join(dir, filename);
        let stat: fs.Stats;
        try { stat = fs.statSync(fullPath); } catch { return null; }
        const ts = parseHistoryTimestamp(filename);
        return {
          filename,
          size: stat.size,
          saved_at: (ts || stat.mtime).toISOString(),
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => new Date(b.saved_at).getTime() - new Date(a.saved_at).getTime());
  } catch (e) {
    return [];
  }
}

function readProjectKnowledgeHistoryFile(project: any, filename: any): any {
  const dir = projectKnowledgeHistoryDir(project);
  if (!dir) return { ok: false, error: '项目未绑定路径' };
  // 严格校验文件名, 避免路径穿越.
  if (!filename || !filename.startsWith(HISTORY_FILE_PREFIX) || !filename.endsWith(HISTORY_FILE_SUFFIX) || filename.includes('..') || filename.includes('/')) {
    return { ok: false, error: '非法文件名' };
  }
  const fullPath = path.join(dir, filename);
  try {
    if (!fs.existsSync(fullPath)) return { ok: false, error: '快照不存在' };
    const content = fs.readFileSync(fullPath, 'utf8');
    return { ok: true, content, path: fullPath };
  } catch (e) {
    return { ok: false, error: `读取快照失败: ${e.message}` };
  }
}

function syncProjectKnowledge(project: any, opts: any = {}): any {
  if (!project?.id) return { ok: false, error: '项目不存在' };

  const sourcePath = projectKnowledgePath(project);
  const memoryName = projectKnowledgeMemoryName(project);
  if (!sourcePath) {
    return { ok: true, synced: false, reason: '项目未绑定路径', memory_name: memoryName };
  }
  if (!fs.existsSync(sourcePath)) {
    return { ok: true, synced: false, reason: 'project_knowledge.md 不存在', path: sourcePath, memory_name: memoryName };
  }

  let stat: fs.Stats;
  try { stat = fs.statSync(sourcePath); }
  catch (e) { return { ok: false, error: `无法访问项目知识文件: ${e.message}`, path: sourcePath, memory_name: memoryName }; }
  if (!stat.isFile()) {
    return { ok: false, error: '项目知识路径不是文件', path: sourcePath, memory_name: memoryName };
  }
  if (stat.size > MAX_MEMORY_MARKDOWN_BYTES) {
    return {
      ok: false,
      error: `项目知识文件不能超过 ${formatBytes(MAX_MEMORY_MARKDOWN_BYTES)}`,
      path: sourcePath,
      memory_name: memoryName,
    };
  }

  let body = '';
  try { body = fs.readFileSync(sourcePath, 'utf8'); }
  catch (e) { return { ok: false, error: `读取项目知识文件失败: ${e.message}`, path: sourcePath, memory_name: memoryName }; }

  const ownerUserId = (project.created_by || opts.fallbackUserId || '').trim();
  if (!ownerUserId) {
    return { ok: false, error: '项目缺少创建者, 无法确定项目知识 Memory 归属', path: sourcePath, memory_name: memoryName };
  }

  const result = memoriesFs.upsertProjectMemory({
    userId: ownerUserId,
    projectId: project.id,
    slug: PROJECT_KNOWLEDGE_SLUG,
    name: memoryName,
    description: `自动同步自 ${sourcePath}`,
    body,
  });
  if (!result.ok) {
    return { ok: false, error: result.error || '同步项目知识 Memory 失败', path: sourcePath, memory_name: memoryName };
  }

  return {
    ok: true,
    synced: true,
    changed: !!result.changed,
    path: sourcePath,
    memory_name: memoryName,
    body_length: body.length,
    memory: result.memory,
  };
}

function syncProjectKnowledgeForProjectId(projectId: any, opts: any = {}): any {
  const project = Projects.findById(projectId);
  if (!project) return { ok: false, error: '项目未找到' };
  return syncProjectKnowledge(project, opts);
}

const PROJECT_KNOWLEDGE_TEMPLATE = `# 项目宏观规划

> 由 Mobius 系统宏观规划模式维护，请勿手动删除结构标题

## 项目目标

（待填写）

## 核心模块

（待填写）

## 当前阶段

（待填写）

## 近期任务

（待填写）

## 技术决策记录

（待填写）

## 待决策事项

（待填写）
`;

// 规划 Issue 创建时调用: 确保 .imac/project_knowledge.md 存在并带有模板.
// 已存在则不覆盖, 保护用户已有内容.
function ensureProjectKnowledgeFile(project: any): any {
  const filePath = projectKnowledgePath(project);
  if (!filePath) return { ok: false, error: '项目未绑定路径' };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, PROJECT_KNOWLEDGE_TEMPLATE, 'utf8');
      return { ok: true, created: true, path: filePath };
    }
    return { ok: true, created: false, path: filePath };
  } catch (e) {
    return { ok: false, error: `初始化项目知识文件失败: ${e.message}`, path: filePath };
  }
}

export {
  PROJECT_KNOWLEDGE_SLUG,
  projectKnowledgeMemoryName,
  projectKnowledgePath,
  syncProjectKnowledge,
  syncProjectKnowledgeForProjectId,
  ensureProjectKnowledgeFile,
  snapshotProjectKnowledge,
  listProjectKnowledgeHistory,
  readProjectKnowledgeHistoryFile,
};
