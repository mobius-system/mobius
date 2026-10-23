/**
 * Unit tests for per-session hook injection.
 *
 * Run: node --require tsx/cjs tests/session-hook-inject.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { injectClaudeReminderHook, injectCodexReminderHook } = require('../backend/services/session-hook-inject');
const { buildReminderHookCommand, codexReminderHookToml } = require('../backend/services/session-reminder-hook');

const CLI = '/opt/app/mobius/scripts/cli/mobius_session_reminder';
const COMMAND = buildReminderHookCommand({ cliPath: CLI });

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hook-inject-'));
}

// ── 1. Claude: 保留原配置, 只加一条 ──────────────────────────────────────
{
  const dir = tmpDir();
  const source = path.join(dir, 'model-settings.json');
  const dest = path.join(dir, 'session', 'settings.json');
  fs.writeFileSync(source, JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:45630' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/bin/other-hook' }] }] },
  }));

  injectClaudeReminderHook({
    sourcePath: source,
    destPath: dest,
    command: COMMAND,
    matcher: 'Bash|Edit|Write',
    timeoutSeconds: 5,
  });

  const out = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.strictEqual(out.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:45630', 'env must survive the copy');
  assert.strictEqual(out.hooks.PreToolUse.length, 2, 'existing hook groups are preserved');
  assert.strictEqual(out.hooks.PreToolUse[0].hooks[0].command, '/usr/bin/other-hook');

  const ours = out.hooks.PreToolUse[1];
  assert.strictEqual(ours.matcher, 'Bash|Edit|Write');
  assert.strictEqual(ours.hooks[0].type, 'command');
  assert.strictEqual(ours.hooks[0].command, COMMAND);
  assert.strictEqual(ours.hooks[0].timeout, 5);

  const mode = fs.statSync(dest).mode & 0o777;
  assert.strictEqual(mode, 0o600, 'the copy carries secrets, so it must be 0600');
  console.log('ok 1 - claude settings copy keeps env and adds one hook group');
}

// ── 2. Claude: 重复注入不叠加 ────────────────────────────────────────────
{
  const dir = tmpDir();
  const source = path.join(dir, 'settings.json');
  const dest = path.join(dir, 'session', 'settings.json');
  fs.writeFileSync(source, JSON.stringify({ env: {} }));

  const opts = { sourcePath: source, destPath: dest, command: COMMAND, matcher: 'Bash|Edit|Write' };
  injectClaudeReminderHook(opts);
  injectClaudeReminderHook({ ...opts, sourcePath: dest });
  injectClaudeReminderHook({ ...opts, sourcePath: dest });

  const out = JSON.parse(fs.readFileSync(dest, 'utf8'));
  const ours = out.hooks.PreToolUse.filter((group) =>
    group.hooks.some((handler) => String(handler.command).includes('mobius_session_reminder')));
  assert.strictEqual(ours.length, 1, 'repeated injection must not stack duplicate groups');
  console.log('ok 2 - claude injection is idempotent');
}

// ── 3. Codex: 追加到 profile 副本 ────────────────────────────────────────
{
  const dir = tmpDir();
  const source = path.join(dir, 'mobiusdefault.config.toml');
  const dest = path.join(dir, 'mobiusdefaulthook_sess1.config.toml');
  fs.writeFileSync(source, [
    'model = "gpt-5.5"',
    '[model_providers.mobiusdefault]',
    'base_url = "https://example.invalid/v1"',
    '',
  ].join('\n'));

  injectCodexReminderHook({
    sourcePath: source,
    destPath: dest,
    tomlBlock: codexReminderHookToml(COMMAND),
  });

  const text = fs.readFileSync(dest, 'utf8');
  assert.match(text, /^model = "gpt-5\.5"$/m, 'the profile body is preserved');
  assert.match(text, /^\[\[hooks\.PreToolUse\]\]$/m);
  assert.match(text, /^\[\[hooks\.PreToolUse\.hooks\]\]$/m);
  assert.ok(text.includes(COMMAND), 'the CLI command is present');
  assert.strictEqual((text.match(/\[\[hooks\.PreToolUse\]\]/g) || []).length, 1);
  assert.strictEqual(fs.statSync(dest).mode & 0o777, 0o600);
  console.log('ok 3 - codex profile copy gains the hook block');
}

// ── 4. Codex: 已有钩子块时不重复追加 ─────────────────────────────────────
{
  const dir = tmpDir();
  const source = path.join(dir, 'profile.config.toml');
  const dest = path.join(dir, 'out.config.toml');
  fs.writeFileSync(source, 'model = "x"\n');

  const opts = { sourcePath: source, destPath: dest, tomlBlock: codexReminderHookToml(COMMAND) };
  injectCodexReminderHook(opts);
  injectCodexReminderHook({ ...opts, sourcePath: dest });

  const text = fs.readFileSync(dest, 'utf8');
  assert.strictEqual((text.match(/\[\[hooks\.PreToolUse\]\]/g) || []).length, 1);
  console.log('ok 4 - codex injection is idempotent');
}

console.log('\n4/4 session hook injection checks passed');
