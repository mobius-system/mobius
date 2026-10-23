/**
 * session-reminder-store.ts — the disposable cooldown cache behind session reminders.
 *
 * The table is a cache, not business data: deleting any row only means the same
 * reminder may appear once more. Writes happen only when a reminder is actually
 * shown, so a chatty session does not write on every tool call.
 */

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS session_reminder_cache (
    session_id     TEXT NOT NULL,
    reminder_type  TEXT NOT NULL,
    last_shown_at  TEXT NOT NULL,
    shown_count    INTEGER NOT NULL DEFAULT 1,
    last_tool_name TEXT,
    PRIMARY KEY (session_id, reminder_type)
  )
`;

export interface ReminderStore {
  /** ISO timestamp of the last shown reminder, or null when never shown. */
  lastShownAt(sessionId: string, reminderType: string): string | null;
  /** Record that a reminder was shown now. Upserts the cooldown row. */
  recordShown(input: { sessionId: string; reminderType: string; toolName?: string | null; at?: string }): void;
  /** Delete cache rows; returns how many were removed. */
  clear(sessionId: string, reminderType?: string): number;
}

/**
 * Build a store over any better-sqlite3-compatible database.
 * Tests pass an in-memory database; the app uses the shared one.
 */
export function createReminderStore(database: any): ReminderStore {
  database.exec(CREATE_SQL);

  const selectStmt = database.prepare(
    'SELECT last_shown_at FROM session_reminder_cache WHERE session_id = ? AND reminder_type = ?',
  );
  const upsertStmt = database.prepare(`
    INSERT INTO session_reminder_cache (session_id, reminder_type, last_shown_at, shown_count, last_tool_name)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(session_id, reminder_type) DO UPDATE SET
      last_shown_at  = excluded.last_shown_at,
      shown_count    = session_reminder_cache.shown_count + 1,
      last_tool_name = excluded.last_tool_name
  `);
  const clearBothStmt = database.prepare(
    'DELETE FROM session_reminder_cache WHERE session_id = ? AND reminder_type = ?',
  );
  const clearAllStmt = database.prepare('DELETE FROM session_reminder_cache WHERE session_id = ?');

  return {
    lastShownAt(sessionId, reminderType) {
      const row = selectStmt.get(String(sessionId), String(reminderType)) as { last_shown_at?: string } | undefined;
      return row?.last_shown_at || null;
    },
    recordShown({ sessionId, reminderType, toolName, at }) {
      upsertStmt.run(
        String(sessionId),
        String(reminderType),
        String(at || new Date().toISOString()),
        toolName ? String(toolName) : null,
      );
    },
    clear(sessionId, reminderType) {
      const result = reminderType
        ? clearBothStmt.run(String(sessionId), String(reminderType))
        : clearAllStmt.run(String(sessionId));
      return Number(result?.changes || 0);
    },
  };
}
