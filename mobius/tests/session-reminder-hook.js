/**
 * Unit tests for the session reminder hook transport shared by Claude Code and Codex.
 *
 * What is covered here:
 *   - the exact shell command both agents will run (stdin → curl → stdout)
 *   - request shape the backend will receive (path, token header, body passthrough)
 *   - failure modes (backend down, backend slower than --max-time)
 *   - the two config fragments (Claude settings JSON / Codex TOML)
 *   - the session token derivation
 *
 * Live agent runs live in session-reminder-hook-live.js and are opt-in.
 *
 * Run: node --require tsx/cjs tests/session-reminder-hook.js
 */

const assert = require('assert');
const { execFile } = require('child_process');

const { startReminderServer } = require('./fixtures/reminder-hook-server');
const {
  buildReminderHookCommand,
  claudeReminderHookSettings,
  codexReminderHookToml,
  reminderHookToken,
  reminderHookUrl,
  CLAUDE_REMINDER_MATCHER,
  CODEX_REMINDER_MATCHER,
} = require('../backend/services/session-reminder-hook');

const TOKEN = 'hook-token-for-tests';
const SECRET = 'unit-test-secret';

/** Claude Code PreToolUse payload (fields the backend reads are the same as Codex). */
function claudePayload(sessionId = 'cc-session-1') {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi', description: 'Print hi' },
    cwd: '/tmp/project',
    permission_mode: 'bypassPermissions',
    tool_use_id: 'toolu_test_1',
  });
}

/** Codex PreToolUse payload. */
function codexPayload(sessionId = 'cx-session-1') {
  return JSON.stringify({
    session_id: sessionId,
    turn_id: 'turn-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'apply_patch',
    tool_input: { input: '*** Begin Patch\n*** End Patch' },
    cwd: '/tmp/project',
    transcript_path: null,
    model: 'test-model',
    permission_mode: 'never',
    tool_use_id: 'call_test_1',
  });
}

/** Run a hook command with stdin, the same way both agents do. */
function runHook(command, input, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      'sh',
      ['-c', command],
      {
        env: { ...process.env, MOBIUS_HOOK_TOKEN: TOKEN, ...env },
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
    child.stdin.end(input);
  });
}

function parseHookOutput(stdout) {
  const text = String(stdout || '').trim();
  assert.ok(text, 'hook stdout must not be empty');
  return JSON.parse(text);
}

async function testClaudePayloadDelivery() {
  const server = await startReminderServer();
  try {
    const command = buildReminderHookCommand({ baseUrl: server.baseUrl });
    const payload = claudePayload();
    const result = await runHook(command, payload);

    assert.strictEqual(result.code, 0, `hook must exit 0, stderr: ${result.stderr}`);
    const output = parseHookOutput(result.stdout);
    assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(output.hookSpecificOutput.additionalContext, /target host is ppu/);

    assert.strictEqual(server.requests.length, 1, 'backend must receive exactly one request');
    const req = server.requests[0];
    assert.strictEqual(req.method, 'POST');
    assert.strictEqual(req.url, '/api/internal/session-reminders/remote_target_local_tool/decide');
    assert.strictEqual(req.headers['content-type'], 'application/json');
    assert.strictEqual(req.headers['x-mobius-hook-token'], TOKEN);
    assert.strictEqual(req.body, payload, 'hook stdin must reach the backend unchanged');
  } finally {
    await server.close();
  }
}

async function testCodexPayloadDelivery() {
  const server = await startReminderServer();
  try {
    const command = buildReminderHookCommand({ baseUrl: server.baseUrl });
    const payload = codexPayload();
    const result = await runHook(command, payload);

    assert.strictEqual(result.code, 0, `hook must exit 0, stderr: ${result.stderr}`);
    const output = parseHookOutput(result.stdout);
    assert.match(output.hookSpecificOutput.additionalContext, /core host/);

    const req = server.requests[0];
    assert.strictEqual(req.body, payload, 'codex payload must reach the backend unchanged');
    assert.strictEqual(JSON.parse(req.body).tool_name, 'apply_patch');
  } finally {
    await server.close();
  }
}

async function testEmptyDecisionPassthrough() {
  const server = await startReminderServer({
    handler(req, res) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    },
  });
  try {
    const command = buildReminderHookCommand({ baseUrl: server.baseUrl });
    const result = await runHook(command, claudePayload());
    assert.strictEqual(result.code, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()), {}, 'suppressed decision must pass through as {}');
  } finally {
    await server.close();
  }
}

