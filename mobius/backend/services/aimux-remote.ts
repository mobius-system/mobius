import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Candidate aimux binaries, in priority order:
//   1. AIMUX_BIN env (explicit override)
//   2. ~/.local/bin/aimux (user-level install)
//   3. mobius/.venv-aimux/bin/aimux — the project venv provisioned by
//      start_product.py and used by ecosystem.config.js to run the bridge;
//      always present in this deployment.
//   4. bare 'aimux' on PATH (last resort, avoids ENOENT if none of the above exist)
const AIMUX_BIN_CANDIDATES = [
  process.env.AIMUX_BIN,
  path.join(os.homedir(), '.local', 'bin', 'aimux'),
  path.join(__dirname, '..', '..', '.venv-aimux', 'bin', 'aimux'),
];
const MAX_BUFFER = 1024 * 1024;
const REMOTE_FILE_READ_MAX_BYTES = Math.floor(1.5 * 1024 * 1024);
const REMOTE_FILE_WRITE_MAX_BYTES = 5 * 1024 * 1024;
const REMOTE_FILE_OUTPUT_MAX_BYTES = 3 * 1024 * 1024;

function aimuxBin(): string {
  for (const candidate of AIMUX_BIN_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return 'aimux';
}

function cleanOneLine(value: any, { max = 200, required = false, field = '字段' }: { max?: number; required?: boolean; field?: string } = {}): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (required && !s) throw new Error(`${field} 不能为空`);
  if (s.length > max) throw new Error(`${field} 过长`);
  if (/[\r\n\0]/.test(s)) throw new Error(`${field} 不能包含换行`);
  return s;
}

function cleanRemoteName(value: any, { required = true }: { required?: boolean } = {}): string {
  const s = cleanOneLine(value, { max: 128, required, field: 'remote name' });
  if (!s) return '';
  if (!/^[A-Za-z0-9._@:-]+$/.test(s)) {
    throw new Error('remote name 只能包含字母、数字、点、下划线、@、冒号和短横线');
  }
  return s;
}

function cleanTimeout(value: any, fallback: any): string {
  const s = cleanOneLine(value || fallback, { max: 12, required: true, field: 'timeout' });
  if (!/^\d+(ms|s|m)?$/.test(s)) throw new Error('timeout 格式非法');
  return s;
}

function timeoutToMs(value: any): number {
  const m = String(value || '').match(/^(\d+)(ms|s|m)?$/);
  if (!m) return 5000;
  const n = Number(m[1]);
  const unit = m[2] || 's';
  if (unit === 'ms') return n;
  if (unit === 'm') return n * 60 * 1000;
  return n * 1000;
}

function cleanPort(value: any): number {
  const n = Number(value || 22);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('port 必须是 1-65535 的整数');
  return n;
}

function cleanRemotePath(value: any): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length > 1000) throw new Error('远程路径过长');
  if (/[\r\n\0]/.test(s)) throw new Error('远程路径不能包含换行');
  return s || '~';
}

function runAimux(args: string[], { timeoutMs = 60000, maxBuffer = MAX_BUFFER }: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<any> {
  return new Promise((resolve) => {
    execFile(aimuxBin(), args, { timeout: timeoutMs, maxBuffer }, (error, stdout = '', stderr = '') => {
      const code = typeof error?.code === 'number' ? error.code : (error ? 1 : 0);
      resolve({
        ok: !error,
        exit_code: code,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: error ? (error.message || String(error)) : '',
      });
    });
  });
}

function runAimuxWithInput(
  args: string[],
  input: Buffer,
  { timeoutMs = 60000, maxBuffer = MAX_BUFFER }: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn(aimuxBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuffer) stdout.push(chunk);
      else child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) stderr.push(chunk);
      else child.kill('SIGTERM');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exit_code: 1, stdout: '', stderr: '', error: error.message || String(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const overflow = stdoutBytes > maxBuffer || stderrBytes > maxBuffer;
      resolve({
        ok: code === 0 && !timedOut && !overflow,
        exit_code: typeof code === 'number' ? code : 1,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
        error: timedOut ? `aimux 命令超时 (${timeoutMs}ms)` : (overflow ? 'aimux 响应超过大小限制' : ''),
      });
    });
    child.stdin.end(input);
  });
}

