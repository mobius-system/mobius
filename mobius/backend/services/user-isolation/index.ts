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
export { runSelfCheck, selfCheckResult, selfCheckGate } from './selfcheck';

import { db } from '../../../db';
import { isDockerIsolation } from './config';
import { selfCheckGate } from './selfcheck';
import { landlockAvailable } from '../agent-sandbox';
import { resolveWindowContainer } from './exec-router';

// 窗口名自动路由接线: tmux() 的窗口级调用按归属表进沙箱容器 (零调用点改动).
// 放在模块体: index.ts 在主链路 (session-message-runner) 必被加载, 接线先于任何 agent spawn.
const tmuxOpLog = require('../../agents/tmux-operation-log');
tmuxOpLog.setWindowRouteResolver((args: string[]) => {
  try { return resolveWindowContainer(args); } catch { return null; }
});

// ── 临时措施 (2026-10-13, 用户决策) ──────────────────────────────────────────
// 暂时屏蔽普通用户对小莫的全部访问 (登录 / 后端接口 / Agent / 前端入口).
// 起因: 原生文件编辑器存在已实证的越权读取 — 普通用户可经拓展项目 (bind_path = APP_DIR)
//   GET /api/projects/ext_<name>/file?path=/.env 读到部署根目录的 .env (含 JWT_SECRET /
//   GITHUB_TOKEN_DESKTOP 等密钥), 并可列 / 整个部署根. 正式修复上线前先整体切断普通用户入口.
// 恢复办法: 把 NORMAL_USER_ACCESS_BLOCKED 改回 false 并重新部署 (python3 start.py).
export const NORMAL_USER_ACCESS_BLOCKED = true;

// 该用户此刻是否被临时封禁 (admin 永不受影响).
export function normalUserAccessBlockedFor(user: any): boolean {
  return NORMAL_USER_ACCESS_BLOCKED && !!user && user.role !== 'admin';
}

// 登录/发消息闸门 (替代 agent-sandbox.assertUserSandboxAvailable 的调用点语义):
// admin 恒通; landlock 模式 = 原判定; docker 模式 = docker 自检.
export function assertUserIsolationAvailable(user: any): void {
  if (user?.role === 'admin') return;
  if (normalUserAccessBlockedFor(user)) {
    const e = new Error('普通用户访问已暂时关闭，请稍后再试') as Error & { status?: number; code?: string };
    e.status = 503;
    e.code = 'NORMAL_USER_ACCESS_DISABLED';
    throw e;
  }
  if (isDockerIsolation()) {
    if (!selfCheckGate()) {
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
  if (isDockerIsolation()) return selfCheckGate();
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

// code-server (VSCode Web) 可用性 (2026-10-13 用户决策):
//   - admin 恒可用.
//   - docker 模式: 普通用户的 code-server 跑在沙箱容器内 (隔离边界内), 可用.
//   - landlock 模式: 普通用户的 code-server 直接跑在宿主机上, 不套 landlock 策略 = 逃逸面,
//     故禁止一切访问 (HTTP + WS 反代层统一 403). 前端把「代码 / 在 VSCode 中打开」改为激活
//     原生文件编辑器 (文件访问走 file-access 的鉴权 + 隔离).
export function codeServerAllowedFor(user: any): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return isDockerIsolation();
}

// 后端启动钩子: reconcile + 定时器 (server 启动时调用一次).
export function onBackendStart(): void {
  if (!isDockerIsolation()) return;
  const { reconcileSandboxes, startBackgroundTimers } = require('./docker-sandbox');
  try { reconcileSandboxes(); } catch (e) { console.warn(`[user-isolation] reconcile 失败: ${(e as Error).message}`); }
  startBackgroundTimers();
  // 自检预热 (四步: daemon/镜像/挂卷/端口), 结果缓存供闸门与「容器管理」面板
  const { runSelfCheck } = require('./selfcheck');
  runSelfCheck().catch((e: Error) => console.warn(`[user-isolation] 自检失败: ${e.message}`));
}
