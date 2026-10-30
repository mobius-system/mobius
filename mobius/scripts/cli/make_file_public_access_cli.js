#!/usr/bin/env node
'use strict';

/*
 * make_file_public_access — publish one local file on the Mobius static share
 * and print the public URL anyone can open.
 *
 * Everything the backend needs is sent to POST /static_share/upload as
 * multipart/form-data: the bytes, the share directory, the display name, the
 * expiry and scope=public. Address and credential come from the session
 * environment (MOBIUS_BASE / MOBIUS_CLI_JWT), never from a local config file.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');

const MAX_PUBLIC_BYTES = 10 * 1024 * 1024;
const MAX_NAME_CHARS = 50;
const MAX_PATH_CHARS = 50;
const MAX_PATH_DEPTH = 6;
const MAX_EXPIRE_DAYS = 3650;
const DEFAULT_EXPIRE_DAYS = 7;
const TIMEOUT_MS = 60 * 1000;

// 与服务端同一套白名单: 中文/英文/数字/下划线 + 单点, 且不允许空点段
// Same whitelist as the backend: CJK / latin / digits / underscore + single dots
const SEGMENT_RE = /^[\p{Script=Han}A-Za-z0-9_]+(?:\.[\p{Script=Han}A-Za-z0-9_]+)*$/u;
const EXPIRE_RE = /^([1-9][0-9]{0,3})\s*(?:d|D|天)?$/;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function usage(stream = process.stdout) {
  stream.write('Usage: make_file_public_access --path=<file> [options]\n\n');
  stream.write('  Upload one local file to the Mobius static share and print a public URL.\n');
  stream.write('  Anyone with the link can open it until the expiry date.\n\n');
  stream.write('Options:\n');
  stream.write('  --path <file>        local file to publish (required)\n');
  stream.write('  --file-name <name>   name served on the link; default: basename of --path\n');
  stream.write('  --at-dir <dir>       share directory, may contain "/"; default: share root\n');
  stream.write('  --expire [days]      validity in days (default 7, max 3650); bare --expire means default\n');
  stream.write('  --json               print the raw backend JSON response\n');
  stream.write('  -h, --help           show this help and exit\n\n');
  stream.write('Rules:\n');
  stream.write(`  - public files must be <= ${MAX_PUBLIC_BYTES / 1024 / 1024}MB\n`);
  stream.write(`  - file name / each directory segment: CJK, letters, digits, "_" and single "." only, <= ${MAX_NAME_CHARS} chars\n`);
  stream.write(`  - whole directory path: <= ${MAX_PATH_CHARS} chars, <= ${MAX_PATH_DEPTH} levels\n\n`);
  stream.write('Environment (required):\n');
  stream.write('  MOBIUS_BASE     backend base URL\n');
  stream.write('  MOBIUS_CLI_JWT  per-session CLI token\n\n');
  stream.write('Exit codes:\n');
  stream.write('  0 success · 2 usage/input error · 3 configuration error · 4 authentication error\n');
  stream.write('  5 network error · 6 protocol error · 7 permission error · 8 not found · 10 backend error\n\n');
  stream.write('Examples:\n');
  stream.write('  make_file_public_access --path=./report.html\n');
  stream.write('  make_file_public_access --path=./demo.html --file-name=demo.html --at-dir=demos/2026 --expire=30\n');
  stream.write('  make_file_public_access --path=/tmp/chart.png --file-name=chart.png --at-dir=charts --expire\n');
}

function takeOption(args, index, name) {
  const arg = args[index];
  if (arg === name) {
    if (index + 1 >= args.length || args[index + 1].startsWith('--')) return { value: null, consumed: 1 };
    return { value: args[index + 1], consumed: 2 };
  }
  if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), consumed: 1 };
  return null;
}

function codePointLength(value) {
  return Array.from(value).length;
}

function validateSegment(raw, label) {
  const value = String(raw || '').normalize('NFC');
  if (!value) fail(`Input error: ${label} must not be empty`);
  if (codePointLength(value) > MAX_NAME_CHARS) fail(`Input error: ${label} must be at most ${MAX_NAME_CHARS} characters`);
  if (value.includes('..')) fail(`Input error: ${label} must not contain consecutive dots`);
  if (!SEGMENT_RE.test(value)) {
    fail(`Input error: ${label} may only contain Chinese, English, digits, "_" and single dots`);
  }
  return value;
}

function validateDir(raw) {
  const value = String(raw || '').trim().normalize('NFC').replace(/^\/+|\/+$/g, '');
  if (!value) return '';
  if (codePointLength(value) > MAX_PATH_CHARS) fail(`Input error: --at-dir must be at most ${MAX_PATH_CHARS} characters`);
  const segments = value.split('/');
  if (segments.length > MAX_PATH_DEPTH) fail(`Input error: --at-dir must be at most ${MAX_PATH_DEPTH} levels deep`);
  return segments.map((segment) => validateSegment(segment, '--at-dir segment')).join('/');
}

function parseExpire(raw) {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_EXPIRE_DAYS;
  const match = String(raw).trim().match(EXPIRE_RE);
  if (!match) fail('Input error: --expire must be a positive integer number of days (max 3650)');
  const days = Number(match[1]);
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRE_DAYS) {
    fail(`Input error: --expire must be between 1 and ${MAX_EXPIRE_DAYS} days`);
  }
  return days;
}

function parseArgs(args) {
  if (args.includes('-h') || args.includes('--help')) {
    usage();
    process.exit(0);
  }
  let filePath = null;
  let fileName = null;
  let atDir = null;
  let expireRaw = null;
  let expireSeen = false;
  let json = false;

  for (let i = 0; i < args.length;) {
    const arg = args[i];
    const pathOption = takeOption(args, i, '--path');
    if (pathOption) {
      if (!pathOption.value) fail('Input error: --path requires a value');
      filePath = pathOption.value;
      i += pathOption.consumed;
      continue;
    }
    const nameOption = takeOption(args, i, '--file-name');
    if (nameOption) {
      if (!nameOption.value) fail('Input error: --file-name requires a value');
      fileName = nameOption.value;
      i += nameOption.consumed;
      continue;
    }
    const dirOption = takeOption(args, i, '--at-dir');
    if (dirOption) {
      atDir = dirOption.value === null ? '' : dirOption.value;
      i += dirOption.consumed;
      continue;
    }
    const expireOption = takeOption(args, i, '--expire');
    if (expireOption) {
      if (expireSeen) fail('Input error: --expire may be specified only once');
      expireSeen = true;
      expireRaw = expireOption.value;
      i += expireOption.consumed;
      continue;
    }
    if (arg === '--json') { json = true; i += 1; continue; }
    fail(`Input error: unknown argument: ${arg}`);
  }

  if (!filePath) fail('Input error: --path is required');
  return {
    localPath: path.resolve(filePath),
    fileName,
    atDir,
    expireDays: parseExpire(expireRaw),
    json,
  };
}

/*
 * Build the multipart body in memory. Public uploads are capped at 10MB, so
 * buffering is bounded and keeps the CLI dependency-free.
 */
