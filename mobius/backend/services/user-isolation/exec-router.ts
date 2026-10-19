/**
 * user-isolation/exec-router.ts — agent 执行面的容器路由.
 *
 * 三件事:
 *  1. tmux 窗口名自动路由: 后端所有窗口级 tmux 操作都是 `-t HUB:<sessionId>` 形式,
 *     本模块维护 window→user 归属表, tmux() 解析到已注册窗口时自动改走
 *     `docker exec <该用户容器> tmux ...`, 两个 agent 后端的几十处调用点零改动.
 *  2. 宿主路径 → 沙箱路径的映射 (仅 $HOME / $CODEX_HOME 两族, 其余挂载同路径零改写).
 *  3. deepseek-harness 的 spawn 分派 (docker exec -i 透传 stdio).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { db } from '../../../db';
import {
  SBX_GATEWAY_IP, SBX_AIMUX_BIN, SBX_NODE22, isDockerIsolation,
} from './config';
import { isolationActiveFor, sbxHomeFor, ensureSandbox, containerAlive, refreshSbxHomeInputs } from './docker-sandbox';
import { ensureTempRoot } from '../file-access';
import * as registry from './registry';

const HOME = os.homedir();

// ── 窗口归属表 ───────────────────────────────────────────────────────────────
const windowOwner = new Map<string, string>();

export function setWindowOwner(sessionId: string, userId: string): void {
  windowOwner.set(sessionId, userId);
}

// 按窗口名反查容器 (无路由目标返回 null → 宿主执行).
export function containerForWindow(sessionId: string): string | null {
  const userId = windowOwner.get(sessionId);
  if (!userId || !isolationActiveFor(userId)) return null;
  return containerNameFor(userId);
}

export function clearWindowOwner(sessionId: string): void {
  windowOwner.delete(sessionId);
}

// tmux() 自动路由入口: 从 args 里解析 HUB:<window> 目标, 命中已注册窗口 → 返回容器名.
export function resolveWindowContainer(args: string[]): string | null {
  if (!isDockerIsolation() || windowOwner.size === 0) return null;
  let target: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-t' || args[i] === '-pt') && i + 1 < args.length) {
      target = args[i + 1];
      break;
    }
  }
  if (!target) return null;
  const win = target.includes(':') ? target.split(':').slice(1).join(':') : target;
  if (!win || win === '_root') return null;
  const userId = windowOwner.get(win);
  if (!userId || !isolationActiveFor(userId)) return null;
  return containerNameOf(userId);
}

import { containerNameFor } from './config';
function containerNameOf(userId: string): string {
  return containerNameFor(userId);
}

// ── 容器 tmux server 引导 (每容器一次) ───────────────────────────────────────
const guidedContainers = new Set<string>();

export function ensureContainerTmuxServer(userId: string): void {
  const name = containerNameFor(userId);
  if (guidedContainers.has(name)) return;
  const r = spawnSync('docker', ['exec', name, 'tmux', '-L', 'mobius-agent',
    'start-server', ';',
    'set-option', '-g', 'exit-empty', 'off', ';',
    'set-option', '-g', 'history-limit', '100000', ';',
    'set-option', '-g', 'default-terminal', 'tmux-256color',
  ], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) return;
  // 容器内还要预建两个 agent hub session (宿主侧 ensureHub 不会进容器): 幂等.
  for (const hub of ['imac_claude_code_agent_hub', 'imac_codex_agent_hub']) {
    spawnSync('docker', ['exec', name, 'tmux', '-L', 'mobius-agent',
      'new-session', '-d', '-s', hub, '-n', '_root'], { encoding: 'utf8', timeout: 15000 });
  }
  guidedContainers.add(name);
}

// 容器销毁后清缓存: 重建的新容器同名, 不清会跳过 hub session 预建 (docker-sandbox.destroySandbox 调用).
export function forgetContainerGuidance(name: string): void {
  guidedContainers.delete(name);
}

// spawn 前统一入口: 确保容器在 + tmux server 已引导, 返回容器名 (非隔离用户返回 null).
export function prepareSpawn(userId: string | null | undefined, sessionId: string | null | undefined): string | null {
  if (!isolationActiveFor(userId)) return null;
  ensureSandbox(String(userId));
  // 只读输入的保鲜: seed 只在建容器时跑一次, 之后宿主侧新增/改动的 codex channel 配置,
  // 代理文件都要按 mtime 补进容器可见的 .sbx-home (容器已在跑就一直是旧副本).
  refreshSbxHomeInputs(String(userId));
  ensureContainerTmuxServer(String(userId));
  if (sessionId) setWindowOwner(sessionId, String(userId));
  return containerNameFor(String(userId));
}

// ── docker 模式下 listSessions 聚合: 遍历存活沙箱容器列窗口, 与宿主行合并 ─────
export function listWindowsRowsFromSandboxes(hub: string): string[][] {
  if (!isDockerIsolation()) return [];
  const rows: string[][] = [];
  for (const entry of registry.allEntries()) {
    if (!isolationActiveFor(entry.user) || !containerAlive(entry.user)) continue;
    const r = spawnSync('docker', ['exec', entry.containerName, 'tmux', '-L', 'mobius-agent',
      'list-windows', '-t', hub,
      '-F', '#{window_name}|#{pane_pid}|#{window_index}|#{window_activity}|#{pane_dead}|#{pane_current_command}',
    ], { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) continue;
    for (const line of r.stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const cols = line.split('|');
      rows.push(cols);
      // 顺带重建窗口归属表: 后端重启后 windowOwner 清空, 这里是窗口→容器映射的天然来源
      if (cols[0] && cols[0] !== '_root') setWindowOwner(cols[0], entry.user);
    }
  }
  return rows;
}

// ── 状态查询路径的沙箱窗口行快照 (异步刷新) ──────────────────────────────────
// listWindowsRowsFromSandboxes 一次遍历要给每个沙箱 spawnSync 一条 docker inspect + 一条
// docker exec (8 个沙箱 ≈ 16 个子进程 ≈ 1.8s), 全程阻塞 Node 事件循环. 它挂在
// isAlive → listWindowsRowsCached 上, 而 agent-status-syncer 每分钟把这套探测跑过 2000+
// 个会话: 3s 缓存一过期就再冻 1.8s, 事件循环被占满 → 整个 HTTP 服务只接连接不回应.
// (2026-10-16 事故: /api/v2/health 连续 000, 暂停取样栈顶正是这里的 spawnSync.)
// 故状态路径改读异步刷新的快照 (容忍 SBX_ROWS_TTL_MS 陈旧, 与原来的 3s 缓存同性质);
// 控制流 (windowExists / 建窗口 / 杀窗口) 仍走实时同步版, 那里必须看到真值.
const SBX_ROWS_TTL_MS = 5000;
const SBX_HUBS = ['imac_claude_code_agent_hub', 'imac_codex_agent_hub'];

let sbxRowsCache: { ts: number; byHub: Map<string, string[][]> } | null = null;
let sbxRowsRefreshInFlight = false;
let sbxRowsLastSyncFallbackTs = 0;

// 异步版的单容器 list-windows: 成功返回行, 失败 (容器不在 / 无 tmux server) 返回 null.
function dockerTmuxListWindows(container: string, hub: string): Promise<string[][] | null> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('docker', ['exec', container, 'tmux', '-L', 'mobius-agent',
      'list-windows', '-t', hub,
      '-F', '#{window_name}|#{pane_pid}|#{window_index}|#{window_activity}|#{pane_dead}|#{pane_current_command}',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } resolve(null); }, 15000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve(null); return; }
      resolve(out.trim().split('\n').filter(Boolean).map((l) => l.split('|')));
    });
  });
}

// 后台刷新一轮: 与同步版同源, 顺带重建窗口归属表 (后端重启后 windowOwner 为空时靠它).
function scheduleSandboxRowsRefresh(): void {
  if (sbxRowsRefreshInFlight) return;
  sbxRowsRefreshInFlight = true;
  const entries = registry.allEntries().filter((e) => isolationActiveFor(e.user));
  const byHub = new Map<string, string[][]>();
  const jobs: Promise<void>[] = [];
  for (const entry of entries) {
    for (const hub of SBX_HUBS) {
      jobs.push(dockerTmuxListWindows(entry.containerName, hub).then((rows) => {
        if (!rows) return;
        const acc = byHub.get(hub) || [];
        for (const cols of rows) {
          acc.push(cols);
          if (cols[0] && cols[0] !== '_root') setWindowOwner(cols[0], entry.user);
        }
        byHub.set(hub, acc);
      }));
    }
  }
  Promise.all(jobs).then(() => {
    // ts 取刷新完成时刻: 原实现在 spawnSync 之前取 now, 一次 1.8s 的慢刷新会把 TTL 直接
    // 吃掉一半以上, 缓存形同虚设.
    sbxRowsCache = { ts: Date.now(), byHub };
  }).catch(() => { /* 单容器失败已在上面吞掉 */ }).finally(() => { sbxRowsRefreshInFlight = false; });
}

