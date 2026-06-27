/**
 * extension-build-pipeline.ts — 拓展前端按需编译.
 *
 * 触发: GET /extension/<name>/ 命中且 dist/index.html 不存在 → enqueue(entry)
 *
 * 实现:
 *   - 进程内 map: extension_name → BuildState
 *     { state: 'idle'|'building'|'ready'|'error', startedAt, finishedAt, log: string[] }
 *   - 同名拓展并发去重 (already 'building' → 不再 spawn)
 *   - spawn `npm run build` (cwd = frontend/), 把 stdout/stderr 滚动收集进 log (尾部 200 行)
 *   - 退出码 0 → state='ready'; 否则 'error'
 *   - getStatus(): 给 /api/extensions/<name>/build-status 用
 *   - forceRebuild(): 清掉 dist 后 enqueue (admin 用)
 *
 * 注意: 拓展 frontend/ 必须自带 package.json + "build" script. 由 manifest 校验阶段
 * 不强制 (允许纯静态 index.html 的极简拓展跳过编译). 若没有 package.json, 我们认为
 * frontend/ 就是已编译产物, 直接当 dist/ 用 (软链接 / 复制都行, 第一版直接复制).
 */
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

interface BuildState {
  state: 'idle' | 'building' | 'ready' | 'error';
  startedAt: number | null;
  finishedAt: number | null;
  log: string[];
}

const states = new Map<string, BuildState>(); // name → BuildState
const MAX_LOG_LINES = 200;

function getState(entry: any): BuildState {
  let st = states.get(entry.name);
  if (!st) {
    st = { state: 'idle', startedAt: null, finishedAt: null, log: [] };
    states.set(entry.name, st);
  }
  return st;
}

function tailLog(st: BuildState): string {
  return st.log.slice(-MAX_LOG_LINES).join('');
}

function pushLog(st: BuildState, chunk: any): void {
  if (!chunk) return;
  st.log.push(String(chunk));
  if (st.log.length > MAX_LOG_LINES * 2) {
    st.log = st.log.slice(-MAX_LOG_LINES);
  }
}

// 拷贝 frontend/* → frontend/dist/* (仅当 frontend 没有 package.json 时的兜底,
// 让"零编译"的极简拓展也能直接服务).
function copyAsDist(frontendDir: string, distDir: string): void {
  fs.mkdirSync(distDir, { recursive: true });
  for (const entry of fs.readdirSync(frontendDir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const src = path.join(frontendDir, entry.name);
    const dst = path.join(distDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function clearDist(distDir: string): void {
  if (!fs.existsSync(distDir)) return;
  fs.rmSync(distDir, { recursive: true, force: true });
}

async function runBuild(entry: any): Promise<void> {
  const st = getState(entry);
  if (st.state === 'building') return;
  st.state = 'building';
  st.startedAt = Date.now();
  st.finishedAt = null;
  st.log = [];

  const frontendDir = entry.frontend_dir;
  const distDir = path.join(frontendDir, 'dist');
  const pkgPath = path.join(frontendDir, 'package.json');

  // 零编译兜底: 没有 package.json → 直接把 frontend/ 当 dist
  if (!fs.existsSync(pkgPath)) {
    try {
      copyAsDist(frontendDir, distDir);
      pushLog(st, '[build-pipeline] 无 package.json, 直接拷贝 frontend/* → dist/\n');
      st.state = 'ready';
      st.finishedAt = Date.now();
    } catch (e) {
      pushLog(st, `[build-pipeline] 拷贝失败: ${e.message}\n`);
      st.state = 'error';
      st.finishedAt = Date.now();
    }
    return;
  }

  // 标准: npm run build (拓展开发者负责保证产物在 dist/)
  await new Promise<void>((resolve) => {
    pushLog(st, `[build-pipeline] spawn: npm run build in ${frontendDir}\n`);
    // 依赖未装时先 npm install
    const nodeModules = path.join(frontendDir, 'node_modules');
    const install = !fs.existsSync(nodeModules);

    const run = () => {
      const proc = spawn('npm', ['run', 'build'], { cwd: frontendDir });
      proc.stdout.on('data', (b) => pushLog(st, b.toString()));
      proc.stderr.on('data', (b) => pushLog(st, b.toString()));
      proc.on('error', (e) => { pushLog(st, `[spawn error] ${e.message}\n`); });
      proc.on('exit', (code) => {
        if (code === 0 && fs.existsSync(path.join(distDir, 'index.html'))) {
          st.state = 'ready';
        } else {
          pushLog(st, `[build-pipeline] npm run build 退出码 ${code}, dist/index.html 是否存在: ${fs.existsSync(path.join(distDir, 'index.html'))}\n`);
          st.state = 'error';
        }
        st.finishedAt = Date.now();
        resolve();
      });
    };

    if (install) {
      pushLog(st, '[build-pipeline] node_modules 不存在, 先跑 npm install\n');
      const inst = spawn('npm', ['install', '--no-audit', '--no-fund'], { cwd: frontendDir });
      inst.stdout.on('data', (b) => pushLog(st, b.toString()));
      inst.stderr.on('data', (b) => pushLog(st, b.toString()));
      inst.on('error', (e) => { pushLog(st, `[npm install error] ${e.message}\n`); });
      inst.on('exit', (code) => {
        if (code !== 0) {
          pushLog(st, `[build-pipeline] npm install 退出码 ${code}, 跳过 build\n`);
          st.state = 'error';
          st.finishedAt = Date.now();
          return resolve();
        }
        run();
      });
    } else {
      run();
    }
  });

  // 落盘到 _build.log 便于离线排查
  try {
    fs.writeFileSync(path.join(entry.data_dir, '_build.log'), tailLog(st));
  } catch { /* noop */ }
}

function enqueue(entry: any): void {
  const st = getState(entry);
  if (st.state === 'building') return;
  // 异步触发, 不 await
  runBuild(entry).catch((e) => {
    pushLog(st, `[build-pipeline] uncaught: ${e.message}\n`);
    st.state = 'error';
    st.finishedAt = Date.now();
  });
}

async function forceRebuild(entry: any): Promise<void> {
  const st = getState(entry);
  if (st.state === 'building') {
    throw new Error('正在编译中, 请稍后再试');
  }
  clearDist(path.join(entry.frontend_dir, 'dist'));
  await runBuild(entry);
  if (st.state === 'error') throw new Error('编译失败, 详情见 build-status');
}

function getStatus(entry: any): any {
  const st = getState(entry);
  const distExists = fs.existsSync(path.join(entry.frontend_dir, 'dist', 'index.html'));
  // dist 已存在但 state==idle = 进程启动以来从未编译过, 但磁盘上有产物 → 视为 ready
  const effectiveState = st.state === 'idle' && distExists ? 'ready' : st.state;
  return {
    state: effectiveState,
    started_at: st.startedAt,
    finished_at: st.finishedAt,
    log_tail: tailLog(st),
  };
}

export { enqueue, forceRebuild, getStatus };
