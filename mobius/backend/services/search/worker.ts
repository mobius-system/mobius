import Database from 'better-sqlite3';
import fs from 'fs';
import { historyStorePath, syncSession } from '../mobius-agent-history';
import { indexBatch, queryIndex } from './index';

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
  setInterval(() => {
    if (!inventory.length) return;
    try { syncSource(); indexBatch(db, allowed); }
    catch (error: any) { console.warn('[search] index:', error.message); }
  }, 200);
}
process.on('disconnect', () => process.exit(0));
