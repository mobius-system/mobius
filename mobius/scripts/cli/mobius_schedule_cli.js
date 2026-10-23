#!/usr/bin/env node
'use strict';

const http = require('http');

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DURATION_RE = /^([1-9][0-9]*)([smhd])$/;
const MAX_SECONDS = 365 * 24 * 60 * 60;
const MIN_INTERVAL_SECONDS = 10 * 60;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function usage(mode, stream = process.stdout) {
  if (mode === 'wake') {
    stream.write('Usage:\n');
    stream.write('  mobius_schedule_wake_me_up <session_id> --once --after-time <duration> --reminder <text>\n');
    stream.write('  mobius_schedule_wake_me_up <session_id> --interval --interval-time <duration> --reminder <text>\n\n');
    stream.write('  Schedule a reminder that wakes one Mobius Session later.\n\n');
    stream.write('Options:\n');
    stream.write('  --once                 fire once after --after-time, then cancel itself\n');
    stream.write('  --after-time <duration> delay before the single wake-up\n');
    stream.write('  --interval             repeat every --interval-time until cancelled\n');
    stream.write('  --interval-time <duration> repeat period; minimum 10m\n');
    stream.write('  --reminder <text>      reminder text delivered when the Session wakes\n');
    stream.write('  -h, --help             show this help and exit\n\n');
    stream.write('Duration format: positive integer followed by s, m, h, or d (max 365d).\n');
    stream.write('Examples:\n');
    stream.write('  mobius_schedule_wake_me_up abc123 --once --after-time 30m --reminder "check the build"\n');
    stream.write('  mobius_schedule_wake_me_up abc123 --interval --interval-time 2h --reminder "check service health"\n');
    return;
  }
  if (mode === 'list') {
    stream.write('Usage: mobius_schedule_list [--json]\n\n');
    stream.write('  List the scheduled wake-ups of the current Session.\n\n');
    stream.write('Options:\n');
    stream.write('  --json     print the raw JSON payload\n');
    stream.write('  -h, --help show this help and exit\n');
    return;
  }
  stream.write('Usage: mobius_schedule_cancel_all --session-id <session_id>\n\n');
  stream.write('  Cancel every scheduled wake-up of one Session.\n\n');
  stream.write('Options:\n');
  stream.write('  --session-id <id>  Mobius Session ID\n');
  stream.write('  -h, --help         show this help and exit\n');
}

function takeOption(args, index, name) {
  const arg = args[index];
  if (arg === name) {
    if (index + 1 >= args.length || args[index + 1].startsWith('--')) fail(`Input error: ${name} requires a value`);
    return { value: args[index + 1], consumed: 2 };
  }
  if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), consumed: 1 };
  return null;
}

function one(values, name, required = false) {
  if (values.length > 1) fail(`Input error: ${name} may be specified only once`);
  if (required && values.length === 0) fail(`Input error: ${name} is required`);
  return values.length ? values[0] : null;
}

function durationSeconds(raw, optionName) {
  const match = String(raw || '').match(DURATION_RE);
  if (!match) fail(`Input error: ${optionName} must use a positive integer followed by s, m, h, or d`);
  const scale = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
  const seconds = Number(match[1]) * scale;
  if (!Number.isSafeInteger(seconds) || seconds > MAX_SECONDS) {
    fail(`Input error: ${optionName} must not exceed 365d`);
  }
  return seconds;
}

/*
 * Parse the deliberately small command surface before any authentication or network activity.
 */
