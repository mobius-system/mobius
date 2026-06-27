import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as watcher from './jsonl-watcher';

const DEFAULT_MAX_LINES = 10000;
const DEFAULT_HISTORY_TAIL = 200;
const MAX_HISTORY_FETCH = 5000;
const MOBIUS_JSONL_VERSION = 1;

function mobiusJsonlPathOf(jsonlPath: string | null | undefined): string | null {
  if (!jsonlPath || typeof jsonlPath !== 'string') return null;
  return jsonlPath.endsWith('.jsonl')
    ? jsonlPath.slice(0, -'.jsonl'.length) + '.mobius.jsonl'
    : jsonlPath + '.mobius.jsonl';
}

function fileSize(filePath: string | null | undefined): number {
  if (!filePath) return 0;
  try { return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0; }
  catch { return 0; }
}

function parseTimestampMs(entry: any): number | null {
  const candidates = [
    entry?.timestamp,
    entry?.created_at,
    entry?.payload?.timestamp,
    entry?.message?.created_at,
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const ms = new Date(raw).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function sourceOrder(source: string): number {
  return source === 'primary' ? 0 : 1;
}

interface MergeRecord {
  entry: any;
  index: number;
  source: string;
}

function compareRecords(a: MergeRecord, b: MergeRecord): number {
  const at = parseTimestampMs(a.entry);
  const bt = parseTimestampMs(b.entry);
  if (at != null && bt != null && at !== bt) return at - bt;
  if (at == null && bt != null) return -1;
  if (at != null && bt == null) return 1;
  const so = sourceOrder(a.source) - sourceOrder(b.source);
  if (so !== 0) return so;
  return a.index - b.index;
}

interface ReadHistoryOpts {
  maxLines?: any;
  tailCount?: any;
  [key: string]: any;
}

function readMergedJsonlHistory(jsonlPath: string | null | undefined, opts: ReadHistoryOpts = {}): any {
  const maxLines = Math.max(0, Math.floor(Number.isFinite(Number(opts.maxLines)) ? Number(opts.maxLines) : DEFAULT_MAX_LINES));
  const tailCount = Math.max(0, Math.floor(Number.isFinite(Number(opts.tailCount)) ? Number(opts.tailCount) : 0));
  const mobiusPath = mobiusJsonlPathOf(jsonlPath);
  // tailCount > 0 时, 单侧读取也按 tailCount 截尾 — 合并后再二次截尾即可,
  // 不必双侧都读满 maxLines 浪费 parse.
  const sideOpts = { ...opts, maxLines, tailCount };
  const primary = watcher.readAll(jsonlPath as any, sideOpts);
  const mobius = mobiusPath ? watcher.readAll(mobiusPath, sideOpts) : { entries: [], total: 0, totalApproximate: false, truncated: false, size: 0 };
  const records: MergeRecord[] = [];

  primary.entries.forEach((entry: any, index: number) => records.push({ entry, index, source: 'primary' }));
  mobius.entries.forEach((entry: any, index: number) => records.push({ entry, index, source: 'mobius' }));
  records.sort(compareRecords);

  const total = (primary.total || 0) + (mobius.total || 0);
  const effectiveLimit = tailCount > 0
    ? (maxLines > 0 ? Math.min(maxLines, tailCount) : tailCount)
    : maxLines;
  const entries = (effectiveLimit > 0 ? records.slice(-effectiveLimit) : []).map((r) => r.entry);
  return {
    entries,
    total,
    totalApproximate: !!primary.totalApproximate || !!mobius.totalApproximate,
    truncated: total > entries.length || !!primary.truncated || !!mobius.truncated,
    sentinel: {
      primary: primary.size || 0,
      mobius: mobius.size || 0,
    },
    paths: {
      primary: jsonlPath || null,
      mobius: mobiusPath || null,
    },
  };
}

/**
 * 仅扫字节数 \n, 不 parse — count-then-tail 的 count 阶段, 给 SSE jsonl_meta / REST 标题用.
 * 同时返回 primary + mobius 两侧字节大小, 方便上层 normalize sentinel.
 * @param jsonlPath
 * @param [opts] 透传 jsonl-watcher.countLines 的 opts
 * @returns {{ total: number, primary: number, mobius: number, totalApproximate: boolean, sizes: {primary:number, mobius:number}, paths: {primary:string|null, mobius:string|null} }}
 */
function countMergedJsonl(jsonlPath: string | null | undefined, opts: any = {}): any {
  const mobiusPath = mobiusJsonlPathOf(jsonlPath);
  const p = watcher.countLines(jsonlPath as any, opts);
  const m = mobiusPath ? watcher.countLines(mobiusPath, opts) : { count: 0, size: 0, approximate: false };
  return {
    total: (p.count || 0) + (m.count || 0),
    primary: p.count || 0,
    mobius: m.count || 0,
    totalApproximate: !!p.approximate || !!m.approximate,
    sizes: {
      primary: p.size || 0,
      mobius: m.size || 0,
    },
    paths: {
      primary: jsonlPath || null,
      mobius: mobiusPath || null,
    },
  };
}

interface ReadSliceOpts {
  fromIndex?: any;
  limit?: any;
  maxBytes?: any;
  [key: string]: any;
}

/**
 * 取合并 jsonl 历史的 [fromIndex, fromIndex + limit). 用于前端 "展开全部" 按需补齐.
 * 实现: 双侧各自全文件 parse, merge 后按 sort key 取窗口. 仅在用户主动点 "展开全部"
 * 时触发, 不在 SSE 首包路径上, 因此可以接受 O(total) 解析.
 * @param jsonlPath
 * @param [opts]
 * @param [opts.fromIndex=0]
 * @param [opts.limit=DEFAULT_HISTORY_TAIL]
 * @param [opts.maxBytes] 透传 readSlice 的安全上限
 * @returns {{ entries: object[], total: number, from: number, returned: number, exceeded: boolean }}
 */
function readMergedJsonlSlice(jsonlPath: string | null | undefined, opts: ReadSliceOpts = {}): any {
  const fromIndex = Math.max(0, Math.floor(Number.isFinite(Number(opts.fromIndex)) ? Number(opts.fromIndex) : 0));
  const limit = Math.max(0, Math.min(
    MAX_HISTORY_FETCH,
    Math.floor(Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : DEFAULT_HISTORY_TAIL),
  ));
  const mobiusPath = mobiusJsonlPathOf(jsonlPath);

  // 单侧拿全文件 (上限受 readSlice.maxBytes 保护). 这里 limit 给一个很大的值,
  // 因为我们需要 merge 后再取窗口, 不能只取单侧前 N 行.
  const sliceOpts = { fromIndex: 0, limit: Number.MAX_SAFE_INTEGER, ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) };
  const p = watcher.readSlice(jsonlPath as any, sliceOpts);
  const m = mobiusPath ? watcher.readSlice(mobiusPath, sliceOpts) : { entries: [], total: 0, exceeded: false };
  if (p.exceeded || m.exceeded) {
    return { entries: [], total: (p.total || 0) + (m.total || 0), from: fromIndex, returned: 0, exceeded: true };
  }
  const records: MergeRecord[] = [];
  p.entries.forEach((entry: any, index: number) => records.push({ entry, index, source: 'primary' }));
  m.entries.forEach((entry: any, index: number) => records.push({ entry, index, source: 'mobius' }));
  records.sort(compareRecords);
  const total = records.length;
  const slice = limit > 0 ? records.slice(fromIndex, fromIndex + limit) : [];
  return {
    entries: slice.map((r) => r.entry),
    total,
    from: fromIndex,
    returned: slice.length,
    exceeded: false,
  };
}

function currentMergedJsonlSentinel(jsonlPath: string | null | undefined): { primary: number; mobius: number } {
  const mobiusPath = mobiusJsonlPathOf(jsonlPath);
  return {
    primary: fileSize(jsonlPath),
    mobius: fileSize(mobiusPath),
  };
}

function normalizeSentinel(sentinel: any, jsonlPath: string | null | undefined): { primary: number; mobius: number } {
  const current = currentMergedJsonlSentinel(jsonlPath);
  if (typeof sentinel === 'number') {
    return {
      primary: Math.max(0, sentinel),
      mobius: sentinel === 0 ? 0 : current.mobius,
    };
  }
  if (!sentinel || typeof sentinel !== 'object') return current;
  const primary = Number(sentinel.primary ?? sentinel.primarySize ?? sentinel.size);
  const mobius = Number(sentinel.mobius ?? sentinel.mobiusSize);
  return {
    primary: Number.isFinite(primary) && primary >= 0 ? primary : current.primary,
    mobius: Number.isFinite(mobius) && mobius >= 0 ? mobius : current.mobius,
  };
}

interface WatchMergedJsonlArgs {
  path: string | null | undefined;
  startSentinel?: any;
  onEntry: (raw: string, lineNo: number, source: string) => void;
  onPrimaryEntry?: (raw: string, lineNo: number) => void;
  onError?: (err: any) => void;
}

function watchMergedJsonl({ path: jsonlPath, startSentinel, onEntry, onPrimaryEntry, onError = () => {} }: WatchMergedJsonlArgs): any {
  if (!jsonlPath || typeof onEntry !== 'function') {
    throw new Error('watchMergedJsonl 需要 { path, onEntry }');
  }
  const mobiusPath = mobiusJsonlPathOf(jsonlPath);
  const offsets = normalizeSentinel(startSentinel, jsonlPath);
  const watchers: any[] = [];

  watchers.push(watcher.watch({
    path: jsonlPath,
    startOffset: offsets.primary,
    onEntry: (raw: string, lineNo: number) => {
      try { if (typeof onPrimaryEntry === 'function') onPrimaryEntry(raw, lineNo); } catch (e) { onError(e); }
      onEntry(raw, lineNo, 'primary');
    },
    onError,
  }));

  if (mobiusPath) {
    watchers.push(watcher.watch({
      path: mobiusPath,
      startOffset: offsets.mobius,
      onEntry: (raw: string, lineNo: number) => onEntry(raw, lineNo, 'mobius'),
      onError,
    }));
  }

  return {
    stop() {
      for (const w of watchers) {
        try { w.stop(); } catch {}
      }
    },
    state() {
      return {
        primary: watchers[0]?.state?.() || null,
        mobius: watchers[1]?.state?.() || null,
      }
    },
  };
}

function promptKind(content: any, explicitKind?: string): string {
  if (explicitKind) return explicitKind;
  const text = String(content || '').trim();
  return text.startsWith('/compact') ? 'compact' : 'user_input';
}

interface BuildMobiusUserEntryArgs {
  sessionId?: any;
  agentSessionId?: any;
  cwd?: any;
  backendName?: any;
  content?: any;
  inputText?: any;
  requestId?: any;
  turnNumber?: any;
  source?: any;
  userId?: any;
  kind?: string;
  timestamp?: any;
}

function buildMobiusUserEntry({
  sessionId,
  agentSessionId,
  cwd,
  backendName,
  content,
  inputText,
  requestId,
  turnNumber,
  source,
  userId,
  kind,
  timestamp,
}: BuildMobiusUserEntryArgs): any {
  const ts = timestamp || new Date().toISOString();
  const body = String(content || '');
  const typed = inputText == null ? null : String(inputText);
  const resolvedKind = promptKind(body, kind);
  const promptId = crypto.randomUUID();
  const entry = {
    parentUuid: null,
    isSidechain: false,
    promptId,
    type: 'user',
    message: {
      role: 'user',
      content: body,
    },
    uuid: crypto.randomUUID(),
    timestamp: ts,
    permissionMode: 'bypassPermissions',
    userType: 'external',
    entrypoint: 'mobius',
    cwd: cwd || null,
    sessionId: agentSessionId || sessionId,
    version: `mobius-jsonl/${MOBIUS_JSONL_VERSION}`,
    mobius: {
      schema_version: MOBIUS_JSONL_VERSION,
      source: source || 'session.send',
      kind: resolvedKind,
      backend: backendName || null,
      session_id: sessionId || null,
      agent_session_id: agentSessionId || null,
      user_id: userId || null,
      request_id: requestId || null,
      turn_number: Number.isFinite(Number(turnNumber)) ? Number(turnNumber) : null,
      input_text: typed,
      content_length: body.length,
      captured_at: ts,
    },
  };
  return entry;
}

function appendMobiusPromptEntry({ jsonlPath, ...entryOpts }: BuildMobiusUserEntryArgs & { jsonlPath: any }): { filePath: string; entry: any } {
  const filePath = mobiusJsonlPathOf(jsonlPath);
  if (!filePath) throw new Error('缺少原始 JSONL 路径, 无法写入 mobius JSONL');
  const entry = buildMobiusUserEntry(entryOpts);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  return { filePath, entry };
}

interface BuildMobiusErrorEntryArgs {
  sessionId?: any;
  agentSessionId?: any;
  cwd?: any;
  backendName?: any;
  error?: any;
}

function buildMobiusErrorEntry({
  sessionId,
  agentSessionId,
  cwd,
  backendName,
  error,
}: BuildMobiusErrorEntryArgs): any {
  const ts = error?.capturedAt || new Date().toISOString();
  const message = String(error?.message || '').slice(0, 4000);
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'error',
    message: {
      role: 'error',
      content: message,
    },
    uuid: crypto.randomUUID(),
    timestamp: ts,
    permissionMode: 'bypassPermissions',
    userType: 'external',
    entrypoint: 'mobius',
    cwd: cwd || null,
    sessionId: agentSessionId || sessionId,
    version: `mobius-jsonl/${MOBIUS_JSONL_VERSION}`,
    mobius: {
      schema_version: MOBIUS_JSONL_VERSION,
      source: 'agent.error_scan',
      kind: 'recent_error',
      backend: backendName || null,
      session_id: sessionId || null,
      agent_session_id: agentSessionId || null,
      raw_line: error?.rawLine || null,
      captured_at: ts,
    },
  };
}

