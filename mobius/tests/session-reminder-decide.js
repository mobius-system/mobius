/**
 * Unit tests for the session reminder cooldown contract.
 *
 * The two guarantees under test:
 *   1. At most one reminder per rolling hour (real wall-clock time).
 *   2. A suppressed decision carries no message at all, so the transport can
 *      return `{}` and the agent sees exactly what it would see without a hook.
 *
 * Run: node --require tsx/cjs tests/session-reminder-decide.js
 */

const assert = require('assert');

const {
  decideReminder,
  normalizeConfig,
  renderReminderMessage,
  DEFAULT_REMINDER_COOLDOWN_MINUTES,
  DEFAULT_REMINDER_MESSAGE,
} = require('../backend/services/session-reminder-decide');

const NOW = Date.parse('2026-10-22T10:00:00.000Z');
const TARGET = 'ppu';
const BASE_CONFIG = { enabled: true, cooldownMinutes: 60, message: 'target={{target}} tool={{tool}}' };

function decide(overrides = {}) {
  return decideReminder({
    reminderType: 'remote_target_local_tool',
    now: NOW,
    target: TARGET,
    lastShownAt: null,
    toolName: 'Bash',
    config: BASE_CONFIG,
    ...overrides,
  });
}

function isoMinutesAgo(minutes) {
  return new Date(NOW - minutes * 60_000).toISOString();
}

// ── 1. 一个小时内的第二次调用必须被压制 ────────────────────────────────
{
  const first = decide();
  assert.strictEqual(first.show, true, 'first call must remind');
  assert.strictEqual(first.reason, 'shown');
  assert.strictEqual(first.message, 'target=ppu tool=Bash');

  for (const minutes of [0, 1, 30, 59, 59.99]) {
    const cooling = decide({ lastShownAt: isoMinutesAgo(minutes) });
    assert.strictEqual(cooling.show, false, `${minutes}m ago must still be cooling`);
    assert.strictEqual(cooling.reason, 'cooling');
  }
  console.log('ok 1 - suppressed inside the rolling hour');
}

// ── 2. 到点后恢复，边界按 >= 处理 ────────────────────────────────────────
{
  const exactly = decide({ lastShownAt: isoMinutesAgo(60) });
  assert.strictEqual(exactly.show, true, 'exactly one hour later must remind again');
  assert.strictEqual(exactly.reason, 'shown');

  const later = decide({ lastShownAt: isoMinutesAgo(61) });
  assert.strictEqual(later.show, true);
  console.log('ok 2 - reminder resumes at the cooldown boundary');
}

// ── 3. 时钟回拨不发 —— 未来时间戳按"刚提醒过"处理 ────────────────────────
{
  const future = decide({ lastShownAt: new Date(NOW + 5 * 60_000).toISOString() });
  assert.strictEqual(future.show, false);
  assert.strictEqual(future.reason, 'cooling');
  console.log('ok 3 - clock skew does not double-fire');
}

// ── 4. 压制时不携带任何文案 ──────────────────────────────────────────────
{
  const suppressed = [
    decide({ lastShownAt: isoMinutesAgo(5) }),
    decide({ target: null }),
    decide({ config: { ...BASE_CONFIG, enabled: false } }),
  ];
  for (const decision of suppressed) {
    assert.strictEqual(decision.show, false);
    assert.strictEqual(decision.message, undefined,
      'suppressed decisions must not carry text (transport then returns {})');
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(decision)).message,
      undefined,
      'serialized suppressed decision must have no message key',
    );
  }
  console.log('ok 4 - suppressed decisions inject nothing');
}

// ── 5. 没有远端目标 / 关闭开关 ───────────────────────────────────────────
{
  assert.strictEqual(decide({ target: '' }).reason, 'no_remote_target');
  assert.strictEqual(decide({ target: '   ' }).reason, 'no_remote_target');
  assert.strictEqual(decide({ target: null }).reason, 'no_remote_target');
  assert.strictEqual(decide({ config: { ...BASE_CONFIG, enabled: false } }).reason, 'disabled');
  console.log('ok 5 - no target and disabled are silent');
}

// ── 6. 冷却时间可配置 ────────────────────────────────────────────────────
{
  const halfHour = decide({ config: { ...BASE_CONFIG, cooldownMinutes: 30 }, lastShownAt: isoMinutesAgo(29) });
  assert.strictEqual(halfHour.show, false, '29m must be inside a 30m cooldown');
  const afterHalfHour = decide({ config: { ...BASE_CONFIG, cooldownMinutes: 30 }, lastShownAt: isoMinutesAgo(31) });
  assert.strictEqual(afterHalfHour.show, true);
  console.log('ok 6 - cooldown is configurable');
}

// ── 7. 默认值 ────────────────────────────────────────────────────────────
{
  const config = normalizeConfig(null);
  assert.strictEqual(config.enabled, true);
  assert.strictEqual(config.cooldownMinutes, DEFAULT_REMINDER_COOLDOWN_MINUTES);
  assert.strictEqual(config.message, DEFAULT_REMINDER_MESSAGE);
  assert.strictEqual(DEFAULT_REMINDER_COOLDOWN_MINUTES, 60);

  assert.strictEqual(normalizeConfig({ cooldownMinutes: 0 }).cooldownMinutes, 60, 'zero falls back to default');
  assert.strictEqual(normalizeConfig({ cooldownMinutes: -5 }).cooldownMinutes, 60, 'negative falls back to default');
  assert.strictEqual(normalizeConfig({ cooldownMinutes: 'abc' }).cooldownMinutes, 60, 'garbage falls back to default');
  console.log('ok 7 - defaults and clamping');
}

// ── 8. 文案渲染 ──────────────────────────────────────────────────────────
{
  assert.strictEqual(renderReminderMessage('a {{target}} b', { target: 'ppu' }), 'a ppu b');
  assert.strictEqual(renderReminderMessage('{{ target }}', { target: 'ppu' }), 'ppu');
  assert.strictEqual(renderReminderMessage('{{tool}}', { target: 'ppu', tool: 'apply_patch' }), 'apply_patch');
  assert.strictEqual(renderReminderMessage('{{unknown}}', { target: 'ppu' }), '{{unknown}}');
  console.log('ok 8 - message rendering');
}

// ── 9. 坏时间戳当作没提醒过 ──────────────────────────────────────────────
{
  const bad = decide({ lastShownAt: 'not-a-date' });
  assert.strictEqual(bad.show, true, 'garbage timestamp must not suppress forever');
  console.log('ok 9 - invalid timestamps degrade to "never shown"');
}

console.log('\n9/9 session reminder decision checks passed');
