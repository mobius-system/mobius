import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as watcher from './jsonl-watcher';
import {
  applyTaskCalls,
  buildTaskStateFromJsonl,
  extractTaskReminderSnapshot,
  extractTaskToolCalls,
  taskRecordsSorted,
  taskSnapshotSignature,
  type TaskRecord,
} from './task-state-reducer';

const DEFAULT_MAX_LINES = 10000;
const DEFAULT_HISTORY_TAIL = 200;
// 特殊规则: .mobius.jsonl 轨不受 DEFAULT_HISTORY_TAIL(200) 限制, 尾部窗口阈值提高到 600。
// mobius 轨条目稀疏 (每轮 1 条 user_input + 少量 task_state), 而主轨条目高密度 (每轮可达
// 上百条工具调用) — 时间上更早但仍有价值的用户输入卡会被主轨流量挤出 200 条窗口,
// 前端轮次分组随之丢失更早的轮。600 保证合并后更早的用户输入卡仍存活。
const MOBIUS_HISTORY_TAIL = 600;
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
  // tailCount > 0 时, 单侧读取也按 tailCount 截尾 — 合并后不再二次截尾 (见下),
  // 不必双侧都读满 maxLines 浪费 parse.
  const sideOpts = { ...opts, maxLines, tailCount };
  const primary = watcher.readAll(jsonlPath as any, sideOpts);
  // mobius 轨特殊规则: 不受调用方 tailCount(默认 200) 限制, 阈值提高到 MOBIUS_HISTORY_TAIL.
  const mobiusTailCount = tailCount > 0 ? Math.max(tailCount, MOBIUS_HISTORY_TAIL) : 0;
  const mobius = mobiusPath
    ? watcher.readAll(mobiusPath, { ...sideOpts, tailCount: mobiusTailCount })
    : { entries: [], total: 0, totalApproximate: false, truncated: false, size: 0 };
  const records: MergeRecord[] = [];

  primary.entries.forEach((entry: any, index: number) => records.push({ entry, index, source: 'primary' }));
  mobius.entries.forEach((entry: any, index: number) => records.push({ entry, index, source: 'mobius' }));
  records.sort(compareRecords);

  const total = (primary.total || 0) + (mobius.total || 0);
  // tailCount 模式 (SSE 首包) 下不做全局再截尾: 两侧已按各自窗口截好
  // (primary ≤ tailCount, mobius ≤ MOBIUS_HISTORY_TAIL, 合计 ≤ 800), 全局再砍会把
  // 时间上更早的 mobius 用户输入卡重新挤出去, 违背特殊规则。
  // full 模式 (tailCount=0) 保留旧行为: 全局截到 maxLines。
  const entries = (tailCount > 0
    ? records
    : (maxLines > 0 ? records.slice(-maxLines) : records)
  ).map((r) => r.entry);
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

// ── 超长会话按需加载: 伴生轨全量骨架 + 主轨时间戳切片 ────────────────────────

// 伴生轨全量 (骨架): 每轮 1 条 user_input + 少量 task_state/error, 体量极小,
// 一次全量返回给前端做轮次索引; 主轨明细等展开轮次时再按 ts 切片取.
// 缓存: 按 (path, 文件大小) 失效的 LRU (≤32 会话) — 反复点"加载全部"/切换会话回来不重读盘.
const SPINE_CACHE_LIMIT = 32;
const spineCache = new Map<string, { size: number; spine: any }>();
function readMobiusSpine(jsonlPath: string | null | undefined, opts: any = {}): any {
  const mobiusPath = mobiusJsonlPathOf(jsonlPath);
  if (!mobiusPath || !fs.existsSync(mobiusPath)) {
    return { entries: [], total: 0, truncated: false };
  }
  const size = fileSize(mobiusPath);
  const hit = spineCache.get(mobiusPath);
  if (hit && hit.size === size) {
    // LRU 触碰: 删了重插到尾部
    spineCache.delete(mobiusPath);
    spineCache.set(mobiusPath, hit);
    return hit.spine;
  }
  const maxLines = positiveNum(opts.maxLines, 50000);
  const r = watcher.readAll(mobiusPath, { maxLines, tailCount: 0 });
  const spine = { entries: r.entries, total: r.total || r.entries.length, truncated: !!r.truncated };
  spineCache.delete(mobiusPath);
  spineCache.set(mobiusPath, { size, spine });
  while (spineCache.size > SPINE_CACHE_LIMIT) {
    spineCache.delete(spineCache.keys().next().value as string);
  }
  return spine;
}

