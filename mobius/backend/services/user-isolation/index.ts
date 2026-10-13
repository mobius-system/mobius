/**
 * user-isolation/index.ts — 用户隔离的统一出口 (老文件只 import 这里).
 *
 * landlock 模式: 一切分派落到现有 agent-sandbox 行为, 零变化.
 * docker 模式: 普通用户的一切执行面进 mobius-sbx-<userId> 沙箱容器.
 */
export { USER_ISOLATION_METHOD, USER_ISOLATION_DOCKER_IMAGE, isDockerIsolation, dockerSandboxAvailable } from './config';
export {
  isolationActiveFor, ensureSandbox, rebuildNow, destroySandbox,
  reconcileSandboxes, startBackgroundTimers,
} from './docker-sandbox';
export {
  prepareSpawn, resolveWindowContainer, setWindowOwner, clearWindowOwner, containerForWindow,
  listWindowsRowsFromSandboxes, claudeHomeFor, codexHomeFor,
  rewriteHostPath, rewriteEnvUrls, rewriteAimuxBin, spawnHarnessChild, materializeSettingsForSbx,
} from './exec-router';
export { dockerCodeServerActive, ensureDocker, killDocker, proxyTargetHost, listDocker } from './code-server';
export { bridgeRoutedFor, ensureBroker, bridgeTargetFor } from './bridge';
export * as sandboxRegistry from './registry';

import { db } from '../../../db';
import { isDockerIsolation, dockerSandboxAvailable } from './config';
import { landlockAvailable } from '../agent-sandbox';
import { resolveWindowContainer } from './exec-router';

// 窗口名自动路由接线: tmux() 的窗口级调用按归属表进沙箱容器 (零调用点改动).
// 放在模块体: index.ts 在主链路 (session-message-runner) 必被加载, 接线先于任何 agent spawn.
const tmuxOpLog = require('../../agents/tmux-operation-log');
tmuxOpLog.setWindowRouteResolver((args: string[]) => {
  try { return resolveWindowContainer(args); } catch { return null; }
});

// 登录/发消息闸门 (替代 agent-sandbox.assertUserSandboxAvailable 的调用点语义):
// admin 恒通; landlock 模式 = 原判定; docker 模式 = docker 自检.
export function assertUserIsolationAvailable(user: any): void {
  if (user?.role === 'admin') return;
  if (isDockerIsolation()) {
    if (!dockerSandboxAvailable()) {
      const e = new Error('当前服务器 docker 沙箱不可用，普通用户暂时不能登录或使用 Agent') as Error & { status?: number };
      e.status = 503;
      throw e;
    }
    return;
  }
  if (!landlockAvailable()) {
    const e = new Error('当前服务器不支持普通用户 Agent 沙盒，普通用户暂时不能登录或使用 Agent') as Error & { status?: number };
    e.status = 503;
    throw e;
  }
}

// 建号/改号闸门 (admin.ts 三处 landlockAvailable() 的等价替代): 能否创建普通用户.
export function isolationAllowsNormalUsers(): boolean {
  if (isDockerIsolation()) return dockerSandboxAvailable();
  return landlockAvailable();
}

// sandboxPolicy 生成分派: docker 模式不生成 landlock 策略 (容器即边界), 改确保容器在.
export function sandboxPolicyFor(user: any, opts: { userId: string; projectId?: string | null; workDir: string }): string | null {
  if (user?.role === 'admin') return null;
  if (isDockerIsolation()) return null; // 容器边界; ensureSandbox 由 spawn 层 prepareSpawn 触发
  const { writeSandboxPolicy } = require('../agent-sandbox');
  return writeSandboxPolicy(opts);
}

// web 终端可用性: 仅 admin. 普通用户在任何隔离模式下都禁用 (2026-10-13 用户决策).
//   - landlock 模式: web 终端直接 spawn 宿主原始 shell, 不套 landlock 策略 = 越权逃逸隔离,
//     故普通用户必须拒绝 (此前 landlock 模式默认放行, 是本轮收紧点).
//   - docker 模式: 普通用户改用容器内 code-server 自带终端, 本来已禁用.
export function webTerminalAllowedFor(user: any): boolean {
  return user?.role === 'admin';
}

// 后端启动钩子: reconcile + 定时器 (server 启动时调用一次).
export function onBackendStart(): void {
  if (!isDockerIsolation()) return;
  const { reconcileSandboxes, startBackgroundTimers } = require('./docker-sandbox');
  try { reconcileSandboxes(); } catch (e) { console.warn(`[user-isolation] reconcile 失败: ${(e as Error).message}`); }
  startBackgroundTimers();
}
