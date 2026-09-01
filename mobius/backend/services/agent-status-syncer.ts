/**
 * agent-status-syncer.ts:
 * 处理 sessions_v2.agent_status 的赋值
 *
 * 分级扫描 (降低计算量):
 *   - 活跃集 (idle/running/waiting/completed): 每 60s 扫一遍 — 可能随时变化
 *       (completed 也在此集: 用户可能重新发消息把它激活回 running, 需快速恢复)
 *   - 终态集 (failed/stale): 每 3600s 扫一遍 — 终态稳定, 且通常需人工介入才恢复
 *   - 启动首次全扫 (含终态集) 一次建立基准
 *
 * 复用: 判定逻辑来自 backend/utils/session-runtime-status.ts, 与 /status 接口共用,
 *       改判定逻辑只需改那一处.
 */

import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../db';
import { BACKEND_WORKER_LOG_DIR } from '../config';
import {
  computeSessionRuntimeStatus,
  syncAgentStatusIfChanged,
} from '../utils/session-runtime-status';

const SCAN_INTERVAL_MS = 60 * 1000;          // 活跃集扫描间隔

const TERMINAL_SCAN_TICKS = 60;              // 终态集: 每 60 个 tick (= 3600s) 扫一次
const FIRST_RUN_DELAY_MS = 20 * 1000;        // 启动先等 backend runtime 恢复

// 活跃集: 可能随时变化的状态. completed 也在此 (重新发消息会激活).
const ACTIVE_STATUSES = ['idle', 'running', 'waiting', 'completed'];

// 终态集: 稳定态, 低频扫. failed/stale 通常需人工介入.
const TERMINAL_STATUSES = ['failed', 'stale'];

const LOG_DIR = BACKEND_WORKER_LOG_DIR;
const LOG_FILE = path.join(LOG_DIR, 'agent_status_syncer.log');

let timer: NodeJS.Timeout | null = null;
let scanning = false;   // 互斥: 上一轮未结束则跳过本轮, 避免重叠写库
let tick = 0;

function nowIso(): string {
  return new Date().toISOString();
}

function appendLog(text: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // ⭐ 真正落盘的动作; 前一行 mkdirSync 只是为它扫清目录障碍.
    fs.appendFileSync(LOG_FILE, text);
  } catch (e) {
    console.warn(`[agent-status-syncer] 写日志失败: ${(e as Error).message}`);
  }
}

interface SessionRow {
  session_id: string;
  model: string | null;
  agent_status: string;
  bind_path: string | null;
}

function loadSessions(statuses: string[]): SessionRow[] {
  const placeholders = statuses.map(() => '?').join(',');
  // ⭐ 前面的 placeholders 拼接只为喂这次查询; 耗时全在此.
  return db.prepare(`
    SELECT s.session_id, s.model, s.agent_status, p.bind_path AS bind_path
    FROM sessions_v2 s
    LEFT JOIN projects p ON s.project_id = p.id
    WHERE s.status = 'active' AND s.agent_status IN (${placeholders})
  `).all(...statuses) as SessionRow[];
}

// syncBatch: 给一批会话, 挨个查状态、写回数据库; 谁给的、为什么给, 不管. 写回 sessions_v2.agent_status 的逻辑统一在 syncAgentStatusIfChanged (util),
// 与 /status 接口共用, 这里只调用它. 单 session 故障不拖垮整批.
async function syncBatch(batch: SessionRow[], batchLabel: string): Promise<{ checked: number; changed: number }> {
  let checked = 0;
  let changed = 0;
  for (const session of batch) {
    checked++;
    try {
      const bindPath = session.bind_path ? path.resolve(session.bind_path) : null;
      // ⭐ syncer 最贵的一步 (tmux 探测/jsonl 尾读/flag I/O); bindPath 解析只为喂它.
      const runtime = computeSessionRuntimeStatus( { session_id: session.session_id, model: session.model }, bindPath );
      // ⭐ 把上面的判定写回 agent_status; 没有它探测白做.
      const { changed: didChange, next } = syncAgentStatusIfChanged(session.session_id, session.agent_status, runtime);
      if (didChange) {
        changed++;
        appendLog(
          `[${nowIso()}] ${batchLabel} sid=${session.session_id} ${session.agent_status} -> ${next} ` +
          `(alive=${runtime.alive} working=${runtime.working} accomplished=${runtime.jobAccomplished} failed=${runtime.failed})\n`
        );
      }
    } catch (e) {
      appendLog(`[${nowIso()}] ${batchLabel} sid=${session.session_id} 计算失败: ${(e as Error).message}\n`);
    }
  }
  return { checked, changed };
}

