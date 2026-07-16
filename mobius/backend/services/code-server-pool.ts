/**
 * code-server-pool.ts — 按 (userId, projectId) 维度起 code-server 子进程.
 *
 * v1.9 主栈版(旧 gateway 已退役, 当前栈接管. 代码从历史 RFC 复刻).
 *
 * 设计:
 *   - 每个 (userId, projectId) 一个 code-server 进程, 端口动态分配
 *   - 数据 / 扩展 / git identity 三隔离 → ~/.imac/cs-data/<user>/<proj>/, ~/.imac/cs-ext/<user>/<proj>/
 *   - LRU 60min 回收 + per-user 4 个 / 全局 16 个 配额
 *   - spawn 时 strip VSCODE_* / CURSOR_* env(避免继承 IDE IPC socket 导致 ECONNREFUSED)
 *   - 写权限校验, bind_path 对当前进程不可写直接报错
 *
 * Reload 存活 (v1.9+):
 *   - 子进程 detached=true + unref, 脱离父进程组 → PM2 reload 后端时 code-server 不被 group-kill
 *   - pool 状态原子写 cs-pool-state.json, 后端重启后 TCP probe reconcile re-adopt 存活子进程
 *   - 目的: reload 期间浏览器 WS 断 1~3s 自动重连, code-server 不冷启动
 */
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn, execFile } from 'child_process';
import * as os from 'os';

const HOME = os.homedir();
const CODE_SERVER_DATA_ROOT = process.env.CODE_SERVER_DATA_ROOT || '/data/code_server';
const DATA_ROOT = process.env.CS_DATA_ROOT || path.join(CODE_SERVER_DATA_ROOT, 'cs-data');
const EXT_ROOT = process.env.CS_EXT_ROOT || path.join(CODE_SERVER_DATA_ROOT, 'cs-ext');
const CS_BIN = process.env.CS_BIN || '/usr/bin/code-server';
const CS_IPC_GUARD = path.join(__dirname, 'code-server-ipc-guard.cjs');
const PORT_BASE = parseInt(process.env.CS_PORT_BASE || '45700', 10);
const PORT_END = PORT_BASE + parseInt(process.env.CS_POOL_MAX || '32', 10);
const IDLE_MIN = parseInt(process.env.CS_IDLE_TIMEOUT_MIN || '60', 10);
const MAX_PER_USER = parseInt(process.env.CS_MAX_PER_USER || '4', 10);
const MAX_TOTAL = parseInt(process.env.CS_MAX_TOTAL || '16', 10);
const READY_TIMEOUT_MS = parseInt(process.env.CS_READY_TIMEOUT_MS || '30000', 10);

fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.mkdirSync(EXT_ROOT, { recursive: true });

// pool 状态文件: 跨后端重启 reconcile re-adopt 存活子进程用.
const STATE_FILE = path.join(CODE_SERVER_DATA_ROOT, 'cs-pool-state.json');

interface FakeProc {
  pid: number;
  killed: boolean;
  kill: (sig?: string) => void;
}

interface PoolEntry {
  key: string;
  userId: string;
  projectId: string;
  port: number;
  proc: FakeProc | null;
  bindPath: string;
  lastActive: number;
  ready: boolean;
  startedAt: number;
  adopted?: boolean;
  _livenessPoll?: NodeJS.Timeout;
}

interface StateEntry {
  userId: string;
  projectId: string;
  port: number;
  pid?: number;
  bindPath: string;
  startedAt?: number;
}

const pool: Map<string, PoolEntry> = new Map();

function key(userId: string, projectId: string): string { return `${userId}__${projectId}`; }

function samePath(a: any, b: any): boolean {
  try {
    return path.resolve(a) === path.resolve(b);
  } catch {
    return String(a || '') === String(b || '');
  }
}

function isPidAlive(pid: number | undefined | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function probePort(port: number, timeoutMs: number = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.end(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}

// 用 ss 反查 port 对应 pid. setsid --fork 后我们拿不到真实 cs pid, 只能按 port 找.
function findPidOnPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ss', ['-lntp'], (err, stdout) => {
      if (err) return resolve(null);
      const re = new RegExp(`127\\.0\\.0\\.1:${port}\\b[^\\n]*pid=(\\d+)`);
      const m = stdout.match(re);
      resolve(m ? parseInt(m[1], 10) : null);
    });
  });
}

