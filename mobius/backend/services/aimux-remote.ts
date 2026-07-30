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

function timeoutToSshSeconds(value: any): number {
  return Math.max(1, Math.ceil(timeoutToMs(value) / 1000));
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

function runAimux(args: string[], { timeoutMs = 60000 }: { timeoutMs?: number } = {}): Promise<any> {
  return new Promise((resolve) => {
    execFile(aimuxBin(), args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER }, (error, stdout = '', stderr = '') => {
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

function parseJsonOutput(result: any): any {
  const raw = result.stdout || result.stderr || '';
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

// 把任意路径安全地嵌成 POSIX sh 单引号字面量 (单引号内一切都是字面, 只需转义单引号本身)
function shSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeRemoteRelativePath(value: any): string {
  const raw = typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '/';
  const withRoot = raw.startsWith('/') ? raw : `/${raw}`;
  const parts = withRoot.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error('远程文件路径不能包含 . 或 ..');
  }
  if (withRoot.length > 2000 || /[\r\n\0]/.test(withRoot)) {
    throw new Error('远程文件路径格式非法');
  }
  return parts.length ? `/${parts.join('/')}` : '/';
}

function remoteRootPrelude(rootPath: any, relPath: any): string[] {
  const root = cleanRemotePath(rootPath);
  const rel = normalizeRemoteRelativePath(relPath);
  return [
    `ROOT_INPUT=${shSingleQuote(root)}`,
    'if [ -z "$ROOT_INPUT" ] || [ "$ROOT_INPUT" = "~" ]; then ROOT_INPUT="$HOME"; fi',
    'case "$ROOT_INPUT" in "~/"*) ROOT_INPUT="$HOME/${ROOT_INPUT#~/}" ;; esac',
    'ROOT=$(cd "$ROOT_INPUT" 2>/dev/null && pwd -P)',
    'if [ -z "$ROOT" ]; then printf "ERR\\tremote_root_unavailable\\n"; exit 3; fi',
    `REL=${shSingleQuote(rel)}`,
    'if [ "$REL" = "/" ]; then TARGET="$ROOT"; else TARGET="${ROOT%/}/${REL#/}"; fi',
  ];
}

function decodeBase64Field(value: string): string {
  try { return Buffer.from(value || '', 'base64').toString('utf8'); }
  catch { return ''; }
}

type SshScriptResult = { stdout: string; stderr: string; code: number | null };

function runRemoteShellScript(
  name: any,
  script: string,
  { timeout = '12s', maxBuffer = MAX_BUFFER }: { timeout?: any; maxBuffer?: number } = {},
): Promise<SshScriptResult> {
  const remoteName = cleanRemoteName(name);
  const timeoutValue = cleanTimeout(timeout, '12s');
  const timeoutMs = Math.max(3000, timeoutToMs(timeoutValue) + 2000);
  const sshTimeout = timeoutToSshSeconds(timeoutValue);

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${sshTimeout}`,
      remoteName,
      'sh',
      '-s',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`访问远程文件超时 (${timeoutValue})`));
    }, timeoutMs);

    const append = (current: string, chunk: any, label: string): string => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > maxBuffer) {
        child.kill('SIGTERM');
        throw new Error(`${label}超过大小限制`);
      }
      return next;
    };
    child.stdout.on('data', (chunk) => {
      try { stdout = append(stdout, chunk, '远程文件响应'); }
      catch (e) { if (!settled) { settled = true; clearTimeout(timer); reject(e); } }
    });
    child.stderr.on('data', (chunk) => {
      try { stderr = append(stderr, chunk, '远程错误响应'); }
      catch (e) { if (!settled) { settled = true; clearTimeout(timer); reject(e); } }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(script);
  });
}

function remoteScriptError(result: SshScriptResult, fallback: string): Error | null {
  const errorLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith('ERR\t'));
  if (result.code === 0 && !errorLine) return null;
  const detail = errorLine?.split('\t').slice(1).join(': ') || result.stderr.trim() || `ssh 退出码 ${result.code}`;
  return new Error(`${fallback}: ${detail}`);
}

async function listRemoteFiles(name: any, rootPath: any, relPath: any): Promise<any> {
  const script = [
    ...remoteRootPrelude(rootPath, relPath),
    'if [ ! -d "$TARGET" ]; then printf "ERR\\tnot_directory\\n"; exit 3; fi',
    'REAL=$(cd "$TARGET" 2>/dev/null && pwd -P)',
    'case "$REAL" in "$ROOT"|"$ROOT"/*) ;; *) printf "ERR\\toutside_root\\n"; exit 3 ;; esac',
    'printf "ROOT\\t%s\\n" "$(printf %s "$ROOT" | base64 | tr -d \'\\n\')"',
    'printf "PATH\\t%s\\n" "$(printf %s "$REAL" | base64 | tr -d \'\\n\')"',
    'for p in "$REAL"/* "$REAL"/.[!.]* "$REAL"/..?*; do',
    '  [ -e "$p" ] || [ -L "$p" ] || continue',
    '  [ -L "$p" ] && continue',
    '  name=${p##*/}',
    '  [ "$name" = "." ] && continue',
    '  [ "$name" = ".." ] && continue',
    '  if [ -d "$p" ]; then kind=dir; size=;',
    '  elif [ -f "$p" ]; then kind=file; size=$(wc -c < "$p" 2>/dev/null | tr -d \' \');',
    '  else continue; fi',
    '  name64=$(printf %s "$name" | base64 | tr -d \'\\n\')',
    '  path64=$(printf %s "$p" | base64 | tr -d \'\\n\')',
    '  printf "ITEM\\t%s\\t%s\\t%s\\t%s\\n" "$kind" "$size" "$name64" "$path64"',
    'done',
  ].join('\n');
  const result = await runRemoteShellScript(name, script, { timeout: '12s', maxBuffer: REMOTE_FILE_OUTPUT_MAX_BYTES });
  const error = remoteScriptError(result, '加载远程文件失败');
  if (error) throw error;
  let resolvedRoot = '';
  let resolvedPath = '';
  const entries: any[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const parts = line.split('\t');
    if (parts[0] === 'ROOT') resolvedRoot = decodeBase64Field(parts[1]);
    if (parts[0] === 'PATH') resolvedPath = decodeBase64Field(parts[1]);
    if (parts[0] === 'ITEM' && parts.length >= 5) {
      const kind = parts[1] === 'dir' ? 'dir' : 'file';
      entries.push({
        name: decodeBase64Field(parts[3]),
        type: kind,
        size: kind === 'file' ? Number(parts[2] || 0) : null,
        modified: '',
        abs_path: decodeBase64Field(parts[4]),
      });
    }
  }
  entries.sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
  return { remote: cleanRemoteName(name), root_path: resolvedRoot, path: resolvedPath, entries };
}

async function readRemoteFile(name: any, rootPath: any, relPath: any): Promise<any> {
  const script = [
    ...remoteRootPrelude(rootPath, relPath),
    'if [ -L "$TARGET" ]; then printf "ERR\\tsymlink_unsupported\\n"; exit 3; fi',
    'if [ ! -f "$TARGET" ]; then printf "ERR\\tnot_file\\n"; exit 3; fi',
    'PARENT=$(cd "$(dirname "$TARGET")" 2>/dev/null && pwd -P)',
    'case "$PARENT" in "$ROOT"|"$ROOT"/*) ;; *) printf "ERR\\toutside_root\\n"; exit 3 ;; esac',
    'SIZE=$(wc -c < "$TARGET" 2>/dev/null | tr -d \' \')',
    'printf "ROOT\\t%s\\n" "$(printf %s "$ROOT" | base64 | tr -d \'\\n\')"',
    'printf "PATH\\t%s\\n" "$(printf %s "$TARGET" | base64 | tr -d \'\\n\')"',
    'printf "SIZE\\t%s\\n" "$SIZE"',
    `dd if="$TARGET" bs=${REMOTE_FILE_READ_MAX_BYTES} count=1 2>/dev/null | base64 | tr -d '\\n'`,
    'printf "\\n"',
  ].join('\n');
  const result = await runRemoteShellScript(name, script, { timeout: '15s', maxBuffer: REMOTE_FILE_OUTPUT_MAX_BYTES });
  const error = remoteScriptError(result, '读取远程文件失败');
  if (error) throw error;
  const lines = result.stdout.split(/\r?\n/);
  const resolvedRoot = decodeBase64Field(lines.find((line) => line.startsWith('ROOT\t'))?.slice(5) || '');
  const absPath = decodeBase64Field(lines.find((line) => line.startsWith('PATH\t'))?.slice(5) || '');
  const size = Number(lines.find((line) => line.startsWith('SIZE\t'))?.slice(5) || 0);
  const contentLine = lines.find((line) => line && !/^(ROOT|PATH|SIZE)\t/.test(line)) || '';
  const buffer = Buffer.from(contentLine, 'base64');
  const binary = buffer.indexOf(0) !== -1;
  return {
    remote: cleanRemoteName(name),
    root_path: resolvedRoot,
    path: normalizeRemoteRelativePath(relPath),
    name: absPath.split('/').pop() || '',
    abs_path: absPath,
    size,
    content: binary ? '' : buffer.toString('utf8'),
    truncated: size > REMOTE_FILE_READ_MAX_BYTES,
    binary,
  };
}

async function writeRemoteFile(name: any, rootPath: any, relPath: any, content: any): Promise<any> {
  if (typeof content !== 'string') throw new Error('content 必须是字符串');
  const size = Buffer.byteLength(content, 'utf8');
  if (size > REMOTE_FILE_WRITE_MAX_BYTES) {
    throw new Error(`远程文件过大 (${size} 字节)，超过 ${REMOTE_FILE_WRITE_MAX_BYTES} 上限`);
  }
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  const script = [
    ...remoteRootPrelude(rootPath, relPath),
    'if [ -L "$TARGET" ]; then printf "ERR\\tsymlink_unsupported\\n"; exit 3; fi',
    'if [ ! -f "$TARGET" ]; then printf "ERR\\tnot_file\\n"; exit 3; fi',
    'PARENT=$(cd "$(dirname "$TARGET")" 2>/dev/null && pwd -P)',
    'case "$PARENT" in "$ROOT"|"$ROOT"/*) ;; *) printf "ERR\\toutside_root\\n"; exit 3 ;; esac',
    'if [ ! -w "$TARGET" ]; then printf "ERR\\tread_only\\n"; exit 3; fi',
    `printf %s ${shSingleQuote(encoded)} | base64 -d > "$TARGET"`,
    'printf "PATH\\t%s\\n" "$(printf %s "$TARGET" | base64 | tr -d \'\\n\')"',
  ].join('\n');
  const result = await runRemoteShellScript(name, script, { timeout: '20s', maxBuffer: MAX_BUFFER });
  const error = remoteScriptError(result, '保存远程文件失败');
  if (error) throw error;
  const absPath = decodeBase64Field(result.stdout.split(/\r?\n/).find((line) => line.startsWith('PATH\t'))?.slice(5) || '');
  return {
    remote: cleanRemoteName(name),
    path: normalizeRemoteRelativePath(relPath),
    name: absPath.split('/').pop() || '',
    abs_path: absPath,
    size,
    saved: true,
  };
}

function remoteBrowseScript(targetPath: string): string {
  // 注意: 不能用 `read -r TARGET` 从 stdin 读路径 —— dash 会把整段脚本缓冲, read 读不到内容,
  // TARGET 退回 $HOME, 于是任何子目录点击都只会回到家目录 (子路径无法进入). 直接把路径嵌成字面量.
  return [
    `TARGET=${shSingleQuote(targetPath)}`,
    'if [ -z "$TARGET" ]; then TARGET="$HOME"; fi',
    'if [ "$TARGET" = "~" ]; then TARGET="$HOME"; fi',
    'case "$TARGET" in "~/"*) TARGET="$HOME/${TARGET#~/}" ;; esac',
    'if [ ! -d "$TARGET" ]; then printf "ERR\\tnot_directory\\t%s\\n" "$TARGET"; exit 3; fi',
    'REAL=$(cd "$TARGET" 2>/dev/null && pwd -P)',
    'if [ -z "$REAL" ]; then printf "ERR\\taccess_denied\\t%s\\n" "$TARGET"; exit 3; fi',
    'printf "PATH\\t%s\\n" "$REAL"',
    'printf "PARENT\\t%s\\n" "$(dirname "$REAL")"',
    'TAB=$(printf "\\t")',
    'for p in "$REAL"/* "$REAL"/.[!.]* "$REAL"/..?*; do',
    '  [ -d "$p" ] || continue',
    '  name=${p##*/}',
    '  [ "$name" = "." ] && continue',
    '  [ "$name" = ".." ] && continue',
    '  case "$name" in *"$TAB"*) continue ;; esac',
    '  printf "DIR\\t%s\\t%s\\n" "$name" "$p"',
    'done',
  ].join('\n');
}

function parseBrowseOutput(stdout: any): any {
  const out: any = { path: '', parent: '', entries: [] as any[] };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts[0] === 'PATH') out.path = parts.slice(1).join('\t');
    else if (parts[0] === 'PARENT') out.parent = parts.slice(1).join('\t');
    else if (parts[0] === 'DIR' && parts.length >= 3) {
      out.entries.push({ name: parts[1], path: parts.slice(2).join('\t') });
    } else if (parts[0] === 'ERR') {
      out.error = parts.slice(1).join(': ');
    }
  }
  out.entries.sort((a: any, b: any) => a.name.localeCompare(b.name));
  return out;
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
  const targetPath = cleanRemotePath(remotePath);
  const timeoutValue = cleanTimeout(timeout, '8s');
  const timeoutMs = Math.max(3000, timeoutToMs(timeoutValue) + 2000);
  const sshTimeout = timeoutToSshSeconds(timeoutValue);

  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${sshTimeout}`,
      remoteName,
      'sh',
      '-s',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`浏览远程路径超时 (${timeoutValue})`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_BUFFER) {
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_BUFFER) {
        child.kill('SIGTERM');
      }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseBrowseOutput(stdout);
      if (code !== 0 || parsed.error || !parsed.path) {
        const msg = parsed.error || stderr.trim() || `ssh 退出码 ${code}`;
        reject(new Error(`无法浏览 ${remoteName}:${targetPath}: ${msg}`));
        return;
      }
      resolve({
        remote: remoteName,
        requested_path: targetPath,
        path: parsed.path,
        parent: parsed.parent,
        entries: parsed.entries,
      });
    });

    child.stdin.end(remoteBrowseScript(targetPath));
  });
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
