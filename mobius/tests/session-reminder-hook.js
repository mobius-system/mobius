/**
 * Unit tests for the session reminder hook CLI and the config fragments both
 * agents use.
 *
 * What is covered here:
 *   - mobius_session_reminder: stdin → backend → stdout, plus its exit codes
 *   - request shape the backend receives (path, token header, body passthrough)
 *   - failure modes (backend down, backend slower than the CLI timeout)
 *   - the two config fragments (Claude settings JSON / Codex TOML)
 *   - sandbox vs host base URL and the session token derivation
 *
 * Live agent runs live in session-reminder-hook-live.js and are opt-in.
 *
 * Run: node --require tsx/cjs tests/session-reminder-hook.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const { startReminderServer } = require('./fixtures/reminder-hook-server');
const {
  buildReminderHookCommand,
  claudeReminderHookSettings,
  codexReminderHookToml,
  reminderHookToken,
  reminderHookBaseUrl,
  SANDBOX_GATEWAY_IP,
  CLAUDE_REMINDER_MATCHER,
  CODEX_REMINDER_MATCHER,
} = require('../backend/services/session-reminder-hook');

const CLI_PATH = path.resolve(__dirname, '../scripts/cli/mobius_session_reminder');
const TOKEN = 'hook-token-for-tests';
const SECRET = 'unit-test-secret';
const SESSION_ID = 'mobius-session-1';
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-hook-config-'));

/** Write a per-session hook config and return its path. */
function writeConfig(baseUrl, sessionId = SESSION_ID, token = TOKEN) {
  const file = path.join(CONFIG_DIR, `config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ base_url: baseUrl, session_id: sessionId, token }), { mode: 0o600 });
  return file;
}

/** Build the hook command pointing at a config file for this backend. */
function commandFor(baseUrl) {
  return buildReminderHookCommand({ cliPath: CLI_PATH, configPath: writeConfig(baseUrl) });
}

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

/** Run the hook command with stdin, the same way both agents do. */
function runHook(command, input, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      'sh',
      ['-c', command],
      {
        env: { ...process.env, MOBIUS_BASE: '', MOBIUS_SESSION_ID: '', MOBIUS_HOOK_TOKEN: '', ...env },
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
    const command = commandFor(server.baseUrl);
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
    assert.strictEqual(req.headers['x-mobius-session-id'], 'mobius-session-1');
    assert.strictEqual(req.body, payload, 'hook stdin must reach the backend unchanged');
  } finally {
    await server.close();
  }
}

async function testCodexPayloadDelivery() {
  const server = await startReminderServer();
  try {
    const command = commandFor(server.baseUrl);
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
    const command = commandFor(server.baseUrl);
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

  const command = commandFor(baseUrl);
  const result = await runHook(command, claudePayload());
  assert.notStrictEqual(result.code, 0, 'connection failure must surface as a non-zero exit');
  assert.strictEqual(result.stdout.trim(), '', 'no output on failure, so the agent sees no reminder');
}

async function testCliTimeout() {
  const server = await startReminderServer({ delayMs: 4500 });
  try {
    const command = commandFor(server.baseUrl);
    const started = Date.now();
    const result = await runHook(command, claudePayload());
    const elapsed = Date.now() - started;

    assert.strictEqual(result.code, 3, 'CLI must report a network exit code when curl times out');
    assert.strictEqual(result.stdout.trim(), '', 'no partial output on timeout');
    assert.ok(elapsed < 4000, `CLI must give up at its own timeout (took ${elapsed}ms)`);
  } finally {
    await server.close();
  }
}

function testCliUsageAndConfigErrors() {
  const help = require('child_process').spawnSync(CLI_PATH, ['--help'], { encoding: 'utf8' });
  assert.strictEqual(help.status, 0, '--help must exit 0');
  assert.match(help.stdout, /Usage: mobius_session_reminder/);
  assert.match(help.stdout, /MOBIUS_BASE/);

  const badArg = require('child_process').spawnSync(CLI_PATH, ['--nope'], { encoding: 'utf8' });
  assert.strictEqual(badArg.status, 2, 'unknown arguments exit 2');
  assert.match(badArg.stderr, /unknown argument/);

  const missingEnv = require('child_process').spawnSync(CLI_PATH, [], {
    encoding: 'utf8',
    input: '{}',
    env: { ...process.env, MOBIUS_BASE: '', MOBIUS_SESSION_ID: '', MOBIUS_HOOK_TOKEN: '' },
  });
  assert.strictEqual(missingEnv.status, 3, 'missing environment exits 3');
  assert.match(missingEnv.stderr, /MOBIUS_BASE is unset and --config has no base_url/);

  // 配置文件缺失 → 配置错误
  const missingConfig = require('child_process').spawnSync(CLI_PATH, ['--config', '/nonexistent/hook.json'], {
    encoding: 'utf8',
    input: '{}',
    env: { ...process.env, MOBIUS_BASE: '', MOBIUS_SESSION_ID: '', MOBIUS_HOOK_TOKEN: '' },
  });
  assert.strictEqual(missingConfig.status, 3, 'unreadable --config exits 3');
  assert.match(missingConfig.stderr, /cannot read hook config/);

  // 有配置文件时不需要任何环境变量
  const cfg = writeConfig('http://127.0.0.1:1');
  const emptyStdin = require('child_process').spawnSync(CLI_PATH, ['--config', cfg], {
    encoding: 'utf8',
    input: '',
    env: { ...process.env, MOBIUS_BASE: '', MOBIUS_SESSION_ID: '', MOBIUS_HOOK_TOKEN: '' },
  });
  assert.strictEqual(emptyStdin.status, 0, 'empty stdin is a silent success');
  assert.strictEqual(emptyStdin.stdout, '');
}

function testClaudeSettingsFragment() {
  const command = commandFor('http://127.0.0.1:45616');
  const settings = claudeReminderHookSettings(command);
  const group = settings.hooks.PreToolUse[0];

  assert.strictEqual(group.matcher, CLAUDE_REMINDER_MATCHER);
  assert.strictEqual(group.hooks.length, 1);
  assert.strictEqual(group.hooks[0].type, 'command');
  assert.strictEqual(group.hooks[0].timeout, 5);
  assert.strictEqual(group.hooks[0].command, command);
  assert.ok(group.hooks[0].command.startsWith(CLI_PATH), 'the hook must invoke the CLI');
  assert.ok(!group.hooks[0].command.includes(TOKEN), 'no secret in the config file');
}

function testCodexTomlFragment() {
  const command = commandFor('http://127.0.0.1:45616');
  const toml = codexReminderHookToml(command);

  assert.match(toml, /^\[\[hooks\.PreToolUse\]\]$/m,
    'events must sit under top-level hooks (profile file is loaded as config.toml)');
  assert.match(toml, /^matcher = "Bash\|apply_patch"$/m);
  assert.match(toml, /^\[\[hooks\.PreToolUse\.hooks\]\]$/m);
  assert.match(toml, /^type = "command"$/m);
  assert.match(toml, /^timeout = 5$/m);
  assert.ok(toml.includes(command), 'TOML must carry the shared command verbatim');
  assert.strictEqual(CODEX_REMINDER_MATCHER, 'Bash|apply_patch');
}

function testCommandValidation() {
  assert.throws(() => buildReminderHookCommand({ cliPath: 'relative/path', configPath: '/tmp/c.json' }), /invalid reminder hook cli path/);
  assert.throws(() => buildReminderHookCommand({ cliPath: "/tmp/x'; rm -rf /", configPath: '/tmp/c.json' }), /invalid reminder hook cli path/);
  assert.throws(() => buildReminderHookCommand({ cliPath: CLI_PATH, configPath: "relative.json" }), /invalid reminder hook config path/);
  assert.throws(
    () => buildReminderHookCommand({ cliPath: CLI_PATH, configPath: '/tmp/c.json', reminderType: '../evil' }),
    /invalid reminder type/,
  );
}

function testSandboxBaseUrl() {
  assert.strictEqual(SANDBOX_GATEWAY_IP, '172.28.0.1');
  assert.strictEqual(
    reminderHookBaseUrl({ isolated: false, backendPort: 45616 }),
    'http://127.0.0.1:45616',
    'host sessions use loopback',
  );
  assert.strictEqual(
    reminderHookBaseUrl({ isolated: true, backendPort: 45616 }),
    'http://172.28.0.1:45616',
    'sandbox sessions must use the host bridge gateway, not their own loopback',
  );
  assert.strictEqual(
    reminderHookBaseUrl({ isolated: true, backendPort: 45616, gatewayIp: '172.30.0.1' }),
    'http://172.30.0.1:45616',
    'gateway must be overridable for non-default docker networks',
  );
  assert.throws(() => reminderHookBaseUrl({ isolated: false, backendPort: 0 }), /invalid backend port/);
  assert.throws(() => reminderHookBaseUrl({ isolated: false, backendPort: 70000 }), /invalid backend port/);
  assert.throws(
    () => reminderHookBaseUrl({ isolated: true, backendPort: 45616, gatewayIp: "1.2.3.4'; rm -rf /" }),
    /invalid hook host/,
  );
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
    ['cli timeout', testCliTimeout],
    ['cli usage and config errors', testCliUsageAndConfigErrors],
    ['claude settings fragment', testClaudeSettingsFragment],
    ['codex toml fragment', testCodexTomlFragment],
    ['command validation', testCommandValidation],
    ['sandbox base url', testSandboxBaseUrl],
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
