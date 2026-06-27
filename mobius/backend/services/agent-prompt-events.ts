import { db } from '../../db';

const DEFAULT_WINDOW_HOURS = 5;
const MAX_WINDOW_HOURS = 24 * 7;

function normalizeHours(value: any, fallback: number = DEFAULT_WINDOW_HOURS): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, 1), MAX_WINDOW_HOURS);
}

function sinceExpr(hours: any): string {
  const h = normalizeHours(hours);
  return `-${h} hours`;
}

function recordPromptPaste({ backendName, sessionId, contentLength }: { backendName: any; sessionId: any; contentLength: any }): boolean {
  if (!backendName || !sessionId) return false;
  try {
    db.prepare(`
      INSERT INTO agent_prompt_events(backend_name, session_id, content_length)
      VALUES (?, ?, ?)
    `).run(
      String(backendName),
      String(sessionId),
      Math.max(0, Number(contentLength) || 0),
    );
    return true;
  } catch (e) {
    console.warn(`[agent-prompt-events] record failed (${backendName}/${sessionId}): ${e.message}`);
    return false;
  }
}

function statsSince(hours: number = DEFAULT_WINDOW_HOURS): { window_hours: number; since: string; total: number; by_backend: Record<string, number> } {
  const modifier = sinceExpr(hours);
  const total = (db.prepare(`
    SELECT COUNT(*) AS c
    FROM agent_prompt_events
    WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
  `).get(modifier) as { c: number }).c;
  const byBackendRows = db.prepare(`
    SELECT backend_name, COUNT(*) AS count
    FROM agent_prompt_events
    WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
    GROUP BY backend_name
  `).all(modifier) as Array<{ backend_name: string; count: number }>;
  const byBackend: Record<string, number> = {};
  for (const row of byBackendRows) byBackend[row.backend_name] = row.count;
  const since = (db.prepare(`
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) AS since
  `).get(modifier) as { since: string }).since;
  return {
    window_hours: normalizeHours(hours),
    since,
    total,
    by_backend: byBackend,
  };
}

function countsBySessionSince(hours: number = DEFAULT_WINDOW_HOURS): Map<string, number> {
  const modifier = sinceExpr(hours);
  const rows = db.prepare(`
    SELECT session_id, COUNT(*) AS count
    FROM agent_prompt_events
    WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
    GROUP BY session_id
  `).all(modifier) as Array<{ session_id: string; count: number }>;
  return new Map(rows.map((row) => [row.session_id, row.count]));
}

function statsSinceMinutes(minutes: number = 2): { window_minutes: number; by_backend: Record<string, number> } {
  const m = Math.max(1, Math.round(Number(minutes) || 2));
  const modifier = `-${m} minutes`;
  const byBackendRows = db.prepare(`
    SELECT backend_name, COUNT(*) AS count
    FROM agent_prompt_events
    WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
    GROUP BY backend_name
  `).all(modifier) as Array<{ backend_name: string; count: number }>;
  const byBackend: Record<string, number> = {};
  for (const row of byBackendRows) byBackend[row.backend_name] = row.count;
  return { window_minutes: m, by_backend: byBackend };
}

export {
  DEFAULT_WINDOW_HOURS,
  normalizeHours,
  recordPromptPaste,
  statsSince,
  statsSinceMinutes,
  countsBySessionSince,
};
