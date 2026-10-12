/**
 * user-isolation/docker-sandbox.ts — 用户沙箱容器的生命周期核心.
 *
 * 规则 (2026-10-13 用户定论):
 *   - 权限变更 → 立即杀旧容器起新容器, 不允许脏容器 (reconcile 定时比对挂载集兜底).
 *   - 该用户所有 agent 不活跃 (tmux 会话全灭) → 立即删除容器.
 *   - 数据保留边界 = 工作路径 + 一切 --volume 挂载; 容器仅销毁自身可写层.
 *   - 挂载一律同路径 bind mount (宿主/容器路径一致, 零路径改写).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { db } from '../../../db';
import {
  SBX_NETWORK, SBX_SUBNET, SBX_GATEWAY_IP, SBX_MEMORY, SBX_CPUS, SBX_PIDS_LIMIT,
  SBX_HOME_DIRNAME, isDockerIsolation, dockerSandboxAvailable, sandboxImageRef,
  containerNameFor,
} from './config';
import { exceptionPathsFor } from '../agent-sandbox';
import { ensureTempRoot } from '../file-access';
import * as registry from './registry';

const HOME = os.homedir();
const CS_DATA_ROOT = process.env.CODE_SERVER_DATA_ROOT || '/data/code_server';
const CS_DATA_DIR = process.env.CS_DATA_ROOT || path.join(CS_DATA_ROOT, 'cs-data');
const CS_EXT_DIR = process.env.CS_EXT_ROOT || path.join(CS_DATA_ROOT, 'cs-ext');
const RUNTIME_DIR = path.join(__dirname, '..', '..', '..', 'deepseek-harness-runtime');

export function isolationActiveFor(userId: string | null | undefined): boolean {
  if (!isDockerIsolation() || !userId) return false;
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(String(userId)) as { role?: string } | undefined;
  return !!user && user.role !== 'admin';
}

export function sbxHomeFor(workDir: string): string {
  return path.join(workDir, SBX_HOME_DIRNAME);
}

function docker(args: string[], timeoutMs = 60000) {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs });
}

// ── 挂载矩阵 ────────────────────────────────────────────────────────────────
// 期望挂载集: 本人 work_dir + 有写权限的例外项目 (exceptionPathsFor 同口径) +
// per-user temp + 本人 code-server 数据目录 + harness runtime(ro) + CLI 支撑文件.
export function mountsFor(userId: string): Array<{ host: string; mode: 'rw' | 'ro' }> {
  const user = db.prepare('SELECT work_dir FROM users WHERE id = ?').get(String(userId)) as { work_dir?: string } | undefined;
  const workDir = (user?.work_dir || '').trim();
  if (!workDir) throw new Error(`用户 ${userId} 无 work_dir, 无法构建沙箱挂载`);
  fs.mkdirSync(workDir, { recursive: true });

  const mounts: Array<{ host: string; mode: 'rw' | 'ro' }> = [];
  const seen = new Set<string>();
  const push = (host: string, mode: 'rw' | 'ro') => {
    let real = host;
    try { real = fs.realpathSync(host); } catch { /* 不存在的路径不挂 */ return; }
    if (seen.has(real)) return;
    seen.add(real);
    mounts.push({ host: real, mode });
  };

  // 本人工作区 (含 .sbx-home 容器 HOME) 与例外项目
  for (const p of exceptionPathsFor(String(userId), null, workDir)) push(p, 'rw');
  // per-user temp: TMPDIR 注入值与容器内路径一致 (display_images 产物后端可见)
  push(ensureTempRoot(userId), 'rw');
  // 本人 code-server 数据/扩展目录
  fs.mkdirSync(path.join(CS_DATA_DIR, userId), { recursive: true });
  fs.mkdirSync(path.join(CS_EXT_DIR, userId), { recursive: true });
  push(path.join(CS_DATA_DIR, userId), 'rw');
  push(path.join(CS_EXT_DIR, userId), 'rw');
  // harness runtime (只读, 版本随宿主)
  push(RUNTIME_DIR, 'ro');
  return mounts;
}