function parseJsonOutput(result: any): any {
  const raw = result.stdout || result.stderr || '';
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

function normalizedRemoteRoot(value: any): string {
  const cleaned = cleanRemotePath(value);
  return cleaned === '~' ? '.' : cleaned;
}

function normalizeRemoteRelativePath(value: any): string {
  const raw = typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '/';
  const rooted = raw.startsWith('/') ? raw : `/${raw}`;
  const parts = rooted.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('远程文件路径不能包含 . 或 ..');
  if (rooted.length > 2000 || /[\r\n\0]/.test(rooted)) throw new Error('远程文件路径格式非法');
  return parts.length ? `/${parts.join('/')}` : '/';
}

function remotePathSeparator(root: string): '/' | '\\' {
  return /^[A-Za-z]:[\\/]/.test(root) || (root.includes('\\') && !root.includes('/')) ? '\\' : '/';
}

function joinRemotePath(rootPath: any, relPath: any): string {
  const root = normalizedRemoteRoot(rootPath);
  const rel = normalizeRemoteRelativePath(relPath);
  if (rel === '/') return root;
  const separator = remotePathSeparator(root);
  const suffix = rel.slice(1).split('/').join(separator);
  const trimmedRoot = root.replace(/[\\/]+$/, '');
  return `${trimmedRoot || separator}${trimmedRoot ? separator : ''}${suffix}`;
}

function remoteBasename(value: any): string {
  const normalized = String(value || '').replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).pop() || normalized;
}

function remoteParent(value: any): string {
  const pathValue = String(value || '').replace(/[\\/]+$/, '');
  const index = Math.max(pathValue.lastIndexOf('/'), pathValue.lastIndexOf('\\'));
  if (index < 0) return '.';
  if (index === 0) return pathValue[0];
  return pathValue.slice(0, index);
}

async function aimuxFileList(remoteName: string, targetPath: string, timeoutMs = 70000): Promise<any> {
  const result = await runAimux(
    ['file', 'list', remoteName, '--path', targetPath, '--json'],
    { timeoutMs, maxBuffer: REMOTE_FILE_OUTPUT_MAX_BYTES },
  );
  const data = parseJsonOutput(result);
  if (!result.ok || !data || !Array.isArray(data.entries)) throw new Error(resultMessage(result));
  return data;
}

function resultMessage(result: any): string {
  const parsed = parseJsonOutput(result);
  if (parsed?.error?.message) return parsed.error.message;
  if (parsed?.message) return parsed.message;
  return result.stderr || result.stdout || result.error || 'aimux remote 命令执行失败';
}

async function listRemotes(): Promise<any[]> {
  const result = await runAimux(['remote', 'ls', '--json'], { timeoutMs: 70000 });
  const data = parseJsonOutput(result);
  if (!result.ok && !Array.isArray(data)) throw new Error(resultMessage(result));
  if (!Array.isArray(data)) throw new Error('aimux remote ls 返回格式异常');
  return data.map((item: any) => ({
    name: String(item.name || ''),
    user: String(item.user || ''),
    hostname: String(item.hostname || ''),
    port: Number(item.port || 22),
    status: String(item.status || ''),
    rtt_ms: typeof item.rtt_ms === 'number' ? item.rtt_ms : null,
  })).filter((item: any) => item.name);
}

async function testRemote(name: any, timeout: any): Promise<any> {
  const remoteName = cleanRemoteName(name);
  const timeoutValue = cleanTimeout(timeout, '5s');
  const result = await runAimux(['remote', 'test', remoteName, '--timeout', timeoutValue, '--json'], { timeoutMs: 20000 });
  const data = parseJsonOutput(result);
  return {
    ok: result.ok,
    exit_code: result.exit_code,
    remote: remoteName,
    result: data || null,
    stdout: data ? '' : result.stdout,
    stderr: data ? '' : result.stderr,
    message: data ? '' : (result.ok ? '' : resultMessage(result)),
  };
}

