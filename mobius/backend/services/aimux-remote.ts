import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';

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
const REMOTE_FILE_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const REMOTE_FILE_DOWNLOAD_TIMEOUT_MS = 600000;

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

function normalizeRemote(item: any): any {
  return {
    name: String(item?.name || ''),
    type: String(item?.type || ''),
    user: String(item?.user || ''),
    hostname: String(item?.hostname || ''),
    port: Number(item?.port || 22),
    status: String(item?.status || ''),
    rtt_ms: typeof item?.rtt_ms === 'number' ? item.rtt_ms : null,
  };
}

async function listRemotes(): Promise<any[]> {
  const result = await runAimux(['remote', 'ls', '--json'], { timeoutMs: 70000 });
  const data = parseJsonOutput(result);
  if (!result.ok && !Array.isArray(data)) throw new Error(resultMessage(result));
  if (!Array.isArray(data)) throw new Error('aimux remote ls 返回格式异常');
  return data.map(normalizeRemote).filter((item: any) => item.name);
}

async function streamRemotes(
  onEvent: (event: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(aimuxBin(), ['remote', 'ls', '--stream'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const decoder = new StringDecoder('utf8');
    let stdoutBuffer = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;

    const abortError = () => {
      const error = new Error('aimux remote 流扫描已取消');
      error.name = 'AbortError';
      return error;
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      child.kill('SIGTERM');
      finish(abortError());
    };
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try { event = JSON.parse(line); }
      catch { throw new Error('aimux remote 流返回了无效 JSON'); }
      if (!event || typeof event.event !== 'string') return;
      if (event.event === 'remote') {
        const remote = normalizeRemote(event.remote);
        if (!remote.name) return;
        onEvent({ ...event, remote });
        return;
      }
      onEvent(event);
    };
    const drainLines = () => {
      let newline: number;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        handleLine(line);
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 70000);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > REMOTE_FILE_OUTPUT_MAX_BYTES) {
        child.kill('SIGTERM');
        finish(new Error('aimux remote 流响应超过大小限制'));
        return;
      }
      try {
        stdoutBuffer += decoder.write(chunk);
        drainLines();
      } catch (error) {
        child.kill('SIGTERM');
        finish(error as Error);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (settled) return;
      try {
        stdoutBuffer += decoder.end();
        if (stdoutBuffer.trim()) handleLine(stdoutBuffer.replace(/\r$/, ''));
      } catch (error) {
        finish(error as Error);
        return;
      }
      if (timedOut) finish(new Error('aimux remote 流扫描超时'));
      else if (code !== 0) finish(new Error(stderr.trim() || `aimux remote 流扫描失败 (code=${code})`));
      else finish();
    });
  });
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

/*
 * Fetch one remote file as raw bytes for download.
 * Unlike readRemoteFile (preview: 1.5MB cap, binary refused) this returns the
 * full buffer up to a 50MB download cap, so tar.gz / zip / binaries work.
 * stat is checked first so oversized files fail fast with a clear message.
 */
async function readRemoteFileRaw(name: any, rootPath: any, relPath: any): Promise<Buffer> {
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
  if (size > REMOTE_FILE_DOWNLOAD_MAX_BYTES) {
    throw new Error(`远程文件过大 (${size} 字节)，超过 ${REMOTE_FILE_DOWNLOAD_MAX_BYTES} 下载上限`);
  }
  // ✨ maxBuffer 必须覆盖 base64 展宽 (4/3) 再留余量, 否则文件还没读完就被截断
  // ✨ maxBuffer must cover the base64 inflation (4/3) plus headroom, or the read is truncated mid-flight
  const readResult = await runAimux(
    ['file', 'read', remoteName, '--path', targetPath, '--b64'],
    { timeoutMs: REMOTE_FILE_DOWNLOAD_TIMEOUT_MS, maxBuffer: Math.ceil(size * 2) + 1024 },
  );
  if (!readResult.ok) throw new Error(resultMessage(readResult));
  let buffer: Buffer;
  try { buffer = Buffer.from(readResult.stdout || '', 'base64'); }
  catch { throw new Error('aimux 返回的远程文件内容格式异常'); }
  if (size > 0 && buffer.length !== size) {
    throw new Error(`远程文件读取不完整 (${buffer.length}/${size} 字节)`);
  }
  return buffer;
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

/**
 * 移除一台由「莫比乌斯添加」的 SSH 主机.
 *
 * aimux 的 CLI 只有 remote ls/test/hardware/add, 没有 remove —— 增删不对称,
 * 而 ~/.ssh/config 里的 Host 块是唯一事实来源, 所以这里直接改那个文件.
 *
 * 只删我们自己写进去的块 (块前带 "# Added by aimux at <ts>" 标记):
 * 手写进 ~/.ssh/config 的主机 (公司跳板机、git 用的那台) 不是莫比乌斯建的,
 * 删掉会破坏用户自己的 ssh 配置, 因此明确拒绝, 让用户手动改.
 *
 * 写之前先备份, 与 aimux remote add 的做法一致.
 */
function removeRemote(name: string): any {
  const remoteName = cleanRemoteName(name);
  const configPath = path.join(os.homedir(), '.ssh', 'config');
  if (!fs.existsSync(configPath)) throw new Error('未找到 SSH 配置文件, 无法移除该主机');
  const original = fs.readFileSync(configPath, 'utf8');
  const lines = original.split('\n');

  // 找 "Host <name>" 行. 只认独占一行的模式列表 (aimux 追加时就是这么写的);
  // "Host a b" 这种共享块删掉会连带干掉 b, 一律不碰.
  let hostIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*Host\s+(.+?)\s*$/i);
    if (!m) continue;
    const patterns = m[1].split(/\s+/).filter(Boolean);
    if (patterns.length === 1 && patterns[0] === remoteName) { hostIdx = i; break; }
  }
  if (hostIdx < 0) throw new Error(`SSH 配置里没有主机 ${remoteName}`);

  // 往上找最近的非空行 —— aimux 追加块时紧挨着写的是 "# Added by aimux at <ts>".
  let markerIdx = -1;
  for (let i = hostIdx - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    if (lines[i].trim().startsWith('# Added by aimux at ')) markerIdx = i;
    break;
  }
  if (markerIdx < 0) {
    throw new Error(`${remoteName} 不是通过莫比乌斯添加的, 请手动编辑 ~/.ssh/config 处理`);
  }

  // 块尾 = 下一个 Host 行 (或文件末尾). 中间的缩进选项行一并删掉.
  let endIdx = hostIdx + 1;
  while (endIdx < lines.length && !/^\s*Host\s+/i.test(lines[endIdx])) endIdx++;

  // 块前 aimux 还会写一个空行, 一起删掉, 免得留下连续空行.
  let startIdx = markerIdx;
  if (startIdx > 0 && !lines[startIdx - 1].trim()) startIdx--;

  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const backupPath = `${configPath}.aimux.bak.${ts}`;
  fs.copyFileSync(configPath, backupPath);

  const kept = lines.slice(0, startIdx).concat(lines.slice(endIdx));
  fs.writeFileSync(configPath, kept.join('\n'), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(configPath, 0o600); } catch { /* 权限收紧失败不阻塞删除 */ }
  return { ok: true, name: remoteName, backup: backupPath };
}

export {
  listRemotes,
  streamRemotes,
  testRemote,
  hardwareRemote,
  browseRemotePath,
  listRemoteFiles,
  readRemoteFile,
  readRemoteFileRaw,
  writeRemoteFile,
  addRemote,
  removeRemote,
};
