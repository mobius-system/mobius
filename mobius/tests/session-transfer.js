const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 历史库回退测试先把 agent-history-store 指到临时目录 — 必须在 require 服务模块
// 之前设置, 服务模块加载时读取该 env (不设会连到真实 11GB 生产库).
// Point the agent-history store at a temp dir BEFORE requiring the service
// modules — STORE_PATH is captured at module load (never touch the real store).
const historyStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-history-store-'));
process.env.MOBIUS_AGENT_HISTORY_STORE_PATH = path.join(historyStoreDir, 'agent-history-store.db');

const { HIDDEN_FOLDER_NAME } = require('../backend/config');
const {
  buildSessionTransferMarkdown,
  transferReferencePrompt,
  writeSessionTransferBundle,
} = require('../backend/services/session-transfer');

function appendJsonl(filePath, entry) {
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-session-transfer-'));
const jsonlPath = path.join(tmp, 'source.jsonl');
const sourceSession = {
  session_id: 'source123',
  issue_id: 'issue123',
  project_id: 'project123',
  scope_type: 'issue',
  research_id: null,
  research_role: null,
  user_id: 'must-not-be-exported',
  name: 'Source session',
  description: 'Continue the original task',
  model: 'codex',
  language: 'zh',
  status: 'active',
  agent_status: 'idle',
  created_at: '2026-07-20T00:00:00.000Z',
  last_active: '2026-07-21T00:00:00.000Z',
  completed_at: null,
  message_count: 50,
  turn_count: 25,
  context_snapshot_body: 'must-not-be-exported',
};

// 396 个 x + 1 空格为一组拼接: 总长 21040 仍触发 20000 截断, 但不形成 ≥512
// 连续 base64 段 — stripBinaryHunks 会把长 base64 run 折叠成占位符, 会让
// 'x'.repeat(21000) 这类老测试数据整段消失 (2026-11-17 起的行为).
// Chunks of 396 x's joined by spaces: 21040 chars in total still crosses the
// 20000 truncation, yet never forms a 512+ contiguous base64 run —
// stripBinaryHunks folds such runs away, which erased the old x-repeat data.
const LONG_TEXT = Array.from({ length: 53 }, () => 'x'.repeat(396)).join(' ');

appendJsonl(jsonlPath, {
  timestamp: '2026-07-20T00:00:00.000Z',
  type: 'user',
  message: { content: [{ type: 'text', text: 'FIRST_USER_MESSAGE' }] },
});

for (let index = 0; index < 42; index += 1) {
  appendJsonl(jsonlPath, {
    timestamp: new Date(Date.parse('2026-07-20T00:01:00.000Z') + index * 1000).toISOString(),
    type: 'assistant',
    message: {
      content: [{
        type: 'text',
        text: `${LONG_TEXT}\nASSISTANT_MARKER_${index}`,
      }],
    },
  });
}

appendJsonl(jsonlPath, {
  timestamp: '2026-07-20T01:00:00.000Z',
  type: 'event_msg',
  payload: { type: 'user_message', message: 'LAST_USER_MESSAGE' },
});
appendJsonl(jsonlPath, {
  timestamp: '2026-07-20T01:00:01.000Z',
  type: 'event_msg',
  payload: { type: 'agent_message', message: 'LAST_ASSISTANT_MARKER' },
});

const limited = buildSessionTransferMarkdown({
  sourceSession,
  targetSessionId: 'target-limited',
  jsonlPath,
});
assert.strictEqual(limited.cardsOmitted, true);
assert.ok(limited.markdown.includes('后续卡片未写入'));

const bundle = writeSessionTransferBundle({
  bindPath: tmp,
  sourceSession,
  targetSessionId: 'target123',
  jsonlPath,
});

const expectedDir = path.join(tmp, HIDDEN_FOLDER_NAME, 'change_model', 'target123');
assert.strictEqual(bundle.paths.full, path.join(expectedDir, 'full.md'));
assert.strictEqual(bundle.paths.user_messages, path.join(expectedDir, 'user_messages.md'));
assert.strictEqual(bundle.paths.metadata, path.join(expectedDir, 'session_metadata.json'));
assert.strictEqual(bundle.cardsOmitted, false);
assert.strictEqual(bundle.individualCardsTruncated, false);

const full = fs.readFileSync(bundle.paths.full, 'utf8');
const userMessages = fs.readFileSync(bundle.paths.user_messages, 'utf8');
const metadata = JSON.parse(fs.readFileSync(bundle.paths.metadata, 'utf8'));

assert.ok(full.length > 800000);
assert.ok(full.includes('ASSISTANT_MARKER_41'));
assert.ok(full.includes('LAST_ASSISTANT_MARKER'));
assert.ok(!full.includes('后续卡片未写入'));
assert.ok(userMessages.includes('FIRST_USER_MESSAGE'));
assert.ok(userMessages.includes('LAST_USER_MESSAGE'));
assert.ok(!userMessages.includes('LAST_ASSISTANT_MARKER'));
assert.strictEqual(metadata.source_session.session_id, sourceSession.session_id);
assert.strictEqual(metadata.source_session.user_id, undefined);
assert.strictEqual(metadata.source_session.context_snapshot_body, undefined);
assert.strictEqual(metadata.source_records.user_message_count, 2);
assert.strictEqual(metadata.transfer_files.full, bundle.paths.full);
assert.deepStrictEqual(metadata.truncation, {
  cards_omitted: false,
  individual_cards_truncated: false,
});

// 51e5d511 之后 transferReferencePrompt 只包分隔符: 前言+路径改由
// session-context-sections 的「旧会话转接」提升段承载 (pendingTransferPaths).
// Since 51e5d511 the prompt wrapper only adds the separator — the preamble and
// paths live in the hoisted 旧会话转接 section (session-context-sections).
const prompt = transferReferencePrompt(bundle.paths, 'SESSION_CONTEXT_AND_DESCRIPTION');
assert.ok(prompt.includes('--- 下面是用户的最新指令'));
assert.ok(prompt.includes('SESSION_CONTEXT_AND_DESCRIPTION'));
assert.ok(prompt.includes('------'));
assert.ok(!prompt.includes(bundle.paths.full));
assert.ok(!prompt.includes('FIRST_USER_MESSAGE'));
assert.ok(!prompt.includes('LAST_ASSISTANT_MARKER'));

const legacyPrompt = transferReferencePrompt({
  full: path.join(tmp, HIDDEN_FOLDER_NAME, 'session_transfer', 'source123.md'),
  user_messages: null,
  metadata: null,
}, 'LEGACY_CONTEXT');
assert.ok(legacyPrompt.includes('--- 下面是用户的最新指令'));
assert.ok(legacyPrompt.includes('LEGACY_CONTEXT'));

// 无任何转接路径 → 原样返回, 不包分隔符
// No transfer paths at all → return the content unwrapped
assert.strictEqual(transferReferencePrompt(null, 'BARE_CONTEXT'), 'BARE_CONTEXT');
assert.strictEqual(transferReferencePrompt({ full: null, user_messages: null, metadata: null }, 'BARE_CONTEXT'), 'BARE_CONTEXT');

// ── 纯数据库构建 (主路径): 原生 JSONL 不存在, 记录直接来自 agent-history-store ──
// ── DB-only build: no native JSONL on disk, records come straight from the store ──
const { historyStorePath } = require('../backend/services/mobius-agent-history');
const Database = require('better-sqlite3');
const store = new Database(historyStorePath()); // 先触发建表 (openStore)
const insertEntryStmt = store.prepare(`
  INSERT INTO entries (session_id, uuid, seq, group_seq, seq_in_group, round_opener, origin, ts, json)
  VALUES (?, ?, ?, NULL, NULL, 0, 'primary', ?, ?)
`);
insertEntryStmt.run('historysrc', 'u1', 1, Date.parse('2026-07-22T00:00:00.000Z'), JSON.stringify({
  timestamp: '2026-07-22T00:00:00.000Z',
  type: 'user',
  message: { content: [{ type: 'text', text: 'HISTORY_FALLBACK_USER_MESSAGE' }] },
}));
insertEntryStmt.run('historysrc', 'u2', 2, Date.parse('2026-07-22T00:00:05.000Z'), JSON.stringify({
  timestamp: '2026-07-22T00:00:05.000Z',
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'HISTORY_FALLBACK_ASSISTANT' }] },
}));

