/**
 * Opt-in live checks: does each agent really run the command hook, and does a
 * suppressed decision (`{}`) inject absolutely nothing?
 *
 * These spawn real agents and cost tokens, so they never run by default.
 *
 *   MOBIUS_HOOK_LIVE=1        run the Claude Code checks
 *   MOBIUS_HOOK_LIVE_CODEX=1  additionally run the Codex checks
 *
 * Run: node --require tsx/cjs tests/session-reminder-hook-live.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { startReminderServer } = require('./fixtures/reminder-hook-server');
const {
  buildReminderHookCommand,
  claudeReminderHookSettings,
} = require('../backend/services/session-reminder-hook');

const CLI_PATH = path.resolve(__dirname, '../scripts/cli/mobius_session_reminder');

const MARKER = `LIVE-MARKER-${Date.now()}`;
const ASK_FOR_REMINDER =
  'Run the Bash command exactly: echo hi . Then answer between <seen> and </seen> with any reminder ' +
  'context you were given about a target host. If you received none, write <seen>NONE</seen>.';

function runBin(bin, args, options = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        env: { ...process.env, MOBIUS_CLI_JWT: 'live-token', ...options.env },
        timeout: options.timeout || 240000,
        maxBuffer: 16 * 1024 * 1024,
        cwd: options.cwd,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
    if (options.input) child.stdin.end(options.input);
  });
}

/** Parse hook_success attachments out of a Claude Code transcript. */
function hookSuccessEntries(transcript) {
  return String(transcript || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((row) => row && row.attachment && row.attachment.type === 'hook_success')
    .map((row) => row.attachment);
}

function shownHandler(req, res) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `[reminder] ${MARKER} the target host is ppu; this call acts on the core host.`,
    },
  }));
}

function suppressedHandler(req, res) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end('{}');
}

async function runClaude(server, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-reminder-${mode}-`));
  const command = buildReminderHookCommand({ cliPath: CLI_PATH });
  const settings = claudeReminderHookSettings(command);
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  const result = await runBin('claude', [
    '-p', ASK_FOR_REMINDER,
    '--dangerously-skip-permissions',
    '--model', 'haiku',
    '--settings', settingsPath,
    '--output-format', 'text',
  ], { cwd: dir, env: { MOBIUS_BASE: server.baseUrl, MOBIUS_SESSION_ID: 'live-mobius-session', MOBIUS_CLI_JWT: 'live-token' } });
  result.transcript = readClaudeTranscript(dir);
  return result;
}

/**
 * Locate the transcript Claude Code wrote for a run in `cwd`.
 * Claude Code stores it under ~/.claude/projects/<cwd with / and . replaced by ->.
 */
function readClaudeTranscript(cwd) {
  const key = String(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', key);
  try {
    const files = fs.readdirSync(projectDir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(projectDir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files.length ? fs.readFileSync(files[0], 'utf8') : '';
  } catch {
    return '';
  }
}

async function testClaudeShown() {
  const server = await startReminderServer({ handler: shownHandler });
  try {
    const result = await runClaude(server, 'shown');
    assert.strictEqual(result.code, 0, `claude failed: ${result.stderr}`);
    assert.ok(server.requests.length >= 1, 'claude must invoke the command hook');
    assert.match(result.stdout, new RegExp(MARKER), 'the model must see the reminder text');
    assert.match(result.transcript, /hook additional context/,
      'the transcript must contain the injected reminder');
    console.log(`ok - claude shows the reminder (${server.requests.length} hook call(s))`);
  } finally {
    await server.close();
  }
}

/**
 * Baseline: the exact same prompt with no hook configured at all. The answer
 * format is dictated by ASK_FOR_REMINDER, so a "NONE" answer here proves the
 * suppressed run's NONE is the prompt's format, not injected content.
 */
async function testClaudeNoHookBaseline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reminder-baseline-'));
  const result = await runBin('claude', [
    '-p', ASK_FOR_REMINDER,
    '--dangerously-skip-permissions',
    '--model', 'haiku',
    '--output-format', 'text',
  ], { cwd: dir });
  result.transcript = readClaudeTranscript(dir);
  assert.strictEqual(result.code, 0, `claude failed: ${result.stderr}`);
  assert.match(result.stdout, /<seen>\s*NONE\s*<\/seen>/i,
    'without any hook the model also answers NONE: that text is the prompt format, not injected context');
  assert.doesNotMatch(result.transcript, /hook additional context/);
  console.log('ok - no-hook baseline answers the same way');
}

async function testClaudeSuppressedInjectsNothing() {
  const server = await startReminderServer({ handler: suppressedHandler });
  try {
    const result = await runClaude(server, 'suppressed');
    assert.strictEqual(result.code, 0, `claude failed: ${result.stderr}`);
    assert.ok(server.requests.length >= 1, 'the hook still runs so the backend can decide');
    assert.match(result.stdout, /<seen>\s*NONE\s*<\/seen>/i,
      'a suppressed decision must look exactly like no hook: the model sees no reminder');
    assert.doesNotMatch(result.stdout, new RegExp(MARKER));
    assert.doesNotMatch(result.transcript, /hook additional context/,
      'a suppressed decision must not add any context entry to the transcript');

    const hooks = hookSuccessEntries(result.transcript);
    assert.ok(hooks.length >= 1, 'the hook must appear in the transcript as a successful, empty run');
    for (const hook of hooks) {
      assert.strictEqual(hook.content, '', 'hook_success must carry no content');
      assert.strictEqual(String(hook.stdout || '').trim(), '{}', 'the hook must only have emitted {}');
    }
    console.log(`ok - claude suppressed decision injects nothing (${server.requests.length} hook call(s))`);
  } finally {
    await server.close();
  }
}

function buildCodexOverride(command) {
  // TOML inline table, passed through -c so no file outside CODEX_HOME is needed
  return `hooks.PreToolUse=[{matcher="Bash|apply_patch",hooks=[{type="command",command="${command}",timeout=5}]}]`;
}

async function runCodex(server, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cx-reminder-${mode}-`));
  const command = buildReminderHookCommand({ cliPath: CLI_PATH });
  return runBin('codex', [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
    '--skip-git-repo-check',
    '-C', dir,
    '-c', buildCodexOverride(command),
    ASK_FOR_REMINDER,
  ], { cwd: dir, env: { MOBIUS_BASE: server.baseUrl, MOBIUS_SESSION_ID: 'live-mobius-session', MOBIUS_CLI_JWT: 'live-token' } });
}

