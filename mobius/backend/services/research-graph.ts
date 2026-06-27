import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { Researches } from '../repositories/researches';

const GRAPH_FILENAME = 'research-graph.yml';
const ALLOWED_VISUAL_EFFECTS = ['in_progress', 'completed', 'failed', 'successful'];
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']);

function resolveGraphFile(researchId: any): any {
  const research = Researches.findByIdWithProject(researchId);
  if (!research) return { error: 'Research 未找到' };
  const bindPath = (research.bind_path || '').trim();
  if (!bindPath) return { error: `Research 所属项目「${research.project_name || research.project_id}」尚未配置绑定路径` };
  const root = path.resolve(bindPath);
  const dir = path.join(root, '.imac', 'blackboard', researchId);
  return {
    research,
    root,
    dir,
    file: path.join(dir, GRAPH_FILENAME),
  };
}

function asIntId(value: any): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function asStringList(value: any): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v : String(v == null ? '' : v))).map((s) => s.trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function pickOwner(raw: any): string {
  const candidate = raw.owner ?? raw['责任人'] ?? raw.responsible ?? raw.assignee;
  if (candidate == null) return '';
  return typeof candidate === 'string' ? candidate.trim() : String(candidate).trim();
}

function normalizeNode(raw: any): any {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = asIntId(raw.id);
  if (id == null) return null;

  const parentNodes = (Array.isArray(raw.parent_nodes) ? raw.parent_nodes : [])
    .map(asIntId)
    .filter((v) => v != null);

  const visualEffects = asStringList(raw.visual_effects)
    .filter((v) => ALLOWED_VISUAL_EFFECTS.includes(v));

  const mainContentRaw = raw.main_content;
  const mainContent = typeof mainContentRaw === 'string'
    ? mainContentRaw
    : (mainContentRaw == null ? '' : String(mainContentRaw));

  const color = typeof raw.color === 'string' && raw.color.trim() ? raw.color.trim() : null;

  return {
    id,
    color,
    parent_nodes: Array.from(new Set(parentNodes)),
    visual_effects: visualEffects,
    main_content: mainContent,
    owner: pickOwner(raw),
    attached_images: asStringList(raw.attached_images),
  };
}

function extractRawNodes(parsed: any): any[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.nodes)) return parsed.nodes;
  return [];
}

function buildEdges(nodes: any[]): any[] {
  const idSet = new Set(nodes.map((n) => n.id));
  const edges = [];
  const seen = new Set();
  for (const node of nodes) {
    for (const parentId of node.parent_nodes) {
      if (!idSet.has(parentId)) continue;
      const key = `${parentId}->${node.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: `e${key}`, source: String(parentId), target: String(node.id) });
    }
  }
  return edges;
}

function readGraph(researchId: any): any {
  const resolved = resolveGraphFile(researchId);
  if (resolved.error) return resolved;
  try {
    if (!fs.existsSync(resolved.file)) {
      return { exists: false, nodes: [], edges: [], file: resolved.file, research: resolved.research };
    }
    const content = fs.readFileSync(resolved.file, 'utf8');
    let parsed;
    try {
      parsed = yaml.load(content);
    } catch (e) {
      return { error: `解析 research-graph.yml 失败: ${e.message}`, file: resolved.file };
    }
    const rawNodes = extractRawNodes(parsed);
    const nodesById = new Map();
    for (const raw of rawNodes) {
      const node = normalizeNode(raw);
      if (node) nodesById.set(node.id, node); // 后出现的同 id 覆盖前者
    }
    const nodes = Array.from(nodesById.values()).sort((a, b) => a.id - b.id);
    return {
      exists: true,
      nodes,
      edges: buildEdges(nodes),
      file: resolved.file,
      research: resolved.research,
    };
  } catch (e) {
    return { error: `读取 research-graph.yml 失败: ${e.message}` };
  }
}

// 仅允许读取 research 绑定根目录内、且为图片扩展名的文件, 防止任意文件读取
function resolveGraphImage(researchId: any, requestedPath: any): any {
  const resolved = resolveGraphFile(researchId);
  if (resolved.error) return resolved;
  if (!requestedPath || typeof requestedPath !== 'string') return { error: 'path 不能为空' };
  const absPath = path.resolve(requestedPath);
  const root = resolved.root;
  if (absPath !== root && !absPath.startsWith(root + path.sep)) {
    return { error: '图片路径越界 (必须位于 research 绑定目录内)' };
  }
  let realPath;
  try {
    realPath = fs.realpathSync(absPath);
  } catch {
    return { error: '图片不存在' };
  }
  const realRoot = fs.realpathSync(root);
  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    return { error: '图片路径越界 (符号链接指向目录外)' };
  }
  if (!IMAGE_EXTS.has(path.extname(realPath).toLowerCase())) {
    return { error: '仅支持图片文件' };
  }
  if (!fs.statSync(realPath).isFile()) return { error: '不是文件' };
  return { absPath: realPath };
}

export {
  GRAPH_FILENAME,
  ALLOWED_VISUAL_EFFECTS,
  resolveGraphFile,
  readGraph,
  resolveGraphImage,
};
