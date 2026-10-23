/**
 * Unit tests for the reminder cooldown cache and the token verifier.
 *
 * Run: node --require tsx/cjs tests/session-reminder-store.js
 */

const assert = require('assert');
const Database = require('better-sqlite3');

const { createReminderStore } = require('../backend/services/session-reminder-store');
const { decideReminder, DEFAULT_REMINDER_MESSAGE } = require('../backend/services/session-reminder-decide');

const SECRET = 'store-test-secret';
const TYPE = 'remote_target_local_tool';

function newStore() {
  return createReminderStore(new Database(':memory:'));
}

// ── 1. 读 / 写 / 计数 ─────────────────────────────────────────────────────
{
  const store = newStore();
  assert.strictEqual(store.lastShownAt('s1', TYPE), null, 'a fresh session has no cooldown');

  store.recordShown({ sessionId: 's1', reminderType: TYPE, toolName: 'Bash', at: '2026-10-22T10:00:00.000Z' });
  assert.strictEqual(store.lastShownAt('s1', TYPE), '2026-10-22T10:00:00.000Z');

  store.recordShown({ sessionId: 's1', reminderType: TYPE, toolName: 'apply_patch', at: '2026-10-22T11:30:00.000Z' });
  assert.strictEqual(store.lastShownAt('s1', TYPE), '2026-10-22T11:30:00.000Z', 'second write updates the timestamp');

  // 不同类型互不影响
  assert.strictEqual(store.lastShownAt('s1', 'other_type'), null);
  assert.strictEqual(store.lastShownAt('s2', TYPE), null);
  console.log('ok 1 - read/write isolation across sessions and types');
}

// ── 2. shown_count 递增（同一会话同一类型只有一行） ──────────────────────
{
  const db = new Database(':memory:');
  const store = createReminderStore(db);
  store.recordShown({ sessionId: 's1', reminderType: TYPE, toolName: 'Bash' });
  store.recordShown({ sessionId: 's1', reminderType: TYPE, toolName: 'Bash' });
  store.recordShown({ sessionId: 's1', reminderType: TYPE, toolName: 'Edit' });

  const rows = db.prepare('SELECT shown_count, last_tool_name FROM session_reminder_cache').all();
  assert.strictEqual(rows.length, 1, 'one row per (session, type)');
  assert.strictEqual(rows[0].shown_count, 3);
  assert.strictEqual(rows[0].last_tool_name, 'Edit');
  console.log('ok 2 - upsert keeps one row and increments shown_count');
}

// ── 3. clear 重置冷却 ─────────────────────────────────────────────────────
{
  const store = newStore();
  store.recordShown({ sessionId: 's1', reminderType: TYPE, at: '2026-10-22T10:00:00.000Z' });
  store.recordShown({ sessionId: 's1', reminderType: 'other_type', at: '2026-10-22T10:00:00.000Z' });

  assert.strictEqual(store.clear('s1', TYPE), 1);
  assert.strictEqual(store.lastShownAt('s1', TYPE), null, 'cleared type is eligible again');
  assert.ok(store.lastShownAt('s1', 'other_type'), 'other types are untouched');

  assert.strictEqual(store.clear('s1'), 1);
  assert.strictEqual(store.lastShownAt('s1', 'other_type'), null);
  console.log('ok 3 - clearing a row makes the reminder eligible immediately');
}

// ── 4. 与决策函数的联动：一小时闸门 ─────────────────────────────────────
{
  const store = newStore();
  const config = { enabled: true, cooldownMinutes: 60, message: '' };

  const first = decideReminder({
    reminderType: TYPE,
    now: Date.parse('2026-10-22T10:00:00.000Z'),
    target: 'ppu',
    lastShownAt: store.lastShownAt('s1', TYPE),
    toolName: 'Bash',
    config,
  });
  assert.strictEqual(first.show, true);
  assert.strictEqual(first.message, DEFAULT_REMINDER_MESSAGE.replace('{{target}}', 'ppu'));
  store.recordShown({ sessionId: 's1', reminderType: TYPE, toolName: 'Bash', at: '2026-10-22T10:00:00.000Z' });

  const second = decideReminder({
    reminderType: TYPE,
    now: Date.parse('2026-10-22T10:59:00.000Z'),
    target: 'ppu',
    lastShownAt: store.lastShownAt('s1', TYPE),
    toolName: 'Bash',
    config,
  });
  assert.strictEqual(second.show, false, 'the same hour must be suppressed');
  assert.strictEqual(second.message, undefined, 'suppressed decisions carry no text');
  assert.strictEqual(store.lastShownAt('s1', TYPE), '2026-10-22T10:00:00.000Z', 'suppression must not move the clock');

  const third = decideReminder({
    reminderType: TYPE,
    now: Date.parse('2026-10-22T11:01:00.000Z'),
    target: 'ppu',
    lastShownAt: store.lastShownAt('s1', TYPE),
    toolName: 'Bash',
    config,
  });
  assert.strictEqual(third.show, true, 'after the cooldown it is eligible again');
  console.log('ok 4 - store + decide enforce the rolling hour');
}

console.log('\n4/4 session reminder store checks passed');