// ── state.json: 后端重启后 reconcile re-adopt 存活子进程 ──
function loadState(): Record<string, StateEntry> {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return (j && typeof j === 'object') ? j : {};
  } catch (e) {
    console.warn(`[cs-pool] loadState 失败 (忽略): ${e.message}`);
    return {};
  }
}

function saveState(state: Record<string, StateEntry>): void {
  try {
    fs.mkdirSync(CODE_SERVER_DATA_ROOT, { recursive: true });
    const tmp = `${STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.warn(`[cs-pool] saveState 失败 (忽略): ${e.message}`);
  }
}

function writeStateEntry(entry: PoolEntry): void {
  const state = loadState();
  state[entry.key] = {
    userId: entry.userId,
    projectId: entry.projectId,
    port: entry.port,
    pid: entry.proc?.pid,
    bindPath: entry.bindPath,
    startedAt: entry.startedAt,
  };
  saveState(state);
}

function removeStateEntry(k: string): void {
  const state = loadState();
  if (!state[k]) return;
  delete state[k];
  saveState(state);
}

// re-adopt 时没有真实 ChildProcess, 造一个最小 proc 满足 kill() / list() 的接口.
function makeFakeProc(pid: number): FakeProc {
  return {
    pid,
    killed: false,
    kill(sig?: string) {
      try { process.kill(pid, sig || 'SIGTERM'); } catch {}
      this.killed = true;
    },
  };
}

function startLivenessPoll(entry: PoolEntry): void {
  const interval = setInterval(() => {
    if (!isPidAlive(entry.proc?.pid)) {
      console.log(`[cs-pool] adopted ${entry.key} pid=${entry.proc?.pid} 已死, 清理`);
      clearInterval(interval);
      pool.delete(entry.key);
      removeStateEntry(entry.key);
    }
  }, 30000);
  interval.unref();
  entry._livenessPoll = interval;
}

let reconcilePromise: Promise<void> | null = null;

async function reconcile(): Promise<void> {
  const state = loadState();
  const keys = Object.keys(state);
  if (keys.length === 0) return;
  console.log(`[cs-pool] reconcile: state.json 有 ${keys.length} 条, 开始 probe`);
  const next: Record<string, StateEntry> = {};
  for (const k of keys) {
    const s = state[k];
    if (!s || !s.port || !s.pid) continue;
    // ensure() 可能已经在等待 reconcile 完成时先 spawn 了同一个 key, 此时不要覆盖.
    if (pool.has(k)) {
      console.log(`[cs-pool] reconcile: ${k} 已被 ensure 占用, 跳过 re-adopt (state 以 pool 为准)`);
      next[k] = s;
      continue;
    }
    const portAlive = await probePort(s.port, 1000);
    const pidAlive = isPidAlive(s.pid);
    if (!portAlive || !pidAlive) {
      console.log(`[cs-pool] reconcile: ${k} port=${s.port} portAlive=${portAlive} pidAlive=${pidAlive}, 丢弃`);
      continue;
    }
    pool.set(k, {
      key: k, userId: s.userId, projectId: s.projectId,
      port: s.port, bindPath: s.bindPath,
      proc: makeFakeProc(s.pid),
      lastActive: Date.now(), ready: true,
      startedAt: s.startedAt || Date.now(),
      adopted: true,
    });
    startLivenessPoll(pool.get(k)!);
    next[k] = s;
    console.log(`[cs-pool] reconcile: re-adopt ${k} port=${s.port} pid=${s.pid}`);
  }
  if (Object.keys(next).length !== keys.length) saveState(next);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

async function pickFreePort(): Promise<number> {
  const used = new Set<number>([...pool.values()].map(e => e.port));
  for (let p = PORT_BASE; p < PORT_END; p++) {
    if (used.has(p)) continue;
    if (await isPortFree(p)) return p;
  }
  throw new Error(`code-server-pool: 端口池 ${PORT_BASE}-${PORT_END} 已满`);
}

function lruEvict(): void {
  while (pool.size >= MAX_TOTAL) {
    let oldest: PoolEntry | null = null;
    for (const e of pool.values()) if (!oldest || e.lastActive < oldest.lastActive) oldest = e;
    if (!oldest) break;
    console.log(`[cs-pool] LRU evict ${oldest.key} (idle ${Math.round((Date.now()-oldest.lastActive)/60000)} min)`);
    kill(oldest.key);
  }
}
function lruEvictForUser(userId: string): void {
  const userEntries = [...pool.values()].filter(e => e.userId === userId);
  while (userEntries.length >= MAX_PER_USER) {
    userEntries.sort((a, b) => a.lastActive - b.lastActive);
    const victim = userEntries.shift()!;
    console.log(`[cs-pool] per-user LRU evict ${victim.key}`);
    kill(victim.key);
  }
}

function kill(k: string): void {
  const e = pool.get(k);
  if (!e) return;
  pool.delete(k);
  if (e._livenessPoll) clearInterval(e._livenessPoll);
  try { if (e.proc && !e.proc.killed) e.proc.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { if (e.proc && !e.proc.killed) e.proc.kill('SIGKILL'); } catch {} }, 5000);
  removeStateEntry(k);
}

function appendNodeRequire(existingOptions: string | undefined, requirePath: string): string {
  const requireOption = `--require=${requirePath}`;
  if (!existingOptions) return requireOption;
  if (existingOptions.includes(requirePath)) return existingOptions;
  return `${existingOptions} ${requireOption}`;
}

async function waitForReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.end(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise<void>(r => setTimeout(r, 200));
  }
  return false;
}

async function ensure(user: any, projectId: string, bindPath: string): Promise<{ port: number; key: string; started: boolean }> {
  if (!user?.id || !projectId || !bindPath) throw new Error('cs-pool: 缺 user / projectId / bindPath');
  // 等启动期 reconcile 完成, 避免 spawn 和 re-adopt 同 key 竞态覆盖.
  if (reconcilePromise) { try { await reconcilePromise; } catch {} }
  if (!fs.existsSync(bindPath) || !fs.statSync(bindPath).isDirectory()) {
    throw Object.assign(new Error(`bind_path 不存在或不是目录: ${bindPath}`), { code: 'BIND_PATH_INVALID' });
  }
  try { fs.accessSync(bindPath, fs.constants.W_OK); }
  catch { throw Object.assign(new Error(`bind_path 对当前进程不可写: ${bindPath} (请联系管理员调权限)`), { code: 'BIND_PATH_RO' }); }

  const k = key(user.id, projectId);
  const existing = pool.get(k);
  if (existing && existing.proc && !existing.proc.killed) {
    if (!samePath(existing.bindPath, bindPath)) {
      console.log(`[cs-pool] restart ${k}: workspace changed ${existing.bindPath} -> ${bindPath}`);
      kill(k);
    } else {
      existing.lastActive = Date.now();
      return { port: existing.port, key: k, started: false };
    }
  }
  if (existing) pool.delete(k);

  lruEvictForUser(user.id);
  lruEvict();

  const port = await pickFreePort();
  const dataDir = path.join(DATA_ROOT, user.id, projectId);
  const extDir = path.join(EXT_ROOT, user.id, projectId);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(extDir, { recursive: true });

  // 预置 git identity, 不再被 user 全局 config 污染
  const settingsPath = path.join(dataDir, 'User', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      'git.user.name': user.display_name || user.id,
      'git.user.email': user.email || `${user.id}@imac.local`,
      'workbench.colorTheme': 'Default Dark+',
      'editor.fontSize': 13,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
    }, null, 2));
  }

  const args = [
    '--bind-addr', `127.0.0.1:${port}`,
    '--auth', 'none',
    '--disable-telemetry',
    '--disable-update-check',
    '--user-data-dir', dataDir,
    '--extensions-dir', extDir,
    bindPath,
  ];
  console.log(`[cs-pool] spawn ${CS_BIN} for user=${user.id} project=${projectId} port=${port}`);

  // ⭐ 关键: strip IDE 继承的 env, 否则 code-server 子内核连外部 IPC socket 必 ECONNREFUSED
  const cleanEnv: Record<string, any> = {};
  for (const [k2, v2] of Object.entries(process.env)) {
    if (k2.startsWith('VSCODE_') || k2.startsWith('CURSOR_') || k2 === 'TERM_PROGRAM') continue;
    cleanEnv[k2] = v2;
  }
  cleanEnv.HOME = HOME;
  cleanEnv.PATH = process.env.PATH || '/usr/bin:/bin';
  cleanEnv.NODE_OPTIONS = appendNodeRequire(cleanEnv.NODE_OPTIONS, CS_IPC_GUARD);

  // PM2 reload cluster 模式会 tree-kill worker 的所有后代 (process group/session
  // 隔离对 tree-kill 无效). 用 setsid --fork 双 fork: setsid 自己 fork 后立刻退出,
  // code-server 被 reparent 到 init (ppid=1), 不再是 Node 后端的 descendant, PM2
  // tree-kill 找不到它. 代价: spawn() 返回的 ChildProcess 是 setsid 不是 cs, 拿不到
  // 真实 pid, 启动后用 ss -lntp 按 port 反查 pid, 之后所有 liveness 走 pid+port poll.
  const logFile = `/tmp/cs-${k}.log`;
  const outFd = fs.openSync(logFile, 'a');
  const errFd = fs.openSync(logFile, 'a');
  try { fs.appendFileSync(logFile, `\n===== ${new Date().toISOString()} launching port=${port} =====\n`); } catch {}
  const launcher = spawn('setsid', ['--fork', CS_BIN, ...args], {
    stdio: ['ignore', outFd, errFd],
    env: cleanEnv,
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  try { launcher.unref(); } catch {}

  const entry: PoolEntry = {
    key: k, userId: user.id, projectId, port,
    proc: null, // setsid --fork 后真实 cs pid 在 ready 之后用 findPidOnPort 反查
    lastActive: Date.now(), ready: false, startedAt: Date.now(), bindPath,
  };
  pool.set(k, entry);

  const ready = await waitForReady(port, READY_TIMEOUT_MS);
  if (!ready) { kill(k); throw new Error(`cs-pool: code-server 启动 ${READY_TIMEOUT_MS}ms 内未就绪 (port ${port})`); }
  const csPid = await findPidOnPort(port);
  if (!csPid) { kill(k); throw new Error(`cs-pool: code-server 启动了但 ss 找不到 port ${port} 对应 pid`); }
  entry.proc = makeFakeProc(csPid);
  entry.ready = true;
  startLivenessPoll(entry);
  try { fs.appendFileSync(logFile, `\n===== ready pid=${csPid} =====\n`); } catch {}
  writeStateEntry(entry);
  return { port, key: k, started: true };
}

function touch(k: string): void { const e = pool.get(k); if (e) e.lastActive = Date.now(); }
function get(k: string): PoolEntry | undefined { return pool.get(k); }
function list(): any[] {
  return [...pool.values()].map(e => ({
    key: e.key, userId: e.userId, projectId: e.projectId,
    port: e.port, bindPath: e.bindPath,
    started_at: new Date(e.startedAt).toISOString(),
    last_active: new Date(e.lastActive).toISOString(),
    idle_min: Math.round((Date.now() - e.lastActive) / 60000),
    pid: e.proc?.pid, alive: !!(e.proc && !e.proc.killed),
    adopted: !!e.adopted,
  }));
}

setInterval(() => {
  const cutoff = Date.now() - IDLE_MIN * 60 * 1000;
  for (const e of pool.values()) {
    if (e.lastActive < cutoff) {
      console.log(`[cs-pool] idle ${IDLE_MIN}min reap ${e.key}`);
      kill(e.key);
    }
  }
}, 60 * 1000).unref();

// 启动时 reconcile: 把上一轮后端残留的存活 code-server re-adopt 进 pool.
// 不阻塞模块加载, 但 ensure() 会等它完成, 避免 spawn 和 re-adopt 同 key 竞态.
reconcilePromise = reconcile().catch(e => {
  console.warn(`[cs-pool] reconcile 失败: ${e.message}`);
});

export { ensure, kill, touch, get, list, key };