async function testCodexShown() {
  const server = await startReminderServer({ handler: shownHandler });
  try {
    const result = await runCodex(server, 'shown');
    assert.strictEqual(result.code, 0, `codex failed: ${result.stderr}`);
    assert.ok(server.requests.length >= 1, 'codex must invoke the command hook');
    const body = JSON.parse(server.requests[0].body);
    assert.ok(['Bash', 'apply_patch', 'exec_command'].includes(body.tool_name),
      `unexpected codex tool name: ${body.tool_name}`);
    assert.match(result.stdout + result.stderr, new RegExp(MARKER), 'the model must see the reminder text');
    console.log(`ok - codex shows the reminder (${server.requests.length} hook call(s), tool=${body.tool_name})`);
  } finally {
    await server.close();
  }
}

async function testCodexSuppressedInjectsNothing() {
  const server = await startReminderServer({ handler: suppressedHandler });
  try {
    const result = await runCodex(server, 'suppressed');
    assert.strictEqual(result.code, 0, `codex failed: ${result.stderr}`);
    assert.ok(server.requests.length >= 1, 'the hook still runs so the backend can decide');
    assert.match(result.stdout + result.stderr, /<seen>\s*NONE\s*<\/seen>/i,
      'a suppressed decision must look exactly like no hook');
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(MARKER));
    console.log(`ok - codex suppressed decision injects nothing (${server.requests.length} hook call(s))`);
  } finally {
    await server.close();
  }
}

async function main() {
  if (process.env.MOBIUS_HOOK_LIVE !== '1') {
    console.log('skip - set MOBIUS_HOOK_LIVE=1 to run the live Claude Code checks');
    return;
  }
  await testClaudeNoHookBaseline();
  await testClaudeShown();
  await testClaudeSuppressedInjectsNothing();

  if (process.env.MOBIUS_HOOK_LIVE_CODEX !== '1') {
    console.log('skip - set MOBIUS_HOOK_LIVE_CODEX=1 to run the live Codex checks');
    return;
  }
  await testCodexShown();
  await testCodexSuppressedInjectsNothing();
}

main().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
