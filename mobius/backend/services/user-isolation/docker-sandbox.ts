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
  SBX_HOME_DIRNAME, SBX_IDLE_DESTROY_MS, isDockerIsolation, dockerSandboxAvailable, sandboxImageRef,
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

// 该用户的工作区路径 (空串 = 未配置, 调用方按需降级)
export function workDirOfUser(userId: string): string {
  const user = db.prepare('SELECT work_dir FROM users WHERE id = ?').get(String(userId)) as { work_dir?: string } | undefined;
  return (user?.work_dir || '').trim();
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

// ── 只读输入的保鲜 (每次 spawn 前) ───────────────────────────────────────────
// seed 只发生在建容器那一刻: 宿主侧之后改动 (新增/修改 codex channel 配置、换代理配置) 时,
// 还活着的容器里仍是旧副本 —— codex 会静默回落旧 profile (缺文件 = 空层, 不报错), proxychains
// 档则直接起不来. 按 mtime 补一次; 列表里只放容器只读的文件 (config.toml 带容器侧写入的信任条目).
// The seed runs once, at container creation: a later host-side change (a new/edited codex channel
// config, rotated proxy files) leaves the live container on the stale copy — codex then silently
// falls back to the old profile (a missing file is an empty layer, not an error) and the
// proxychains tiers fail to start. Refresh by mtime; only files the container never writes are
// listed here (config.toml carries container-side trust entries).
const REFRESH_HOME_FILES = ['proxy_envs.conf', 'proxy_envs.bash', 'proxychains_config_for_llm_models.conf'];

export function refreshSbxHomeInputs(userId: string): void {
  const workDir = workDirOfUser(String(userId));
  if (!workDir) return;
  const sbxHome = sbxHomeFor(workDir);
  const codexHome = process.env.CODEX_HOME || path.join(HOME, '.codex');
  const pairs: Array<[string, string]> = REFRESH_HOME_FILES.map(
    (name) => [path.join(HOME, name), path.join(sbxHome, name)] as [string, string],
  );
  try {
    for (const name of fs.existsSync(codexHome) ? fs.readdirSync(codexHome) : []) {
      if (name.endsWith('.config.toml')) {
        pairs.push([path.join(codexHome, name), path.join(sbxHome, '.codex', name)]);
      }
    }
  } catch { /* 宿主 codex 目录读不到就只刷新代理文件 */ }
  for (const [src, dst] of pairs) {
    try {
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } catch { /* best-effort: 保留旧副本, 下次 spawn 再试 */ }
  }
  // claude 默认 settings 与 seed 同款改写 (token-proxy 地址 → 沙箱网关), 一并保鲜:
  // 普通会话的 --settings 每次由 materializeSettingsForSbx 现取现写, 吃这份副本的只有
  // bash 链的兜底 `--settings "$HOME/.claude/mobiusdefault.settings.json"`.
  // The claude default settings get the same seed-time rewrite (token-proxy → sandbox gateway) and
  // the same refresh: only the bash-chain fallback --settings "$HOME/.claude/..." reads this copy.
  try {
    const src = path.join(HOME, '.claude', 'mobiusdefault.settings.json');
    const dst = path.join(sbxHome, '.claude', 'mobiusdefault.settings.json');
    if (fs.existsSync(src) && (!fs.existsSync(dst) || fs.statSync(dst).mtimeMs < fs.statSync(src).mtimeMs)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, fs.readFileSync(src, 'utf-8').replace(/127\.0\.0\.1/g, SBX_GATEWAY_IP));
    }
  } catch { /* best-effort */ }
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
// "活着" = 存在且 Running. 只查存在性会把 Created/Exited 误判为活:
// 2026-10-14 事故 — runc 间歇性失败把 mobius-sbx-normal-test 卡在 Created,
// 之后每次 docker exec 都报 "container is not running" 且无自愈路径.
export function containerAlive(userId: string): boolean {
  const r = docker(['inspect', containerNameFor(userId), '--format', '{{.State.Running}}']);
  return r.status === 0 && r.stdout.trim() === 'true';
}

function containerExists(userId: string): boolean {
  return docker(['inspect', containerNameFor(userId), '--format', '{{.Id}}']).status === 0;
}

// 从实际容器收编 registry 条目 (后端重启/条目丢失时). 挂载集取 inspect 实际值,
// 避免空 mounts 触发挂载集比对误判而白白重建.
function adoptEntry(userId: string): void {
  const name = containerNameFor(String(userId));
  const prev = registry.getEntry(String(userId));
  registry.putEntry({
    user: String(userId), containerName: name,
    containerId: (docker(['inspect', name, '--format', '{{.Id}}']).stdout.trim() || '').slice(0, 12),
    ip: docker(['inspect', name, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']).stdout.trim(),
    image: sandboxImageRef(),
    mounts: inspectMounts(String(userId)),
    createdAt: prev?.createdAt || Date.now(),
    lastActiveAt: Date.now(),
    services: prev?.services || {},
    refs: prev?.refs || { agents: 0, codeServer: 0, terminals: 0, bridgeClients: 0 },
  });
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
  // 自愈: 容器存在但不在运行 (runc 间歇性失败留下的 Created / 宿主 docker 重启后的
  // Exited) → docker start 按原配置拉起 (配置未变, 不构成脏容器); start 失败则抛错,
  // 保留容器本体待下次请求重试 (daemon 恢复后即收敛).
  if (!containerAlive(userId) && containerExists(userId)) {
    const st = docker(['start', name], 60000);
    if (st.status !== 0) {
      const e = new Error(`沙箱容器无法启动 (docker start ${name}): ${st.stderr || st.error?.message || 'unknown'}`) as Error & { status?: number };
      e.status = 503;
      throw e;
    }
    console.log(`[user-isolation] ${name} 此前处于非运行状态, 已重新拉起`);
  }
  if (containerAlive(userId)) {
    knownAlive.add(String(userId));
    // registry 条目丢失/不完整 (后端重启、历史事故) → 从实际容器收编
    const entry = registry.getEntry(String(userId));
    if (!entry || entry.mounts.length === 0) adoptEntry(userId);
    else registry.touchEntry(userId);
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
    // 默认 seccomp profile 生效 (2026-10-13 曾因 runc 1.3.4 bug 临时 seccomp=unconfined,
    // docker daemon 重启后已恢复, 绕过行已移除).
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
  knownAlive.add(String(userId));
  console.log(`[user-isolation] started ${name} ip=${ip} mounts=${mounts.length}`);
}

export function destroySandbox(userId: string): void {
  const name = containerNameFor(userId);
  docker(['rm', '-f', name], 60000);
  registry.removeEntry(userId);
  knownAlive.delete(String(userId));
  // 重建后的新容器同名: 清掉 tmux 引导缓存, 下次 prepareSpawn 重新预建容器内 hub session
  try { (require('./exec-router') as typeof import('./exec-router')).forgetContainerGuidance(name); } catch { /* best-effort */ }
  // 会话配置随容器生灭 (2026-10-13: 配置只在启动会话瞬间复制到 per-user temp 的 sbx-session/ 下)
  try {
    const fsx = require('fs');
    fsx.rmSync(path.join(ensureTempRoot(String(userId)), 'sbx-session'), { recursive: true, force: true });
  } catch { /* best-effort */ }
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

// ── 心跳制生命周期 (2026-10-13 方案 A) ──────────────────────────────────────
// 判据只有一个: registry.lastActiveAt = 该用户最后一个带 JWT 的鉴权请求时刻;
// 超过 SBX_IDLE_DESTROY_MS(3h) 无心跳即销毁, 容器内 agent 是否仍在运行不构成豁免.

// 已建容器的内存快查 (auth 心跳是热路径, 不每请求 docker inspect).
const knownAlive = new Set<string>();
export function isContainerProvisioned(userId: string): boolean {
  return knownAlive.has(String(userId));
}

function reapIdleSandboxes(): void {
  for (const entry of registry.allEntries()) {
    if (!containerAlive(entry.user)) { registry.removeEntry(entry.user); knownAlive.delete(entry.user); continue; }
    if (!isolationActiveFor(entry.user)) continue; // 模式切回/降为 admin: 不动, 交 admin 面
    const lastSeen = entry.lastActiveAt || entry.createdAt;
    if (Date.now() - lastSeen > SBX_IDLE_DESTROY_MS) {
      console.log(`[user-isolation] ${Math.round((Date.now() - lastSeen) / 60000)}min 无鉴权请求, 删除容器 ${entry.containerName}`);
      destroySandbox(entry.user);
    }
  }
}

// 定时器: 60s 一轮 = reconcile 收编 (registry 自愈, docker ps 里未登记的容器补条目)
// + 心跳超时扫描 (3h 无鉴权请求销毁). 收编必须持续跑: registry 只是缓存, 只在启动时
// 收编一次的话, 一次写丢失就会让窗口列表/端口寻址长期残废.
let timerStarted = false;
export function startBackgroundTimers(): void {
  if (timerStarted) return;
  timerStarted = true;
  setInterval(() => { try { reconcileSandboxes(); } catch { /* 单轮失败不影响下轮 */ } }, 60_000).unref();
}

// 后端重启 reconcile: docker ps 按 label 收编存量容器 (registry 缺条目则重建条目).
export function reconcileSandboxes(): void {
  if (!isDockerIsolation()) return;
  const r = docker(['ps', '--filter', `label=mobius.sandbox.user`, '--format', '{{.Names}}\t{{.ID}}\t{{.Label "mobius.sandbox.user"}}']);
  if (r.status !== 0) return;
  for (const line of r.stdout.split('\n')) {
    const [name, , userId] = line.trim().split('\t');
    if (!name || !userId) continue;
    if (!registry.getEntry(userId)) {
      adoptEntry(userId);
      console.log(`[user-isolation] reconcile 收编 ${name}`);
    }
  }
  reapIdleSandboxes();
}
