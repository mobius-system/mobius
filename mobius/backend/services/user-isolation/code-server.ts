/**
 * user-isolation/code-server.ts — code-server 的沙箱容器分支 (供 code-server-pool 分派).
 *
 * 容器内启动 code-server, 绑 0.0.0.0:<port> (唯一入口是宿主后端反代 + icc=false
 * 网络隔离); 数据/扩展目录同路径挂载 (宿主 /data/code_server/<user>/<proj>);
 * idle 回收退化为随容器生死 (容器 agent 全灭即删).
 */
import net from 'net';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { isDockerIsolation } from './config';
import { isolationActiveFor, ensureSandbox } from './docker-sandbox';
import { containerNameFor } from './config';
import * as registry from './registry';

const CS_DATA_ROOT = process.env.CODE_SERVER_DATA_ROOT || '/data/code_server';
const CS_DATA_DIR = process.env.CS_DATA_ROOT || path.join(CS_DATA_ROOT, 'cs-data');
const CS_EXT_DIR = process.env.CS_EXT_ROOT || path.join(CS_DATA_ROOT, 'cs-ext');
const PORT_BASE = parseInt(process.env.CS_PORT_BASE || '45700', 10);
const READY_TIMEOUT_MS = parseInt(process.env.CS_READY_TIMEOUT_MS || '30000', 10);

// 模块级实例表: key = "<userId>__<projectId>" (与 pool.key 同键法)
const instances = new Map<string, { port: number; startedAt: number }>();

export function dockerCodeServerActive(userId: string): boolean {
  return isDockerIsolation() && isolationActiveFor(userId);
}

function containerIp(userId: string): string | null {
  const entry = registry.getEntry(userId);
  if (entry?.ip) return entry.ip;
  const r = spawnSync('docker', ['inspect', containerNameFor(userId),
    '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'], { encoding: 'utf8', timeout: 15000 });
  const ip = (r.stdout || '').trim();
  return ip || null;
}

// 反代目标 (code-server-proxy 调用): 隔离用户 → 容器 IP, 其余 → 127.0.0.1.
export function proxyTargetHost(userId: string): string {
  if (!dockerCodeServerActive(userId)) return '127.0.0.1';
  return containerIp(userId) || '127.0.0.1';
}

function portBusyInContainer(name: string, port: number): boolean {
  const r = spawnSync('docker', ['exec', name, 'bash', '-lc',
    `ss -lnt | grep -q ':${port} '`], { encoding: 'utf8', timeout: 15000 });
  return r.status === 0;
}

async function waitForReady(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, ip);
      s.once('connect', () => { s.end(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise<void>((r) => setTimeout(r, 250));
  }
  return false;
}

// pool.ensure 的 docker 分支: 返回结构与 pool.ensure 相同 ({ port, key, started }).
export async function ensureDocker(
  user: any, projectId: string, bindPath: string,
): Promise<{ port: number; key: string; started: boolean } | null> {
  if (!dockerCodeServerActive(user?.id)) return null;
  ensureSandbox(String(user.id));
  const name = containerNameFor(String(user.id));
  const k = `${user.id}__${projectId}`;

  // 复用优先: 内存表 → registry (后端重启后内存丢失, registry 是持久事实源).
  // portBusyInContainer = 端口被占 = 实例活着; 空闲说明进程死了, 必须重新起.
  const memo = instances.get(k);
  if (memo && portBusyInContainer(name, memo.port)) {
    return { port: memo.port, key: k, started: false };
  }
  const reg = registry.getEntry(String(user.id))?.services.codeServer?.find((s) => s.projectId === projectId);
  if (reg && portBusyInContainer(name, reg.port)) {
    instances.set(k, { port: reg.port, startedAt: reg.startedAt });
    return { port: reg.port, key: k, started: false };
  }

  // 容器内端口分配: 同号段池取号 (容器网络独立栈, 与宿主监听无冲突)
  const used = new Set([...instances.values()].map((v) => v.port));
  let port = PORT_BASE;
  while (used.has(port) || portBusyInContainer(name, port)) port++;
  if (port >= PORT_BASE + 128) throw new Error('user-isolation/cs: 容器端口耗尽');

  const dataDir = path.join(CS_DATA_DIR, user.id, projectId);
  const extDir = path.join(CS_EXT_DIR, user.id, projectId);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(extDir, { recursive: true });

  // 预置 git identity (与 pool 同款)
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

  const r = spawnSync('docker', ['exec', '-d', name, 'code-server',
    '--bind-addr', `0.0.0.0:${port}`,
    '--auth', 'none',
    '--disable-telemetry',
    '--disable-update-check',
    '--user-data-dir', dataDir,
    '--extensions-dir', extDir,
    bindPath,
  ], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error(`沙箱内 code-server 启动失败: ${r.stderr || r.error?.message}`);

  const ip = containerIp(String(user.id));
  if (!ip) throw new Error('沙箱容器 IP 未知');
  const ready = await waitForReady(ip, port, READY_TIMEOUT_MS);
  if (!ready) throw new Error(`沙箱内 code-server ${READY_TIMEOUT_MS}ms 未就绪 (port ${port})`);

  instances.set(k, { port, startedAt: Date.now() });
  registry.recordCodeServer(String(user.id), projectId, port);
  console.log(`[user-isolation/cs] started ${k} in ${name} port=${port}`);
  return { port, key: k, started: true };
}

export function killDocker(key: string, userId: string, projectId: string): boolean {
  const inst = instances.get(key);
  if (!inst) return false;
  instances.delete(key);
  try {
    spawnSync('docker', ['exec', containerNameFor(userId), 'bash', '-lc',
      `fuser -k ${inst.port}/tcp 2>/dev/null || true`], { encoding: 'utf8', timeout: 15000 });
  } catch { /* 容器可能已删 */ }
  registry.dropCodeServer(userId, projectId);
  return true;
}

export function listDocker(): any[] {
  return [...instances.entries()].map(([key, v]) => ({
    key, ...v, docker: true,
    started_at: new Date(v.startedAt).toISOString(),
  }));
}
