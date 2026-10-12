/**
 * session-status-refresher.ts — 只刷新「热点会话」的 agent_status 快查字段.
 *
 * 背景: sessions_v2.agent_status 是全网读侧栏/概览页共用的快查字段, 但原先只有
 * agent-status-syncer 每 60s 扫全表 (实测 2664 行 / 约 1.3s 阻塞) 在维护它, 于是侧栏
 * 非当前会话的状态点最坏要 ~70s 才追上一次.
 *
 * 关键观察: 真正会变的只有极少数行. 实测全表 active=2664, 而「近 15 分钟有活动」
 * 并上「当前 alive」只有 5~15 行 —— 相差两个数量级. 所以本模块每个周期只重算这一小撮,
 * 全表扫描留给 syncer 做兜底.
 *
 * 热点 = (近 HOT_WINDOW 分钟内有活动) ∪ (当前 agent_status 为 running/waiting).
 * 用「活动」而不是固定名单定义热点, 所以**新出现的会话 (last_active 立刻变新) 与
 * 刚断掉的会话 (仍在 alive 集合) 都会在下一个周期被捕获**, 不需要任何登记协议.
 *
 * 读取方 (侧栏列表接口) 只读快查字段, 探测完全不落在 HTTP 请求路径上 —— 那条路径与
 * spawnSync 的 tmux 抓屏共用事件循环, 放进去会把请求排队 (实测 limit=1 最慢 1.8s).
 */

import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../db';
import { BACKEND_WORKER_LOG_DIR } from '../config';
import { refreshStoredStatus } from './session-live-status';

const REFRESH_INTERVAL_MS = 2000;    // 热点集刷新周期
const FIRST_RUN_DELAY_MS = 15 * 1000; // 启动先等 backend runtime 恢复 (与 syncer 同源)
const HOT_WINDOW_MINUTES = 15;       // 近 N 分钟有活动即视为热点
const MAX_HOT_ROWS = 300;            // 安全阀: 极端情况下也不让单周期无限膨胀
// 单周期时间预算: 超出就停下, 剩下的下一周期再probe, 避免探测挤占事件循环.
// 未跑完的行不会丢 —— 它们是热点集里最冷的一批, 60s 全表兜底会捡起来.
// Per-cycle budget: stop early so probing never monopolises the event loop; the rows left over
// are the coldest in the hot set and the 60s full sweep picks them up.
const CYCLE_BUDGET_MS = 600;

const LOG_DIR = BACKEND_WORKER_LOG_DIR;
const LOG_FILE = path.join(LOG_DIR, 'session_status_refresher.log');

let timer: NodeJS.Timeout | null = null;
let refreshing = false;  // 互斥: 上一轮未结束则跳过本轮, 避免探测重叠挤压事件循环
let skippedCycles = 0;

interface HotRow {
  session_id: string;
  model: string | null;
  agent_status: string;
  bind_path: string | null;
}

function appendLog(text: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    // ⭐ 真正落盘的动作; 前一行 mkdirSync 只是为它扫清目录障碍.
    fs.appendFileSync(LOG_FILE, text);
  } catch (e) {
    console.warn(`[session-status-refresher] 写日志失败: ${(e as Error).message}`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/*
 * The hot set: sessions that could plausibly change state right now.
 * last_active is stored as ISO ("2026-10-12T07:59:58.287Z"), so the cutoff must be built to
 * that exact shape — comparing it against datetime() (space-separated) would string-compare
 * 'T' > ' ' and match every row of the same day.
 */
function loadHotSessions(): HotRow[] {
  const cutoff = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now',?) AS t")
    .get(`-${HOT_WINDOW_MINUTES} minutes`) as { t: string };
  // ⭐ 前面的 cutoff 拼接只为喂这次查询; 耗时全在它和下游的逐行探测上.
  return db.prepare(`
    SELECT s.session_id, s.model, s.agent_status, p.bind_path AS bind_path
    FROM sessions_v2 s
    LEFT JOIN projects p ON s.project_id = p.id
    WHERE s.status = 'active'
      AND (s.last_active > ? OR s.agent_status IN ('running','waiting'))
    ORDER BY s.last_active DESC
    LIMIT ?
  `).all(cutoff.t, MAX_HOT_ROWS) as HotRow[];
}

// refreshOnce: 一个周期 — 查出热点名单, 逐行问真相源, 变了才写快查字段.
async function refreshOnce(): Promise<void> {
  if (refreshing) {
    skippedCycles++;
    return;
  }
  refreshing = true;
  const startedAt = Date.now();
  try {
    const rows = loadHotSessions();
    let changed = 0;
    let probed = 0;
    for (const row of rows) {
      if (Date.now() - startedAt > CYCLE_BUDGET_MS) break;
      probed++;
      const bindPath = row.bind_path ? path.resolve(row.bind_path) : null;
      const next = refreshStoredStatus(row, bindPath);
      if (next && next !== row.agent_status) {
        changed++;
        appendLog(`[${nowIso()}] sid=${row.session_id} ${row.agent_status} -> ${next}\n`);
      }
    }
    // 只在「有变化」或「本周期明显超时」时留痕, 否则 2s 一行的日志很快就没用了.
    // Log only on change or on a badly overrun cycle, otherwise a line every 2s is pure noise.
    const durMs = Date.now() - startedAt;
    const overBudget = probed < rows.length;
    if (changed > 0 || durMs > REFRESH_INTERVAL_MS || overBudget) {
      appendLog(
        `[${nowIso()}] refresh hot=${rows.length} probed=${probed} changed=${changed} cost=${durMs}ms` +
        (overBudget ? ' (budget-cut)' : '') + (skippedCycles ? ` skipped=${skippedCycles}` : '') + '\n'
      );
      skippedCycles = 0;
    }
  } catch (e) {
    appendLog(`[${nowIso()}] (error) 刷新异常: ${(e as Error).stack || e}\n`);
  } finally {
    refreshing = false;
  }
}

// 启动热点刷新循环. 幂等: 重复调用只保留一个 timer.
function startSessionStatusRefresher(): NodeJS.Timeout | null {
  if (timer) return timer;
  appendLog(
    `\n[${nowIso()}] ===== session-status-refresher 启动 (interval=${REFRESH_INTERVAL_MS}ms, ` +
    `hot_window=${HOT_WINDOW_MINUTES}min, max_hot=${MAX_HOT_ROWS}, first_run_in=${FIRST_RUN_DELAY_MS}ms) =====\n` +
    `[${nowIso()}] log_file=${LOG_FILE}\n`
  );
  // 两层定时器都 unref: 避免阻止 Node 优雅退出 (与 agent-status-syncer 一致)。
  setTimeout(() => {
    // ⭐ 整个文件的"心跳": 启动横幅与延迟等待全为建立这条 2s 周期.
    timer = setInterval(() => {
      refreshOnce().catch((e) => appendLog(`[${nowIso()}] (error) refreshOnce 异常: ${(e as Error).stack || e}\n`));
    }, REFRESH_INTERVAL_MS);
    timer.unref();
    refreshOnce().catch(() => {});
  }, FIRST_RUN_DELAY_MS).unref();
  console.log(
    `[session-status-refresher] 已启动, 热点集每 ${REFRESH_INTERVAL_MS / 1000}s 刷新 -> ${LOG_FILE}`
  );
  return timer;
}

export { startSessionStatusRefresher, refreshOnce, loadHotSessions, LOG_FILE };
