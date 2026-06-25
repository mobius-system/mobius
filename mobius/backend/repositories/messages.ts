import { db } from '../../db';
import type { MessageRow } from '../types/rows';

interface RecentResult {
  messages: MessageRow[];
  total: number;
}

interface TurnRow {
  turn_number: number;
  turn_summary: string | null;
  created_at: string;
  user_input: string | null;
  agent_output: string | null;
}

const Messages = {
  insertUser: (taskId: string, content: string, turnNumber: number) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, turn_number) VALUES (?, ?, ?, ?)'
  ).run(taskId, 'user', content, turnNumber),

  // system 消息支持 turn_summary 字段, 用于 stop 终止信号、permission 持久化等
  insertSystem: (taskId: string, content: string, turnNumber: number, turnSummary: string | null) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, turn_number, turn_summary) VALUES (?, ?, ?, ?, ?)'
  ).run(taskId, 'system', content, turnNumber, turnSummary),

  // ─── v2 直连专属: 从 SDK 事件流落库 ────────────────────────────────
  insertAssistant: (taskId: string, content: string, turnNumber: number) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, turn_number) VALUES (?, ?, ?, ?)'
  ).run(taskId, 'assistant', content, turnNumber),

  insertAssistantWithRaw: (taskId: string, content: string, rawEvent: string | null, turnNumber: number) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, raw_event, turn_number) VALUES (?, ?, ?, ?, ?)'
  ).run(taskId, 'assistant', content, rawEvent || null, turnNumber),

  insertThinking: (taskId: string, content: string, turnNumber: number) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, turn_number) VALUES (?, ?, ?, ?)'
  ).run(taskId, 'thinking', content, turnNumber),

  insertTool: (taskId: string, summary: string, status: string | null, turnNumber: number) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, tool_summary, tool_status, turn_number) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(taskId, 'tool', summary, summary, status, turnNumber),

  insertToolWithContent: (taskId: string, summary: string, content: string, status: string | null, turnNumber: number) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, tool_summary, tool_status, turn_number) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(taskId, 'tool', content, summary, status, turnNumber),

  insertToolResult: (taskId: string, content: string, status: string | null, turnNumber: number) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, tool_status, turn_number) VALUES (?, ?, ?, ?, ?)'
  ).run(taskId, 'tool', content, status, turnNumber),

  // ⭐ 未知 SDK 事件兜底
  insertRaw: (taskId: string, rawJson: string, turnNumber: number) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, raw_event, turn_number) VALUES (?, ?, ?, ?, ?)'
  ).run(taskId, 'raw', '(unknown SDK event)', rawJson, turnNumber),

  // 主对话框 history 回灌
  listForTask: (taskId: string, limit: number = 200): MessageRow[] => db.prepare(
    'SELECT * FROM messages_v2 WHERE task_id = ? ORDER BY id ASC LIMIT ?'
  ).all(taskId, limit) as MessageRow[],

  userInputsForTask: (taskId: string): Array<{ id: number; content: string; created_at: string; turn_number: number | null }> => db.prepare(
    "SELECT id, content, created_at, turn_number FROM messages_v2 WHERE task_id = ? AND role = 'user' ORDER BY id ASC"
  ).all(taskId) as Array<{ id: number; content: string; created_at: string; turn_number: number | null }>,

  // limit 语义:
  //   > 0 -> 取最近 limit 条(按 id DESC 后 reverse,保持时序)
  //   <=0 / undefined / null / 'all' -> 全量返回(按 id ASC 时序),主对话框展示该 session 全部 segment
  recentForTask: (taskId: string, limit: unknown): RecentResult => {
    const total = db.prepare('SELECT COUNT(*) as c FROM messages_v2 WHERE task_id = ?').get(taskId) as { c: number };
    const parsed = parseInt(limit as string, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      const messages = db.prepare('SELECT * FROM messages_v2 WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, parsed) as MessageRow[];
      return { messages: messages.reverse(), total: total.c };
    }
    const messages = db.prepare('SELECT * FROM messages_v2 WHERE task_id = ? ORDER BY id ASC').all(taskId) as MessageRow[];
    return { messages, total: total.c };
  },

  countAll: (): number => (db.prepare('SELECT COUNT(*) as c FROM messages_v2').get() as { c: number }).c,

  deleteForTask: (taskId: string) => db.prepare(
    'DELETE FROM messages_v2 WHERE task_id = ?'
  ).run(taskId),

  findWithUser: (id: number): (MessageRow & { user_id: string }) | undefined => db.prepare(
    'SELECT m.*, t.user_id FROM messages_v2 m JOIN sessions_v2 t ON m.task_id = t.session_id WHERE m.id = ?'
  ).get(id) as (MessageRow & { user_id: string }) | undefined,

  setBookmark: (id: number, val: number) => db.prepare('UPDATE messages_v2 SET bookmarked = ? WHERE id = ?').run(val, id),

  bookmarksForTask: (taskId: string): Array<{ id: number; role: string; content: string; created_at: string }> => db.prepare(
    'SELECT id, role, content, created_at FROM messages_v2 WHERE task_id = ? AND bookmarked = 1 ORDER BY id'
  ).all(taskId) as Array<{ id: number; role: string; content: string; created_at: string }>,

  maxTurnFor: (taskId: string): number => {
    const r = db.prepare("SELECT MAX(turn_number) as max_t FROM messages_v2 WHERE task_id = ?").get(taskId) as { max_t: number | null } | undefined;
    return r?.max_t || 0;
  },

  countUserMessagesFor: (taskId: string): number => (db.prepare(
    "SELECT COUNT(*) as cnt FROM messages_v2 WHERE task_id = ? AND role = 'user'"
  ).get(taskId) as { cnt: number }).cnt,

  turnsForSession: (sessionId: string): TurnRow[] => db.prepare(`
    SELECT turn_number, turn_summary, created_at,
      (SELECT content FROM messages_v2 WHERE task_id = ? AND turn_number = m.turn_number AND role = 'user' ORDER BY id ASC LIMIT 1) as user_input,
      (SELECT content FROM messages_v2 WHERE task_id = ? AND turn_number = m.turn_number AND role = 'assistant' ORDER BY id DESC LIMIT 1) as agent_output
    FROM messages_v2 m
    WHERE task_id = ? AND turn_number IS NOT NULL
    GROUP BY turn_number
    ORDER BY MIN(id)
  `).all(sessionId, sessionId, sessionId) as TurnRow[],

  // 用于 turn-summary polling 与变更扫描
  findLastAssistantInTurn: (taskId: string, turnNum: number): { id: number } | undefined => db.prepare(
    "SELECT id FROM messages_v2 WHERE task_id = ? AND turn_number = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1"
  ).get(taskId, turnNum) as { id: number } | undefined,

  updateTurnSummary: (id: number, summary: string) => db.prepare("UPDATE messages_v2 SET turn_summary = ? WHERE id = ?").run(summary, id),

  recentContentForSession: (sessionId: string, limit: number = 80): Array<{ content: string }> => db.prepare(
    "SELECT content FROM messages_v2 WHERE task_id = ? ORDER BY id DESC LIMIT ?"
  ).all(sessionId, limit) as Array<{ content: string }>,

  latestAssistantOrTool: (sessionId: string): { content: string } | undefined => db.prepare(
    "SELECT content FROM messages_v2 WHERE task_id = ? AND role IN ('assistant','tool') ORDER BY id DESC LIMIT 1"
  ).get(sessionId) as { content: string } | undefined,
};

export { Messages };
