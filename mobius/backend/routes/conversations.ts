import express from 'express';
import { auth, authOrQuery } from '../middleware/auth';
import { Conversations } from '../repositories/conversations';
import type { MemberInput, MemberType } from '../repositories/conversations';
import { runSessionMessage } from '../services/session-message-runner';
// 群消息推送: 给离线(无 SSE)成员远程推送
import { pushToUser as pushToUserExt } from '../services/extension-push';
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
  return Conversations.listMembers(conversationId).map((m: any) => {
    const agentOwnerName = m.member_type === 'agent' && m.agent_owner_id
      ? ((db.prepare('SELECT display_name FROM users WHERE id = ?').get(m.agent_owner_id) as { display_name?: string } | undefined)?.display_name || null)
      : null;
    return {
      ...m,
      online: m.member_type === 'agent' ? true : isMemberOnline(m.last_seen_at),
      agent_owner_name: agentOwnerName,
    };
  });
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
  Conversations.markRead(id, user.id);
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
        agentDisplayName: `${ownerUser.display_name || ownerId}·${String(member.display_name || '小莫').replace(/^我的/, '')}`,
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

// 从 jsonl 的 baselineLines(触发前)之后, 读取**所有** assistant 文本并合并, 同时返回当前行数.
// 合并规则: claude-code 流式可能 emit 多条 assistant(内容累积增长), 若后一条包含前一条则取后者(完整),
// 否则用空行拼接(多条独立回复). 返回行数供 watchAgentReply 判断 agent 是否停止写入.
function readAllAssistantText(sessionId: string, baselineLines: number): { text: string | null; lineCount: number } {
  const p = resolveAgentJsonlPath(sessionId);
  if (!p || !fs.existsSync(p)) return { text: null, lineCount: 0 };
  let lines: string[];
  try {
    lines = fs.readFileSync(p, 'utf8').split('\n');
  } catch {
    return { text: null, lineCount: 0 };
  }
  const texts: string[] = [];
  for (let i = baselineLines; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== 'assistant') continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    const t = content.filter((c: any) => c?.type === 'text').map((c: any) => c?.text || '').join('').trim();
    if (t) texts.push(t);
  }
  let text: string | null = null;
  if (texts.length === 1) {
    text = texts[0];
  } else if (texts.length > 1) {
    const last = texts[texts.length - 1];
    const prev = texts[texts.length - 2];
    text = last.includes(prev) ? last : texts.join('\n\n');
  }
  return { text, lineCount: lines.length };
}

// 等 agent 的 turn 完成后, 把**完整**回复回写群聊(经群 SSE 广播给所有成员).
// 用 jsonl 轮询 + text 内容稳定判断: readAllAssistantText 读 agent 的 transcript jsonl
// (claude-code turn 结束才写入带 stop_reason 的完整 assistant), 连续 3 次(6s) text 不变即写完, 回写.
// 轮询能自愈"订阅时序"——runSessionMessage 是 fire-and-forget, watchAgentReply 调用时 runtime/jsonl
// 可能还没就绪, 前几次 readAll 返回 null, 就绪后即读到完整回复. 不用 thought stream 订阅(其在 runtime
// 未就绪时订阅会空等到超时), 也不用"行数稳定"(claude-code 流式可能覆盖式更新最后一条 assistant,
// 行数不变内容变). 实测 turn-complete entry(assistant+stop_reason=end_turn)的 text 是完整回复.
function watchAgentReply(p: {
  conversationId: string;
  agentSessionId: string;
  agentDisplayName: string;
  baselineLines: number;
  isClone?: boolean;
}): void {
  const cleanupClone = () => {
    if (p.isClone) {
      try { Sessions.updateStatus(p.agentSessionId, 'deleted' as any); } catch {}
    }
  };
  const writeBack = (text: string | null) => {
    if (!text) return;
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
  };

  // jsonl 轮询, 等 text 内容连续稳定(agent 写完)再回写.
  let ticks = 0;
  let lastText: string | null = null;
  let stableTicks = 0;
  const timer = setInterval(() => {
    ticks++;
    const { text } = readAllAssistantText(p.agentSessionId, p.baselineLines);
    if (text && text === lastText) {
      stableTicks++;
    } else {
      stableTicks = 0;
    }
    lastText = text;
    const settled = stableTicks >= 3; // text 内容连续 3 次(6s)不变 → agent 已写完
    if (text && (settled || ticks >= 150)) {
      writeBack(text);
      clearInterval(timer);
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

  // 群消息推送: 给离线(无 SSE)的真人成员远程推送; 在线成员由群 SSE(1.5s 轮询)实时送达.
  // agent 成员(小莫/分身)无设备令牌, 跳过. 发送者自己不推. fire-and-forget, 失败不影响发消息.
  try {
    const convName = (Conversations.findById(id) as { name?: string } | undefined)?.name || '群聊';
    const senderName = user.display_name || user.id;
    for (const m of Conversations.listMembers(id)) {
      if (m.member_type !== 'user') continue;
      if (String(m.member_id) === String(user.id)) continue;
      if (isMemberOnline(m.last_seen_at)) continue;
      void pushToUserExt({
        username: String(m.member_id),
        title: convName,
        body: `${senderName}: ${content}`,
        deepLink: `momo://group/${id}`,
      });
    }
  } catch {}

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
    Conversations.markRead(id, user.id);
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
