/**
 * user-isolation/index.ts — 用户隔离的统一出口 (老文件只 import 这里).
 *
 * landlock 模式: 一切分派落到现有 agent-sandbox 行为, 零变化.
 * docker 模式: 普通用户的一切执行面进 mobius-sbx-<userId> 沙箱容器.
 */
export { USER_ISOLATION_METHOD, USER_ISOLATION_DOCKER_IMAGE, isDockerIsolation, dockerSandboxAvailable, SBX_GATEWAY_IP } from './config';
export {
  isolationActiveFor, ensureSandbox, rebuildNow, destroySandbox,
  reconcileSandboxes, startBackgroundTimers, refreshSbxHomeInputs,
} from './docker-sandbox';
export {
  prepareSpawn, resolveWindowContainer, setWindowOwner, clearWindowOwner, containerForWindow,
  listWindowsRowsFromSandboxes, listWindowsRowsForStatus, claudeHomeFor, codexHomeFor,
  rewriteHostPath, rewriteEnvUrls, rewriteAimuxBin, spawnHarnessChild, materializeSettingsForSbx,
  sessionConfigDir, removeSessionConfigs,
} from './exec-router';
export { dockerCodeServerActive, ensureDocker, killDocker, proxyTargetHost, listDocker } from './code-server';
export { bridgeRoutedFor, ensureBroker, bridgeTargetFor } from './bridge';
export * as sandboxRegistry from './registry';
export { runSelfCheck, selfCheckResult, selfCheckGate } from './selfcheck';

import { db } from '../../../db';
import { isDockerIsolation } from './config';
import { selfCheckGate } from './selfcheck';
import { isolationActiveFor } from './docker-sandbox';
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

// 小莫助理 (「小莫光点」浮动入口) 可用性 —— 临时措施 (2026-10-13 用户要求):
// 关闭期间普通用户对小莫的一切访问被拒 (server.js 在 /api/assistant 挂闸门, 403),
// 前端入口同步隐藏 (frontend/src/services/assistant-availability.ts 同名常量).
// 管理员不受影响. 恢复: 把下面常量改为 false, 改完 python3 start.py --detach 重载.
export const ASSISTANT_NORMAL_USER_BLOCKED = true;

export function assistantAllowedFor(user: any): boolean {
  if (!ASSISTANT_NORMAL_USER_BLOCKED) return true;
  return user?.role === 'admin';
}

// ── 心跳制生命周期入口 (auth 中间件每个带 JWT 的请求调用) ─────────────────
// 语义 (2026-10-13 方案 A): 任意鉴权请求 = 心跳; 容器不在则创建 (异步, 不拖慢请求);
// 超过 SBX_IDLE_DESTROY_MS(3h) 无心跳由定时器销毁, 容器内 agent 是否在跑不构成豁免.
const hbInFlight = new Set<string>();
const HB_PERSIST_MS = 30_000; // registry 落盘节流

export function onAuthedRequest(user: any): void {
  try {
    const userId = String(user?.id || '');
    if (!userId) return;
    if (!isolationActiveFor(userId)) return;
    const { ensureSandbox, isContainerProvisioned } = require('./docker-sandbox');
    const now = Date.now();
    // lastActiveAt = 最后鉴权请求时刻 (节流落盘; 内存即时)
    const { getEntry, touchEntry } = require('./registry');
    if (now - (getEntry(userId)?.lastActiveAt || 0) > HB_PERSIST_MS) touchEntry(userId);
    else getEntry(userId) && (getEntry(userId)!.lastActiveAt = now); // 内存视图即时, 不等落盘
    // 容器不在 → 异步创建 (去重; agent spawn 路径的 prepareSpawn 仍有同步 ensure 兜底)
    if (!isContainerProvisioned(userId) && !hbInFlight.has(userId)) {
      hbInFlight.add(userId);
      setImmediate(() => {
        try {
          ensureSandbox(userId); // 幂等: 不在则建, 在则 touch + 挂载集比对(权限变更兜底)
        } catch (e) {
          console.warn(`[user-isolation] 心跳建容器失败 (下次请求重试): ${(e as Error).message}`);
        } finally {
          hbInFlight.delete(userId);
        }
      });
    }
  } catch (e) { console.warn(`[user-isolation] 心跳异常: ${(e as Error).message}`); }
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
