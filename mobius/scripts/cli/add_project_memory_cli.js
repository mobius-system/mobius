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

const http = require('http');
const https = require('https');

const MAX_NAME_CHARS = 200;
const MAX_CONTENT_CHARS = 10000;
const TIMEOUT_MS = 60 * 1000;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function usage(stream = process.stdout) {
  stream.write('Usage: add_project_memory --memory-name=<name> --memory-content=<text>\n\n');
  stream.write('  Add one Memory to the project of the current Mobius Session.\n');
  stream.write('  The project is resolved from the Session; no project id is needed.\n\n');
  stream.write('Options:\n');
  stream.write('  --memory-name <name>      memory title (required, single line, <= 200 characters)\n');
  stream.write('  --memory-content <text>   memory body (required, at most 10000 characters; quote multi-line text)\n');
  stream.write('  -h, --help                show this help and exit\n\n');
  stream.write('Environment (required):\n');
  stream.write('  MOBIUS_BASE        backend base URL\n');
  stream.write('  MOBIUS_CLI_JWT     per-session CLI token\n');
  stream.write('  MOBIUS_SESSION_ID  Session id used to resolve the current project\n\n');
  stream.write('Exit codes:\n');
  stream.write('  0 success · 2 usage/input error · 3 configuration error · 4 authentication error\n');
  stream.write('  5 network error · 6 protocol error · 7 permission error · 8 not found · 10 backend error\n\n');
  stream.write('Examples:\n');
  stream.write('  add_project_memory --memory-name="构建约定" --memory-content="提交前必须跑 tsc -p tsconfig.backend.json"\n');
  stream.write('  add_project_memory --memory-name="部署流程" --memory-content="$(cat notes.md)"\n');
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
  let name = null;
  let content = null;
  for (let i = 0; i < args.length;) {
    const nameOption = takeOption(args, i, '--memory-name');
    if (nameOption) { name = nameOption.value; i += nameOption.consumed; continue; }
    const contentOption = takeOption(args, i, '--memory-content');
    if (contentOption) { content = contentOption.value; i += contentOption.consumed; continue; }
    fail(`Input error: unknown argument: ${args[i]}`);
  }

  if (!name || !name.trim()) fail('Input error: --memory-name is required');
  const trimmedName = name.trim();
  if (Array.from(trimmedName).length > MAX_NAME_CHARS) fail(`Input error: --memory-name must be at most ${MAX_NAME_CHARS} characters`);
  if (/[\r\n]/.test(trimmedName)) fail('Input error: --memory-name must be a single line');

  if (content === null) fail('Input error: --memory-content is required');
  const body = String(content).replace(/\r\n/g, '\n');
  if (!body.trim()) fail('Input error: --memory-content must not be empty');
  // 正文上限 10000 字符, 与服务端 50MB 硬上限之外再加一道产品约束
  // Content is capped at 10000 characters, tighter than the server's 50MB hard limit
  if (Array.from(body).length > MAX_CONTENT_CHARS) {
    fail(`Input error: --memory-content must be at most ${MAX_CONTENT_CHARS} characters`);
  }
  return { name: trimmedName, body };
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
  const body = input.body;

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

  // 项目一律由当前会话解析, 不需要也不接受手工传项目 ID
  // The project always comes from the current Session; no manual project id
  const sessionId = String(process.env.MOBIUS_SESSION_ID || '').trim();
  if (!sessionId) fail('Configuration error: MOBIUS_SESSION_ID is unset', 3);
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
  const projectId = String(info.project_id);
  const projectName = String(info.project_name || '');

  let response;
  try {
    // ✨ 真正写入项目记忆的一次调用
    // ✨ The one call that actually writes the project memory
    response = await request(
      base,
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/memories`,
      token,
      { name: input.name, description: '', body },
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

  process.stdout.write(`Added project memory ${JSON.stringify(payload.name)}\n`);
  process.stdout.write(`Project: ${projectName ? `${projectName} (${projectId})` : projectId}\n`);
  process.stdout.write(`Memory ID: ${payload.id}\n`);
  process.stdout.write(`Body: ${Array.from(body).length} characters\n`);
}

main().catch((error) => fail(`Unexpected error: ${error && error.message ? error.message : error}`, 10));