function appendMobiusErrorEntry({ jsonlPath, ...entryOpts }: BuildMobiusErrorEntryArgs & { jsonlPath: any }): { filePath: string; entry: any } {
  const filePath = mobiusJsonlPathOf(jsonlPath);
  if (!filePath) throw new Error('缺少原始 JSONL 路径, 无法写入 mobius JSONL');
  const entry = buildMobiusErrorEntry(entryOpts);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  return { filePath, entry };
}

// 返回 .mobius.jsonl 末条 entry 的 type; 文件不存在/为空/解析失败 → null.
// 用于 getRecentError 触发条件的去重判断 (末条已经是 error 就不再重复扫描写入).
function readLastMobiusEntryType(jsonlPath: string | null | undefined): string | null {
  const filePath = mobiusJsonlPathOf(jsonlPath);
  if (!filePath) return null;
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.size) return null;
  // 只读末 8KB 找最后一行; 单条 entry 通常远小于这个大小.
  const len = Math.min(stat.size, 8 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, buf, 0, len, stat.size - len); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e && typeof e === 'object' && typeof e.type === 'string') return e.type;
    } catch {}
  }
  return null;
}

export {
  mobiusJsonlPathOf,
  readMergedJsonlHistory,
  readMergedJsonlSlice,
  countMergedJsonl,
  currentMergedJsonlSentinel,
  watchMergedJsonl,
  buildMobiusUserEntry,
  appendMobiusPromptEntry,
  buildMobiusErrorEntry,
  appendMobiusErrorEntry,
  readLastMobiusEntryType,
  DEFAULT_HISTORY_TAIL,
  MAX_HISTORY_FETCH,
};
