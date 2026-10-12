/**
 * user-isolation/bridge.ts — aimux bridge 的 per-user 容器路由.
 *
 * docker 模式下普通用户的 broker 跑在其沙箱容器内 (0.0.0.0:33315, 网络隔离下
 * 仅宿主可达); runtime.json (url+token) 写在容器 HOME (.sbx-home, 宿主直读).
 * /aimux_bridge 代理按 JWT 用户路由到对应容器; admin 与 landlock 模式走宿主
 * 全局 broker (runtime.json 原路径).
 */
import fs from 'fs';
import path from 'path';
import url from 'url';
import { spawnSync } from 'child_process';
import { db } from '../../../db';
import { isDockerIsolation } from './config';
import { isolationActiveFor, ensureSandbox, sbxHomeFor, containerAlive } from './docker-sandbox';
import { containerNameFor } from './config';
import * as registry from './registry';

export interface BridgeTarget {
  baseUrl: string;
  token: string;
  hostname: string;
  port: number;
}

const GLOBAL_RUNTIME_PATH = process.env.AIMUX_BRIDGE_RUNTIME ||
  path.join(process.env.HOME || '/root', '.aimux', 'bridge', 'runtime.json');

const BRIDGE_PORT = parseInt(process.env.AIMUX_BRIDGE_PORT || '33315', 10);

export function bridgeRoutedFor(userId: string | null | undefined): boolean {
  return isDockerIsolation() && isolationActiveFor(userId);
}

// 隔离用户的 broker 常驻容器内 (幂等: 已在跑则跳过).
export function ensureBroker(userId: string): void {
  if (!bridgeRoutedFor(userId)) return;
  ensureSandbox(userId);
  const name = containerNameFor(userId);
  const r = spawnSync('docker', ['exec', name, 'pgrep', '-f', 'bridge deploy'], { encoding: 'utf8', timeout: 15000 });
  if (r.status === 0 && r.stdout.trim()) return;
  const workDir = (db.prepare('SELECT work_dir FROM users WHERE id = ?').get(userId) as { work_dir?: string })?.work_dir || '';
  const home = sbxHomeFor(workDir);
  // HOME 指向容器 sbx-home: broker 默认把 runtime.json 写到 $HOME/.aimux/bridge/
  const run = spawnSync('docker', ['exec', '-d', '-e', `HOME=${home}`, name,
    'aimux', 'bridge', 'deploy', '--host', '0.0.0.0', '--port', String(BRIDGE_PORT),
  ], { encoding: 'utf8', timeout: 30000 });
  if (run.status !== 0) {
    console.warn(`[user-isolation/bridge] 容器内 broker 启动失败: ${run.stderr || run.error?.message}`);
    return;
  }
  // 就绪等待: broker 绑定端口前代理转发会 ECONNREFUSED (容器内 TCP 探测, 最多 15s)
  for (let i = 0; i < 30; i++) {
    const probe = spawnSync('docker', ['exec', name, 'bash', '-c',
      `</dev/tcp/127.0.0.1/${BRIDGE_PORT}`], { encoding: 'utf8', timeout: 5000 });
    if (probe.status === 0) break;
    spawnSync('sleep', ['0.5']);
  }
  console.log(`[user-isolation/bridge] broker started in ${name} :${BRIDGE_PORT}`);
}

// 代理目标解析 (aimux-bridge-proxy 调用): 隔离用户 → 容器内 runtime.json,
// url 的 host 改写为容器静态 IP (broker 写的是 0.0.0.0).
export function bridgeTargetFor(userId: string | null | undefined): BridgeTarget {
  if (!bridgeRoutedFor(userId)) {
    return readRuntime(GLOBAL_RUNTIME_PATH, null);
  }
  const u = String(userId);
  const workDir = (db.prepare('SELECT work_dir FROM users WHERE id = ?').get(u) as { work_dir?: string })?.work_dir || '';
  const runtimePath = path.join(sbxHomeFor(workDir), '.aimux', 'bridge', 'runtime.json');
  const ip = registry.getEntry(u)?.ip || null;
  return readRuntime(runtimePath, ip);
}

function readRuntime(runtimePath: string, ipOverride: string | null): BridgeTarget {
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
  } catch {
    const err = new Error(`aimux bridge broker is not running (runtime.json missing: ${runtimePath})`) as Error & { code: string };
    err.code = 'BRIDGE_DOWN';
    throw err;
  }
  if (!data?.url || !data?.token) {
    const err = new Error('aimux bridge runtime.json missing url/token') as Error & { code: string };
    err.code = 'BRIDGE_DOWN';
    throw err;
  }
  const parsed = url.parse(data.url);
  const hostname = ipOverride || parsed.hostname || '127.0.0.1';
  const port = parsed.port ? Number(parsed.port) : BRIDGE_PORT;
  return {
    baseUrl: `http://${hostname}:${port}`,
    token: data.token,
    hostname,
    port,
  };
}

// broker 是否健康 (容器内 GET /api/health).
export function brokerHealthy(userId: string): boolean {
  if (!containerAlive(userId)) return false;
  const t = registry.getEntry(userId);
  if (!t?.ip) return false;
  const r = spawnSync('docker', ['exec', containerNameFor(userId), 'bash', '-lc',
    `curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${BRIDGE_PORT}/api/health || true`],
    { encoding: 'utf8', timeout: 15000 });
  return r.stdout.trim() === '200';
}
