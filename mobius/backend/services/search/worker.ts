import Database from 'better-sqlite3';
import fs from 'fs';
import { historyStorePath, syncSession } from '../mobius-agent-history';
import { indexBatch, queryIndex, type BatchMetrics } from './index';
import { cpuRestMs, SEARCH_CPU_COUNT } from './cpu-budget';

const db = new Database(historyStorePath());
db.pragma('busy_timeout=1000');
db.pragma('cache_size=-8192');
let inventory: Array<{ sessionId: string; path: string | null; backend: string }> = [];
let allowed = new Set<string>();
let cursor = 0;
const sizes = new Map<string, string>();

function syncSource(): void {
  for (let count = 0; count < Math.min(20, inventory.length); count++) {
    const source = inventory[cursor++ % inventory.length];
    if (!source.path) continue;
    try {
      const stat = fs.statSync(source.path);
      const signature = `${source.path}|${stat.ino}|${stat.size}|${stat.mtimeMs}`;
      if (sizes.get(source.sessionId) === signature) continue;
      const state = db.prepare('SELECT pending_round_openers,primary_path,primary_read_bytes FROM ingest_state WHERE session_id=?').get(source.sessionId) as any;
      if (state && JSON.parse(state.pending_round_openers).length) continue;
      if (state?.primary_path === source.path && state.primary_read_bytes === stat.size) {
        sizes.set(source.sessionId, signature);
        continue;
      }
      const result = syncSession(source.sessionId, source.path, entry => {
        if (source.backend === 'tmux-codex') return entry?.type === 'response_item' && entry?.payload?.type === 'message' && entry?.payload?.role === 'user'
          || entry?.type === 'event_msg' && entry?.payload?.type === 'task_started';
        return false;
      });
      if (result.ok) sizes.set(source.sessionId, signature);
      break;
    } catch (error: any) {
      if (error.code !== 'ENOENT') console.warn('[search] history sync:', error.message);
    }
  }
}

process.on('message', (message: any) => {
  if (message.type === 'inventory') {
    inventory = message.sources;
    allowed = new Set(inventory.map(source => source.sessionId));
  } else if (message.type === 'query') {
    try { process.send?.({ id: message.id, result: queryIndex(db, message.request) }); }
    catch (error: any) { process.send?.({ id: message.id, error: error.message }); }
  }
});

if (process.env.MOBIUS_SEARCH_WORKER === 'indexer') {
  let lastSync = 0;
  let lastReport = performance.now();
  let lastCpu = process.cpuUsage();
  let totals: BatchMetrics = { readMs: 0, tokenizeMs: 0, writeMs: 0, processed: 0, skipped: 0 };
  const run = () => {
    const cycleStarted = performance.now();
    const cycleCpu = process.cpuUsage();
    let more = false;
    try {
      if (inventory.length) {
        if (Date.now() - lastSync >= 1000) { lastSync = Date.now(); syncSource(); }
        const metrics = {} as BatchMetrics;
        more = indexBatch(db, allowed, 10, metrics);
        for (const key of Object.keys(totals) as Array<keyof BatchMetrics>) totals[key] += metrics[key];
        const now = performance.now();
        if (now - lastReport >= 10000) {
          const cpu = process.cpuUsage(lastCpu);
          const cpuPercent = (cpu.user + cpu.system) / ((now - lastReport) * 10 * SEARCH_CPU_COUNT);
          db.prepare('INSERT OR REPLACE INTO history_search_metrics VALUES(1,?,?,?,?,?,?,?)')
            .run(new Date().toISOString(), cpuPercent, totals.readMs, totals.tokenizeMs, totals.writeMs, totals.processed, totals.skipped);
          console.log('[search] metrics', JSON.stringify({ cpuPercent, ...totals }));
          totals = { readMs: 0, tokenizeMs: 0, writeMs: 0, processed: 0, skipped: 0 };
          lastReport = now;
          lastCpu = process.cpuUsage();
        }
      }
    } catch (error: any) { console.warn('[search] index:', error.message); }
    const used = process.cpuUsage(cycleCpu);
    const rest = cpuRestMs((used.user + used.system) / 1000, performance.now() - cycleStarted);
    setTimeout(run, Math.max(more ? 0 : 1000, rest));
  };
  run();
}
process.on('disconnect', () => process.exit(0));
