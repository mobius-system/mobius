/**
 * session-live-status.ts — 侧栏列表的实时状态叠加层.
 *
 * 背景: sessions_v2.agent_status 由 agent-status-syncer 每 60s 才重算一次, 而侧栏列表接口
 * 原先只读这个库值, 于是非当前会话的状态点最坏要 ~60s(后台重算) + 10s(前端轮询) 才追上.
 *
 * 做法: 在列表接口内只对「本次要返回给用户的这几行」按需重算, 并用进程内 2s TTL 缓存去重
 * 同一会话的并发请求. 迟滞因此降到前端轮询间隔本身, 成本也只与可见行数成正比, 不再依赖全表扫描.
 * 判定逻辑仍复用 utils/session-runtime-status.ts, 与 /status 接口、agent-status-syncer 同源.
 */

import {
  computeSessionRuntimeStatus,
  runtimeStatusToAgentStatus,
  syncAgentStatusIfChanged,
  type RuntimeStatus,
} from '../utils/session-runtime-status';

// 2s TTL: 一屏轮询间隔量级, 足够让同一会话被多行/多用户请求时只算一次, 又不至于让人眼感知到陈旧.
// 2s TTL: one screen-poll apart — dedupes repeated probes without a perceivable staleness.
const LIVE_STATUS_TTL_MS = 2000;

// 超过这个规模就顺手清理过期项, 避免长跑累积 (每会话一条).
// Prune expired entries past this size so a long-lived process cannot grow unbounded.
const CACHE_PRUNE_THRESHOLD = 4096;

const cache = new Map<string, { at: number; runtime: RuntimeStatus }>();

function pruneExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.at > LIVE_STATUS_TTL_MS) cache.delete(key);
  }
}

/**
 * Live runtime status for one session, probed from the backend (not read off the DB column).
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
  if (hit && now - hit.at <= LIVE_STATUS_TTL_MS) return hit.runtime;

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
 * Overlay live agent_status onto list rows, writing changes back to sessions_v2 so the stored
 * column stays fresh as a by-product for consumers that still read it.
 */
export function withLiveAgentStatus<T extends { session_id: string; agent_status?: string }>(
  rows: T[],
  bindPathOf: (row: T) => string | null,
): T[] {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    const runtime = probeLiveStatus(row, bindPathOf(row));
    if (!runtime) return row;
    try {
      // 顺带回写库值, 让读 DB 的其它消费方 (概览页等) 也吃到新鲜状态.
      // Write the value back too, so other DB readers (overview pages) benefit as well.
      syncAgentStatusIfChanged(row.session_id, row.agent_status, runtime);
    } catch {}
    return { ...row, agent_status: runtimeStatusToAgentStatus(runtime) };
  });
}
