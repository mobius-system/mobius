/**
 * user-isolation/selfcheck.ts — docker 隔离模式的自检 (对齐 landlock 的 mobius-landlock --check).
 *
 * 四步 (2026-10-13 用户定义):
 *   1. docker daemon 直接可用
 *   2. USER_ISOLATION_DOCKER_IMAGE 镜像存在
 *   3. 能创建容器并 mount 一个测试 volume (双向读写)
 *   4. 能创建容器并开放 code-server 与 aimux bridge 端口 (宿主可连通)
 *
 * 结果进程内缓存 (成功不重跑; 失败后下次调用重试), 后端启动时预热. 闸门
 * (登录/建号/spawn) 读缓存: 任一步失败 → 普通用户 fail-closed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawnSync } from 'child_process';
import { isDockerIsolation, USER_ISOLATION_DOCKER_IMAGE, SBX_NETWORK, SBX_SUBNET } from './config';

export interface SelfCheckStep {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

export interface SelfCheckResult {
  ok: boolean;
  ranAt: number;
  steps: SelfCheckStep[];
}

let cached: SelfCheckResult | null = null;
let running: Promise<SelfCheckResult> | null = null;

export function selfCheckResult(): SelfCheckResult | null {
  return cached;
}

function docker(args: string[], timeoutMs = 60000) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs });
}

function ensureSbxNetwork(): void {
  const probe = docker(['network', 'inspect', SBX_NETWORK]);
  if (probe.status !== 0) {
    docker(['network', 'create', '--subnet', SBX_SUBNET,
      '--opt', 'com.docker.network.bridge.enable_icc=false', SBX_NETWORK]);
  }
}

function tcpProbe(ip: string, port: number, timeoutMs = 15000): boolean {
  const r = spawnSync('node', ['-e', `
    const net = require('net');
    const s = net.connect(${port}, '${ip}');
    s.once('connect', () => { s.end(); process.exit(0); });
    s.once('error', () => process.exit(1));
    setTimeout(() => { process.exit(1); }, ${timeoutMs - 1000});
  `], { timeout: timeoutMs });
  return r.status === 0;
}

// 第 3+4 步共用一个一次性容器: 挂卷 → 起服务 → 探端口 → 清理.
function probeContainerSteps(steps: SelfCheckStep[]): void {
  const tag = `sbx-selfcheck-${Date.now()}`;
  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-selfcheck-'));
  try {
    ensureSbxNetwork();
    const run = docker(['run', '-d', '--name', tag, '--network', SBX_NETWORK,
      '--memory', '512m', '--cpus', '1', '--pids-limit', '64',
      '--label', 'mobius.sandbox.selfcheck=1',
      '-v', `${hostDir}:/mnt-probe`,
      USER_ISOLATION_DOCKER_IMAGE, 'sleep', 'infinity'], 60000);
    if (run.status !== 0) {
      steps.push({ name: '创建容器', ok: false, detail: (run.stderr || '').trim().slice(0, 200), ms: 0 });
      return;
    }
    // 步骤 3: mount 测试 volume — 容器写 → 宿主读 (双向 bind 的写方向), 再宿主写 → 容器读.
    const t0 = Date.now();
    const w = docker(['exec', tag, 'bash', '-c', 'echo probe-ok > /mnt-probe/from-container'], 30000);
    const hostSaw = w.status === 0 && fs.readFileSync(path.join(hostDir, 'from-container'), 'utf8').trim() === 'probe-ok';
    fs.writeFileSync(path.join(hostDir, 'from-host'), 'probe-ok');
    const r = docker(['exec', tag, 'cat', '/mnt-probe/from-host'], 30000);
    const containerSaw = r.status === 0 && r.stdout.trim() === 'probe-ok';
    steps.push({
      name: '容器 + volume 挂载读写',
      ok: hostSaw && containerSaw,
      detail: hostSaw && containerSaw ? '双向读写正常' : `宿主读=${hostSaw} 容器读=${containerSaw}`,
      ms: Date.now() - t0,
    });

    // 步骤 4: 容器内起 code-server 与 aimux broker, 宿主经容器 IP 连通两个端口.
    const t1 = Date.now();
    docker(['exec', '-d', tag, 'code-server', '--bind-addr', '0.0.0.0:45798',
      '--auth', 'none', '--disable-telemetry', '/tmp'], 30000);
    docker(['exec', '-d', tag, 'bash', '-c',
      'HOME=/root aimux bridge deploy --host 0.0.0.0 --port 33316'], 30000);
    // 就绪等待 (code-server 冷启动 / broker 监听)
    let csOk = false, bridgeOk = false;
    const ipRaw = docker(['inspect', tag, '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'], 15000);
    const ip = (ipRaw.stdout || '').trim();
    for (let i = 0; i < 20 && (!csOk || !bridgeOk); i++) {
      if (!csOk) csOk = tcpProbe(ip, 45798, 5000);
      if (!bridgeOk) bridgeOk = tcpProbe(ip, 33316, 5000);
      if (!csOk || !bridgeOk) spawnSync('sleep', ['0.8']);
    }
    steps.push({
      name: 'code-server / aimux bridge 端口',
      ok: csOk && bridgeOk,
      detail: `code-server(45798)=${csOk ? '通' : '不通'} · bridge(33316)=${bridgeOk ? '通' : '不通'} · 容器IP=${ip || '?'}`,
      ms: Date.now() - t1,
    });
  } finally {
    docker(['rm', '-f', tag], 30000);
    try { fs.rmSync(hostDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

export function runSelfCheck(force = false): Promise<SelfCheckResult> {
  if (!force && cached) return Promise.resolve(cached);
  if (force && running) return running;
  if (running) return running;
  running = new Promise<SelfCheckResult>((resolve) => {
    const steps: SelfCheckStep[] = [];
    const t0 = Date.now();
    const v = docker(['version', '--format', '{{.Server.Version}}'], 15000);
    steps.push({
      name: 'docker daemon 可用',
      ok: v.status === 0,
      detail: v.status === 0 ? `server ${v.stdout.trim()}` : (v.stderr || 'docker 命令不可用').trim().slice(0, 200),
      ms: Date.now() - t0,
    });
    if (v.status === 0) {
      const t1 = Date.now();
      const img = docker(['image', 'inspect', USER_ISOLATION_DOCKER_IMAGE, '--format', '{{.Id}}'], 15000);
      steps.push({
        name: `沙箱镜像存在 (${USER_ISOLATION_DOCKER_IMAGE})`,
        ok: img.status === 0,
        detail: img.status === 0 ? img.stdout.trim().slice(0, 19) : '未找到该镜像, 请先构建或导入',
        ms: Date.now() - t1,
      });
      if (img.status === 0) probeContainerSteps(steps);
    }
    const result: SelfCheckResult = {
      ok: steps.length > 0 && steps.every((s) => s.ok),
      ranAt: Date.now(),
      steps,
    };
    cached = result;
    running = null;
    console.log(`[user-isolation/selfcheck] ${result.ok ? '✅ 全部通过' : '❌ 存在失败项'}: ${steps.map((s) => `${s.ok ? '√' : '×'}${s.name}`).join(' ')}`);
    resolve(result);
  });
  return running;
}

// 闸门用: 同步语义 (缓存优先; 无缓存时回退轻检并异步触发全检).
export function selfCheckGate(): boolean {
  if (!isDockerIsolation()) return false;
  if (cached) return cached.ok;
  const hasImage = Boolean(USER_ISOLATION_DOCKER_IMAGE) && docker(['image', 'inspect', USER_ISOLATION_DOCKER_IMAGE], 15000).status === 0;
  void runSelfCheck(); // 异步预热全检, 结果进缓存
  return hasImage;
}