const historySession = { ...sourceSession, session_id: 'historysrc', name: 'History session' };
const historyBundle = writeSessionTransferBundle({
  bindPath: tmp,
  sourceSession: historySession,
  targetSessionId: 'targethistory',
  jsonlPath: path.join(tmp, 'gone.jsonl'), // 不存在 → 纯读库
});
const historyFull = fs.readFileSync(historyBundle.paths.full, 'utf8');
const historyUserMessages = fs.readFileSync(historyBundle.paths.user_messages, 'utf8');
const historyMetadata = JSON.parse(fs.readFileSync(historyBundle.paths.metadata, 'utf8'));
assert.ok(historyFull.includes('HISTORY_FALLBACK_USER_MESSAGE'));
assert.ok(historyFull.includes('HISTORY_FALLBACK_ASSISTANT'));
assert.ok(historyFull.includes('记录来源: 会话历史数据库'));
assert.ok(historyFull.includes('记录同步截至'));
assert.ok(historyUserMessages.includes('HISTORY_FALLBACK_USER_MESSAGE'));
assert.strictEqual(historyMetadata.source_records.records_source, 'history_store');
assert.strictEqual(historyMetadata.source_records.sync_ok, true);
assert.strictEqual(historyMetadata.source_records.user_message_count, 1);
assert.strictEqual(historyMetadata.source_records.entry_count, 2);

