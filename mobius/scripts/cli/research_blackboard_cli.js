#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const LIMITED_WARNING = '【Mobius不鼓励使用 --limit-receiver，建议仅在用户强烈要求的情况下才去用它】';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function usage(mode, stream = process.stdout) {
  const command = mode === 'read' ? 'research_blackboard_read' : 'research_blackboard_write';
  const line = mode === 'read'
    ? `${command} --from=<self_id> --research=<research_id>`
    : `${command} --from=<self_id> --research=<research_id> [--limit-receiver --receiver=<receiver_id>] <content...>`;
  stream.write(`Usage: ${line}\n\n`);
  stream.write('IDs may be a Mobius Session ID or backend Agent ID.\n');
  if (mode === 'write') stream.write('Use --stdin instead of content arguments for multiline input.\n');
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

function parseArgs(mode, rawArgs) {
  const values = { from: [], research: [], receiver: [] };
  const positional = [];
  let limitedReceiver = false;
  let limitedCount = 0;
  let stdin = false;
  let positionalOnly = false;
  for (let i = 0; i < rawArgs.length;) {
    const arg = rawArgs[i];
    if (positionalOnly) {
      positional.push(arg);
      i += 1;
      continue;
    }
    if (arg === '--') {
      positionalOnly = true;
      i += 1;
      continue;
    }
    if (arg === '-h' || arg === '--help') {
      usage(mode);
      process.exit(0);
    }
    const from = takeOption(rawArgs, i, '--from');
    if (from) { values.from.push(from.value); i += from.consumed; continue; }
    const research = takeOption(rawArgs, i, '--research');
    if (research) { values.research.push(research.value); i += research.consumed; continue; }
    const receiver = takeOption(rawArgs, i, '--receiver');
    if (receiver) { values.receiver.push(receiver.value); i += receiver.consumed; continue; }
    if (arg === '--limit-receiver') {
      limitedReceiver = true;
      limitedCount += 1;
      i += 1;
      continue;
    }
    if (arg === '--stdin') {
      stdin = true;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) fail(`Input error: unknown option: ${arg}`);
    positional.push(arg);
    i += 1;
  }

  if (values.from.length !== 1) fail(values.from.length === 0 ? 'Input error: --from=<self_id> is required' : 'Input error: --from may be specified only once');
  if (values.research.length !== 1) fail(values.research.length === 0 ? 'Input error: --research=<research_id> is required' : 'Input error: --research may be specified only once');
  const from = values.from[0].trim();
  const research = values.research[0].trim();
  if (!ID_RE.test(from)) fail('Input error: --from must be one Session/Agent ID using only letters, digits, _ and - (1-128 characters)');
  if (!ID_RE.test(research)) fail('Input error: --research must use only letters, digits, _ and - (1-128 characters)');

  if (mode === 'read') {
    if (limitedReceiver || values.receiver.length || stdin || positional.length) fail('Input error: read accepts only --from and --research');
    return { from, research, limitedReceiver: false, receiver: null, content: null };
  }
  if (limitedCount > 1) fail('Input error: --limit-receiver may be specified only once');
  if (values.receiver.length > 1) fail('Input error: --receiver accepts exactly one receiver and may be specified only once');
  if (limitedReceiver && values.receiver.length === 0) fail('Input error: --limit-receiver requires exactly one --receiver=<receiver_id>');
  if (!limitedReceiver && values.receiver.length > 0) fail('Input error: --receiver requires --limit-receiver');
  const receiver = values.receiver.length ? values.receiver[0].trim() : null;
  if (values.receiver.length && (!ID_RE.test(receiver) || receiver.includes(','))) fail('Input error: --receiver accepts exactly one Session/Agent ID using only letters, digits, _ and -');
  if (receiver && receiver === from) fail('Input error: sender and receiver must be different Sessions');
  if (stdin && positional.length) fail('Input error: use either --stdin or content arguments, not both');
  const content = stdin ? fs.readFileSync(0, 'utf8') : positional.join(' ');
  if (!content.trim()) fail('Input error: content must not be empty');
  return { from, research, limitedReceiver, receiver, content };
}

function parseEnvValue(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, '').trim();
}

function readEnv(envPath) {
  const values = {};
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = rawLine.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = parseEnvValue(match[2]);
  }
  return values;
}

