/**
 * mobius-agent-history.ts — 会话历史存储 (agent-history-store.db) 的唯一入口.
 *
 * 取代旧 services/mobius-jsonl.ts (双轨 jsonl 读写全家). 变化:
 *  - .mobius.jsonl 不再被写入: 原四类写入 (user_input/final_prompt、task_state 快照、
 *    recent_error、compact) 全部直写本库; 旧文件冻结为一次性迁移源 (backfill 读一次).
 *  - 分组规则 "写入即开组": 只有发送链路写入的 user_input/compact 卡开新轮
 *    (排除 Blackboard / running-flag 两种系统提醒串), 其余一切条目 (原生轨全部、
 *    task_state、recent_error) 归当前组 (最新组).
 *  - 更新模型 "用前必同步": syncSession 从书签 (已读字节) 读原生 jsonl 到 EOF;
 *    groups/entries API、SSE 订阅、直写、错误扫描的开头都调它.
 *    jsonl 只 append → 书签只前进 → 永不重复读, 天然幂等.
 *
 * 铁律: 数据层只认 id + version; 组元数据创建后不可变 (entry_count == version).
 */
import Database from 'better-sqlite3';
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
import { DB_PATH } from '../config';
// [legacy-migration] 懒迁移叶子模块 (冻结 .mobius.jsonl → 本库).
// 全部会话迁移完成后: 删除该文件 + 本文件里 grep [legacy-migration] 的调用点.
import { loadLegacyBackfill, type LegacyBackfill } from './mobius-agent-history-legacy';

// 系统提醒排除串: 这两类提醒走发送链路写入 (套 user 壳) 但不是人类提问, 不开新轮.
// 文案唯一事实源在前端 jsonl-round-helpers.ts 的同名常量, 改动须两处同步.
const BLACKBOARD_MARKER = '[Research Blackboard 更新提醒]';
const RUNNING_FLAG_MARKER = 'It seems that the running flag is still present';

const MOBIUS_ENTRY_SCHEMA_VERSION = 1;
// backfill 一次事务的最大条目数: 控制长事务对事件循环的占用.
const SCAN_CHUNK_ENTRIES = 5000;

const STORE_PATH = process.env.MOBIUS_AGENT_HISTORY_STORE_PATH
  || path.join(path.dirname(DB_PATH), 'agent-history-store.db');

// ── 连接与表 ─────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;
let _stmts: ReturnType<typeof buildStatements> | null = null;

