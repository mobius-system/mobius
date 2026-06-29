import { randomUUID } from 'crypto';
import { db } from '../../db';
import type * as BetterSqlite3 from 'better-sqlite3';
import { Sessions } from './sessions';

// 群聊数据访问层. 见 db.ts:migrateConversations 的表结构说明.
// 成员分两类: 'user'(真人, member_id=users.id) 与 'agent'(小莫/分身, member_id=session_id).

interface RepoError extends Error {
  status: number;
}

function repoError(message: string, status: number = 400): RepoError {
  const e = new Error(message) as RepoError;
  e.status = status;
  return e;
}

export type MemberType = 'user' | 'agent';
export type MemberRole = 'owner' | 'member';

export interface MemberInput {
  type: MemberType;
  id: string; // user 成员=users.id; agent 成员=session_id
  display_name?: string;
  agent_session_id?: string; // agent 成员触发任务用的 session_id(默认等于 id)
}

export interface MemberRow {
  id: number;
  conversation_id: string;
  member_type: MemberType;
  member_id: string;
  display_name: string;
  role: MemberRole;
  agent_session_id: string | null;
  agent_owner_id: string | null;
  joined_at: string;
}

function makeConversationId(): string {
  return `conv_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

// agent 成员的 owner 与显示名从 sessions_v2 反查 (跨用户时 agent_owner_id 用于授权).
function resolveAgentMeta(sessionId: string): { ownerId: string | null; name: string | null } {
  try {
    const s = Sessions.findById(sessionId) as { user_id?: string; name?: string } | undefined;
    if (!s) return { ownerId: null, name: null };
    return { ownerId: s.user_id || null, name: s.name || null };
  } catch {
    return { ownerId: null, name: null };
  }
}

const insertMemberStmt = db.prepare(`
  INSERT INTO conversation_members
    (conversation_id, member_type, member_id, display_name, role, agent_session_id, agent_owner_id)
  VALUES (@conversation_id, @member_type, @member_id, @display_name, @role, @agent_session_id, @agent_owner_id)
  ON CONFLICT(conversation_id, member_type, member_id) DO UPDATE SET
    display_name = excluded.display_name,
    agent_session_id = excluded.agent_session_id,
    agent_owner_id = excluded.agent_owner_id
`) as BetterSqlite3.Statement;

const Conversations = {
  create({ name, ownerId, ownerName, members = [] }: {
    name: string;
    ownerId: string;
    ownerName: string;
    members?: MemberInput[];
  }): { id: string; name: string } {
    const trimmed = String(name || '').trim();
    if (!trimmed) throw repoError('群名称不能为空', 400);
    if (trimmed.length > 60) throw repoError('群名称最多 60 个字符', 400);
    const id = makeConversationId();
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO conversations (id, name, owner_id) VALUES (?, ?, ?)').run(id, trimmed, ownerId);
      insertMemberStmt.run({
        conversation_id: id,
        member_type: 'user',
        member_id: ownerId,
        display_name: ownerName,
        role: 'owner',
        agent_session_id: null,
        agent_owner_id: null,
      });
      for (const m of members) {
        if (m.type === 'user' && m.id === ownerId) continue; // 不重复加群主
        Conversations.addMember(id, m);
      }
    });
    tx();
    return { id, name: trimmed };
  },

  addMember(conversationId: string, m: MemberInput): void {
    const type: MemberType = m.type === 'agent' ? 'agent' : 'user';
    const memberId = String(m.id || '').trim();
    if (!memberId) throw repoError('成员 id 不能为空', 400);
    let displayName = String(m.display_name || '').trim();
    let agentSessionId: string | null = null;
    let agentOwnerId: string | null = null;
    if (type === 'agent') {
      agentSessionId = String(m.agent_session_id || memberId).trim();
      const meta = resolveAgentMeta(agentSessionId);
      agentOwnerId = meta.ownerId;
      if (!displayName) displayName = meta.name || `小莫 ${memberId.slice(0, 6)}`;
    } else {
      if (!displayName) {
        const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(memberId) as { display_name?: string } | undefined;
        displayName = u?.display_name || memberId;
      }
    }
    insertMemberStmt.run({
      conversation_id: conversationId,
      member_type: type,
      member_id: memberId,
      display_name: displayName,
      role: 'member',
      agent_session_id: agentSessionId,
      agent_owner_id: agentOwnerId,
    });
  },

  listForUser(userId: string): Array<Record<string, unknown>> {
    return db.prepare(`
      SELECT c.id, c.name, c.owner_id, c.created_at, c.last_active,
             (SELECT content FROM conversation_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message,
             (SELECT created_at FROM conversation_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message_at,
             (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) AS member_count
      FROM conversations c
      WHERE c.id IN (SELECT conversation_id FROM conversation_members WHERE member_type = 'user' AND member_id = ?)
      ORDER BY c.last_active DESC
    `).all(userId) as Array<Record<string, unknown>>;
  },

  // 查找或创建 1对1 私聊(恰好两个 user 成员, 无 agent).
  findOrCreateDirect(userA: string, userB: string, userAName: string): { id: string; name: string } {
    const row = db.prepare(`
      SELECT conversation_id FROM conversation_members
      WHERE member_type = 'user' AND member_id = ?
        AND conversation_id IN (
          SELECT conversation_id FROM conversation_members WHERE member_type = 'user' AND member_id = ?
        )
        AND conversation_id IN (
          SELECT conversation_id FROM conversation_members GROUP BY conversation_id HAVING COUNT(*) = 2
        )
      LIMIT 1
    `).get(userA, userB) as { conversation_id?: string } | undefined;
    if (row?.conversation_id) {
      const c = db.prepare('SELECT name FROM conversations WHERE id = ?').get(row.conversation_id) as { name?: string } | undefined;
      return { id: row.conversation_id, name: c?.name || '聊天' };
    }
    const otherName = (db.prepare('SELECT display_name FROM users WHERE id = ?').get(userB) as { display_name?: string } | undefined)?.display_name || userB;
    return Conversations.create({ name: otherName, ownerId: userA, ownerName: userAName, members: [{ type: 'user', id: userB }] });
  },

  findById(id: string): Record<string, unknown> | undefined {
    return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  },

  listMembers(conversationId: string): MemberRow[] {
    return db.prepare(
      'SELECT * FROM conversation_members WHERE conversation_id = ? ORDER BY role DESC, joined_at ASC',
    ).all(conversationId) as MemberRow[];
  },

  findMember(conversationId: string, type: MemberType, memberId: string): MemberRow | undefined {
    return db.prepare(
      'SELECT * FROM conversation_members WHERE conversation_id = ? AND member_type = ? AND member_id = ?',
    ).get(conversationId, type, memberId) as MemberRow | undefined;
  },

  isUserMember(conversationId: string, userId: string): boolean {
    return !!db.prepare(
      "SELECT 1 FROM conversation_members WHERE conversation_id = ? AND member_type = 'user' AND member_id = ?",
    ).get(conversationId, userId);
  },

  removeMember(conversationId: string, type: MemberType, memberId: string): number {
    return db.prepare(
      'DELETE FROM conversation_members WHERE conversation_id = ? AND member_type = ? AND member_id = ?',
    ).run(conversationId, type, memberId).changes;
  },

  touch(conversationId: string): void {
    db.prepare(
      "UPDATE conversations SET last_active = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    ).run(conversationId);
  },

  insertMessage(args: {
    conversationId: string;
    senderId: string;
    senderType: 'user' | 'agent';
    senderName: string;
    content: string;
    mentionTargets?: unknown[];
    sourceAgentSession?: string | null;
  }): Record<string, unknown> {
    const mentionTargets = Array.isArray(args.mentionTargets) && args.mentionTargets.length
      ? JSON.stringify(args.mentionTargets)
      : null;
    const info = db.prepare(`
      INSERT INTO conversation_messages
        (conversation_id, sender_id, sender_type, sender_name, content, mention_targets, source_agent_session)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      args.conversationId,
      args.senderId,
      args.senderType,
      args.senderName,
      args.content,
      mentionTargets,
      args.sourceAgentSession ?? null,
    );
    return db.prepare('SELECT * FROM conversation_messages WHERE id = ?').get(info.lastInsertRowid) as Record<string, unknown>;
  },

  // 最近 N 条 (正序). SSE 首次回灌用.
  recentMessages(conversationId: string, limit: number = 50): Array<Record<string, unknown>> {
    const rows = db.prepare(
      'SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?',
    ).all(conversationId, limit) as Array<Record<string, unknown>>;
    return rows.reverse();
  },

  // id > sinceId 的增量 (正序). SSE 轮询用.
  listMessagesSince(conversationId: string, sinceId: number, limit: number = 200): Array<Record<string, unknown>> {
    return db.prepare(
      'SELECT * FROM conversation_messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
    ).all(conversationId, sinceId, limit) as Array<Record<string, unknown>>;
  },
};

export { Conversations };