async function hardwareRemote(name: any, timeout: any): Promise<any> {
  const remoteName = cleanRemoteName(name);
  const timeoutValue = cleanTimeout(timeout, '10s');
  const result = await runAimux(['remote', 'hardware', remoteName, '--timeout', timeoutValue, '--json'], { timeoutMs: 30000 });
  const data = parseJsonOutput(result);
  return {
    ok: result.ok,
    exit_code: result.exit_code,
    remote: remoteName,
    result: data || null,
    stdout: data ? '' : result.stdout,
    stderr: data ? '' : result.stderr,
    message: result.ok ? '' : resultMessage(result),
  };
}

async function browseRemotePath(name: any, remotePath: any, timeout: any): Promise<any> {
  const remoteName = cleanRemoteName(name);
  const targetPath = normalizedRemoteRoot(remotePath);
  const timeoutValue = cleanTimeout(timeout, '8s');
  const data = await aimuxFileList(remoteName, targetPath, Math.max(3000, timeoutToMs(timeoutValue) + 2000));
  const resolvedPath = typeof data.path === 'string' && data.path ? data.path : targetPath;
  const entries = data.entries
    .filter((entry: any) => entry?.type === 'dir')
    .map((entry: any) => {
      const entryPath = String(entry.path || joinRemotePath(resolvedPath, `/${entry.name || ''}`));
      return { name: String(entry.name || remoteBasename(entryPath)), path: entryPath };
    })
    .filter((entry: any) => entry.name)
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  return {
    remote: remoteName,
    requested_path: targetPath,
    path: resolvedPath,
    parent: remoteParent(resolvedPath),
    entries,
  };
}

