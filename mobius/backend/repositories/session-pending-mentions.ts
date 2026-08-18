import { db } from '../../db';

export type PendingSessionMention = {
  kind: 'agent';
  session_id: string;
  mode: 'read_only' | 'bidirectional';
};

export function normalizePendingSessionMentions(value: unknown): PendingSessionMention[] {
  if (!Array.isArray(value)) return [];
  const result: PendingSessionMention[] = [];
  const indexBySession = new Map<string, number>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as any;
    const kind = String(row.kind || row.type || '').trim();
    if (kind !== 'agent') continue;
    const sessionId = String(row.session_id || row.sessionId || row.id || '').trim();
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(sessionId)) continue;
    const mode = String(row.mode || row.mention_mode || '').trim() === 'bidirectional'
      ? 'bidirectional'
      : 'read_only';
    const existingIndex = indexBySession.get(sessionId);
    if (existingIndex != null) {
      if (mode === 'bidirectional') result[existingIndex] = { kind: 'agent', session_id: sessionId, mode };
      continue;
    }
    indexBySession.set(sessionId, result.length);
    result.push({ kind: 'agent', session_id: sessionId, mode });
  }
  return result;
}

export const SessionPendingMentions = {
  save(sessionId: string, value: unknown): PendingSessionMention[] {
    const mentions = normalizePendingSessionMentions(value);
    if (!sessionId) return [];
    if (mentions.length === 0) {
      db.prepare('DELETE FROM session_pending_mentions WHERE session_id = ?').run(sessionId);
      return [];
    }
    db.prepare(`
      INSERT INTO session_pending_mentions(session_id, mentions_json)
      VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        mentions_json = excluded.mentions_json,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(sessionId, JSON.stringify(mentions));
    return mentions;
  },

  find(sessionId: string): PendingSessionMention[] {
    if (!sessionId) return [];
    const row = db.prepare('SELECT mentions_json FROM session_pending_mentions WHERE session_id = ?')
      .get(sessionId) as { mentions_json?: string } | undefined;
    if (!row?.mentions_json) return [];
    try {
      return normalizePendingSessionMentions(JSON.parse(row.mentions_json));
    } catch {
      return [];
    }
  },

  clear(sessionId: string): void {
    if (!sessionId) return;
    db.prepare('DELETE FROM session_pending_mentions WHERE session_id = ?').run(sessionId);
  },
};
