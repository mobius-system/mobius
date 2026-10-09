import { db } from '../../db';

export type ScheduledWakeupMode = 'once' | 'interval';

export interface ScheduledWakeupRow {
  id: string;
  user_id: string;
  session_id: string;
  mode: ScheduledWakeupMode;
  schedule_seconds: number;
  reminder: string;
  status: 'active' | 'completed' | 'cancelled';
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledWakeupRunRow {
  id: number;
  wakeup_id: string;
  scheduled_for: string;
  status: 'dispatching' | 'ok' | 'error';
  turn_number: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const insertWakeup = db.prepare(`
  INSERT INTO scheduled_wakeups
    (id, user_id, session_id, mode, schedule_seconds, reminder, next_run_at)
  VALUES
    (@id, @user_id, @session_id, @mode, @schedule_seconds, @reminder, @next_run_at)
`);

const claimDueTransaction = db.transaction((id: string, nowIso: string) => {
  const row = db.prepare(`
    SELECT * FROM scheduled_wakeups
    WHERE id = ? AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
  `).get(id, nowIso) as ScheduledWakeupRow | undefined;
  if (!row || !row.next_run_at) return null;

  const inserted = db.prepare(`
    INSERT OR IGNORE INTO scheduled_wakeup_runs (wakeup_id, scheduled_for, status)
    VALUES (?, ?, 'dispatching')
  `).run(row.id, row.next_run_at);
  if (inserted.changes !== 1) return null;

  if (row.mode === 'once') {
    db.prepare(`
      UPDATE scheduled_wakeups
      SET status = 'completed', next_run_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(row.id);
  } else {
    const intervalMs = row.schedule_seconds * 1000;
    let nextMs = Date.parse(row.next_run_at) + intervalMs;
    const currentMs = Date.parse(nowIso);
    if (nextMs <= currentMs) {
      nextMs += (Math.floor((currentMs - nextMs) / intervalMs) + 1) * intervalMs;
    }
    db.prepare(`
      UPDATE scheduled_wakeups
      SET next_run_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(new Date(nextMs).toISOString(), row.id);
  }

  return row;
});

/*
 * Persist and query scheduled wake-ups while keeping all user scoping in one repository.
 */
const ScheduledWakeups = {
  create(input: {
    id: string;
    user_id: string;
    session_id: string;
    mode: ScheduledWakeupMode;
    schedule_seconds: number;
    reminder: string;
    next_run_at: string;
  }): ScheduledWakeupRow {
    insertWakeup.run(input);
    return db.prepare('SELECT * FROM scheduled_wakeups WHERE id = ?').get(input.id) as ScheduledWakeupRow;
  },

  listActiveForUser(userId: string): ScheduledWakeupRow[] {
    return db.prepare(`
      SELECT * FROM scheduled_wakeups
      WHERE user_id = ? AND status = 'active'
      ORDER BY next_run_at ASC, created_at ASC
    `).all(userId) as ScheduledWakeupRow[];
  },

  cancelActiveForSession(userId: string, sessionId: string): number {
    return db.prepare(`
      UPDATE scheduled_wakeups
      SET status = 'cancelled', next_run_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_id = ? AND session_id = ? AND status = 'active'
    `).run(userId, sessionId).changes;
  },

  listDue(nowIso: string, limit = 100): ScheduledWakeupRow[] {
    return db.prepare(`
      SELECT * FROM scheduled_wakeups
      WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC
      LIMIT ?
    `).all(nowIso, limit) as ScheduledWakeupRow[];
  },

  claimDue(id: string, nowIso: string): ScheduledWakeupRow | null {
    return claimDueTransaction(id, nowIso) as ScheduledWakeupRow | null;
  },

  finishRun(id: string, scheduledFor: string, result: { ok: boolean; turnNumber?: number | null; error?: string }): void {
    const finishedAt = new Date().toISOString();
    db.transaction(() => {
      db.prepare(`
        UPDATE scheduled_wakeup_runs
        SET status = ?, turn_number = ?, error = ?, finished_at = ?
        WHERE wakeup_id = ? AND scheduled_for = ?
      `).run(result.ok ? 'ok' : 'error', result.turnNumber || null, result.error || null, finishedAt, id, scheduledFor);
      db.prepare(`
        UPDATE scheduled_wakeups
        SET last_run_at = ?, last_status = ?, last_error = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `).run(finishedAt, result.ok ? 'ok' : 'error', result.error || null, id);
    })();
  },

  listRuns(id: string, limit = 20): ScheduledWakeupRunRow[] {
    return db.prepare(`
      SELECT * FROM scheduled_wakeup_runs
      WHERE wakeup_id = ? ORDER BY id DESC LIMIT ?
    `).all(id, limit) as ScheduledWakeupRunRow[];
  },
};

export { ScheduledWakeups };