// 状态查询入口: 读快照, 不阻塞事件循环. 冷启动 (首轮刷新未回来) 才允许同步兜底,
// 且 10s 内最多一次 — 防止"刷新一直失败 → 每次调用都卡 1.8s"把事故重演一遍.
export function listWindowsRowsForStatus(hub: string): string[][] {
  if (!isDockerIsolation()) return [];
  if (!sbxRowsCache || Date.now() - sbxRowsCache.ts > SBX_ROWS_TTL_MS) scheduleSandboxRowsRefresh();
  if (sbxRowsCache) return sbxRowsCache.byHub.get(hub) || [];
  const now = Date.now();
  if (now - sbxRowsLastSyncFallbackTs < 10000) return [];
  sbxRowsLastSyncFallbackTs = now;
  return listWindowsRowsFromSandboxes(hub);
}

// ── 宿主路径 → 沙箱路径 (仅 HOME / CODEX_HOME 两族; 其余挂载同路径) ────────────
function workDirOf(userId: string): string {
  const u = db.prepare('SELECT work_dir FROM users WHERE id = ?').get(String(userId)) as { work_dir?: string } | undefined;
  return (u?.work_dir || '').trim();
}

// 后端读 claude transcript / codex jsonl 的 HOME 基准: 隔离用户指向其 sbx-home.
export function claudeHomeFor(userId: string | null | undefined): string {
  if (!isolationActiveFor(userId)) return HOME;
  const wd = workDirOf(String(userId));
  return wd ? sbxHomeFor(wd) : HOME;
}