function positiveNum(v: any, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const TS_SLICE_MAX_ENTRIES = 2000;
const TS_SLICE_PROBE_CHUNK = 64 * 1024;

// 读取 fd 上"包含字节 pos"的那一行; 返回 {start, end, text}。
// start=行首字节, end=换行之后一字节 (下一行起点); pos 越界返回 null。
// 注意必须是"包含"而非"pos 之后的下一行": 二分探针落在行中间时, 答案行可能正是这一行,
// 跳到下一行会让二分漏看该行并原地踏步 (实测死循环)。
function readLineContaining(fd: number, size: number, pos: number): { start: number; end: number; text: string } | null {
  if (pos < 0 || pos >= size) return null;
  let start = 0;
  if (pos > 0) {
    const prevNl = lastNewlineBefore(fd, pos);   // pos 前面最近的 \n (pos 恰为行首时就是 pos-1)
    start = prevNl < 0 ? 0 : prevNl + 1;
  }
  const nl = readChunkUntil(fd, size, start, (b) => b.indexOf(10));
  const end = nl < 0 ? size : nl + 1;
  const buf = Buffer.alloc(end - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  return { start, end, text: buf.toString('utf8').replace(/\n$/, '') };
}

// 在 [0, pos) 内找最后一个 \n 的字节位置; 没有返回 -1 (说明 pos 在文件第一行内)。
function lastNewlineBefore(fd: number, pos: number): number {
  let hi = pos;   // 排他上界
  while (hi > 0) {
    const lo = Math.max(0, hi - TS_SLICE_PROBE_CHUNK);
    const len = hi - lo;
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, lo);
    if (n <= 0) return -1;
    const idx = (n === len ? buf : buf.subarray(0, n)).lastIndexOf(10);
    if (idx >= 0) return lo + idx;
    hi = lo;
  }
  return -1;
}

// 从 from 字节起找第一个满足 pred(buffer) 的字节位置 (用于找 \n), 跨 chunk 续读; 找不到返回 -1。
function readChunkUntil(fd: number, size: number, from: number, pred: (b: Buffer) => number): number {
  let pos = from;
  while (pos < size) {
    const len = Math.min(TS_SLICE_PROBE_CHUNK, size - pos);
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, pos);
    if (n <= 0) return -1;
    const idx = pred(n === len ? buf : buf.subarray(0, n));
    if (idx >= 0) return pos + idx;
    pos += n;
  }
  return -1;
}

// 二分: 返回第一条 ts >= targetMs 的行的起始字节; 全部小于 targetMs 则返回 size。
// 前提: 行按写入顺序追加, ts 单调不减 (claude-code/codex 均满足)。
function tsLowerBoundByte(fd: number, size: number, targetMs: number): number {
  let lo = 0;
  let hi = size;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const line = readLineContaining(fd, size, mid);
    if (!line) { hi = mid; continue; }
    const ms = parseTimestampMs(safeParseJson(line.text));
    if (ms == null || ms < targetMs) lo = Math.max(mid + 1, line.end);
    else hi = line.start;
  }
  return lo;
}

function safeParseJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

