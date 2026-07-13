// =====================================================================
// 全局会话内容搜索 — /api/search
//
// 需求: 顶栏搜索框输入关键词, 返回命中的每个 session 及其命中片段,
//       层级: 项目 → Issue/Research → Session → 命中片段.
//
// 数据源: session 的 JSONL 原文 (primary cc jsonl + .mobius.jsonl sidecar, 与
//         readMergedJsonlHistory 同源). 路径解析复用 backend._resolveJsonlPath
//         (runtime → hub-runtime.json → hub-archive.json 三级查表).
//         注: messages_v2 自 2026-06-10 起只落 user/system (assistant/tool/thinking 的
//         insertXxx 成死代码、无调用方), 不能作内容搜索源 → 完整对话正文仍以 JSONL 为唯一权威源.
//
// 性能边界 (用户主动触发, 非轮询; 仍要保护单 worker 事件循环):
//   - 候选 session 上限 DEFAULT_CANDIDATES=200 (按 last_active 倒序), 可由 query 抬到 MAX_CANDIDATES.
//   - 时间范围 range (默认 7d): 仅扫 created_at 在窗口内的 session, 缩小候选集.
//   - 有界并发扫描 SCAN_CONCURRENCY=8, 重叠文件 I/O (await 让出事件循环时其它 worker 推进).
//   - 单 jsonl 文件读取上限 FILE_READ_CAP=1.5MB, 超过只读尾部; 整文件一次小写预判, 无命中直接跳过.
//   - 单 session 命中片段上限 MAX_FRAGMENTS_PER_SESSION=3, 命中即提前结束该文件扫描.
//   - 全局墙钟预算 BUDGET_MS=4000ms, 超时返回已得部分 + truncated=true.
//   - 匹配用「原始 JSONL 行小写子串」, 命中行才 JSON.parse 提取可读片段 — 不逐行 parse.
// =====================================================================
import express from 'express';
import fs from 'fs';
import { auth } from '../middleware/auth';
import { db } from '../../db';
// @ts-ignore — service 仍是 .js
import * as modelRegistry from '../services/model-registry';
// @ts-ignore — agents registry 仍是 .js
import * as agents from '../agents';
// @ts-ignore — service 仍是 .js
import { mobiusJsonlPathOf } from '../services/mobius-jsonl';
// @ts-ignore — service 仍是 .js
import { canReadSession } from '../services/access-control';

const router = express.Router();

type AnyUser = { id: string; role?: string; [k: string]: any };

function userOf(req: express.Request): AnyUser {
  return (req as any).user as AnyUser;
}

// ---- 常量 / 上限 ----
const MIN_Q = 2;
const MAX_Q = 200;
const DEFAULT_CANDIDATES = 200;
const MAX_CANDIDATES = 600;
const FILE_READ_CAP = 1.5 * 1024 * 1024; // 1.5MB, 超过只读尾部
const MAX_FRAGMENTS_PER_SESSION = 3;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const BUDGET_MS = 4000;
const SCAN_CONCURRENCY = 8; // 并发扫 JSONL 的 worker 数 (重叠文件 I/O; 单 worker 事件循环不被长时阻塞)

function clampInt(v: any, def: number, lo: number, hi: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

// ---- 从一条 JSONL entry 提取 {role, text, timestamp} ----
// content 可能是 string (user/error) 或 content-block 数组 (assistant: text/tool_use/tool_result/thinking).
function tryStringify(v: any, cap: number): string {
  if (v == null) return '';
  let s: string;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v); } catch { s = String(v); } }
  return s.length > cap ? s.slice(0, cap) + '…' : s;
}

function extractTextFromEntry(entry: any): { role: string; text: string; timestamp: string | null } | null {
  if (!entry || typeof entry !== 'object') return null;
  const msg = entry.message;
  const role: string = msg?.role || entry.type || 'unknown';
  const timestamp: string | null = entry.timestamp || entry.created_at || msg?.created_at || null;
  let text = '';
  const content = msg?.content;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text' && typeof c.text === 'string') {
        parts.push(c.text);
      } else if (c.type === 'thinking' && typeof c.thinking === 'string') {
        parts.push(c.thinking);
      } else if (c.type === 'tool_use') {
        parts.push(`[工具 ${c.name || ''}] ${tryStringify(c.input, 200)}`);
      } else if (c.type === 'tool_result') {
        const rc = c.content;
        let rt = '';
        if (typeof rc === 'string') rt = rc;
        else if (Array.isArray(rc)) rt = rc.filter((x: any) => x && x.type === 'text').map((x: any) => x.text).join('');
        parts.push(`[结果] ${tryStringify(rt, 300)}`);
      }
    }
    text = parts.join('\n');
  } else if (entry.type === 'error' && typeof msg?.content === 'string') {
    text = msg.content;
  }
  // 去掉 NUL, 限长, 避免巨型片段.
  text = String(text || '').replace(/\x00/g, '').slice(0, 4000);
  if (!text.trim()) return null;
  return { role, text, timestamp };
}