function buildMultipart(input, bytes) {
  const boundary = `----mobius${crypto.randomBytes(12).toString('hex')}`;
  const escapeName = (value) => value.replace(/["\\\r\n]/g, '_');
  const textField = (name, value) => Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    'utf8',
  );
  const fileHead = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escapeName(input.fileName)}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    boundary,
    body: Buffer.concat([
      textField('filename', input.fileName),
      textField('file_path', input.atDir),
      textField('expires_in_days', String(input.expireDays)),
      textField('scope', 'public'),
      fileHead,
      bytes,
      tail,
    ]),
  };
}

function request(base, body, contentType, token) {
  const transport = base.protocol === 'https:' ? https : http;
  const port = base.port || (base.protocol === 'https:' ? 443 : 80);
  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: base.hostname,
      port: Number(port),
      method: 'POST',
      path: '/static_share/upload',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType,
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`request timed out after ${TIMEOUT_MS / 1000} seconds`)));
    req.on('error', reject);
    req.end(body);
  });
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  const input = parseArgs(process.argv.slice(2));

  let stat;
  try {
    stat = fs.statSync(input.localPath);
  } catch {
    fail(`Input error: file not found: ${input.localPath}`);
  }
  if (!stat.isFile()) fail(`Input error: not a regular file: ${input.localPath}`);
  if (stat.size <= 0) fail(`Input error: file is empty: ${input.localPath}`);
  if (stat.size > MAX_PUBLIC_BYTES) {
    fail(`Input error: public files must be <= ${MAX_PUBLIC_BYTES / 1024 / 1024}MB (got ${humanSize(stat.size)})`);
  }

  input.fileName = validateSegment(input.fileName || path.basename(input.localPath), '--file-name');
  input.atDir = validateDir(input.atDir);

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

  const bytes = fs.readFileSync(input.localPath);
  const { boundary, body } = buildMultipart(input, bytes);

  let response;
  try {
    // ✨ 真正把文件发布出去的一步
    // ✨ The one call that actually publishes the file
    response = await request(base, body, `multipart/form-data; boundary=${boundary}`, token);
  } catch (error) {
    fail(`Network error: unable to connect to Mobius at ${base.host}: ${error.message}`, 5);
  }

  let payload = null;
  try { payload = JSON.parse(response.body); } catch {}
  if (response.status < 200 || response.status >= 300) {
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
    fail(`${prefix} (HTTP ${status}): ${reason}`, code);
  }

  if (!payload || !payload.access_url) fail('Protocol error: Mobius returned an invalid upload response', 6);
  const publicUrl = payload.absolute_url || new URL(payload.access_url, rawBase).toString();

  if (input.json) {
    process.stdout.write(`${JSON.stringify({ ...payload, public_url: publicUrl }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Public URL: ${publicUrl}\n`);
  process.stdout.write(`File: ${input.atDir ? `${input.atDir}/` : ''}${input.fileName} (${humanSize(stat.size)})\n`);
  process.stdout.write(`Expires: ${payload.expires_at} (${input.expireDays} day${input.expireDays === 1 ? '' : 's'})\n`);
  process.stdout.write('Access: anyone with the link, no login required\n');
}

main().catch((error) => fail(`Unexpected error: ${error && error.message ? error.message : error}`, 10));