// 同步报错 (ingest_state.error) → 文档最前出「同步异常」警示卡, 且已入库内容照常进文档
// A recorded sync error → leading warning card, ingested content still included
insertEntryStmt.run('errsrc', 'e1', 1, Date.parse('2026-07-23T00:00:00.000Z'), JSON.stringify({
  timestamp: '2026-07-23T00:00:00.000Z',
  type: 'user',
  message: { content: [{ type: 'text', text: 'HISTORY_ERR_SESSION_MESSAGE' }] },
}));
store.prepare(`INSERT INTO ingest_state (session_id, primary_path, error) VALUES (?, ?, ?)`)
  .run('errsrc', '/nonexistent/err-track.jsonl', 'ingest exploded');
const errBundle = writeSessionTransferBundle({
  bindPath: tmp,
  sourceSession: { ...sourceSession, session_id: 'errsrc', name: 'Err session' },
  targetSessionId: 'targeterr',
  jsonlPath: path.join(tmp, 'err-gone.jsonl'),
});
const errFull = fs.readFileSync(errBundle.paths.full, 'utf8');
assert.ok(errFull.includes('⚠️ 同步异常'));
assert.ok(errFull.includes('ingest exploded'));
assert.ok(errFull.includes('HISTORY_ERR_SESSION_MESSAGE'));
const errMetadata = JSON.parse(fs.readFileSync(errBundle.paths.metadata, 'utf8'));
assert.strictEqual(errMetadata.source_records.sync_ok, false);
assert.strictEqual(errMetadata.source_records.sync_error, 'ingest exploded');

// 库里无记录 → 显式失败, 不生成空转接文档, 也不回退读文件
// Nothing in the store → fail loudly; no empty digest, no file fallback
assert.throws(() => writeSessionTransferBundle({
  bindPath: tmp,
  sourceSession: { ...sourceSession, session_id: 'emptysrc' },
  targetSessionId: 'targetempty',
  jsonlPath: path.join(tmp, 'also-gone.jsonl'),
}), /历史库中没有可读取的会话记录/);

console.log('session-transfer ok');
