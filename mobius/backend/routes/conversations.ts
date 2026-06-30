import express from 'express';
import { auth, authOrQuery } from '../middleware/auth';
import { Conversations } from '../repositories/conversations';
import type { MemberInput, MemberType } from '../repositories/conversations';
import { runSessionMessage } from '../services/session-message-runner';
import { Sessions } from '../repositories/sessions';
import { Users } from '../repositories/users';
import { db } from '../../db';
import fs from 'fs';
import agents from '../agents';
import modelRegistry from '../services/model-registry';
import { randomUUID } from 'crypto';

const router = express.Router();

function userOf(req: express.Request): any {
  return (req as any).user;
}

function isMemberOnline(lastSeen?: string | null): boolean {
  if (!lastSeen) return false;
  const t = Date.parse(lastSeen);
  return !isNaN(t) && Date.now() - t < 6000;
}

function listMembersWithOnline(conversationId: string) {
  return Conversations.listMembers(conversationId).map((m: any) => ({
    ...m,
    online: m.member_type === 'agent' ? true : isMemberOnline(m.last_seen_at),
  }));
}

function normalizeMember(raw: any): MemberInput | null {
  if (!raw) return null;
  const type: MemberType = raw.type === 'agent' ? 'agent' : 'user';
  const id = String(raw.id || '').trim();
  if (!id) return null;
  return {
    type,
    id,
    display_name: typeof raw.display_name === 'string' ? raw.display_name : undefined,
    agent_session_id: typeof raw.agent_session_id === 'string' ? raw.agent_session_id : undefined,
  };
}

// 我的群列表 (按最近活跃排序)
router.get('/', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  res.json({ conversations: Conversations.listForUser(user.id) });
});

// 建群: { name, members: [{ type:'user'|'agent', id, display_name?, agent_session_id? }] }
// 群主(当前用户)自动作为 owner 成员加入, 也会出现在 members 里则去重.
router.post('/', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const body = (req.body || {}) as { name?: string; members?: any[] };
  const members: MemberInput[] = Array.isArray(body.members)
    ? body.members.map(normalizeMember).filter((m): m is MemberInput => m !== null)
    : [];
  try {
    const created = Conversations.create({
      name: String(body.name || ''),
      ownerId: user.id,
      ownerName: user.display_name || user.id,
      members,
    });
    res.status(201).json({ id: created.id, name: created.name });
  } catch (e) {
    const err = e as RepoError;
    res.status(err.status || 400).json({ error: err.message || '建群失败' });
  }
});

// 发起/查找 1对1 私聊: POST /direct { member_id }. 1对1 = 恰好两个 user 成员的 conversation.
router.post('/direct', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const otherId = String((req.body || {}).member_id || '').trim();
  if (!otherId) { res.status(400).json({ error: 'member_id 不能为空' }); return; }
  if (otherId === user.id) { res.status(400).json({ error: '不能和自己私聊' }); return; }
  try {
    const conv = Conversations.findOrCreateDirect(user.id, otherId, user.display_name || user.id);
    res.json({ id: conv.id, name: conv.name });
  } catch (e) {
    const err = e as RepoError;
    res.status(err.status || 400).json({ error: err.message || '创建私聊失败' });
  }
});

// 群详情 + 成员列表 (仅成员可见)
router.get('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  const conv = Conversations.findById(id);
  if (!conv) {
    res.status(404).json({ error: '群不存在' });
    return;
  }
  if (!Conversations.isUserMember(id, user.id)) {
    res.status(403).json({ error: '你不是该群成员' });
    return;
  }
  res.json({ conversation: conv, members: listMembersWithOnline(id) });
});

// 邀请成员 (仅群主)
router.post('/:id/members', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  const me = Conversations.findMember(id, 'user', user.id);
  if (!me) {
    res.status(403).json({ error: '你不是该群成员' });
    return;
  }
  if (me.role !== 'owner') {
    res.status(403).json({ error: '仅群主可邀请成员' });
    return;
  }
  const member = normalizeMember((req.body || {}));
  if (!member) {
    res.status(400).json({ error: '成员 type/id 不能为空' });
    return;
  }
  try {
    Conversations.addMember(id, member);
    res.status(201).json({ ok: true });
  } catch (e) {
    const err = e as RepoError;
    res.status(err.status || 400).json({ error: err.message });
  }
});