function parseArgs(mode, args) {
  if (args.includes('-h') || args.includes('--help')) {
    usage(mode);
    process.exit(0);
  }
  if (mode === 'list') {
    if (args.length === 0) return { json: false, sessionHint: null };
    if (args.length === 1 && args[0] === '--json') return { json: true, sessionHint: null };
    fail(`Input error: unknown option: ${args[0]}`);
  }
  if (mode === 'cancel-all') {
    const values = [];
    for (let i = 0; i < args.length;) {
      const option = takeOption(args, i, '--session-id');
      if (!option) fail(`Input error: unknown option: ${args[i]}`);
      values.push(option.value);
      i += option.consumed;
    }
    const sessionId = String(one(values, '--session-id', true)).trim();
    if (!ID_RE.test(sessionId)) fail('Input error: --session-id format is invalid');
    return { sessionId, sessionHint: sessionId };
  }
  if (mode !== 'wake') fail('Internal error: unsupported command mode', 6);

  const positional = [];
  const afterTimes = [];
  const intervalTimes = [];
  const reminders = [];
  let once = 0;
  let interval = 0;
  for (let i = 0; i < args.length;) {
    const arg = args[i];
    const afterTime = takeOption(args, i, '--after-time');
    if (afterTime) { afterTimes.push(afterTime.value); i += afterTime.consumed; continue; }
    const intervalTime = takeOption(args, i, '--interval-time');
    if (intervalTime) { intervalTimes.push(intervalTime.value); i += intervalTime.consumed; continue; }
    const reminder = takeOption(args, i, '--reminder');
    if (reminder) { reminders.push(reminder.value); i += reminder.consumed; continue; }
    if (arg === '--once') { once += 1; i += 1; continue; }
    if (arg === '--interval') { interval += 1; i += 1; continue; }
    if (arg.startsWith('--')) fail(`Input error: unknown option: ${arg}`);
    positional.push(arg);
    i += 1;
  }
  if (positional.length !== 1 || !ID_RE.test(positional[0])) {
    fail('Input error: exactly one valid <session_id> is required');
  }
  if (once > 1 || interval > 1) fail('Input error: --once and --interval may each be specified only once');
  if ((once === 1) === (interval === 1)) fail('Input error: exactly one of --once or --interval is required');
  const reminder = String(one(reminders, '--reminder', true)).trim();
  if (!reminder) fail('Input error: --reminder must not be empty');

  if (once) {
    const raw = one(afterTimes, '--after-time', true);
    if (intervalTimes.length) fail('Input error: --interval-time cannot be used with --once');
    return {
      sessionId: positional[0], sessionHint: positional[0], mode: 'once',
      scheduleSeconds: durationSeconds(raw, '--after-time'), reminder,
    };
  }
  const raw = one(intervalTimes, '--interval-time', true);
  if (afterTimes.length) fail('Input error: --after-time cannot be used with --interval');
  const scheduleSeconds = durationSeconds(raw, '--interval-time');
  if (scheduleSeconds < MIN_INTERVAL_SECONDS) fail('Input error: interval-time must be at least 10m');
  return { sessionId: positional[0], sessionHint: positional[0], mode: 'interval', scheduleSeconds, reminder };
}

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(30000, () => req.destroy(new Error('request timed out after 30 seconds')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function durationLabel(seconds) {
  for (const [unit, scale] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    if (seconds % scale === 0) return `${seconds / scale}${unit}`;
  }
  return `${seconds}s`;
}

function printWakeupList(wakeups) {
  if (!wakeups.length) {
    process.stdout.write('No active scheduled wake-up tasks found\n');
    return;
  }
  process.stdout.write('JOB_ID\tSESSION_ID\tMODE\tSCHEDULE\tNEXT_RUN\tREMINDER\n');
  for (const item of wakeups) {
    const reminder = String(item.reminder || '').replace(/[\r\n\t]+/g, ' ');
    process.stdout.write(`${item.id}\t${item.session_id}\t${item.mode}\t${durationLabel(item.schedule_seconds)}\t${item.next_run_at || '-'}\t${reminder}\n`);
  }
}

async function main() {
  const mode = process.argv[2];
  if (!['wake', 'list', 'cancel-all'].includes(mode)) fail('Internal error: invalid command mode', 6);
  const input = parseArgs(mode, process.argv.slice(3));

  // 地址与令牌全部来自会话环境: 宿主与沙箱走同一条路, 没有本机回落
  // Address and token come from the session environment only; no host fallback
  const sessionBase = String(process.env.MOBIUS_BASE || '').trim();
  const token = String(process.env.MOBIUS_CLI_JWT || '').trim();
  if (!sessionBase) fail('Configuration error: MOBIUS_BASE is unset', 3);
  if (!token) fail('Configuration error: MOBIUS_CLI_JWT is unset', 3);
  let parsedBase;
  try { parsedBase = new URL(sessionBase); } catch { fail(`Configuration error: invalid MOBIUS_BASE: ${sessionBase}`, 3); }
  const hostname = parsedBase.hostname;
  const rawPort = parsedBase.port || (parsedBase.protocol === 'https:' ? '443' : '80');

  let method = 'GET';
  let requestPath = '/api/scheduled-wake-ups';
  let body = null;
  if (mode === 'wake') {
    method = 'POST';
    body = JSON.stringify({
      session_id: input.sessionId,
      mode: input.mode,
      ...(input.mode === 'once' ? { after_seconds: input.scheduleSeconds } : { interval_seconds: input.scheduleSeconds }),
      reminder: input.reminder,
    });
  } else if (mode === 'cancel-all') {
    method = 'DELETE';
    requestPath += `?session_id=${encodeURIComponent(input.sessionId)}`;
  }

  let response;
  try {
    response = await request({
      hostname, port: Number(rawPort), method, path: requestPath,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, body);
  } catch (error) {
    fail(`Network error: unable to connect to Mobius at ${hostname}:${rawPort}: ${error.message}`, 5);
  }

  let payload = null;
  try { payload = JSON.parse(response.body); } catch {}
  if (response.status < 200 || response.status >= 300) {
    const reason = payload?.error || response.body.trim() || 'request rejected';
    const prefix = response.status === 400 ? 'Input error'
      : response.status === 401 ? 'Authentication error'
        : response.status === 403 ? 'Permission error'
          : response.status === 404 ? 'Lookup error'
            : `Backend error (HTTP ${response.status})`;
    fail(`${prefix}: ${reason}`, response.status === 400 ? 2 : response.status === 401 ? 4 : response.status === 403 ? 7 : response.status === 404 ? 8 : 10);
  }
  if (mode === 'list') {
    if (!Array.isArray(payload?.wakeups)) fail('Protocol error: Mobius returned an invalid list response', 6);
    if (input.json) process.stdout.write(`${JSON.stringify(payload.wakeups, null, 2)}\n`);
    else printWakeupList(payload.wakeups);
    return;
  }
  if (mode === 'cancel-all') {
    const count = Number(payload?.cancelled);
    if (!Number.isSafeInteger(count) || count < 0) fail('Protocol error: Mobius returned an invalid cancel response', 6);
    process.stdout.write(count === 0
      ? `No active scheduled wake-up tasks found for Session ${input.sessionId}\n`
      : `Cancelled ${count} scheduled wake-up task${count === 1 ? '' : 's'} for Session ${input.sessionId}\n`);
    return;
  }
  if (!payload?.wakeup?.id || !payload?.wakeup?.next_run_at) fail('Protocol error: Mobius returned an invalid create response', 6);
  process.stdout.write(`Scheduled ${input.mode} wake-up ${payload.wakeup.id} for Session ${input.sessionId} at ${payload.wakeup.next_run_at}\n`);
}

main().catch((error) => fail(`Unexpected error: ${error?.message || error}`, 10));
