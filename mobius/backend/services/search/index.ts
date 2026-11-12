import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { extractSearchContent, indexTokens, matchingSnippet, parseSearchQuery, type SearchOptions } from './content';

export function initializeSearchIndex(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS history_search_fts USING fts5(
      tokens, content='', contentless_delete=1, detail=none
    );
    CREATE TABLE IF NOT EXISTS history_search_state (
      id INTEGER PRIMARY KEY CHECK(id=1), last_rowid INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO history_search_state(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS history_search_pending (entry_rowid INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS history_search_processed (entry_rowid INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history_search_metrics (id INTEGER PRIMARY KEY CHECK(id=1), updated_at TEXT, cpu_percent REAL,
      read_ms REAL, tokenize_ms REAL, write_ms REAL, processed INTEGER, skipped INTEGER);
    CREATE TRIGGER IF NOT EXISTS history_search_insert AFTER INSERT ON entries BEGIN
      INSERT OR IGNORE INTO history_search_pending VALUES(new.rowid);
    END;
    CREATE TRIGGER IF NOT EXISTS history_search_update AFTER UPDATE OF json ON entries BEGIN
      INSERT OR IGNORE INTO history_search_pending VALUES(new.rowid);
    END;
    CREATE TRIGGER IF NOT EXISTS history_search_delete AFTER DELETE ON entries BEGIN
      DELETE FROM history_search_fts WHERE rowid=old.rowid;
      DELETE FROM history_search_pending WHERE entry_rowid=old.rowid;
    END;
  `);
  db.exec(`CREATE TRIGGER IF NOT EXISTS history_search_processed_delete AFTER DELETE ON entries BEGIN
    DELETE FROM history_search_processed WHERE entry_rowid=old.rowid;
  END;`);
}

export type BatchMetrics = { readMs: number; tokenizeMs: number; writeMs: number; processed: number; skipped: number };

export function indexBatch(db: Database.Database, allowed: Set<string>, batchSize = 10, metrics?: BatchMetrics): boolean {
  const started = performance.now();
  const state = db.prepare('SELECT last_rowid FROM history_search_state WHERE id=1').get() as any;
  const rows = db.prepare('SELECT rowid,session_id,json FROM entries WHERE rowid>? ORDER BY rowid LIMIT ?').all(state.last_rowid, batchSize) as any[];
  const pending = db.prepare(`SELECT e.rowid,e.session_id,e.json FROM history_search_pending p
    JOIN entries e ON e.rowid=p.entry_rowid ORDER BY p.entry_rowid DESC LIMIT ?`).all(batchSize) as any[];
  const readProcessed = db.prepare('SELECT fingerprint FROM history_search_processed WHERE entry_rowid=?');
  const selected = [...new Map([...rows, ...pending].map(row => [row.rowid, row])).values()].map(row => {
    const fingerprint = createHash('sha256').update(allowed.has(row.session_id) ? '1' : '0').update(row.json).digest('hex');
    return { ...row, fingerprint, skip: (readProcessed.get(row.rowid) as any)?.fingerprint === fingerprint };
  });
  const readDone = performance.now();
  const prepared = selected.map(row => {
    let content: ReturnType<typeof extractSearchContent> = null;
    if (!row.skip && allowed.has(row.session_id)) {
      try { content = extractSearchContent(JSON.parse(row.json)); } catch {}
    }
    return { ...row, tokens: content ? indexTokens(content.text) : '' };
  });
  const tokenizeDone = performance.now();
  const result = db.transaction(() => {
    const remove = db.prepare('DELETE FROM history_search_fts WHERE rowid=?');
    const insert = db.prepare('INSERT INTO history_search_fts(rowid,tokens) VALUES(?,?)');
    const done = db.prepare('DELETE FROM history_search_pending WHERE entry_rowid=?');
    const unchanged = db.prepare('SELECT 1 FROM entries WHERE rowid=? AND json=?');
    const mark = db.prepare('INSERT OR REPLACE INTO history_search_processed VALUES(?,?)');
    for (const row of prepared) {
      if (!unchanged.get(row.rowid, row.json)) continue;
      if (!row.skip) {
        remove.run(row.rowid);
        if (row.tokens) insert.run(row.rowid, row.tokens);
        mark.run(row.rowid, row.fingerprint);
      }
      done.run(row.rowid);
    }
    if (rows.length) db.prepare('UPDATE history_search_state SET last_rowid=? WHERE id=1').run(rows[rows.length - 1].rowid);
    return rows.length > 0 || pending.length > 0;
  }).immediate();
  if (metrics) Object.assign(metrics, { readMs: readDone - started, tokenizeMs: tokenizeDone - readDone,
    writeMs: performance.now() - tokenizeDone, processed: prepared.filter(row => !row.skip).length,
    skipped: prepared.filter(row => row.skip).length });
  return result;
}

export type IndexedSearchRequest = SearchOptions & { query: string; sessionIds: string[]; limit: number; maxFragments: number };

export function queryIndex(db: Database.Database, request: IndexedSearchRequest): any {
  const started = Date.now();
  const parsed = parseSearchQuery(request.query);
  db.exec('CREATE TEMP TABLE IF NOT EXISTS readable_sessions(id TEXT PRIMARY KEY, ordinal INTEGER)');
  db.exec('DELETE FROM readable_sessions');
  const insert = db.prepare('INSERT INTO readable_sessions VALUES(?,?)');
  db.transaction(() => request.sessionIds.forEach((sessionId, ordinal) => insert.run(sessionId, ordinal)))();
  const state = db.prepare('SELECT last_rowid FROM history_search_state WHERE id=1').get() as any;
  const pending = db.prepare(`SELECT EXISTS(SELECT 1 FROM entries e JOIN readable_sessions s ON s.id=e.session_id
    WHERE e.rowid>?) OR EXISTS(SELECT 1 FROM history_search_pending p JOIN entries e ON e.rowid=p.entry_rowid
    JOIN readable_sessions s ON s.id=e.session_id) AS building`).get(state.last_rowid) as any;
  const missing = db.prepare(`SELECT COUNT(*) AS total FROM readable_sessions s
    WHERE NOT EXISTS(SELECT 1 FROM ingest_state i WHERE i.session_id=s.id AND i.error IS NULL)`).get() as any;
  const groups = new Map<string, any[]>();
  let checked = 0;
  let truncated = false;
  const readEntry = db.prepare('SELECT json FROM entries WHERE rowid=?');
  const candidates = db.prepare(`SELECT e.rowid,e.session_id,e.uuid,e.ts FROM history_search_fts
    JOIN entries e ON e.rowid=history_search_fts.rowid JOIN readable_sessions s ON s.id=e.session_id
    WHERE history_search_fts MATCH ? ORDER BY s.ordinal,e.seq DESC`).iterate(parsed.match);
  for (const row of candidates as Iterable<any>) {
    if (++checked > 20000 || Date.now() - started > 2500) { truncated = true; break; }
    if (groups.has(row.session_id) && groups.get(row.session_id)!.length >= request.maxFragments) continue;
    const stored = readEntry.get(row.rowid) as any;
    const content = extractSearchContent(JSON.parse(stored.json));
    if (!content) continue;
    const snippet = matchingSnippet(content.text, parsed.terms, request);
    if (!snippet) continue;
    if (!groups.has(row.session_id)) {
      if (groups.size >= request.limit) { truncated = true; break; }
      groups.set(row.session_id, []);
    }
    groups.get(row.session_id)!.push({ uuid: row.uuid, role: content.role, snippet, timestamp: row.ts ? new Date(row.ts).toISOString() : null });
  }
  return { hits: [...groups].map(([session_id, fragments]) => ({ session_id, fragments })),
    indexing: !!pending.building, unavailable_sessions: missing.total, truncated, took_ms: Date.now() - started };
}