// 在 text 中以 idx 为中心取窗口, 单行化, 加省略号.
function windowAround(text: string, idx: number, qlen: number): string {
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + qlen + 80);
  let s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) s = '…' + s;
  if (end < text.length) s = s + '…';
  return s.length > 240 ? s.slice(0, 240) : s;
}

interface Fragment {
  role: string;
  snippet: string;
  timestamp: string | null;
}

const fsp = fs.promises;

// 读 jsonl: 超过 FILE_READ_CAP 只读尾部 (最近对话), 否则整文件. 失败返回 null.
async function readJsonlTailOrFull(p: string): Promise<string | null> {
  let stat: fs.Stats;
  try { stat = await fsp.stat(p); } catch { return null; }
  if (!stat.isFile() || stat.size === 0) return null;
  try {
    if (stat.size > FILE_READ_CAP) {
      const handle = await fsp.open(p, 'r');
      try {
        const buf = Buffer.alloc(FILE_READ_CAP);
        await handle.read(buf, 0, FILE_READ_CAP, stat.size - FILE_READ_CAP);
        return buf.toString('utf8');
      } finally { await handle.close(); }
    }
    return await fsp.readFile(p, 'utf8');
  } catch { return null; }
}

// 扫单个 session 的 primary + mobius sidecar, 收集 ≤ maxFragments 条命中片段.
async function scanSession(sessionId: string, model: any, qLower: string, qlen: number, maxFragments: number): Promise<Fragment[]> {
  const backendName = modelRegistry.backendNameForSessionModel(model);
  const backend = agents.get(backendName);
  const primaryPath = typeof backend?._resolveJsonlPath === 'function' ? backend._resolveJsonlPath(sessionId) : null;
  const paths: string[] = [];
  if (primaryPath) {
    paths.push(primaryPath);
    const mob = mobiusJsonlPathOf(primaryPath);
    if (mob) paths.push(mob);
  }
  if (paths.length === 0) return [];
  const seen = new Set<string>(); // dedup by role+snippet 前缀 (primary 与 sidecar 会镜像同一句 user 输入)
  const frags: Fragment[] = [];
  for (const p of paths) {
    if (frags.length >= maxFragments) break;
    const text = await readJsonlTailOrFull(p);
    if (!text) continue;
    // 整文件一次小写预判: 绝大多数文件不命中关键词, 一次 indexOf 跳过, 避免逐行小写化的开销.
    if (text.toLowerCase().indexOf(qLower) < 0) continue;
    const lines = text.split('\n');
    for (const line of lines) {
      if (frags.length >= maxFragments) break;
      if (!line) continue;
      // 廉价: 原始行小写子串先判命中, 不命中跳过 (不 parse).
      if (line.toLowerCase().indexOf(qLower) < 0) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      const ext = extractTextFromEntry(entry);
      if (!ext) continue;
      const mIdx = ext.text.toLowerCase().indexOf(qLower);
      const snippet = mIdx >= 0 ? windowAround(ext.text, mIdx, qlen) : windowAround(ext.text, 0, 0);
      const key = ext.role + '|' + snippet.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      frags.push({ role: ext.role, snippet, timestamp: ext.timestamp });
    }
  }
  return frags;
}