// 主轨时间戳切片 [fromTs, toTs): 字节二分定界 + 区间顺序读取, 不整文件 parse。
// 支持游标续拉: fromByte (上页 next_from_byte) 优先于 fromTs。
// 单调性被破坏时 (lo > hi) 回退整文件过滤 (mode:'scan'), 保证正确性。
function readPrimaryTsSlice(jsonlPath: string | null | undefined, opts: {
  fromTs?: any; toTs?: any; fromByte?: any; limit?: any; forceScan?: boolean;
} = {}): any {
  const maxEntries = Math.max(1, Math.min(TS_SLICE_MAX_ENTRIES, Math.floor(Number(opts.limit) || TS_SLICE_MAX_ENTRIES)));
  const fromMs = parseTsParam(opts.fromTs);
  const toMs = parseTsParam(opts.toTs);
  const fromByte = Number.isFinite(Number(opts.fromByte)) && Number(opts.fromByte) > 0 ? Math.floor(Number(opts.fromByte)) : null;
  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    return { entries: [], returned: 0, has_more: false, mode: 'bisect' };
  }
  const size = fileSize(jsonlPath);
  let fd: number | null = null;
  const parsed: any[] = [];
  let nextFromByte: number | null = null;
  let mode = 'bisect';
  try {
    fd = fs.openSync(jsonlPath, 'r');
    let loByte: number;
    let hiByte: number;
    if (opts.forceScan) {
      loByte = 1; hiByte = 0;   // 直接触发下方 scan 回退
    } else if (fromByte != null) {
      loByte = Math.min(fromByte, size);
      hiByte = (toMs != null && Number.isFinite(toMs)) ? tsLowerBoundByte(fd, size, toMs) : size;
    } else {
      if (fromMs == null && toMs == null) {
        return { entries: [], returned: 0, has_more: false, mode, error: '缺少 from_ts 或 from_byte' };
      }
      loByte = fromMs != null && Number.isFinite(fromMs) ? tsLowerBoundByte(fd, size, fromMs) : 0;
      hiByte = toMs != null && Number.isFinite(toMs) ? tsLowerBoundByte(fd, size, toMs) : size;
    }
    if (loByte > hiByte) {
      if (fromByte != null) {
        // 游标已越过 to_ts 边界: 本窗口读完, 非异常
        return { entries: [], returned: 0, has_more: false, mode, next_from_byte: null };
      }
      // ts 非单调 → 二分结果不可信, 回退整读过滤 (小文件安全上限内)
      mode = 'scan';
      const whole = watcher.readSlice(jsonlPath, { fromIndex: 0, limit: Number.MAX_SAFE_INTEGER });
      const filtered = (whole.entries || []).filter((e: any) => {
        const ms = parseTimestampMs(e);
        if (fromMs != null && Number.isFinite(fromMs) && (ms == null || ms < fromMs)) return false;
        if (toMs != null && Number.isFinite(toMs) && (ms != null && ms >= toMs)) return false;
        return true;
      });
      const page = filtered.slice(0, maxEntries);
      return { entries: page, returned: page.length, has_more: filtered.length > page.length, mode, total_in_window: filtered.length };
    }
    // 顺序读 [loByte, hiByte), 行级 parse, 满 maxEntries 停
    let pos = loByte;
    while (pos < hiByte) {
      const line = readLineContaining(fd, size, pos);
      if (!line) break;
      if (line.start >= hiByte) break;
      const entry = safeParseJson(line.text);
      if (entry) parsed.push(entry);
      pos = line.end;
      if (parsed.length >= maxEntries) {
        nextFromByte = pos < hiByte ? pos : null;
        break;
      }
    }
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
  }
  const hasMore = nextFromByte != null;
  const nextFromTs = hasMore && parsed.length > 0
    ? ((parsed[parsed.length - 1]?.timestamp as string) || null)
    : null;
  return {
    entries: parsed,
    returned: parsed.length,
    has_more: hasMore,
    next_from_byte: nextFromByte,
    next_from_ts: nextFromTs,
    mode,
  };
}

function parseTsParam(v: any): number | null {
  if (v == null || v === '') return null;
  const ms = new Date(String(v)).getTime();
  return Number.isFinite(ms) ? ms : null;
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
  // task_state 快照注入开关 (默认开): 见到 TaskCreate/TaskUpdate 工具调用时把累积任务表
  // 以 task_state 条目追加到 .mobius.jsonl, 前端据此渲染原生卡的计划卡片视图。
  taskState?: boolean;
}

