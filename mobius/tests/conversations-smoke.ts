// P1 群聊骨架运行时冒烟测试 (自清理). 跑法: npx tsx tests/conversations-smoke.ts
import { db } from '../db';
import { Conversations } from '../backend/repositories/conversations';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('❌ FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('✅', msg);
  }
}

const users = db.prepare(
  `SELECT id, display_name FROM users WHERE (deleted_at IS NULL OR deleted_at = '') ORDER BY id LIMIT 2`,
).all() as Array<{ id: string; display_name: string }>;
if (users.length < 1) {
  console.error('需要至少 1 个活跃用户作为 owner');
  process.exit(1);
}
const owner = users[0];
const otherUser = users[1] || { id: 'u_smoke_other', display_name: '其他测试人' };
const TEST_PREFIX = '测试群_smoke_';

try {
  const created = Conversations.create({
    name: TEST_PREFIX + '默认',
    ownerId: owner.id,
    ownerName: owner.display_name,
    members: [
      { type: 'user', id: otherUser.id, display_name: otherUser.display_name },
      { type: 'agent', id: 'fakeSessAAA', display_name: '小莫A' },
    ],
  });
  assert(!!created.id && created.id.startsWith('conv_'), '建群返回 conv_ 前缀 id');

  const myConvs = Conversations.listForUser(owner.id);
  assert(myConvs.some((c: any) => c.id === created.id), 'owner 群列表包含新群');

  const members = Conversations.listMembers(created.id);
  assert(members.length === 3, `成员数=3 (owner+user+agent, 实际 ${members.length})`);

  const agentM = members.find((m: any) => m.member_type === 'agent');
  assert(
    !!agentM && agentM.agent_session_id === 'fakeSessAAA' && agentM.display_name === '小莫A',
    'agent 成员 agent_session_id/display_name 正确',
  );

  const ownerM = members.find((m: any) => m.member_type === 'user' && m.member_id === owner.id);
  assert(ownerM?.role === 'owner', '群主 role=owner');

  assert(Conversations.isUserMember(created.id, owner.id), 'isUserMember(owner)=true');
  assert(!Conversations.isUserMember(created.id, 'nobody_xyz'), 'isUserMember(陌生人)=false');

  Conversations.addMember(created.id, { type: 'user', id: 'u_smoke_added', display_name: '新人' });
  assert(Conversations.listMembers(created.id).length === 4, '加成员后成员数=4');

  const changes = Conversations.removeMember(created.id, 'user', 'u_smoke_added');
  assert(changes === 1 && Conversations.listMembers(created.id).length === 3, '退群删除 1 条, 成员数回到 3');

  Conversations.touch(created.id);
  assert(true, 'touch 更新 last_active 无异常');

  // P2: 真人群消息收发 (P0)
  const m1 = Conversations.insertMessage({
    conversationId: created.id,
    senderId: owner.id,
    senderType: 'user',
    senderName: owner.display_name,
    content: '你好',
    mentionTargets: [],
  });
  assert(!!(m1 as any).id && (m1 as any).content === '你好', 'insertMessage 真人消息返回带 id');

  Conversations.insertMessage({
    conversationId: created.id,
    senderId: otherUser.id,
    senderType: 'user',
    senderName: otherUser.display_name,
    content: '回复你',
    mentionTargets: [{ type: 'agent', id: 'fakeSessAAA' }],
  });

  const recent = Conversations.recentMessages(created.id, 50);
  assert(recent.length === 2, `recentMessages 回灌 2 条 (实际 ${recent.length})`);
  assert((recent[0] as any).sender_id === owner.id && (recent[1] as any).sender_id === otherUser.id, 'recentMessages 正序(先owner后other)');

  const since = Conversations.listMessagesSince(created.id, (recent[0] as any).id as number, 200);
  assert(since.length === 1 && (since[0] as any).content === '回复你', 'listMessagesSince 增量返回 1 条');

  const del = db.prepare('DELETE FROM conversations WHERE name LIKE ?').run(TEST_PREFIX + '%');
  console.log(`🧹 清理 ${del.changes} 个测试群`);
  console.log('SMOKE DONE');
} catch (e) {
  console.error('❌ 异常:', e);
  db.prepare('DELETE FROM conversations WHERE name LIKE ?').run(TEST_PREFIX + '%');
  process.exitCode = 1;
}