// 退群 / 移除成员: DELETE /:id/members/:memberType/:memberId
// 退自己随时; 踢别人仅群主; 群主不可自退(需先转让).
router.delete('/:id/members/:memberType/:memberId', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  const memberType: MemberType = req.params.memberType === 'agent' ? 'agent' : 'user';
  const memberId = String(req.params.memberId);
  const me = Conversations.findMember(id, 'user', user.id);
  if (!me) {
    res.status(403).json({ error: '你不是该群成员' });
    return;
  }
  const isSelf = memberType === 'user' && memberId === user.id;
  if (me.role === 'owner' && isSelf) {
    res.status(400).json({ error: '群主请先转让群主或解散群' });
    return;
  }
  if (!isSelf && me.role !== 'owner') {
    res.status(403).json({ error: '仅群主可移除其他成员' });
    return;
  }
  const changes = Conversations.removeMember(id, memberType, memberId);
  res.json({ ok: true, removed: changes });
});

// 标准帧: event: <name>\ndata: <json>\n\n
// P3: 群内 @agent 触发. 用 agent owner 身份 runSessionMessage(跨用户授权 = 该 agent 在群成员表里).
async function triggerAgentMentions(params: {
  conversationId: string;
  conversationName: string;
  senderName: string;
  rawContent: string;
  mentions: any[];
}): Promise<void> {
  for (const m of params.mentions) {
    if (!m || m.type !== 'agent') continue;
    const memberId = String(m.id || '').trim();
    if (!memberId) continue;
    const member = Conversations.findMember(params.conversationId, 'agent', memberId);
    if (!member) continue; // 不在群里 = 未授权, 忽略
    const agentSessionId = member.agent_session_id || memberId;
    const ownerId = member.agent_owner_id;
    if (!ownerId) continue;
    const ownerUser = Users.findAuthById(ownerId);
    if (!ownerUser) continue;
    // 用临时分身执行(不污染主小莫 1对1 历史). 分身复用主小莫的 issue/project/model 配置.
    const agentSess = Sessions.findById(agentSessionId) as any;
    if (!agentSess) continue;
    const cloneId = `gm${randomUUID().slice(0, 8)}`;
    const taskPrompt = `（群聊「${params.conversationName}」中 ${params.senderName} @你，请处理并给出简洁结果）\n${params.rawContent}`;
    try {
      Sessions.insert({
        session_id: cloneId,
        issue_id: agentSess.issue_id,
        project_id: agentSess.project_id,
        scope_type: 'issue',
        user_id: ownerId,
        name: `${member.display_name}·群聊任务`,
        description: `群聊「${params.conversationName}」@任务`,
        session_key: `group-mention:${agentSessionId}:${cloneId}`,
        model: agentSess.model,
        language: agentSess.language || 'zh',
      } as any);
      const baselineLines = readJsonlLineCount(cloneId);
      await runSessionMessage({
        user: ownerUser,
        sessionId: cloneId,
        content: taskPrompt,
        inputText: taskPrompt,
        hasInputText: true,
        source: 'group.mention',
      } as any);
      watchAgentReply({
        conversationId: params.conversationId,
        agentSessionId: cloneId,
        agentDisplayName: member.display_name,
        baselineLines,
        isClone: true,
      });
    } catch (e) {
      try {
        Conversations.insertMessage({
          conversationId: params.conversationId,
          senderId: agentSessionId,
          senderType: 'agent',
          senderName: member.display_name,
          content: `⚠️ 触发失败: ${(e as Error).message || e}`,
          sourceAgentSession: agentSessionId,
        });
        Conversations.touch(params.conversationId);
      } catch {}
    }
  }
}

// agent 的 assistant 回复走 jsonl 文件(不进 messages_v2), 故用 backend 解析其路径.
function resolveAgentJsonlPath(sessionId: string): string | null {
  try {
    const sess = Sessions.findById(sessionId) as any;
    if (!sess) return null;
    const launch = modelRegistry.launchOptionsForSession(sess);
    const backend = agents.get(launch.backend);
    return typeof backend?._resolveJsonlPath === 'function' ? (backend._resolveJsonlPath(sessionId) as string) : null;
  } catch {
    return null;
  }
}

function readJsonlLineCount(sessionId: string): number {
  const p = resolveAgentJsonlPath(sessionId);
  if (!p || !fs.existsSync(p)) return 0;
  try {
    return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

// 从 jsonl 的 baselineLines(触发前)之后, 读最近一条 assistant 文本.
function readLatestAssistantText(sessionId: string, baselineLines: number): string | null {
  const p = resolveAgentJsonlPath(sessionId);
  if (!p || !fs.existsSync(p)) return null;
  let lines: string[];
  try {
    lines = fs.readFileSync(p, 'utf8').split('\n');
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= baselineLines; i--) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'assistant') continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content.filter((c: any) => c?.type === 'text').map((c: any) => c?.text || '').join('').trim();
    if (text) return text;
  }
  return null;
}