router.get('/', auth, async (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const q = String(req.query.q || '').trim();
  if (q.length < MIN_Q) {
    res.status(400).json({ error: '关键词至少 2 个字符' });
    return;
  }
  if (q.length > MAX_Q) {
    res.status(400).json({ error: '关键词过长' });
    return;
  }
  const qLower = q.toLowerCase();
  const projectId = String(req.query.project_id || '').trim() || null;
  const maxCandidates = clampInt(req.query.candidates, DEFAULT_CANDIDATES, 1, MAX_CANDIDATES);
  const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxFragments = clampInt(req.query.max_fragments, MAX_FRAGMENTS_PER_SESSION, 1, 5);

  // 时间范围过滤 (默认 7 天内创建的会话): 缩小候选集以加速 JSONL 扫描.
  // 复用本库惯用法 (见 services/agent-prompt-events.ts): 用 SQLite strftime('now', 修饰符)
  // 直接算截止时刻, 与 created_at 同格式 (strftime('%Y-%m-%dT%H:%M:%fZ','now')), 字符串比较精确无精度漂移.
  // range: '1d' | '7d'(默认) | '30d' | 'all'; 未知值回落默认 7d.
  const RANGE_MODIFIERS: Record<string, string | null> = {
    '1d': '-1 days', '7d': '-7 days', '30d': '-30 days', 'all': null,
  };
  const rangeKey = String(req.query.range || '7d').trim();
  const rangeModifier = RANGE_MODIFIERS[rangeKey] ?? RANGE_MODIFIERS['7d'];

  // 候选 session (带 project / issue / research 名的 join), 按 last_active 倒序, 限候选量.
  const conds: string[] = [];
  const params: any[] = [];
  if (projectId) { conds.push('s.project_id = ?'); params.push(projectId); }
  if (rangeModifier) {
    conds.push("s.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)");
    params.push(rangeModifier);
  }
  const whereSql = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const rows: any[] = db.prepare(`
    SELECT s.session_id, s.name, s.project_id, s.issue_id, s.research_id, s.scope_type,
           s.model, s.last_active, s.user_id, s.status,
           p.name AS project_name,
           i.title AS issue_title,
           r.title AS research_title
    FROM sessions_v2 s
    LEFT JOIN projects p ON s.project_id = p.id
    LEFT JOIN issues i ON s.issue_id = i.id
    LEFT JOIN researches r ON s.research_id = r.id
    ${whereSql}
    ORDER BY s.last_active DESC
    LIMIT ?
  `).all(...params, maxCandidates);

  const start = Date.now();
  let truncatedByBudget = false;
  let scannedCount = 0;

  // 访问控制: 先过滤出可读候选 (canReadSession 是 JS 逻辑, 无法下推 SQL).
  const readable: any[] = [];
  for (const row of rows) {
    if (canReadSession(user, row)) readable.push(row);
  }

  // 有界并发扫描 JSONL (重叠文件 I/O; JS 单线程, nextIdx/scannedCount 自增在 await 之间同步执行, 无竞态).
  const fragsByIndex = new Map<number, Fragment[]>();
  let nextIdx = 0;
  let budgetStopped = false;
  const worker = async () => {
    while (!budgetStopped) {
      const myIdx = nextIdx++;
      if (myIdx >= readable.length) return;
      if (Date.now() - start > BUDGET_MS) { truncatedByBudget = true; budgetStopped = true; return; }
      const row = readable[myIdx];
      let ff: Fragment[];
      try {
        ff = await scanSession(row.session_id, row.model, qLower, q.length, maxFragments);
      } catch {
        ff = [];
      }
      scannedCount++;
      if (ff.length > 0) fragsByIndex.set(myIdx, ff);
    }
  };
  const workerCount = Math.min(SCAN_CONCURRENCY, readable.length);
  if (workerCount > 0) await Promise.all(Array.from({ length: workerCount }, () => worker()));

  // 组装结果 (按 readable 顺序 = last_active 倒序 → 最活跃在前).
  const results: any[] = [];
  for (let i = 0; i < readable.length; i++) {
    const frags = fragsByIndex.get(i);
    if (!frags || frags.length === 0) continue;
    const row = readable[i];
    results.push({
      session_id: row.session_id,
      session_name: row.name,
      project_id: row.project_id,
      project_name: row.project_name || '',
      issue_id: row.scope_type === 'issue' ? row.issue_id : null,
      issue_title: row.scope_type === 'issue' ? (row.issue_title || '') : null,
      research_id: row.scope_type === 'research' ? row.research_id : null,
      research_title: row.scope_type === 'research' ? (row.research_title || '') : null,
      scope_type: row.scope_type,
      last_active: row.last_active,
      model: row.model,
      fragments: frags,
    });
    if (results.length >= limit) break;
  }

  res.json({
    query: q,
    range: rangeKey,
    total: results.length,
    scanned_sessions: scannedCount,
    candidate_sessions: rows.length,
    truncated: truncatedByBudget,
    results,
  });
});

export = router;