async function testBackendDown() {
  const server = await startReminderServer();
  const baseUrl = server.baseUrl;
  await server.close();

  const command = buildReminderHookCommand({ baseUrl });
  const result = await runHook(command, claudePayload());
  assert.notStrictEqual(result.code, 0, 'connection failure must surface as a non-zero exit');
  assert.strictEqual(result.stdout.trim(), '', 'no output on failure, so the agent sees no reminder');
}

async function testCurlTimeout() {
  const server = await startReminderServer({ delayMs: 2500 });
  try {
    const command = buildReminderHookCommand({ baseUrl: server.baseUrl, maxTimeSeconds: 1 });
    const started = Date.now();
    const result = await runHook(command, claudePayload());
    const elapsed = Date.now() - started;

    assert.notStrictEqual(result.code, 0, 'curl must exit non-zero when --max-time is exceeded');
    assert.strictEqual(result.stdout.trim(), '', 'no partial output on timeout');
    assert.ok(elapsed < 2400, `hook must give up before the handler timeout (took ${elapsed}ms)`);
  } finally {
    await server.close();
  }
}

function testClaudeSettingsFragment() {
  const command = buildReminderHookCommand({ baseUrl: 'http://127.0.0.1:45616' });
  const settings = claudeReminderHookSettings(command);
  const group = settings.hooks.PreToolUse[0];

  assert.strictEqual(group.matcher, CLAUDE_REMINDER_MATCHER);
  assert.strictEqual(group.hooks.length, 1);
  assert.strictEqual(group.hooks[0].type, 'command');
  assert.strictEqual(group.hooks[0].timeout, 5);
  assert.strictEqual(group.hooks[0].command, command);
  assert.ok(!group.hooks[0].command.includes(TOKEN), 'token must come from the environment, not the config');
}

function testCodexTomlFragment() {
  const command = buildReminderHookCommand({ baseUrl: 'http://127.0.0.1:45616' });
  const toml = codexReminderHookToml(command);

  assert.match(toml, /^\[\[hooks\.PreToolUse\]\]$/m,
    'events must sit under top-level hooks (profile file is loaded as config.toml)');
  assert.match(toml, /^matcher = "Bash\|apply_patch"$/m);
  assert.match(toml, /^\[\[hooks\.PreToolUse\.hooks\]\]$/m);
  assert.match(toml, /^type = "command"$/m);
  assert.match(toml, /^timeout = 5$/m);
  assert.ok(toml.includes(command), 'TOML must carry the shared command verbatim');
  assert.strictEqual(CODEX_REMINDER_MATCHER, 'Bash|apply_patch');

  // 命令里没有双引号, 写进 TOML 基本字符串不需要转义
  // The command contains no double quotes, so the TOML basic string stays readable
  const commandLine = toml.split('\n').find((line) => line.startsWith('command = '));
  assert.ok(commandLine && !commandLine.includes('\\"'), 'command line must not need escaping');
}

function testUrlValidation() {
  assert.strictEqual(
    reminderHookUrl({ baseUrl: 'http://127.0.0.1:45616/' }),
    'http://127.0.0.1:45616/api/internal/session-reminders/remote_target_local_tool/decide',
    'trailing slash must be trimmed',
  );
  assert.throws(() => reminderHookUrl({ baseUrl: 'http://127.0.0.1:1/x', reminderType: '../evil' }),
    /invalid reminder type/);
  assert.throws(() => reminderHookUrl({ baseUrl: "http://x'; rm -rf /" }), /invalid reminder hook base url/);
}

function testTokenDerivation() {
  const a = reminderHookToken('session-a', SECRET);
  const b = reminderHookToken('session-a', SECRET);
  const c = reminderHookToken('session-b', SECRET);
  const d = reminderHookToken('session-a', 'another-secret');

  assert.strictEqual(a, b, 'same session + secret must derive the same token');
  assert.notStrictEqual(a, c, 'different sessions must not share a token');
  assert.notStrictEqual(a, d, 'rotating the secret must invalidate old tokens');
  assert.match(a, /^[A-Za-z0-9_-]+$/, 'token must be shell/header safe');
  assert.throws(() => reminderHookToken('', SECRET));
  assert.throws(() => reminderHookToken('session-a', ''));
}

async function main() {
  const tests = [
    ['claude payload delivery', testClaudePayloadDelivery],
    ['codex payload delivery', testCodexPayloadDelivery],
    ['empty decision passthrough', testEmptyDecisionPassthrough],
    ['backend down', testBackendDown],
    ['curl timeout', testCurlTimeout],
    ['claude settings fragment', testClaudeSettingsFragment],
    ['codex toml fragment', testCodexTomlFragment],
    ['url validation', testUrlValidation],
    ['token derivation', testTokenDerivation],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    await fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  }
  console.log(`\n${passed}/${tests.length} session reminder hook checks passed`);
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