function resolveAppDir() {
  let candidate = process.env.MOBIUS_APP_DIR || process.env.APP_DIR || '';
  if (!candidate && process.env.MOBIUS_ROOT) candidate = path.dirname(process.env.MOBIUS_ROOT);
  const marker = path.join(__dirname, '.mobius-cli-app-dir');
  if (!candidate && fs.existsSync(marker)) candidate = fs.readFileSync(marker, 'utf8').trim();
  if (!candidate) {
    const inferred = path.resolve(__dirname, '../../..');
    if (fs.existsSync(path.join(inferred, '.env'))) candidate = inferred;
  }
  if (!candidate) fail('Configuration error: APP_DIR is unavailable; set MOBIUS_APP_DIR or reinstall the CLI', 3);
  try {
    candidate = fs.realpathSync(candidate);
  } catch {
    fail(`Configuration error: APP_DIR does not exist: ${candidate}`, 3);
  }
  const envPath = path.join(candidate, '.env');
  if (!fs.existsSync(envPath)) fail(`Configuration error: required environment file is missing: ${envPath}`, 3);
  return { appDir: candidate, envPath };
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

async function main() {
  const mode = process.argv[2];
  if (mode !== 'read' && mode !== 'write') fail('Internal error: command mode must be read or write', 6);
  const rawArgs = process.argv.slice(3);
  if (rawArgs.includes('--limit-receiver')) process.stderr.write(`${LIMITED_WARNING}\n`);
  const input = parseArgs(mode, rawArgs);
  const { appDir, envPath } = resolveAppDir();
  const env = readEnv(envPath);
  const secret = env.JWT_SECRET || '';
  if (!secret || secret.startsWith('change-me')) fail(`Configuration error: JWT_SECRET is missing, empty, or a placeholder in ${envPath}`, 3);
  const rawPort = env.VITE_PORT || env.MOBIUS_PORT || '';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    fail('Configuration error: APP_DIR/.env must define a valid VITE_PORT or MOBIUS_PORT; no fixed default is used', 3);
  }
  const codecPath = path.join(appDir, 'mobius', 'backend', 'utils', 'research-blackboard-capability.js');
  if (!fs.existsSync(codecPath)) fail(`Configuration error: Blackboard capability module is missing: ${codecPath}`, 3);
  const { RESEARCH_BLACKBOARD_CLI_TOKEN_HEADER, createResearchBlackboardCliToken } = require(codecPath);
  const token = createResearchBlackboardCliToken(secret, {
    action: mode,
    sessionRef: input.from,
    researchId: input.research,
    limitedReceiver: input.limitedReceiver,
    receiverRef: input.receiver,
  });
  const body = mode === 'write' ? JSON.stringify({ content: input.content }) : null;
  let response;
  try {
    response = await request({
      hostname: '127.0.0.1',
      port: Number(rawPort),
      method: mode === 'read' ? 'GET' : 'POST',
      path: `/api/research-blackboard/cli/${encodeURIComponent(input.research)}`,
      headers: {
        [RESEARCH_BLACKBOARD_CLI_TOKEN_HEADER]: token,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, body);
  } catch (error) {
    fail(`Network error: unable to connect to Mobius at 127.0.0.1:${rawPort}: ${error.message}`, 5);
  }
  if (response.status >= 200 && response.status < 300) {
    if (mode === 'read') {
      process.stdout.write(response.body);
      return;
    }
    try {
      const parsed = JSON.parse(response.body);
      if (!parsed.ok || !parsed.record?.id) throw new Error('invalid success response');
      process.stdout.write(`Blackboard write succeeded: ${parsed.record.id}\n`);
      return;
    } catch {
      fail('Protocol error: Mobius returned an invalid write response', 6);
    }
  }
  let reason = response.body.trim();
  try { reason = JSON.parse(response.body).error || reason; } catch {}
  const prefix = response.status === 401 ? 'Authentication error'
    : response.status === 403 ? 'Permission error'
      : response.status === 404 ? 'Lookup error'
        : response.status === 400 ? 'Input error'
          : `Backend error (HTTP ${response.status})`;
  fail(`${prefix}: ${reason || 'request rejected'}`, response.status === 400 ? 2 : response.status === 401 ? 4 : response.status === 403 ? 7 : response.status === 404 ? 8 : 10);
}

main().catch((error) => fail(`Unexpected error: ${error && error.message ? error.message : error}`, 10));