async function listRemoteFiles(name: any, rootPath: any, relPath: any): Promise<any> {
  const remoteName = cleanRemoteName(name);
  const relativePath = normalizeRemoteRelativePath(relPath);
  const targetPath = joinRemotePath(rootPath, relativePath);
  const data = await aimuxFileList(remoteName, targetPath);
  const listedPath = typeof data.path === 'string' && data.path ? data.path : targetPath;
  const entries = data.entries
    .filter((entry: any) => entry?.type === 'dir' || entry?.type === 'file')
    .map((entry: any) => {
      const entryPath = String(entry.path || joinRemotePath(listedPath, `/${entry.name || ''}`));
      const entryName = String(entry.name || remoteBasename(entryPath));
      const childRel = relativePath === '/' ? `/${entryName}` : `${relativePath}/${entryName}`;
      return {
        name: entryName,
        type: entry.type === 'dir' ? 'dir' : 'file',
        size: entry.type === 'file' ? Number(entry.size || 0) : null,
        modified: Number(entry.mtime || 0) > 0 ? new Date(Number(entry.mtime) * 1000).toISOString() : '',
        abs_path: entryPath,
        rel_path: childRel,
      };
    })
    .filter((entry: any) => entry.name)
    .sort((a: any, b: any) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
  return {
    remote: remoteName,
    root_path: normalizedRemoteRoot(rootPath),
    path: relativePath,
    remote_path: listedPath,
    entries,
  };
}

async function readRemoteFile(name: any, rootPath: any, relPath: any): Promise<any> {
  const remoteName = cleanRemoteName(name);
  const relativePath = normalizeRemoteRelativePath(relPath);
  if (relativePath === '/') throw new Error('请选择远程文件');
  const targetPath = joinRemotePath(rootPath, relativePath);
  const statResult = await runAimux(
    ['file', 'stat', remoteName, '--path', targetPath, '--json'],
    { timeoutMs: 70000 },
  );
  const stat = parseJsonOutput(statResult);
  if (!statResult.ok) throw new Error(resultMessage(statResult));
  if (!stat?.exists) throw new Error('远程文件不存在');
  if (stat.type !== 'file') throw new Error('目标不是文件');
  const size = Number(stat.size || 0);
  if (size > REMOTE_FILE_READ_MAX_BYTES) {
    return {
      remote: remoteName,
      root_path: normalizedRemoteRoot(rootPath),
      path: relativePath,
      name: remoteBasename(targetPath),
      abs_path: targetPath,
      size,
      content: '',
      truncated: true,
      binary: false,
    };
  }
  const readResult = await runAimux(
    ['file', 'read', remoteName, '--path', targetPath, '--b64'],
    { timeoutMs: 180000, maxBuffer: REMOTE_FILE_OUTPUT_MAX_BYTES },
  );
  if (!readResult.ok) throw new Error(resultMessage(readResult));
  let buffer: Buffer;
  try { buffer = Buffer.from(readResult.stdout || '', 'base64'); }
  catch { throw new Error('aimux 返回的远程文件内容格式异常'); }
  const binary = buffer.indexOf(0) !== -1;
  return {
    remote: remoteName,
    root_path: normalizedRemoteRoot(rootPath),
    path: relativePath,
    name: remoteBasename(targetPath),
    abs_path: targetPath,
    size,
    content: binary ? '' : buffer.toString('utf8'),
    truncated: false,
    binary,
  };
}

async function writeRemoteFile(name: any, rootPath: any, relPath: any, content: any): Promise<any> {
  const remoteName = cleanRemoteName(name);
  const relativePath = normalizeRemoteRelativePath(relPath);
  if (relativePath === '/') throw new Error('请选择远程文件');
  if (typeof content !== 'string') throw new Error('content 必须是字符串');
  const data = Buffer.from(content, 'utf8');
  if (data.length > REMOTE_FILE_WRITE_MAX_BYTES) {
    throw new Error(`远程文件过大 (${data.length} 字节)，超过 ${REMOTE_FILE_WRITE_MAX_BYTES} 上限`);
  }
  const targetPath = joinRemotePath(rootPath, relativePath);
  const statResult = await runAimux(
    ['file', 'stat', remoteName, '--path', targetPath, '--json'],
    { timeoutMs: 70000 },
  );
  const stat = parseJsonOutput(statResult);
  if (!statResult.ok) throw new Error(resultMessage(statResult));
  if (!stat?.exists) throw new Error('远程文件不存在');
  if (stat.type !== 'file') throw new Error('目标不是文件');
  const result = await runAimuxWithInput(
    ['file', 'write', remoteName, '--path', targetPath, '--stdin'],
    data,
    { timeoutMs: 180000 },
  );
  if (!result.ok) throw new Error(resultMessage(result));
  return {
    remote: remoteName,
    root_path: normalizedRemoteRoot(rootPath),
    path: relativePath,
    name: remoteBasename(targetPath),
    abs_path: targetPath,
    size: data.length,
    saved: true,
  };
}

async function addRemote({ host, user, port, name, identity, timeout }: any = {}): Promise<any> {
  const cleanHost = cleanOneLine(host, { max: 255, required: true, field: 'host' });
  const cleanUser = cleanOneLine(user, { max: 128, required: true, field: 'user' });
  const cleanName = cleanRemoteName(name, { required: false });
  const cleanIdentity = cleanOneLine(identity, { max: 500, required: false, field: 'identity' });
  const cleanTimeoutValue = cleanTimeout(timeout, '5s');
  const cleanPortValue = cleanPort(port);

  const args = [
    'remote', 'add',
    '--host', cleanHost,
    '--user', cleanUser,
    '--port', String(cleanPortValue),
    '--timeout', cleanTimeoutValue,
  ];
  if (cleanName) args.push('--name', cleanName);
  if (cleanIdentity) args.push('--identity', cleanIdentity);

  const result = await runAimux(args, { timeoutMs: 30000 });
  if (!result.ok) {
    const err: any = new Error(resultMessage(result));
    err.result = result;
    throw err;
  }
  return {
    ok: true,
    stdout: result.stdout,
    stderr: result.stderr,
    name: cleanName || cleanHost,
  };
}

export {
  listRemotes,
  testRemote,
  hardwareRemote,
  browseRemotePath,
  listRemoteFiles,
  readRemoteFile,
  writeRemoteFile,
  addRemote,
};