// scanOnce: 定时器每分钟触发的一轮 — 先查出"这轮该查哪些会话"的名单, 再交给 syncBatch 去干.
async function scanOnce(opts: { includeTerminal: boolean }): Promise<void> {
  if (scanning) {
    appendLog(`[${nowIso()}] (skip) 上一轮同步尚未结束, 跳过本轮\n`);
    return;
  }
  scanning = true;
  const startedAt = Date.now();
  try {
    // ⭐ 真正干活的地方; 守卫与耗时日志都是外围.
    const active = await syncBatch(loadSessions(ACTIVE_STATUSES), 'active');
    let terminal = { checked: 0, changed: 0 };
    if (opts.includeTerminal) {
      terminal = await syncBatch(loadSessions(TERMINAL_STATUSES), 'terminal');
    }
    const durMs = Date.now() - startedAt;
    appendLog(
      `[${nowIso()}] sync done tick=${tick} terminal=${opts.includeTerminal} ` +
      `active(checked=${active.checked} changed=${active.changed}) ` +
      `terminal(checked=${terminal.checked} changed=${terminal.changed}) cost=${durMs}ms\n`
    );
  } catch (e) {
    appendLog(`[${nowIso()}] (error) 同步异常: ${(e as Error).stack || e}\n`);
  } finally {
    scanning = false;
  }
}

// 启动巡检. 幂等: 重复调用只保留一个 timer.
function startAgentStatusSyncer(): NodeJS.Timeout | null {
  if (timer) return timer;
  appendLog(
    `\n[${nowIso()}] ===== agent-status-syncer 启动 ` +
    `(active_interval=${SCAN_INTERVAL_MS}ms, terminal_every=${TERMINAL_SCAN_TICKS}ticks=${(TERMINAL_SCAN_TICKS * SCAN_INTERVAL_MS) / 1000}s, ` +
    `first_run_in=${FIRST_RUN_DELAY_MS}ms) =====\n` +
    `[${nowIso()}] log_file=${LOG_FILE}\n`
  );
  const safeScan = () => {
    tick++;
    const includeTerminal = (tick % TERMINAL_SCAN_TICKS === 0);
    Promise.resolve()
      .then(() => scanOnce({ includeTerminal }))
      .catch((e) => appendLog(`[${nowIso()}] (error) scanOnce 异常: ${(e as Error).stack || e}\n`));
  };
  // 两层定时器都 unref: 避免阻止 Node 优雅退出 (与 code-server-pool / extension-scheduler 一致)。
  setTimeout(() => {
    // 首次全扫 (含终态集) 建立基准, 之后按 60s 周期 + 终态集每 60 tick.
    scanOnce({ includeTerminal: true }).catch(
      (e) => appendLog(`[${nowIso()}] (error) 首次全扫异常: ${(e as Error).stack || e}\n`)
    );
    // ⭐ 整个文件的"心跳": 启动横幅/首次全扫/延迟等待全为建立这条 60s 周期.
    timer = setInterval(safeScan, SCAN_INTERVAL_MS);
    timer.unref();
  }, FIRST_RUN_DELAY_MS).unref();
  console.log(
    `[agent-status-syncer] 已启动, 活跃集每 ${SCAN_INTERVAL_MS / 1000}s / 终态集每 ${(TERMINAL_SCAN_TICKS * SCAN_INTERVAL_MS) / 1000}s -> ${LOG_FILE}`
  );
  return timer;
}

export { startAgentStatusSyncer, scanOnce, LOG_FILE };
