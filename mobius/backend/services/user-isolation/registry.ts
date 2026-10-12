/**
 * user-isolation/registry.ts — 沙箱容器登记簿 (§7.2 端口与地址的唯一事实源缓存).
 *
 * 每用户一条: 容器名 / 静态 IP / 镜像 / 挂载集 / 各服务寻址 / 活跃引用.
 * 原子写 JSON (模式沿用 code-server-pool 的 cs-pool-state.json); docker inspect 永远
 * 是最终事实源, 本文件只是缓存 — 冲突时以 inspect 为准并回写.
 */
import fs from 'fs';
import path from 'path';
import { SBX_IP_FIRST, SBX_IP_LAST, SBX_IP_BASE } from './config';

export interface SandboxServices {
  codeServer?: Array<{ projectId: string; port: number; startedAt: number }>;
}

export interface SandboxEntry {
  user: string;
  containerName: string;
  containerId: string;
  ip: string;
  image: string;
  mounts: string[];
  createdAt: number;
  lastActiveAt: number;
  services: SandboxServices;
  refs: { agents: number; codeServer: number; terminals: number; bridgeClients: number };
}

const REGISTRY_DIR = process.env.USER_ISOLATION_REGISTRY_DIR || '/tmp/mobius/sbx-registry';
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'registry.json');

let cache: Map<string, SandboxEntry> | null = null;

function load(): Map<string, SandboxEntry> {
  if (cache) return cache;
  const m = new Map<string, SandboxEntry>();
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    if (raw && typeof raw === 'object') {
      for (const entry of Object.values<any>(raw)) {
        if (entry?.user) m.set(String(entry.user), entry as SandboxEntry);
      }
    }
  } catch { /* 首次或损坏: 空表起步, 由 reconcile 收编 */ }
  return (cache = m);
}

function persist(): void {
  try {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    const obj: Record<string, SandboxEntry> = {};
    for (const [k, v] of load()) obj[k] = v;
    const tmp = `${REGISTRY_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, REGISTRY_FILE);
  } catch (e) {
    console.warn(`[user-isolation/registry] 写入失败: ${(e as Error).message}`);
  }
}

export function getEntry(userId: string): SandboxEntry | undefined {
  return load().get(userId);
}

export function allEntries(): SandboxEntry[] {
  return [...load().values()];
}

export function putEntry(entry: SandboxEntry): void {
  load().set(entry.user, entry);
  persist();
}

export function removeEntry(userId: string): void {
  load().delete(userId);
  persist();
}

// 静态 IP 分配: 取未占用的 172.28.0.<n>, 没有空位抛错 (253 用户上限).
export function allocateIp(): string {
  const used = new Set(allEntries().map((e) => e.ip));
  for (let n = SBX_IP_FIRST; n <= SBX_IP_LAST; n++) {
    const ip = `${SBX_IP_BASE}.${n}`;
    if (!used.has(ip)) return ip;
  }
  throw new Error('user-isolation: 沙箱 IP 池已满 (172.28.0.2-254)');
}

export function recordCodeServer(userId: string, projectId: string, port: number): void {
  const e = getEntry(userId);
  if (!e) return;
  e.services.codeServer = (e.services.codeServer || []).filter((s) => s.projectId !== projectId);
  e.services.codeServer.push({ projectId, port, startedAt: Date.now() });
  e.lastActiveAt = Date.now();
  putEntry(e);
}

export function dropCodeServer(userId: string, projectId: string): void {
  const e = getEntry(userId);
  if (!e?.services.codeServer) return;
  e.services.codeServer = e.services.codeServer.filter((s) => s.projectId !== projectId);
  putEntry(e);
}

export function touchEntry(userId: string): void {
  const e = getEntry(userId);
  if (e) { e.lastActiveAt = Date.now(); putEntry(e); }
}