function buildStatements(db: Database.Database) {
  return {
    getState: db.prepare('SELECT * FROM ingest_state WHERE session_id = ?'),
    insertState: db.prepare('INSERT INTO ingest_state (session_id, primary_path) VALUES (?, ?)'),
    insertRound: db.prepare(`INSERT INTO rounds (session_id, group_seq, round_opener_uuid, round_opener_ts, user_summary, entry_count, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`),
    getRound: db.prepare('SELECT * FROM rounds WHERE session_id = ? AND group_seq = ?'),
    updateRoundCount: db.prepare('UPDATE rounds SET entry_count = ? WHERE session_id = ? AND group_seq = ?'),
    listRounds: db.prepare('SELECT * FROM rounds WHERE session_id = ? ORDER BY group_seq ASC'),
    insertEntry: db.prepare(`INSERT OR IGNORE INTO entries (session_id, uuid, seq, group_seq, seq_in_group, round_opener, origin, ts, json)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateEntryGroup: db.prepare('UPDATE entries SET group_seq = ?, seq_in_group = ? WHERE session_id = ? AND uuid = ?'),
    listGroupEntries: db.prepare('SELECT json, round_opener FROM entries WHERE session_id = ? AND group_seq = ? ORDER BY seq_in_group ASC'),
    lastEntry: db.prepare('SELECT json FROM entries WHERE session_id = ? ORDER BY seq DESC LIMIT 1'),
    deleteState: db.prepare('DELETE FROM ingest_state WHERE session_id = ?'),
    deleteRounds: db.prepare('DELETE FROM rounds WHERE session_id = ?'),
    deleteEntries: db.prepare('DELETE FROM entries WHERE session_id = ?'),
  };
}

function openStore(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  _db = new Database(STORE_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS ingest_state (
      session_id            TEXT PRIMARY KEY,
      primary_path          TEXT NOT NULL,
      primary_read_bytes    INTEGER NOT NULL DEFAULT 0,
      legacy_read_bytes     INTEGER NOT NULL DEFAULT 0,
      session_version       INTEGER NOT NULL DEFAULT 0,
      last_group_seq        INTEGER NOT NULL DEFAULT 0,
      next_seq              INTEGER NOT NULL DEFAULT 1,
      pending_round_openers TEXT NOT NULL DEFAULT '[]',
      error                 TEXT,
      last_synced_at        TEXT
    );
    CREATE TABLE IF NOT EXISTS rounds (
      session_id        TEXT NOT NULL,
      group_seq         INTEGER NOT NULL,
      round_opener_uuid TEXT,
      round_opener_ts   INTEGER,
      user_summary      TEXT NOT NULL DEFAULT '',
      entry_count       INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT,
      PRIMARY KEY (session_id, group_seq)
    );
    CREATE TABLE IF NOT EXISTS entries (
      session_id   TEXT NOT NULL,
      uuid         TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      group_seq    INTEGER,
      seq_in_group INTEGER,
      round_opener INTEGER NOT NULL DEFAULT 0,
      origin       TEXT NOT NULL,
      ts           INTEGER,
      json         TEXT NOT NULL,
      PRIMARY KEY (session_id, uuid)
    );
    CREATE INDEX IF NOT EXISTS idx_entries_group ON entries (session_id, group_seq, seq_in_group);
  `);
  _stmts = buildStatements(_db);
  return _db;
}

function S() {
  openStore();
  return _stmts!;
}

// ── 小工具 ───────────────────────────────────────────────────────────────

function parseTimestampMs(entry: any): number | null {
  const candidates = [entry?.timestamp, entry?.created_at, entry?.payload?.timestamp, entry?.message?.created_at];
  for (const raw of candidates) {
    if (!raw) continue;
    const ms = new Date(raw).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function safeParseJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

function nowIso(): string {
  return new Date().toISOString();
}

// 组元数据摘要: 开组时刻算好, 之后永不变.
function summarizeUserText(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > 80 ? `${t.slice(0, 80)}…` : t;
}

function isExcludedSystemReminder(entry: any): boolean {
  const content = entry?.message?.content;
  const text = typeof content === 'string' ? content : '';
  if (!text) return false;
  return text.includes(BLACKBOARD_MARKER) || text.includes(RUNNING_FLAG_MARKER);
}

function entryUuidOf(entry: any, json: string): string {
  if (typeof entry?.uuid === 'string' && entry.uuid) return entry.uuid;
  // 原生行缺 uuid 时用内容哈希当稳定 id: 重扫同一条产出同 id, OR IGNORE 才能去重.
  return 'sha1:' + crypto.createHash('sha1').update(json).digest('hex');
}

// ── 条目构造 (从旧 mobius-jsonl.ts 平移; 前端按 entrypoint==='mobius' 识别) ──

function promptKind(content: any, explicitKind?: string): string {
  if (explicitKind) return explicitKind;
  const text = String(content || '').trim();
  return text.startsWith('/compact') ? 'compact' : 'user_input';
}

export interface MobiusCoreRecord {
  source?: any;
  kind?: any;
  content?: any;
  inputText?: any;
  finalPrompt?: any;
  requestId?: any;
  turnNumber?: any;
  userId?: any;
  attachments?: any;
  mentions?: any;
  timestamp?: any;
  [key: string]: any;
}

function buildMobiusUserEntry({
  sessionId, agentSessionId, cwd, backendName, content, inputText, finalPrompt,
  requestId, turnNumber, source, userId, kind, timestamp, attachments, mentions,
}: MobiusCoreRecord & {
  sessionId?: any; agentSessionId?: any; cwd?: any; backendName?: any;
}): any {
  const ts = timestamp || nowIso();
  const body = String(content || '');
  const typed = inputText == null ? null : String(inputText);
  const resolvedKind = promptKind(body, kind);
  return {
    parentUuid: null,
    isSidechain: false,
    promptId: crypto.randomUUID(),
    type: 'user',
    message: { role: 'user', content: body },
    uuid: crypto.randomUUID(),
    timestamp: ts,
    permissionMode: 'bypassPermissions',
    userType: 'external',
    entrypoint: 'mobius',
    cwd: cwd || null,
    sessionId: agentSessionId || sessionId,
    version: `mobius-jsonl/${MOBIUS_ENTRY_SCHEMA_VERSION}`,
    mobius: {
      schema_version: MOBIUS_ENTRY_SCHEMA_VERSION,
      source: source || 'session.send',
      kind: resolvedKind,
      backend: backendName || null,
      session_id: sessionId || null,
      agent_session_id: agentSessionId || null,
      user_id: userId || null,
      request_id: requestId || null,
      turn_number: Number.isFinite(Number(turnNumber)) ? Number(turnNumber) : null,
      input_text: typed,
      final_prompt: typeof finalPrompt === 'string' && finalPrompt ? finalPrompt : null,
      attachments: attachments || null,
      mentions: mentions || null,
      content_length: body.length,
      captured_at: ts,
    },
  };
}

function buildMobiusErrorEntry({
  sessionId, agentSessionId, cwd, backendName, error,
}: {
  sessionId?: any; agentSessionId?: any; cwd?: any; backendName?: any; error?: any;
}): any {
  const ts = error?.capturedAt || nowIso();
  const message = String(error?.message || '').slice(0, 4000);
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'error',
    message: { role: 'error', content: message },
    uuid: crypto.randomUUID(),
    timestamp: ts,
    permissionMode: 'bypassPermissions',
    userType: 'external',
    entrypoint: 'mobius',
    cwd: cwd || null,
    sessionId: agentSessionId || sessionId,
    version: `mobius-jsonl/${MOBIUS_ENTRY_SCHEMA_VERSION}`,
    mobius: {
      schema_version: MOBIUS_ENTRY_SCHEMA_VERSION,
      source: 'agent.error_scan',
      kind: 'recent_error',
      backend: backendName || null,
      session_id: sessionId || null,
      agent_session_id: agentSessionId || null,
      raw_line: error?.rawLine || null,
      context_fingerprint: error?.contextFingerprint || null,
      captured_at: ts,
    },
  };
}

// 旧伴生文件路径推导已移至 mobius-agent-history-deprecated.ts (deprecatedMobiusJsonlPathOf).

// ── task_state 累积器 (从旧 mobius-jsonl.ts 平移; 快照改为写库) ─────────────

class TaskStateAccumulator {
  private states = new Map<string, { state: Map<string, TaskRecord>; lastSig: string; replayed: boolean }>()

  private ensure(jsonlPath: string) {
    let slot = this.states.get(jsonlPath);
    if (!slot) {
      slot = { state: buildTaskStateFromJsonl(jsonlPath), lastSig: '', replayed: true };
      this.states.set(jsonlPath, slot);
    }
    return slot;
  }

  // 处理一条原生 entry. 返回需要落库的快照 entry (无则 null).
  absorbPrimaryEntry(jsonlPath: string, rawLine: string): any | null {
    let entry: any;
    try { entry = JSON.parse(rawLine); } catch { return null; }

    const reminder = extractTaskReminderSnapshot(entry);
    if (reminder) {
      const slot = this.ensure(jsonlPath);
      slot.state.clear();
      for (const task of reminder) slot.state.set(task.id, task);
      slot.lastSig = '';
      return null;
    }

    const calls = extractTaskToolCalls(entry);
    if (calls.length === 0) return null;

    const slot = this.ensure(jsonlPath);
    if (!slot.replayed) applyTaskCalls(slot.state, calls);
    slot.replayed = false;

    const tasks = taskRecordsSorted(slot.state);
    const anchorUuid = typeof entry?.uuid === 'string' ? entry.uuid : null;
    const sig = taskSnapshotSignature(anchorUuid, tasks);
    if (!anchorUuid || sig === slot.lastSig) return null;
    slot.lastSig = sig;
    const ts = typeof entry.timestamp === 'string' && entry.timestamp ? entry.timestamp : nowIso();
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
      cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
      sessionId: entry.sessionId || null,
      version: `mobius-jsonl/${MOBIUS_ENTRY_SCHEMA_VERSION}`,
      mobius: {
        schema_version: MOBIUS_ENTRY_SCHEMA_VERSION,
        source: 'task.reducer',
        kind: 'task_state',
        anchor_uuid: anchorUuid,
        anchor_tool_use_id: calls[0]?.toolUseId || null,
        tasks,
        captured_at: nowIso(),
      },
    };
  }
}

const taskAccumulator = new TaskStateAccumulator();

// ── SSE 订阅 (事件 = 落库结果的投影; 没有订阅者就不发) ─────────────────────

export interface HistoryStoreEvent {
  type: 'group_created' | 'entries' | 'pending_opener';
  payload: {
    group?: any;
    group_id?: string;
    group_id_version?: number;
    entries?: any[];
    entry?: any;
  };
}

const subscribers = new Map<string, Set<(ev: HistoryStoreEvent) => void>>();

function emit(sessionId: string, ev: HistoryStoreEvent): void {
  const set = subscribers.get(sessionId);
  if (!set || set.size === 0) return;
  for (const fn of set) {
    try { fn(ev); } catch {}
  }
}

function subscribeSessionEvents(sessionId: string, listener: (ev: HistoryStoreEvent) => void): () => void {
  let set = subscribers.get(sessionId);
  if (!set) { set = new Set(); subscribers.set(sessionId, set); }
  set.add(listener);
  return () => {
    const cur = subscribers.get(sessionId);
    if (!cur) return;
    cur.delete(listener);
    if (cur.size === 0) subscribers.delete(sessionId);
  };
}

// ── 内部: 批次落库 ────────────────────────────────────────────────────────

export interface PendingRow {
  entry: any;
  json: string;
  origin: 'primary' | 'direct' | 'legacy';
  roundOpener: boolean;   // legacy 迁移源的开轮卡: 入库时顺带开新组
  ts: number | null;
}

interface CommitSink {
  newRounds: any[];                  // 本批新建的组元数据 (group_created 事件用)
  rowsByGroup: Map<number, any[]>;   // 本批插入的条目 (entries 事件用, 按组聚合)
}

function ensureGroupRow(sessionId: string, groupSeq: number): number {
  const st = S();
  const row = st.getRound.get(sessionId, groupSeq) as any;
  if (row) return row.entry_count;
  // 当前组行缺失 (0=pre 组首次落条目, 或异常空缺) → 建空行.
  st.insertRound.run(sessionId, groupSeq, null, null, '', 0, nowIso());
  return 0;
}

function commitBatch(sessionId: string, rows: PendingRow[], newBookmark: number, sink: CommitSink): void {
  if (rows.length === 0 && newBookmark < 0) return;
  const db = openStore();
  const st = S();
  const tx = db.transaction(() => {
    const state = st.getState.get(sessionId) as any;
    let gseq = state.last_group_seq || 0;
    // count = 当前组的下一个 seq_in_group; null = 本事务还没碰过组行 (避免空 pre 组被凭空建出).
    let count: number | null = null;
    let nextSeq = state.next_seq || 1;
    let version = state.session_version || 0;

    for (const row of rows) {
      const uuid = entryUuidOf(row.entry, row.json);
      if (row.roundOpener) {
        // 迁移源的开轮卡: 先结清上一组的条数 (若本事务动过), 再开新组.
        if (count !== null) st.updateRoundCount.run(count, sessionId, gseq);
        gseq += 1;
        const summary = summarizeUserText(row.entry?.message?.content);
        st.insertRound.run(sessionId, gseq, uuid, row.ts, summary, 1, nowIso());
        const res = st.insertEntry.run(sessionId, uuid, nextSeq, gseq, 0, 1, row.origin, row.ts, row.json);
        nextSeq++;
        version++;
        if (res.changes === 1) {
          sink.newRounds.push({
            id: String(gseq), seq: gseq,
            opener_ts: row.ts != null ? new Date(row.ts).toISOString() : null,
            user_summary: summary, version: 1, entry_count: 1,
          });
          pushSinkRow(sink, gseq, row.entry);
        }
        count = 1;
        continue;
      }
      if (count === null) count = ensureGroupRow(sessionId, gseq);
      const res = st.insertEntry.run(sessionId, uuid, nextSeq, gseq, count, 0, row.origin, row.ts, row.json);
      nextSeq++;
      if (res.changes === 1) {
        count++; version++;
        pushSinkRow(sink, gseq, row.entry);
      }
    }

    if (count !== null) st.updateRoundCount.run(count, sessionId, gseq);
    db.prepare('UPDATE ingest_state SET primary_read_bytes = ?, session_version = ?, last_group_seq = ?, next_seq = ?, last_synced_at = ? WHERE session_id = ?')
      .run(newBookmark, version, gseq, nextSeq, nowIso(), sessionId);
  });
  tx();
}

function pushSinkRow(sink: CommitSink, gseq: number, entry: any): void {
  let arr = sink.rowsByGroup.get(gseq);
  if (!arr) { arr = []; sink.rowsByGroup.set(gseq, arr); }
  arr.push(entry);
}

function flushSink(sessionId: string, sink: CommitSink): void {
  for (const group of sink.newRounds) {
    emit(sessionId, { type: 'group_created', payload: { group } });
  }
  const st = S();
  for (const [gseq, entries] of sink.rowsByGroup) {
    const row = st.getRound.get(sessionId, gseq) as any;
    const version = row ? row.entry_count : entries.length;
    emit(sessionId, {
      type: 'entries',
      payload: { group_id: String(gseq), group_id_version: version, entries },
    });
  }
}

// ── 书签式增量读取: 只产完整行, 书签只前进到行尾 ─────────────────────────

function* iterateNewLines(filePath: string, startByte: number): Generator<{ text: string; endByte: number }> {
  let fd: number | null = null;
  try {
    try {
      fd = fs.openSync(filePath, 'r');
    } catch (e) {
      // 新会话: claude-code 首条 init 尚未落盘 → 原生 jsonl 还不存在. 这是正常时序
      // (SSE 打开常早于 agent 写首行), 不是错误: 静默跳过, 等下一次 sync 文件出现后再读.
      // 若不加守卫, fs.openSync 抛的 ENOENT 会一路冒到 /events /groups 报给前端.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    const size = fs.fstatSync(fd).size;
    if (startByte >= size) return;
    let pos = Math.max(0, startByte);
    let carryStart = pos;
    let carry = Buffer.alloc(0);
    const CHUNK = 256 * 1024;
    while (pos < size) {
      const want = Math.min(CHUNK, size - pos);
      const buf = Buffer.alloc(want);
      const n = fs.readSync(fd, buf, 0, want, pos);
      if (n <= 0) break;
      const data = Buffer.concat([carry, buf.subarray(0, n)]);
      const dataStart = carryStart;
      let from = 0;
      let nl = data.indexOf(10, from);
      while (nl >= 0) {
        yield { text: data.subarray(from, nl).toString('utf8'), endByte: dataStart + nl + 1 };
        from = nl + 1;
        nl = data.indexOf(10, from);
      }
      carry = data.subarray(from);
      carryStart = dataStart + from;
      pos += n;
    }
  } finally {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
  }
}

// ── 迁移源 (冻结的旧 .mobius.jsonl): 见 mobius-agent-history-legacy.ts ────

// ── pending_round_openers: 出队开轮 ─────────────────────────────────────
// 阶段A (writeMobiusCoreEntry): 条目入库 (group_seq=NULL, round_opener=1) + uuid 入队,
// 只挂起不开轮. 出队 (flush) 触发点:
//   1. group 0 特殊: 新会话还没开过任何轮 (last_group_seq==0) → 阶段A 后立即出队,
//      等价旧「opener 提前」, spawn 前导落进第 1 轮而非第 0 轮.
//   2. dequeue 事件: scanPrimary 扫到 containDequeueEvent(entry)==true 时出队
//      (仅已开过轮的会话走到这; dequeue 必然全部出队, 故「全部 pending → 一个组」).
//   3. session 终止兜底: 后端 terminateSession 调 flushPendingOpeners 清空
//      (防 agent 崩溃后 dequeue 永不出现, pending 永久挂起).
// 多个 pending 一次性出队只开一组 (group_seq 只 +1); 组元数据取「最后一个」pending.

function flushPendingOpenersToSink(sessionId: string, sink: CommitSink): number | null {
  const st = S();
  const state = st.getState.get(sessionId) as any;
  if (!state) return null;
  const pending: string[] = JSON.parse(state.pending_round_openers || '[]');
  if (!pending.length) return null;

  const db = openStore();
  const resolved: { uuid: string; json: string; ts: number | null }[] = [];
  for (const uuid of pending) {
    const row = db.prepare('SELECT json, ts FROM entries WHERE session_id = ? AND uuid = ?').get(sessionId, uuid) as any;
    if (row) resolved.push({ uuid, json: row.json, ts: row.ts });
  }
  if (!resolved.length) {
    // 队列里的条目都没了 → 只清空队列, 不开组.
    db.prepare("UPDATE ingest_state SET pending_round_openers = '[]' WHERE session_id = ?").run(sessionId);
    return null;
  }

  const last = resolved[resolved.length - 1];
  const lastEntry = safeParseJson(last.json);
  const summary = summarizeUserText(lastEntry?.message?.content);

  const tx = db.transaction((): number => {
    const cur = st.getState.get(sessionId) as any;
    const gseq = (cur.last_group_seq || 0) + 1;
    st.insertRound.run(sessionId, gseq, last.uuid, last.ts, summary, resolved.length, nowIso());
    resolved.forEach((r, i) => st.updateEntryGroup.run(gseq, i, sessionId, r.uuid));
    db.prepare('UPDATE ingest_state SET last_group_seq = ?, pending_round_openers = ?, session_version = ? WHERE session_id = ?')
      .run(gseq, '[]', (cur.session_version || 0) + 1, sessionId);
    return gseq;
  });
  const gseq = tx() as number;

  sink.newRounds.push({
    id: String(gseq), seq: gseq,
    opener_ts: last.ts != null ? new Date(last.ts).toISOString() : null,
    user_summary: summary, version: resolved.length, entry_count: resolved.length,
  });
  sink.rowsByGroup.set(gseq, resolved.map((r) => safeParseJson(r.json)).filter(Boolean));
  return gseq;
}

// 对外兜底入口 (terminateSession 等): 自建 sink 并立即广播.
function flushPendingOpeners(sessionId: string): number | null {
  const sink: CommitSink = { newRounds: [], rowsByGroup: new Map() };
  const gseq = flushPendingOpenersToSink(sessionId, sink);
  flushSink(sessionId, sink);
  return gseq;
}

// pending opener 的对外投影 (前端伪组 / pending_opener 事件共用同一形状).
function pendingMetaOf(entry: any): { id: string; opener_ts: string | null; user_summary: string } {
  return {
    id: entry?.uuid || '',
    opener_ts: entry?.timestamp || null,
    user_summary: summarizeUserText(entry?.message?.content),
  };
}

function hasPendingOpeners(sessionId: string): boolean {
  const st = S();
  const state = st.getState.get(sessionId) as any;
  if (!state) return false;
  const pending: string[] = JSON.parse(state.pending_round_openers || '[]');
  return pending.length > 0;
}

// ── 对外: 直写入口 (发送链路 / 错误扫描) ──────────────────────────────────

/**
 * 发送链路写入 user_input/compact 卡 = 唯一的开轮动作 (排除两个系统提醒串).
 * 适配器 harnessWriteMobiusCoreEntry 的公共实现.
 */
function writeMobiusCoreEntry(args: {
  sessionId: string;
  agentSessionId?: any;
  cwd?: any;
  backendName?: any;
  primaryPath?: string | null;
  containDequeueEvent?: (entry: any) => boolean;
} & MobiusCoreRecord): boolean {
  const sessionId = args.sessionId;
  if (!sessionId) return false;
  const entry = buildMobiusUserEntry(args);
  const json = JSON.stringify(entry);
  const ts = parseTimestampMs(entry);
  const db = openStore();
  const st = S();

  // 确保有状态行 (新会话首条消息可能先于任何 sync).
  if (!st.getState.get(sessionId)) {
    // 首触即直写且路径已知: 先完整同步一次 (含旧文件迁移 backfill), 让历史轮次先开组、
    // 本轮 opener 排在最后 — 组序 = 时间序. (路径未知 = 新会话无迁移源, 直接建行,
    // 迁移标记保持 0, 由首次 sync 检查.)
    if (args.primaryPath) {
      try { syncSession(sessionId, args.primaryPath, args.containDequeueEvent); } catch {}
    }
    if (!st.getState.get(sessionId)) {
      st.insertState.run(sessionId, args.primaryPath || '');
    }
  }

  const excluded = isExcludedSystemReminder(entry);
  const sink: CommitSink = { newRounds: [], rowsByGroup: new Map() };

  if (excluded) {
    // 系统提醒: 写入但不开轮, 归当前组.
    const tx = db.transaction(() => {
      const state = st.getState.get(sessionId) as any;
      const gseq = state.last_group_seq || 0;
      const count = ensureGroupRow(sessionId, gseq);
      const res = st.insertEntry.run(sessionId, entry.uuid, state.next_seq || 1, gseq, count, 0, 'direct', ts, json);
      st.updateRoundCount.run(count + (res.changes === 1 ? 1 : 0), sessionId, gseq);
      if (res.changes === 1) {
        db.prepare('UPDATE ingest_state SET next_seq = ?, session_version = ?, last_synced_at = ? WHERE session_id = ?')
          .run((state.next_seq || 1) + 1, (state.session_version || 0) + 1, nowIso(), sessionId);
        pushSinkRow(sink, gseq, entry);
      }
    });
    tx();
    flushSink(sessionId, sink);
    return true;
  }

  // 阶段A: 入库 + 入队.
  const txA = db.transaction(() => {
    const state = st.getState.get(sessionId) as any;
    st.insertEntry.run(sessionId, entry.uuid, state.next_seq || 1, null, null, 1, 'direct', ts, json);
    const pending: string[] = JSON.parse(state.pending_round_openers || '[]');
    pending.push(entry.uuid);
    db.prepare('UPDATE ingest_state SET next_seq = ?, pending_round_openers = ?, session_version = ?, last_synced_at = ? WHERE session_id = ?')
      .run((state.next_seq || 1) + 1, JSON.stringify(pending), (state.session_version || 0) + 1, nowIso(), sessionId);
  });
  txA();

  // 出队决策: group 0 特殊 (新会话还没开过轮) → 立即出队 (等价旧 opener 提前);
  // 已开过轮 → 挂起等 scanPrimary 扫到 dequeue 事件再出队, 前端先收到 pending_opener.
  const stateAfterA = st.getState.get(sessionId) as any;
  if ((stateAfterA.last_group_seq || 0) === 0) {
    flushPendingOpenersToSink(sessionId, sink);
  } else {
    emit(sessionId, { type: 'pending_opener', payload: { entry: pendingMetaOf(entry) } });
  }
  flushSink(sessionId, sink);
  return true;
}

/**
 * 错误扫描写入 recent_error 卡: 归当前组, 不开轮.
 * 去重沿旧规则 — 本会话最后一条 entry 已是 error 时不重复落.
 */
function writeMobiusErrorEntry(args: {
  sessionId: string;
  agentSessionId?: any;
  cwd?: any;
  backendName?: any;
  primaryPath?: string | null;
  containDequeueEvent?: (entry: any) => boolean;
  error?: any;
}): boolean {
  const sessionId = args.sessionId;
  if (!sessionId) return false;
  if (args.primaryPath) {
    try { syncSession(sessionId, args.primaryPath, args.containDequeueEvent); } catch {}
  }
  const st = S();
  if (!st.getState.get(sessionId)) {
    if (!args.primaryPath) return false;
    st.insertState.run(sessionId, args.primaryPath);
  }
  // TUI captures remain unchanged across status polls. Checking only the last
  // entry is insufficient: any normal event appended after an error makes the
  // same stale screen error look new on the next poll. Deduplicate by the
  // stable error payload across a bounded recent window instead.
  const message = String(args.error?.message || '').slice(0, 4000);
  const contextFingerprint = args.error?.contextFingerprint
    ? String(args.error.contextFingerprint)
    : null;
  const recentRows = openStore().prepare(
    'SELECT json FROM entries WHERE session_id = ? ORDER BY seq DESC LIMIT 100'
  ).all(sessionId) as any[];
  for (const row of recentRows) {
    const previous = safeParseJson(row?.json);
    if (previous?.type !== 'error') continue;
    const previousMessage = String(previous?.message?.content || '').slice(0, 4000);
    const previousContextFingerprint = previous?.mobius?.context_fingerprint
      ? String(previous.mobius.context_fingerprint)
      : null;
    if (
      previousMessage === message
      && previousContextFingerprint === contextFingerprint
    ) return false;
  }
  const entry = buildMobiusErrorEntry(args);
  const json = JSON.stringify(entry);
  const ts = parseTimestampMs(entry);
  const db = openStore();
  const sink: CommitSink = { newRounds: [], rowsByGroup: new Map() };
  const tx = db.transaction(() => {
    const state = st.getState.get(sessionId) as any;
    const gseq = state.last_group_seq || 0;
    const count = ensureGroupRow(sessionId, gseq);
    const res = st.insertEntry.run(sessionId, entry.uuid, state.next_seq || 1, gseq, count, 0, 'direct', ts, json);
    st.updateRoundCount.run(count + (res.changes === 1 ? 1 : 0), sessionId, gseq);
    if (res.changes === 1) {
      db.prepare('UPDATE ingest_state SET next_seq = ?, session_version = ?, last_synced_at = ? WHERE session_id = ?')
        .run((state.next_seq || 1) + 1, (state.session_version || 0) + 1, nowIso(), sessionId);
      pushSinkRow(sink, gseq, entry);
    }
  });
  tx();
  flushSink(sessionId, sink);
  return true;
}

// ── 对外: syncSession (其余一切更新的唯一来源) ────────────────────────────

export interface SyncResult {
  ok: boolean;
  error?: string;
  inserted?: number;
}

function markError(sessionId: string, message: string): SyncResult {
  openStore().prepare('UPDATE ingest_state SET error = ? WHERE session_id = ?').run(message, sessionId);
  return { ok: false, error: message };
}

// [legacy-migration] 第四个参数: 迁移源 (无则纯原生轨扫描); 第五个: 本次调用是否结算迁移标记.
// 第六个: 出队事件检测 (缺省恒 true = 立即出队). 删除迁移时一并删掉 legacy 相关参数.
function scanPrimary(sessionId: string, filePath: string, mode: 'initial' | 'members', legacy: LegacyBackfill | null, markLegacyDone: boolean, containDequeueEvent?: (entry: any) => boolean): SyncResult {
  const db = openStore();
  const st = S();
  const state = st.getState.get(sessionId) as any;
  const bookmark = mode === 'members' ? (state.primary_read_bytes || 0) : 0;
  const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (size < bookmark) {
    return markError(sessionId, `原生 jsonl 变小 (书签=${bookmark}, 现大小=${size}), 疑似轮转/截断: ${filePath}`);
  }

  const sink: CommitSink = { newRounds: [], rowsByGroup: new Map() };
  let pendingRows: PendingRow[] = [];
  let batchEnd = bookmark;
  let insertedTotal = 0;
  // 定序锚: 原生行里 933+ 行无时间戳 (claude-code 元数据行), 用最近一次有效 ts 给它们定序 —
  // 元数据行写在哪个时刻之后, 就参与哪个时刻的归并.
  let lastKnownTs: number | null = null;
  // 出队检测缺省恒 true (codex / deepseek 占位), 但基类已提供同名方法, 调用方照传.
  const detectDequeue = containDequeueEvent || (() => true);

  const commit = () => {
    if (pendingRows.length === 0) return;
    commitBatch(sessionId, pendingRows, batchEnd, sink);
    insertedTotal += pendingRows.length;
    pendingRows = [];
  };

  for (const line of iterateNewLines(filePath, bookmark)) {
    const entry = safeParseJson(line.text);
    if (entry) {
      const lineTs = parseTimestampMs(entry);
      const anchorTs = lineTs != null ? lineTs : lastKnownTs;
      if (lineTs != null) lastKnownTs = lineTs;
      // [legacy-migration] 归并序: 迁移条目按时间戳插到原生行之前 (同刻原生优先; 无锚不 flush).
      if (legacy) pendingRows.push(...legacy.takeUpTo(anchorTs));
      // 出队触发: 本行是出队事件 且 有挂起的 opener → 先结清前导行到旧组, 再一次性开组.
      if (detectDequeue(entry) && hasPendingOpeners(sessionId)) {
        commit();
        flushPendingOpenersToSink(sessionId, sink);
      }
      pendingRows.push({ entry, json: line.text, origin: 'primary', roundOpener: false, ts: parseTimestampMs(entry) });
      // task 快照: 紧跟锚点条目之后落库.
      try {
        const snapshot = taskAccumulator.absorbPrimaryEntry(filePath, line.text);
        if (snapshot) {
          // [legacy-migration] 旧文件已有同锚点快照 → 跳过 (防双份).
          const anchor = snapshot?.mobius?.anchor_uuid;
          if (typeof anchor !== 'string' || !legacy?.hasSnapshotAnchor(anchor)) {
            pendingRows.push({ entry: snapshot, json: JSON.stringify(snapshot), origin: 'direct', roundOpener: false, ts: parseTimestampMs(snapshot) });
          }
        }
      } catch (e) {
        console.warn(`[agent-history] task absorb failed: ${(e as Error)?.message || e}`);
      }
    }
    batchEnd = line.endByte;
    if (pendingRows.length >= SCAN_CHUNK_ENTRIES) commit();
  }
  // [legacy-migration] 扫描结束: 取出剩余迁移条目.
  if (legacy) pendingRows.push(...legacy.takeAll());
  commit();

  // [legacy-migration] 本次检查过迁移源: 有源 → 记已消费字节; 无源 → -1 (查过没有).
  // 0 恒表示 "从未检查", 兼容旧数据 (旧代码无源时也写 0, 下次 sync 重查一次后落 -1).
  if (markLegacyDone) {
    db.prepare('UPDATE ingest_state SET legacy_read_bytes = ? WHERE session_id = ?')
      .run(legacy ? legacy.consumedBytes() : -1, sessionId);
  }

  flushSink(sessionId, sink);
  return { ok: true, inserted: insertedTotal };
}

/**
 * 读前补齐: 从书签读原生 jsonl 到 EOF, 分块事务落库.
 * 首次 (无状态行) = backfill: 冻结的旧 .mobius.jsonl 与原生轨按时间戳归并,
 * 见开轮卡切组 (origin='legacy'). 之后旧文件永不再读.
 */
function syncSession(sessionId: string, primaryPath: string | null | undefined, containDequeueEvent?: (entry: any) => boolean): SyncResult {
  const st = S();
  let state = st.getState.get(sessionId) as any;
  let created = false;
  if (!state) {
    if (!primaryPath) return { ok: true, inserted: 0 };
    st.insertState.run(sessionId, primaryPath);
    state = st.getState.get(sessionId) as any;
    created = true;
  }
  if (state.error) return { ok: false, error: state.error };
  if (!primaryPath) return { ok: true, inserted: 0 };

  // 换轨 (respawn 换了原生会话): 先把旧轨读到尾, 再从 0 读新轨.
  if (state.primary_path && state.primary_path !== primaryPath) {
    const oldPath = state.primary_path;
    if (fs.existsSync(oldPath)) {
      const r = scanPrimary(sessionId, oldPath, 'members', null, false, containDequeueEvent);
      if (!r.ok) return r;
      openStore().prepare('UPDATE ingest_state SET primary_path = ?, primary_read_bytes = 0 WHERE session_id = ?')
        .run(primaryPath, sessionId);
    } else {
      openStore().prepare('UPDATE ingest_state SET primary_path = ? WHERE session_id = ?').run(primaryPath, sessionId);
    }
  } else if (state.primary_path !== primaryPath) {
    // 状态行是空路径占位 (直写先于任何 sync 创建) → 认领当前路径.
    openStore().prepare('UPDATE ingest_state SET primary_path = ? WHERE session_id = ?').run(primaryPath, sessionId);
  }

  // [legacy-migration] backfill 触发条件 = legacy_read_bytes == 0 (从未检查), 不再看 created:
  // opener 提前写入也会建状态行, 若按 created 判定, 这些会话的旧文件会被永久跳过.
  const needLegacy = Number(state.legacy_read_bytes) === 0;
  const legacy = needLegacy ? loadLegacyBackfill(primaryPath) : null;
  return scanPrimary(sessionId, primaryPath, created ? 'initial' : 'members', legacy, needLegacy, containDequeueEvent);
}

// ── 对外: 查询 (① ② + 旧 getHistory 兼容) ───────────────────────────────

interface GroupMeta {
  id: string;
  seq: number;
  opener_ts: string | null;
  user_summary: string;
  version: number;
  entry_count: number;
}

function getGroups(sessionId: string): { session_version: number; groups: GroupMeta[] } {
  const st = S();
  const state = st.getState.get(sessionId) as any;
  const rounds = st.listRounds.all(sessionId) as any[];
  return {
    session_version: state ? (state.session_version || 0) : 0,
    groups: rounds.map((r) => ({
      id: String(r.group_seq),
      seq: r.group_seq,
      opener_ts: r.round_opener_ts != null ? new Date(r.round_opener_ts).toISOString() : null,
      user_summary: r.user_summary || '',
      version: r.entry_count || 0,
      entry_count: r.entry_count || 0,
    })),
  };
}

function getGroupEntries(sessionId: string, groupSeq: number): { group_id: string; version: number; entries: any[] } | null {
  const st = S();
  const round = st.getRound.get(sessionId, groupSeq) as any;
  if (!round) return null;
  const rows = st.listGroupEntries.all(sessionId, groupSeq) as any[];
  return {
    group_id: String(groupSeq),
    version: round.entry_count || rows.length,
    entries: rows.map((r) => safeParseJson(r.json)).filter(Boolean),
  };
}

/** 旧 getHistory 语义的库版: 全部条目按到达序. assistant 快照 / 标题扫描仍在用. */
function getHistorySnapshot(sessionId: string, primaryPath: string | null | undefined, containDequeueEvent?: (entry: any) => boolean): {
  entries: any[]; total: number; truncated: boolean; sentinel: any;
} {
  if (primaryPath) {
    try { syncSession(sessionId, primaryPath, containDequeueEvent); } catch {}
  }
  const db = openStore();
  const rows = db.prepare('SELECT json FROM entries WHERE session_id = ? ORDER BY seq ASC').all(sessionId) as any[];
  const state = S().getState.get(sessionId) as any;
  return {
    entries: rows.map((r) => safeParseJson(r.json)).filter(Boolean),
    total: rows.length,
    truncated: false,
    sentinel: state ? (state.primary_read_bytes || 0) : 0,
  };
}

/** 挂起中的开轮卡 (pending_round_openers): 前端把它们当作「特殊的最后一个组」渲染. */
function getPendingOpeners(sessionId: string): { id: string; opener_ts: string | null; user_summary: string }[] {
  const st = S();
  const state = st.getState.get(sessionId) as any;
  if (!state) return [];
  const pending: string[] = JSON.parse(state.pending_round_openers || '[]');
  if (!pending.length) return [];
  const db = openStore();
  const out: { id: string; opener_ts: string | null; user_summary: string }[] = [];
  for (const uuid of pending) {
    const row = db.prepare('SELECT json FROM entries WHERE session_id = ? AND uuid = ?').get(sessionId, uuid) as any;
    if (!row) continue;
    const entry = safeParseJson(row.json);
    if (entry) out.push(pendingMetaOf(entry));
  }
  return out;
}

/** 会话删除: 三表级联. */
function deleteSessionData(sessionId: string): void {
  const st = S();
  const tx = openStore().transaction(() => {
    st.deleteEntries.run(sessionId);
    st.deleteRounds.run(sessionId);
    st.deleteState.run(sessionId);
  });
  try { tx(); } catch {}
  subscribers.delete(sessionId);
}

export {
  syncSession,
  getGroups,
  getGroupEntries,
  getPendingOpeners,
  getHistorySnapshot,
  writeMobiusCoreEntry,
  writeMobiusErrorEntry,
  flushPendingOpeners,
  deleteSessionData,
  subscribeSessionEvents,
};
