/**
 * user-isolation/config.ts — 用户隔离模式的配置读取与常量.
 *
 * USER_ISOLATION_METHOD=landlock (默认, 现状零变化) | docker (用户沙箱容器).
 * USER_ISOLATION_DOCKER_IMAGE: docker 模式必填的沙箱镜像 tag, 留空 = 自检 fail-closed.
 *
 * 三道闸: boot_utils.py RUNTIME_SETTINGS + ecosystem.config.js envKeys + 本目录消费
 * (backend/config.js 同步 re-export 供 CommonJS 侧使用).
 */
import { spawnSync } from 'child_process';

export const USER_ISOLATION_METHOD = String(process.env.USER_ISOLATION_METHOD || 'landlock').trim();
if (!['landlock', 'docker'].includes(USER_ISOLATION_METHOD)) {
  throw new Error(`USER_ISOLATION_METHOD 非法: ${USER_ISOLATION_METHOD} (仅支持 landlock|docker)`);
}

export const USER_ISOLATION_DOCKER_IMAGE = String(process.env.USER_ISOLATION_DOCKER_IMAGE || '').trim();

export function isDockerIsolation(): boolean {
  return USER_ISOLATION_METHOD === 'docker';
}

// ── 沙箱容器规格常量 (2026-10-13 用户拍板: 2g / 4 cpu) ────────────────────────
export const SBX_NETWORK = 'mobius-sbx-net';
export const SBX_SUBNET = '172.28.0.0/24';
export const SBX_GATEWAY_IP = '172.28.0.1';     // 容器回连宿主服务 (token-proxy) 的固定地址
export const SBX_IP_BASE = '172.28.0';            // 172.28.0.<n>, n ∈ [2, 254]
export const SBX_IP_FIRST = 2;
export const SBX_IP_LAST = 254;
export const SBX_MEMORY = '2g';
export const SBX_CPUS = '4';
export const SBX_PIDS_LIMIT = 512;
// 心跳制生命周期 (2026-10-13 用户拍板方案 A): 任意带 JWT 的鉴权请求 = 心跳,
// 超过该时长无心跳即销毁容器 (纯时长判据, 不看 agent 是否仍在运行).
export const SBX_IDLE_DESTROY_MS = 3 * 60 * 60 * 1000;

// 容器 HOME 落在本人 work_dir 内 (数据保留边界 = 工作路径 + 一切 --volume, 2026-10-13 用户规则).
export const SBX_HOME_DIRNAME = '.sbx-home';

// 容器内常量路径 (镜像构建保证): aimux CLI 与 node22 的安装位置.
export const SBX_AIMUX_BIN = '/usr/local/bin/aimux';
export const SBX_NODE22 = '/usr/local/node22/bin/node';

// 沙箱网络与镜像可用性自检 (fail-closed, 结果缓存).
let dockerAvailable: boolean | null = null;
export function dockerSandboxAvailable(): boolean {
  if (!isDockerIsolation()) return false;
  if (dockerAvailable !== null) return dockerAvailable;
  if (!USER_ISOLATION_DOCKER_IMAGE) {
    console.warn('[user-isolation] USER_ISOLATION_DOCKER_IMAGE 未配置, docker 隔离不可用');
    return (dockerAvailable = false);
  }
  const info = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 15000 });
  if (info.status !== 0) {
    console.warn(`[user-isolation] docker daemon 不可达: ${(info.stderr || info.error?.message || '').trim()}`);
    return (dockerAvailable = false);
  }
  const img = spawnSync('docker', ['image', 'inspect', USER_ISOLATION_DOCKER_IMAGE, '--format', '{{.Id}}'], { encoding: 'utf8', timeout: 15000 });
  if (img.status !== 0) {
    console.warn(`[user-isolation] 沙箱镜像不存在: ${USER_ISOLATION_DOCKER_IMAGE}`);
    return (dockerAvailable = false);
  }
  return (dockerAvailable = true);
}

export function sandboxImageRef(): string {
  return USER_ISOLATION_DOCKER_IMAGE;
}

// 容器名: userId 消毒 (同 file-access.tempRootFor 的字符白名单口径).
export function containerNameFor(userId: string): string {
  const uid = String(userId || '').replace(/[^A-Za-z0-9_.@-]/g, '_') || 'anonymous';
  return `mobius-sbx-${uid}`;
}