export function codexHomeFor(userId: string | null | undefined): string {
  if (!isolationActiveFor(userId)) return process.env.CODEX_HOME || path.join(HOME, '.codex');
  const wd = workDirOf(String(userId));
  return wd ? path.join(sbxHomeFor(wd), '.codex') : (process.env.CODEX_HOME || path.join(HOME, '.codex'));
}

// bash 链里的宿主绝对路径 → 容器内路径 ($HOME/x → sbx-home/x, CODEX_HOME/x → sbx/.codex/x).
export function rewriteHostPath(userId: string | null | undefined, p: string): string {
  if (!isolationActiveFor(userId) || !p) return p;
  const codexHome = process.env.CODEX_HOME || path.join(HOME, '.codex');
  if (p.startsWith(codexHome + '/')) {
    const rel = p.slice(codexHome.length + 1);
    return path.join(codexHomeFor(userId), rel);
  }
  if (p.startsWith(HOME + '/')) {
    const wd = workDirOf(String(userId));
    if (!wd) return p;
    return path.join(sbxHomeFor(wd), p.slice(HOME.length + 1));
  }
  return p;
}

// 会话级配置临时目录: 宿主 = 本人 per-user temp 下, 容器内 = /tmp/sbx-session/<sid>/ (同一挂载).
// 语义 (2026-10-13 用户决策): docker 模式的会话配置在"启动会话的瞬间"复制到临时路径,
// 随容器生灭 (reaper 删容器时顺手清理), 不在 .sbx-home 里堆积.
export function sessionConfigDir(userId: string, sessionId: string): string {
  return path.join(ensureTempRoot(userId), 'sbx-session', String(sessionId || 'adhoc'));
}