// 轮询 agent 的 jsonl; 触发后(baselineLines 之后)出现 assistant 回复即回写群消息.
// 不查 messages_v2(assistant 不进它), 不依赖 agent_status 状态机(会错过快速 running).
function watchAgentReply(p: {
  conversationId: string;
  agentSessionId: string;
  agentDisplayName: string;
  baselineLines: number;
  isClone?: boolean;
}): void {
  let ticks = 0;
  // 临时分身用完即弃(软删除), 避免残留在分身列表里.
  const cleanupClone = () => {
    if (p.isClone) {
      try { Sessions.updateStatus(p.agentSessionId, 'deleted' as any); } catch {}
    }
  };
  const timer = setInterval(() => {
    ticks++;
    const text = readLatestAssistantText(p.agentSessionId, p.baselineLines);
    if (text) {
      clearInterval(timer);
      try {
        Conversations.insertMessage({
          conversationId: p.conversationId,
          senderId: p.agentSessionId,
          senderType: 'agent',
          senderName: p.agentDisplayName,
          content: text,
          sourceAgentSession: p.agentSessionId,
        });
        Conversations.touch(p.conversationId);
      } catch {}
      cleanupClone();
      return;
    }
    if (ticks >= 150) { clearInterval(timer); cleanupClone(); } // 最多 ~5 分钟
  }, 2000);
}

function sseWrite(res: express.Response, event: string, data: unknown): boolean {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

// 发群消息 (真人). mention_targets 暂存, P3 在此触发 @agent 执行任务.
router.post('/:id/messages', auth, (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  if (!Conversations.isUserMember(id, user.id)) {
    res.status(403).json({ error: '你不是该群成员' });
    return;
  }
  const content = String(req.body?.content || '').trim();
  if (!content) {
    res.status(400).json({ error: '内容不能为空' });
    return;
  }
  if (content.length > 8000) {
    res.status(400).json({ error: '单条消息过长' });
    return;
  }
  const mentions = Array.isArray(req.body?.mentions) ? req.body.mentions : [];
  const msg = Conversations.insertMessage({
    conversationId: id,
    senderId: user.id,
    senderType: 'user',
    senderName: user.display_name || user.id,
    content,
    mentionTargets: mentions,
  });
  Conversations.touch(id);
  res.status(201).json({ ok: true, message: msg });

  // P3: @agent 触发 —— 用该 agent 的 owner 身份调 runSessionMessage(owner 触发自己的 agent, 天然过 canOperateSession);
  // 跨用户授权依据 = "该 agent 是当前群成员"(建群时被邀请). fire-and-forget, 不阻塞 201 响应.
  if (mentions.length) {
    void triggerAgentMentions({
      conversationId: id,
      conversationName: (Conversations.findById(id) as { name?: string } | undefined)?.name || '群聊',
      senderName: user.display_name || user.id,
      rawContent: content,
      mentions,
    });
  }
});

// 群消息 SSE: 回灌最近 50 条 + 每 1.5s 轮询增量广播.
// 真人消息与 agent 回传(P3)都写入 conversation_messages, 故 SSE 自然都能取到.
router.get('/:id/events', authOrQuery, async (req: express.Request, res: express.Response) => {
  const user = userOf(req);
  const id = String(req.params.id);
  if (!Conversations.findById(id)) {
    res.status(404).json({ error: '群不存在' });
    return;
  }
  if (!Conversations.isUserMember(id, user.id)) {
    res.status(403).json({ error: '你不是该群成员' });
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (req.socket) req.socket.setTimeout(0);

  let closed = false;
  let poll: NodeJS.Timeout;
  let keepalive: NodeJS.Timeout;
  const cleanup = () => {
    closed = true;
    if (poll) clearInterval(poll);
    if (keepalive) clearInterval(keepalive);
  };
  res.on('close', cleanup);

  const recent = Conversations.recentMessages(id, 50);
  let lastId: number = recent.length ? (recent[recent.length - 1] as { id: number }).id : 0;
  sseWrite(res, 'history', { messages: recent });
  sseWrite(res, 'ready', { last_id: lastId });

  poll = setInterval(() => {
    if (closed) return;
    Conversations.touchMemberPresence(id, user.id);
    const newer = Conversations.listMessagesSince(id, lastId, 200);
    if (!newer.length) return;
    for (const m of newer) {
      if (!sseWrite(res, 'message', m)) {
        cleanup();
        return;
      }
    }
    lastId = (newer[newer.length - 1] as { id: number }).id;
  }, 1500);
  keepalive = setInterval(() => {
    if (!closed) sseWrite(res, 'keepalive', { ts: Date.now() });
  }, 25000);
});

export = router;

interface RepoError extends Error {
  status?: number;
}
