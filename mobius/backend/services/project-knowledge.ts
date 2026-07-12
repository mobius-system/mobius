/**
 * project-knowledge.ts — 把项目绑定路径下的 .imac/project_knowledge.md
 * 同步成一条确定 slug 的项目级 Memory.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as memoriesFs from './memories-fs';
import { Projects } from '../repositories/projects';
import {
  MAX_MEMORY_MARKDOWN_BYTES,
  formatBytes,
} from './context-import-utils';
import { HIDDEN_FOLDER_NAME } from '../config';

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
  return path.resolve(bindPath, HIDDEN_FOLDER_NAME, 'project_knowledge.md');
}

function projectKnowledgeHistoryDir(project: any): string {
  const bindPath = (project?.bind_path || '').trim();
  if (!bindPath) return '';
  return path.resolve(bindPath, HIDDEN_FOLDER_NAME, HISTORY_DIR_NAME);
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
      try { fs.unlinkSync((e as any).fullPath); } catch {}
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

// =========================================================================
// Issue 级知识 — 与项目知识同构, 存放于
//   <bind_path>/<HIDDEN_FOLDER_NAME>/issue_knowledge/<issue_id>/issue_knowledge.md
// 设计与项目知识"合二为一":
//   - 共享同样的 "md 文件 → 确定记忆" 的投影思路;
//   - 但 issue 知识**不入 memory 文件库**, 而是在 gatherIssueSources 时按当前 issue
//     即时读取, 拼成一条 memory 形态 ({id,scope,name,description,body}) 注入, 因此
//     只会出现在**本 issue 的 Session** 的记忆列表里, 不污染项目下其它 issue.
//   - 因此它同样可在「创建 Session 第二步」作为可选 memory 勾选/取消, 并进入 prompt.
// =========================================================================
const ISSUE_KNOWLEDGE_SUBDIR = 'issue_knowledge';
const ISSUE_KNOWLEDGE_FILE = 'issue_knowledge.md';
// 合成 memory id 前缀 (不是 memory 库里的真实 slug, 仅作前端勾选/排除用的稳定 id).
const ISSUE_KNOWLEDGE_ID_PREFIX = 'issue-knowledge:';

function issueKnowledgeDir(project: any, issueId: any): string {
  const bindPath = (project?.bind_path || '').trim();
  const id = String(issueId || '').trim();
  if (!bindPath || !id) return '';
  return path.resolve(bindPath, HIDDEN_FOLDER_NAME, ISSUE_KNOWLEDGE_SUBDIR, id);
}

function issueKnowledgePath(project: any, issueId: any): string {
  const dir = issueKnowledgeDir(project, issueId);
  if (!dir) return '';
  return path.resolve(dir, ISSUE_KNOWLEDGE_FILE);
}

function issueKnowledgeMemoryId(issueId: any): string {
  return `${ISSUE_KNOWLEDGE_ID_PREFIX}${String(issueId || '').trim()}`;
}

function issueKnowledgeMemoryName(issue: any): string {
  const title = String(issue?.title || issue?.id || '本任务').trim();
  return `${title}的任务知识`;
}

const ISSUE_KNOWLEDGE_TEMPLATE = `# 本任务知识

> 由 Mobius 维护，记录仅与当前 Issue 相关的、较为局限的知识（项目级通用知识请写入 project_knowledge.md）

## 背景

（待填写）

## 关键决策 / 约束

（待填写）

## 进展 / 待办

（待填写）
`;

// 读取 issue 知识并返回 memory 形态投影. 文件不存在 → 返回 null (不报错, 不创建).
// 由 gatherIssueSources 在拼记忆列表时调用, 让本任务知识像普通 memory 一样可选可注入.
function readIssueKnowledgeShape(project: any, issue: any): any {
  if (!project || !issue || !issue.id) return null;
  const filePath = issueKnowledgePath(project, issue.id);
  if (!filePath) return null;
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); }
  catch { return null; }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_MEMORY_MARKDOWN_BYTES) return null;
  let body = '';
  try { body = fs.readFileSync(filePath, 'utf8'); }
  catch { return null; }
  return {
    id: issueKnowledgeMemoryId(issue.id),
    scope: 'issue',
    name: issueKnowledgeMemoryName(issue),
    description: `本任务知识 (issue_knowledge/${issue.id}/${ISSUE_KNOWLEDGE_FILE})`,
    body,
  };
}

// 写入 issue 知识 md. 不存在则用模板初始化目录. 返回 {ok, path} 或 {ok:false,error}.
function writeIssueKnowledge(project: any, issue: any, content: string): any {
  if (!project || !issue || !issue.id) return { ok: false, error: '缺少 project/issue' };
  const filePath = issueKnowledgePath(project, issue.id);
  if (!filePath) return { ok: false, error: '项目未绑定路径' };
  const body = typeof content === 'string' ? content : '';
  if (Buffer.byteLength(body, 'utf8') > MAX_MEMORY_MARKDOWN_BYTES) {
    return { ok: false, error: `任务知识文件不能超过 ${formatBytes(MAX_MEMORY_MARKDOWN_BYTES)}` };
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body, 'utf8');
    return { ok: true, path: filePath, created: true };
  } catch (e) {
    return { ok: false, error: `写入任务知识文件失败: ${e.message}`, path: filePath };
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
  issueKnowledgePath,
  issueKnowledgeMemoryId,
  issueKnowledgeMemoryName,
  readIssueKnowledgeShape,
  writeIssueKnowledge,
  ISSUE_KNOWLEDGE_TEMPLATE,
};