export function removeSessionConfigs(userId: string, sessionId: string): void {
  try { fs.rmSync(sessionConfigDir(userId, sessionId), { recursive: true, force: true }); } catch { /* best-effort */ }
}

// 容器版 settings 物化: 读宿主 settings (含 withproxy 副本), 把 127.0.0.1 换成
// 沙箱网关 IP 后复制到会话临时目录, 返回容器内同路径 (/tmp/sbx-session/<sid>/<basename>).
// 非隔离用户返回 null (调用方保留原路径).
export function materializeSettingsForSbx(userId: string | null | undefined, sessionId: string | null | undefined, settingsPath: string | null): string | null {
  if (!isolationActiveFor(userId) || !settingsPath) return null;
  try {
    const text = fs.readFileSync(settingsPath, 'utf-8')
      .replace(/127\.0\.0\.1/g, SBX_GATEWAY_IP);
    const containerPath = path.join(sessionConfigDir(String(userId), String(sessionId || 'adhoc')), path.basename(settingsPath));
    fs.mkdirSync(path.dirname(containerPath), { recursive: true });
    fs.writeFileSync(containerPath, text);
    return containerPath;
  } catch (e) {
    // 隔离用户绝不回落宿主路径: 那个路径在容器里不存在, claude 会带着读不到的 --settings 起来,
    // 表现为 TUI 迟迟不就绪 (25s 超时), 排查成本极高. 直接失败, 让会话带着明确原因报错.
    // Never fall back to the host path for isolated users: it does not exist inside the container,
    // so claude starts with an unreadable --settings and the TUI simply never becomes ready (a 25s
    // timeout with no cause in the UI). Fail loudly instead.
    throw new Error(`容器版 settings 物化失败 (容器内可见路径不可写): ${(e as Error).message}`);
  }
}

// agent env 保险改写: token-proxy 地址 127.0.0.1 → 沙箱网关 IP (settings 副本已由 seed 改).
export function rewriteEnvUrls(env: Record<string, any>): Record<string, any> {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (typeof out[key] === 'string' && out[key].includes('127.0.0.1')) {
      out[key] = out[key].replace(/http:\/\/127\.0\.0\.1:/g, `http://${SBX_GATEWAY_IP}:`);
    }
  }
  return out;
}

// agent 会话内 aimux MCP 的可执行路径: 容器内固定安装位 (镜像保证).
export function rewriteAimuxBin(userId: string | null | undefined, bin: string): string {
  return isolationActiveFor(userId) ? SBX_AIMUX_BIN : bin;
}

// ── deepseek-harness spawn 分派 ─────────────────────────────────────────────
// 隔离用户: node 换容器内 node22, 走 docker exec -i 透传 stdio (JSON-RPC peer 直接可用).
export function spawnHarnessChild(
  userId: string | null | undefined,
  command: string,
  args: string[],
  opts: { cwd: string; env: Record<string, any>; },
) {
  if (!isolationActiveFor(userId)) {
    return spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  ensureSandbox(String(userId));
  const name = containerNameFor(String(userId));
  const env = rewriteEnvUrls(opts.env);
  const dockerArgs = ['exec', '-i', '-w', opts.cwd, name];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') dockerArgs.push('-e', `${k}=${v}`);
  }
  // 容器内: node22 直跑 runtime (runtime 目录已同路径只读挂载).
  // proxychains 包装形式 [proxyBin, -q, -f, conf, node, runtimeBin, config] → 取尾部三元素; 容器内不再套 proxychains.
  let containerCommand = command;
  let containerArgs = args;
  if (/proxychains\d*$/.test(command) && args.length >= 3) {
    containerArgs = args.slice(-3); // [node, runtimeBin, config]
    containerCommand = containerArgs[0];
    containerArgs = containerArgs.slice(1);
  } else if (command.endsWith('/node') || /\/node\d+(\.\d+)*$/.test(command)) {
    containerArgs = args; // [runtimeBin, config]
  }
  const finalCommand = /node\d*(\.\d+)*$/.test(path.basename(containerCommand)) ? SBX_NODE22 : containerCommand;
  return spawn('docker', [...dockerArgs, finalCommand, ...containerArgs], {
    cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'],
  });
}