// seed: 容器 HOME 的 CLI 支撑文件 (在 work_dir/.sbx-home 下, 随挂载天然进容器).
//  - settings 副本: 把 token-proxy 地址 127.0.0.1 改写为沙箱网关 IP (唯一改写点)
//  - 代理三件套 / codex 全局配置: 原样复制 (凭证不落 auth.json, 走 env 注入)
function seedSbxHome(workDir: string): void {
  const sbxHome = sbxHomeFor(workDir);
  try {
    fs.mkdirSync(path.join(sbxHome, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(sbxHome, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(sbxHome, '.aimux'), { recursive: true });

    const srcSettings = path.join(HOME, '.claude', 'mobiusdefault.settings.json');
    const dstSettings = path.join(sbxHome, '.claude', 'mobiusdefault.settings.json');
    if (fs.existsSync(srcSettings) && !fs.existsSync(dstSettings)) {
      const text = fs.readFileSync(srcSettings, 'utf-8').replace(/127\.0\.0\.1/g, SBX_GATEWAY_IP);
      fs.writeFileSync(dstSettings, text);
    }
    for (const name of ['proxy_envs.conf', 'proxy_envs.bash', 'proxychains_config_for_llm_models.conf']) {
      const src = path.join(HOME, name);
      const dst = path.join(sbxHome, name);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    }
    // codex 全局 config + profile configs (auth.json / history.jsonl 等用户数据绝不复制)
    const codexHome = process.env.CODEX_HOME || path.join(HOME, '.codex');
    for (const name of fs.existsSync(codexHome)
      ? fs.readdirSync(codexHome).filter((n) => n.endsWith('.toml')) : []) {
      const dst = path.join(sbxHome, '.codex', name);
      if (!fs.existsSync(dst)) fs.copyFileSync(path.join(codexHome, name), dst);
    }
  } catch (e) {
    console.warn(`[user-isolation] seed sbx-home 失败: ${(e as Error).message}`);
  }
}

// ── 网络 (幂等) ─────────────────────────────────────────────────────────────
let networkReady = false;
export function ensureNetwork(): void {
  if (networkReady) return;
  const probe = docker(['network', 'inspect', SBX_NETWORK]);
  if (probe.status !== 0) {
    const create = docker(['network', 'create', '--subnet', SBX_SUBNET,
      '--opt', 'com.docker.network.bridge.enable_icc=false', SBX_NETWORK]);
    if (create.status !== 0) throw new Error(`沙箱网络创建失败: ${create.stderr || create.error?.message}`);
  }
  networkReady = true;
}

// ── 容器存在性 / 期望挂载集比对 ─────────────────────────────────────────────
export function containerAlive(userId: string): boolean {
  return docker(['inspect', containerNameFor(userId), '--format', '{{.Id}}']).status === 0;
}

function inspectMounts(userId: string): string[] {
  const r = docker(['inspect', containerNameFor(userId), '--format', '{{json .Mounts}}']);
  if (r.status !== 0) return [];
  try {
    return (JSON.parse(r.stdout) as Array<{ Source?: string }>).map((m) => m.Source || '');
  } catch { return []; }
}

function mountsMatch(userId: string): boolean {
  const expected = new Set(mountsFor(userId).map((m) => m.host));
  const actual = new Set(inspectMounts(userId));
  if (expected.size !== actual.size) return false;
  for (const e of expected) if (!actual.has(e)) return false;
  return true;
}

// ── 核心: ensure / destroy / rebuild ────────────────────────────────────────
export function ensureSandbox(userId: string): void {
  if (!isolationActiveFor(userId)) return;
  if (!dockerSandboxAvailable()) {
    const e = new Error('docker 沙箱不可用 (daemon/镜像缺失), 普通用户执行面被拒绝') as Error & { status?: number };
    e.status = 503;
    throw e;
  }
  ensureNetwork();
  const name = containerNameFor(userId);
  if (containerAlive(userId)) {
    registry.touchEntry(userId);
    // 脏容器兜底: 期望挂载集与实际不一致 → 立即换容器 (权限变更钩子的兜底路径)
    if (!mountsMatch(userId)) {
      console.log(`[user-isolation] ${name} 挂载集与权限不一致, 立即重建`);
      rebuildNow([userId]);
    }
    return;
  }

  const user = db.prepare('SELECT work_dir FROM users WHERE id = ?').get(String(userId)) as { work_dir?: string };
  const workDir = (user?.work_dir || '').trim();
  if (!workDir) throw new Error(`用户 ${userId} 无 work_dir`);
  seedSbxHome(workDir);

  const mounts = mountsFor(String(userId));
  const ip = registry.allocateIp();
  const args = [
    'run', '-d', '--name', name,
    '--network', SBX_NETWORK, '--ip', ip,
    '--memory', SBX_MEMORY, '--cpus', SBX_CPUS, '--pids-limit', String(SBX_PIDS_LIMIT),
    '--init', '--stop-timeout', '30',
    '--label', `mobius.sandbox.user=${userId}`,
    '-u', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '-e', `HOME=${sbxHomeFor(workDir)}`,
    '-e', `TMPDIR=${ensureTempRoot(userId)}`,
    '-e', `CODEX_HOME=${path.join(sbxHomeFor(workDir), '.codex')}`,
    '-w', workDir,
  ];
  for (const m of mounts) args.push('-v', `${m.host}:${m.host}:${m.mode}`);
  args.push(sandboxImageRef(), 'sleep', 'infinity');

  const r = docker(args, 120000);
  if (r.status !== 0) throw new Error(`沙箱容器启动失败: ${r.stderr || r.error?.message || 'unknown'}`);
  const id = docker(['inspect', name, '--format', '{{.Id}}']).stdout.trim();
  registry.putEntry({
    user: String(userId), containerName: name, containerId: id.slice(0, 12), ip,
    image: sandboxImageRef(), mounts: mounts.map((m) => m.host),
    createdAt: Date.now(), lastActiveAt: Date.now(), services: {},
    refs: { agents: 0, codeServer: 0, terminals: 0, bridgeClients: 0 },
  });
  console.log(`[user-isolation] started ${name} ip=${ip} mounts=${mounts.length}`);
}

export function destroySandbox(userId: string): void {
  const name = containerNameFor(userId);
  docker(['rm', '-f', name], 60000);
  registry.removeEntry(userId);
}

// 权限变更 → 立即杀旧起新 (rm 成功 run 失败 → fail-closed, 下次 ensure 重试).
export function rebuildNow(userIds: Array<string | null | undefined>): void {
  for (const raw of userIds) {
    const userId = String(raw || '').trim();
    if (!userId || !isolationActiveFor(userId)) continue;
    try {
      destroySandbox(userId);
      ensureSandbox(userId);
      console.log(`[user-isolation] rebuilt sandbox for ${userId} (权限变更)`);
    } catch (e) {
      registry.removeEntry(userId);
      console.warn(`[user-isolation] rebuild ${userId} 失败 (fail-closed): ${(e as Error).message}`);
    }
  }
}

// ── agent 活跃判定 + 全灭即删 ───────────────────────────────────────────────
function userHasActiveAgent(userId: string): boolean {
  const name = containerNameFor(userId);
  // tmux 两个 hub 任一有存活窗口 = 活跃
  for (const hub of ['imac_claude_code_agent_hub', 'imac_codex_agent_hub']) {
    const r = docker(['exec', name, 'tmux', '-L', 'mobius-agent', 'list-windows', '-t', hub], 15000);
    if (r.status === 0 && r.stdout.trim()) return true;
  }
  // deepseek-harness: dsh-jsonrpc-agent 进程存活 = 活跃
  const dsh = docker(['exec', name, 'pgrep', '-f', 'dsh-jsonrpc-agent'], 15000);
  if (dsh.status === 0 && dsh.stdout.trim()) return true;
  return false;
}

function reapIdleSandboxes(): void {
  for (const entry of registry.allEntries()) {
    if (!containerAlive(entry.user)) { registry.removeEntry(entry.user); continue; }
    if (!isolationActiveFor(entry.user)) continue; // 模式切回/降为 admin: 不动, 交 admin 面
    let active = false;
    try { active = userHasActiveAgent(entry.user); } catch { continue; }
    if (!active) {
      console.log(`[user-isolation] agent 全灭, 删除容器 ${entry.containerName}`);
      destroySandbox(entry.user);
    }
  }
}

// 定时器: 60s 全灭扫描 (事件丢失的兜底) + reconcile 收编.
let timerStarted = false;
export function startBackgroundTimers(): void {
  if (timerStarted) return;
  timerStarted = true;
  setInterval(() => { try { reapIdleSandboxes(); } catch { /* 单轮失败不影响下轮 */ } }, 60_000).unref();
}

// 后端重启 reconcile: docker ps 按 label 收编存量容器 (registry 缺条目则重建条目).
export function reconcileSandboxes(): void {
  if (!isDockerIsolation()) return;
  const r = docker(['ps', '--filter', `label=mobius.sandbox.user`, '--format', '{{.Names}}\t{{.ID}}\t{{.Label "mobius.sandbox.user"}}']);
  if (r.status !== 0) return;
  for (const line of r.stdout.split('\n')) {
    const [name, id, userId] = line.trim().split('\t');
    if (!name || !userId) continue;
    if (!registry.getEntry(userId)) {
      const ip = docker(['inspect', name, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']).stdout.trim();
      registry.putEntry({
        user: userId, containerName: name, containerId: (id || '').slice(0, 12), ip: ip || '',
        image: sandboxImageRef(), mounts: [], createdAt: Date.now(), lastActiveAt: Date.now(),
        services: {}, refs: { agents: 0, codeServer: 0, terminals: 0, bridgeClients: 0 },
      });
      console.log(`[user-isolation] reconcile 收编 ${name}`);
    }
  }
  reapIdleSandboxes();
}