function watchMergedJsonl({ path: jsonlPath, startSentinel, onEntry, onPrimaryEntry, onError = () => {}, taskState = true }: WatchMergedJsonlArgs): any {
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
      if (taskState) {
        try {
          const snapshot = taskAccumulator.absorbPrimaryEntry(jsonlPath, raw);
          if (snapshot) appendMobiusTaskStateEntry(jsonlPath, snapshot);
        } catch (e) {
          console.warn(`[task-state-reducer] absorb failed: ${(e as Error)?.message || e}`);
        }
      }
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


function appendMobiusCoreEntry({ jsonlPath, ...entryOpts }: BuildMobiusUserEntryArgs & { jsonlPath: any }): { filePath: string; entry: any } {
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

// ── task_state 快照条目 (TaskCreate/TaskUpdate 工具调用的累积状态) ────────
// timestamp 取触发它的原生条目时间戳 → compareRecords 的 tie-break (primary 优先)
// 保证快照在合并序列里紧跟原生卡, 永远落在同一个前端尾部窗口内。
function buildMobiusTaskStateEntry(args: {
  anchorEntry: any;
  anchorToolUseId?: string | null;
  tasks: TaskRecord[];
}): any {
  const anchor = args.anchorEntry || {};
  const ts = typeof anchor.timestamp === 'string' && anchor.timestamp ? anchor.timestamp : new Date().toISOString();
  const tasks = taskRecordsSorted(new Map(args.tasks.map((t) => [t.id, t])));
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'task_state',
    message: { role: 'user', content: '' },
    uuid: crypto.randomUUID(),
    timestamp: ts,
    permissionMode: 'bypassPermissions',
    userType: 'external',
    entrypoint: 'mobius',
    cwd: typeof anchor.cwd === 'string' ? anchor.cwd : null,
    sessionId: anchor.sessionId || null,
    version: `mobius-jsonl/${MOBIUS_JSONL_VERSION}`,
    mobius: {
      schema_version: MOBIUS_JSONL_VERSION,
      source: 'task.reducer',
      kind: 'task_state',
      anchor_uuid: typeof anchor.uuid === 'string' && anchor.uuid ? anchor.uuid : null,
      anchor_tool_use_id: args.anchorToolUseId || null,
      tasks,
      captured_at: new Date().toISOString(),
    },
  };
}

// per-session 任务累积器 (懒初始化 + 去重签名)。每个 jsonlPath 一个实例,
// 由 watchMergedJsonl / readMergedJsonlHistory 的调用方持有; 后端重启后
// 首个任务事件触发全量回放重建。
class TaskStateAccumulator {
  private states = new Map<string, { state: Map<string, TaskRecord>; lastSig: string; replayed: boolean }>()

  private ensure(jsonlPath: string): { state: Map<string, TaskRecord>; lastSig: string; replayed: boolean } {
    let slot = this.states.get(jsonlPath)
    if (!slot) {
      slot = { state: buildTaskStateFromJsonl(jsonlPath), lastSig: '', replayed: true }
      this.states.set(jsonlPath, slot)
    }
    return slot
  }

  // 处理一条 primary 新 entry。返回需要追加到 sidecar 的快照 entry (无则 null)。
  absorbPrimaryEntry(jsonlPath: string, rawLine: string): any | null {
    let entry: any
    try { entry = JSON.parse(rawLine) } catch { return null }

    const reminder = extractTaskReminderSnapshot(entry)
    if (reminder) {
      const slot = this.ensure(jsonlPath)
      slot.state.clear()
      for (const task of reminder) slot.state.set(task.id, task)
      slot.lastSig = ''
      return null // task_reminder 本身已渲染为计划卡, 快照只更新累积表
    }

    const calls = extractTaskToolCalls(entry)
    if (calls.length === 0) return null

    const slot = this.ensure(jsonlPath)
    // 懒初始化的回放已吸收当前行 (watcher 触发时它已落盘) → 只应用一次。
    if (!slot.replayed) applyTaskCalls(slot.state, calls)
    slot.replayed = false

    const tasks = taskRecordsSorted(slot.state)
    const anchorUuid = typeof entry?.uuid === 'string' ? entry.uuid : null
    const sig = taskSnapshotSignature(anchorUuid, tasks)
    if (!anchorUuid || sig === slot.lastSig) return null
    slot.lastSig = sig
    return buildMobiusTaskStateEntry({
      anchorEntry: entry,
      anchorToolUseId: calls[0]?.toolUseId || null,
      tasks,
    })
  }
}

const taskAccumulator = new TaskStateAccumulator()

function appendMobiusTaskStateEntry(jsonlPath: string, entry: any): void {
  const filePath = mobiusJsonlPathOf(jsonlPath)
  if (!filePath) return
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n')
  } catch (e) {
    console.warn(`[task-state-reducer] sidecar append failed: ${(e as Error)?.message || e}`)
  }
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
  readMobiusSpine,
  readPrimaryTsSlice,
  countMergedJsonl,
  currentMergedJsonlSentinel,
  watchMergedJsonl,
  buildMobiusUserEntry,
  appendMobiusCoreEntry,
  buildMobiusErrorEntry,
  appendMobiusErrorEntry,
  readLastMobiusEntryType,
  DEFAULT_HISTORY_TAIL,
  MOBIUS_HISTORY_TAIL,
  MAX_HISTORY_FETCH,
};
