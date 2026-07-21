const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
        text: `${'x'.repeat(21000)}\nASSISTANT_MARKER_${index}`,
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

const prompt = transferReferencePrompt(bundle.paths, 'SESSION_CONTEXT_AND_DESCRIPTION');
assert.ok(prompt.includes('SESSION_CONTEXT_AND_DESCRIPTION'));
assert.ok(prompt.includes(bundle.paths.full));
assert.ok(prompt.includes(bundle.paths.user_messages));
assert.ok(prompt.includes(bundle.paths.metadata));
assert.ok(!prompt.includes('FIRST_USER_MESSAGE'));
assert.ok(!prompt.includes('LAST_ASSISTANT_MARKER'));

const legacyPrompt = transferReferencePrompt({
  full: path.join(tmp, HIDDEN_FOLDER_NAME, 'session_transfer', 'source123.md'),
  user_messages: null,
  metadata: null,
}, 'LEGACY_CONTEXT');
assert.ok(legacyPrompt.includes('session_transfer'));
assert.ok(legacyPrompt.includes('LEGACY_CONTEXT'));

console.log('session-transfer ok');
