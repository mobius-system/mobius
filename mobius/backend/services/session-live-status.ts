/**
 * session-live-status.ts — 会话实时状态的探测封装 (真相源访问层).
 *
 * sessions_v2.agent_status 只是真相源的一张快照 (快查字段); 真相源本身是
 * computeSessionRuntimeStatus 的实时探测 (tmux 窗口 + transcript 尾读 + flag 文件).
 *
 * 本模块只负责"怎样问真相源", 并叠一层 2s 进程内 TTL 缓存去重同一会话的并发探测.
 * "什么时候问" 由 session-status-refresher.ts (热点集刷新) 与 agent-status-syncer.ts
 * (全表兜底) 决定 —— 探测刻意不放在 HTTP 请求路径上: 该路径与 spawnSync 的 tmux 抓屏
 * 共用事件循环, 放进去会把请求排在探测后面 (实测 limit=1 的请求最慢要 1.8s).
 */

import {
  computeSessionRuntimeStatus,
  runtimeStatusToAgentStatus,
  syncAgentStatusIfChanged,
  type AgentStatusValue,
  type RuntimeStatus,
} from '../utils/session-runtime-status';

// 2s: 与热点刷新周期同量级, 只用于去重同一会话的并发探测, 不承担时效职责.
// 2s: same order as the hot refresh cycle — dedupes concurrent probes, not a freshness budget.
const PROBE_TTL_MS = 2000;

// 超过这个规模就顺手清理过期项, 避免长跑累积 (每会话一条).
// Prune expired entries past this size so a long-lived process cannot grow unbounded.
const CACHE_PRUNE_THRESHOLD = 4096;

const cache = new Map<string, { at: number; runtime: RuntimeStatus }>();

function pruneExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.at > PROBE_TTL_MS) cache.delete(key);
  }
}

/**
 * Live runtime status for one session, probed from the backend.
 * Returns null when the session is not probeable, so callers keep the stored value untouched.
 */
export function probeLiveStatus(
  session: { session_id: string; model?: string | null },
  bindPath: string | null | undefined,
): RuntimeStatus | null {
  // 无 session_id 无从探测, 让调用方保留原值.
  // Without a session id there is nothing to probe; the caller keeps the stored value.
  if (!session?.session_id) return null;

  const now = Date.now();
  const hit = cache.get(session.session_id);
  if (hit && now - hit.at <= PROBE_TTL_MS) return hit.runtime;

  let runtime: RuntimeStatus;
  try {
    // ⭐ 真正花时间的一步 (tmux 探测 / jsonl 尾读 / flag I/O); 缓存与兜错都围着它转.
    runtime = computeSessionRuntimeStatus(
      { session_id: session.session_id, model: session.model },
      bindPath || null,
    );
  } catch {
    // 探测失败不编造状态: 丢掉缓存项, 调用方继续读库值.
    // A failed probe invents nothing: drop the cache entry and let the caller read the stored value.
    cache.delete(session.session_id);
    return null;
  }

  if (cache.size > CACHE_PRUNE_THRESHOLD) pruneExpired(now);
  cache.set(session.session_id, { at: now, runtime });
  return runtime;
}

/**
 * Probe one session and flush the result into sessions_v2.agent_status when it changed.
 * Returns the status, or null when the probe failed.
 */
export function refreshStoredStatus(
  session: { session_id: string; model?: string | null; agent_status?: string | null },
  bindPath: string | null | undefined,
): AgentStatusValue | null {
  const runtime = probeLiveStatus(session, bindPath);
  if (!runtime) return null;
  try {
    // ⭐ 把探测结果落到快查字段; 其它读库的页面 (概览页等) 因此一同受益.
    // Flush the probe into the fast field so every DB reader benefits too.
    syncAgentStatusIfChanged(session.session_id, session.agent_status, runtime);
  } catch {}
  return runtimeStatusToAgentStatus(runtime);
}
