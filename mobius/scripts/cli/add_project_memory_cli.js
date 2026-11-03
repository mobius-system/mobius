#!/usr/bin/env node
'use strict';

/*
 * add_project_memory — create one project-scoped Memory for the Session's project.
 *
 * Two backend calls, both existing APIs:
 *   GET  /api/sessions/<session_id>/project   -> resolves "the current project"
 *   POST /api/projects/<project_id>/memories  -> { name, description, body }
 *
 * Address and credential come from the session environment (MOBIUS_BASE /
 * MOBIUS_CLI_JWT), and the session id from MOBIUS_SESSION_ID. Nothing local.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');

const MAX_NAME_CHARS = 200;
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const TIMEOUT_MS = 60 * 1000;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function usage(stream = process.stdout) {
  stream.write('Usage: add_project_memory --name=<name> [options]\n\n');
  stream.write('  Add one Memory to the project of the current Mobius Session.\n');
  stream.write('  The project is resolved from the session unless --project is given.\n\n');
  stream.write('Options:\n');
  stream.write('  --name <name>         memory title (required, <= 200 characters)\n');
  stream.write('  --description <text>  one-line summary shown in the Memory list\n');
  stream.write('  --body <text>         memory body (inline)\n');
  stream.write('  --body-file <path>    read the memory body from a file\n');
  stream.write('  --stdin               read the memory body from standard input\n');
  stream.write('  --project <id>        target project id; default: the Session project\n');
  stream.write('  --session <id>        Session id used for project lookup; default: MOBIUS_SESSION_ID\n');
  stream.write('  --json                print the raw backend JSON response\n');
  stream.write('  -h, --help            show this help and exit\n\n');
  stream.write('Exactly one of --body / --body-file / --stdin is required.\n\n');
  stream.write('Environment (required):\n');
  stream.write('  MOBIUS_BASE        backend base URL\n');
  stream.write('  MOBIUS_CLI_JWT     per-session CLI token\n');
  stream.write('  MOBIUS_SESSION_ID  Session id (used unless --session is given)\n\n');
  stream.write('Exit codes:\n');
  stream.write('  0 success · 2 usage/input error · 3 configuration error · 4 authentication error\n');
  stream.write('  5 network error · 6 protocol error · 7 permission error · 8 not found · 10 backend error\n\n');
  stream.write('Examples:\n');
  stream.write('  add_project_memory --name="构建约定" --description="跑测试前先 tsc" --body="提交前必须 tsc -p tsconfig.backend.json"\n');
  stream.write('  add_project_memory --name="部署流程" --body-file=./notes.md\n');
  stream.write('  printf "第一行\\n第二行" | add_project_memory --name="口诀" --stdin\n');
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

function parseArgs(args) {
  if (args.includes('-h') || args.includes('--help')) {
    usage();
    process.exit(0);
  }
  const out = { name: null, description: '', body: null, bodyFile: null, stdin: false, project: null, session: null, json: false };
  for (let i = 0; i < args.length;) {
    const nameOption = takeOption(args, i, '--name');
    if (nameOption) { out.name = nameOption.value; i += nameOption.consumed; continue; }
    const descOption = takeOption(args, i, '--description');
    if (descOption) { out.description = descOption.value; i += descOption.consumed; continue; }
    const bodyOption = takeOption(args, i, '--body');
    if (bodyOption) { out.body = bodyOption.value; i += bodyOption.consumed; continue; }
    const bodyFileOption = takeOption(args, i, '--body-file');
    if (bodyFileOption) { out.bodyFile = bodyFileOption.value; i += bodyFileOption.consumed; continue; }
    const projectOption = takeOption(args, i, '--project');
    if (projectOption) { out.project = projectOption.value; i += projectOption.consumed; continue; }
    const sessionOption = takeOption(args, i, '--session');
    if (sessionOption) { out.session = sessionOption.value; i += sessionOption.consumed; continue; }
    if (args[i] === '--stdin') { out.stdin = true; i += 1; continue; }
    if (args[i] === '--json') { out.json = true; i += 1; continue; }
    fail(`Input error: unknown argument: ${args[i]}`);
  }

  if (!out.name || !out.name.trim()) fail('Input error: --name is required');
  const name = out.name.trim();
  if (Array.from(name).length > MAX_NAME_CHARS) fail(`Input error: --name must be at most ${MAX_NAME_CHARS} characters`);
  if (/[\r\n]/.test(name)) fail('Input error: --name must be a single line');
  out.name = name;

  const sources = [out.body !== null, out.bodyFile !== null, out.stdin].filter(Boolean).length;
  if (sources === 0) fail('Input error: one of --body, --body-file or --stdin is required');
  if (sources > 1) fail('Input error: --body, --body-file and --stdin are mutually exclusive');
  return out;
}

function resolveBody(input) {
  let body;
  if (input.body !== null) {
    body = input.body;
  } else if (input.bodyFile !== null) {
    try {
      body = fs.readFileSync(input.bodyFile, 'utf8');
    } catch (error) {
      fail(`Input error: cannot read --body-file ${input.bodyFile}: ${error.message}`);
    }
  } else {
    if (process.stdin.isTTY) fail('Input error: --stdin is set but no input is piped in');
    body = fs.readFileSync(0, 'utf8');
  }
  body = String(body || '').replace(/\r\n/g, '\n');
  if (!body.trim()) fail('Input error: memory body must not be empty');
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    fail(`Input error: memory body must be at most ${MAX_BODY_BYTES / 1024 / 1024}MB`);
  }
  return body;
}

function request(base, method, requestPath, token, payload) {
  const transport = base.protocol === 'https:' ? https : http;
  const port = base.port || (base.protocol === 'https:' ? 443 : 80);
  const data = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : null;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: base.hostname,
      port: Number(port),
      method,
      path: requestPath,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`request timed out after ${TIMEOUT_MS / 1000} seconds`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function describeFailure(response) {
  let payload = null;
  try { payload = JSON.parse(response.body); } catch {}
  const reason = (payload && payload.error) || response.body.trim() || 'request rejected';
  const status = response.status;
  const code = status === 400 || status === 409 || status === 413 ? 2
    : status === 401 ? 4
      : status === 403 ? 7
        : status === 404 ? 8
          : 10;
  const prefix = status === 400 || status === 409 || status === 413 ? 'Input error'
    : status === 401 ? 'Authentication error'
      : status === 403 ? 'Permission error'
        : status === 404 ? 'Not found'
          : 'Backend error';
  return { message: `${prefix} (HTTP ${status}): ${reason}`, code, payload };
}

async function main() {
  const input = parseArgs(process.argv.slice(2));
  const body = resolveBody(input);

  // 地址与令牌全部来自会话环境, 宿主与沙箱走同一条路
  // Address and token come from the session environment only; host and sandbox share one path
  const rawBase = String(process.env.MOBIUS_BASE || '').trim();
  const token = String(process.env.MOBIUS_CLI_JWT || '').trim();
  if (!rawBase) fail('Configuration error: MOBIUS_BASE is unset', 3);
  if (!token) fail('Configuration error: MOBIUS_CLI_JWT is unset', 3);
  let base;
  try {
    base = new URL(rawBase);
  } catch {
    fail(`Configuration error: invalid MOBIUS_BASE: ${rawBase}`, 3);
  }

  let projectId = input.project ? String(input.project).trim() : '';
  let projectName = '';
  if (!projectId) {
    const sessionId = String(input.session || process.env.MOBIUS_SESSION_ID || '').trim();
    if (!sessionId) {
      fail('Configuration error: MOBIUS_SESSION_ID is unset; pass --project or --session', 3);
    }
    let lookup;
    try {
      lookup = await request(base, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}/project`, token, null);
    } catch (error) {
      fail(`Network error: unable to connect to Mobius at ${base.host}: ${error.message}`, 5);
    }
    let info = null;
    try { info = JSON.parse(lookup.body); } catch {}
    if (lookup.status < 200 || lookup.status >= 300) {
      const failure = describeFailure(lookup);
      fail(failure.message, failure.code);
    }
    if (!info || !info.project_id) fail('Protocol error: Mobius returned an invalid project response', 6);
    projectId = String(info.project_id);
    projectName = String(info.project_name || '');
  }

  let response;
  try {
    // ✨ 真正写入项目记忆的一次调用
    // ✨ The one call that actually writes the project memory
    response = await request(
      base,
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/memories`,
      token,
      { name: input.name, description: input.description || '', body },
    );
  } catch (error) {
    fail(`Network error: unable to connect to Mobius at ${base.host}: ${error.message}`, 5);
  }

  let payload = null;
  try { payload = JSON.parse(response.body); } catch {}
  if (response.status < 200 || response.status >= 300) {
    const failure = describeFailure(response);
    fail(failure.message, failure.code);
  }
  if (!payload || !payload.id) fail('Protocol error: Mobius returned an invalid memory response', 6);

  if (input.json) {
    process.stdout.write(`${JSON.stringify({ ...payload, project_id: projectId, project_name: projectName || null }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Added project memory ${JSON.stringify(payload.name)}\n`);
  process.stdout.write(`Project: ${projectName ? `${projectName} (${projectId})` : projectId}\n`);
  process.stdout.write(`Memory ID: ${payload.id}\n`);
  process.stdout.write(`Body: ${Array.from(body).length} characters\n`);
}

main().catch((error) => fail(`Unexpected error: ${error && error.message ? error.message : error}`, 10));
