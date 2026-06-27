/**
 * inactive-tmux-cleaner.js — 自动清理不活跃的 tmux agent window.
 *
 * 范围:
 *   - 只扫描 agent hub 里的 session window, 不动普通 tmux session.
 *   - 同时覆盖 tmux-codex 与 tmux-claude-code.
 *   - `_root` hub 占位 window 永不清理.
 *
 * 不活跃判定:
 *   last_activity = max(tmux window_activity, runtime.startedAt, runtime jsonl mtime,
 *                       sessions_v2.last_active, sessions_v2.last_agent_event,
 *                       messages_v2 最近消息时间)
 *   - running.flag 已删除的完成态 session: 当 now - last_activity >= 10m 时清理.
 *   - 其他 session: 当 now - last_activity >= 3h 时清理.
 *
 * 清理动作:
 *   - 调 backend.terminateSession(sessionId), 复用现有 kill-window / runtime 清理.
 *   - 若 DB 能找到项目 bind_path, 再兜底删除 .imac/flags/<sessionId> 目录.
 *   - DB session 标为 idle 并写一条 system 消息留痕.
 */
const fs = require('fs');
const path = require('path');

const { db } = require('../../db');
const { BACKEND_WORKER_LOG_DIR, DEFAULT_AGENT_BACKEND, MODEL_OPTIONS } = require('../config');
const { Messages } = require('../repositories/messages');
const { flagDirOf, runningFlagPathOf, safeRemoveFlagDir } = require('../utils/session-flags');
const agents = require('../agents');

const DEFAULT_INACTIVE_MS = 3 * 60 * 60 * 1000;
const DEFAULT_COMPLETED_INACTIVE_MS = 10 * 60 * 1000;
const INACTIVE_MS = parseDurationMs(process.env.IMAC_TMUX_AGENT_INACTIVE_MS, DEFAULT_INACTIVE_MS);
const COMPLETED_INACTIVE_MS = parseDurationMs(
  process.env.IMAC_TMUX_AGENT_COMPLETED_INACTIVE_MS,
  DEFAULT_COMPLETED_INACTIVE_MS,
);
const SCAN_INTERVAL_MS = parseDurationMs(process.env.IMAC_TMUX_AGENT_CLEANUP_INTERVAL_MS, 30 * 60 * 1000);
const FIRST_RUN_DELAY_MS = parseDurationMs(process.env.IMAC_TMUX_AGENT_CLEANUP_FIRST_DELAY_MS, 60 * 1000);

const LOG_DIR = BACKEND_WORKER_LOG_DIR;
const LOG_FILE = path.join(LOG_DIR, 'cleanup_inactive_tmux_agents.log');

let timer = null;
let scanning = false;

function parseDurationMs(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function appendLog(text) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, text);
  } catch (e) {
    console.warn(`[inactive-tmux-cleaner] 写日志失败: ${e.message}`);
  }
}

function iso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '(unknown)';
}

function ageText(ageMs) {
  if (!Number.isFinite(ageMs)) return 'unknown';
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  const mins = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}h${String(mins).padStart(2, '0')}m`;
}

function parseDbTime(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const ms = Date.parse(raw.endsWith('Z') ? raw : `${raw}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 10_000_000_000 ? n * 1000 : n;
}

function statMtimeMs(filePath) {
  if (!filePath) return null;
  try {
    const st = fs.statSync(filePath);
    return Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

function source(ms, label) {
  return ms ? { ms, label } : null;
}

function latestActivity(sources) {
  const valid = sources.filter((x) => x && Number.isFinite(x.ms) && x.ms > 0);
  if (!valid.length) return null;
  return valid.reduce((best, cur) => (cur.ms > best.ms ? cur : best), valid[0]);
}

function loadDbSessionsById() {
  const rows = db.prepare(`
    SELECT s.session_id, s.name AS session_name, s.status,
           s.last_active, s.last_agent_event, s.model,
           p.bind_path AS bind_path, p.name AS project_name,
           i.title AS issue_title,
           r.title AS research_title,
           (SELECT MAX(created_at) FROM messages_v2 WHERE task_id = s.session_id) AS last_message_at
    FROM sessions_v2 s
    LEFT JOIN projects p ON s.project_id = p.id
    LEFT JOIN issues i ON s.issue_id = i.id
    LEFT JOIN researches r ON s.research_id = r.id
  `).all();
  return new Map(rows.map((row) => [row.session_id, row]));
}

function backendNames() {
  return Array.from(new Set([
    DEFAULT_AGENT_BACKEND,
    ...Object.values(MODEL_OPTIONS || {}).map((m) => m.backend).filter(Boolean),
  ]));
}

function runtimeEntryFor(backend, sessionId) {
  try {
    if (backend?.runtime?.get) return backend.runtime.get(sessionId) || null;
  } catch {}
  return null;
}

function activityForWindow(backend, windowInfo, dbSession) {
  const runtime = runtimeEntryFor(backend, windowInfo.sessionId);
  const sources = [
    source(normalizeEpochMs(windowInfo.lastActivityMs), 'tmux.window_activity'),
    source(normalizeEpochMs(runtime?.startedAt), 'runtime.startedAt'),
    source(statMtimeMs(runtime?.jsonlPath), 'runtime.jsonl_mtime'),
    source(parseDbTime(dbSession?.last_active), 'db.last_active'),
    source(parseDbTime(dbSession?.last_agent_event), 'db.last_agent_event'),
    source(parseDbTime(dbSession?.last_message_at), 'db.last_message_at'),
  ];
  const latest = latestActivity(sources);
  return {
    latest,
    runtime,
    sources: sources.filter(Boolean),
  };
}

function cleanupFlagDir(sessionId, dbSession, runtime) {
  const roots = new Set();
  if (runtime?.flagRoot) roots.add(runtime.flagRoot);
  if (runtime?.cwd) roots.add(runtime.cwd);
  if (dbSession?.bind_path) roots.add(dbSession.bind_path);
  let removed = false;
  for (const root of roots) {
    if (safeRemoveFlagDir(root, sessionId, 'inactive-tmux-cleaner')) removed = true;
  }
  return removed;
}

function completionFlagState(sessionId, dbSession, runtime) {
  const roots = new Set();
  if (runtime?.flagRoot) roots.add(runtime.flagRoot);
  if (runtime?.cwd) roots.add(runtime.cwd);
  if (dbSession?.bind_path) roots.add(dbSession.bind_path);

  const checked = [];
  let sawFlagDir = false;
  for (const root of roots) {
    let flagDirExists = false;
    let runningFlagExists = false;
    try { flagDirExists = fs.existsSync(flagDirOf(root, sessionId)); } catch {}
    try { runningFlagExists = fs.existsSync(runningFlagPathOf(root, sessionId)); } catch {}
    checked.push({ root, flagDirExists, runningFlagExists });
    if (runningFlagExists) {
      return { known: true, completed: false, root, checked };
    }
    if (flagDirExists) sawFlagDir = true;
  }

  return {
    known: sawFlagDir,
    completed: sawFlagDir,
    root: checked.find((x) => x.flagDirExists)?.root || null,
    checked,
  };
}

function thresholdText(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const minutes = Math.round(ms / (60 * 1000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(ms / (60 * 60 * 1000));
  return `${hours} 小时`;
}

function markDbIdle(sessionId) {
  // agent_status 现由 agent-status-syncer 统一管; 巡检杀窗后这里只刷新 last_agent_event 留痕.
  try {
    db.prepare(`
      UPDATE sessions_v2
      SET last_agent_event = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE session_id = ?
    `).run(sessionId);
  } catch (e) {
    console.warn(`[inactive-tmux-cleaner] 更新 DB idle 失败 (${sessionId}): ${e.message}`);
  }
}

function writeCleanupMessage(sessionId, backendName, windowInfo, lastActivity, ageMs, cleanupReason, thresholdMs) {
  try {
    const turnNum = (Messages.maxTurnFor(sessionId) || 0) + 1;
    Messages.insertSystem(
      sessionId,
      [
        `后台巡检已自动清理超过 ${thresholdText(thresholdMs)}无活动的 agent tmux window。`,
        `backend=${backendName}`,
        `window=${windowInfo.sessionId}`,
        `pid=${windowInfo.pid || '(unknown)'}`,
        `cleanup_reason=${cleanupReason || 'inactive'}`,
        `last_activity=${iso(lastActivity?.ms)}`,
        `last_activity_source=${lastActivity?.label || '(unknown)'}`,
        `inactive_age=${ageText(ageMs)}`,
      ].join('\n'),
      turnNum,
      '自动清理不活跃 Agent',
    );
  } catch (e) {
    console.warn(`[inactive-tmux-cleaner] 写清理消息失败 (${sessionId}): ${e.message}`);
  }
}

// 一次完整的"tmux 死窗清理"巡检.
// 职责: 遍历所有 agent backend 的 tmux windows, 找出"长时间无活动"的窗口, kill 掉
//       tmux window + 清 flag 目录 + 给 DB 标 idle + 往 session 写一条清理说明消息.
// 双阈值: 普通窗口 3 小时无活动 (INACTIVE_MS); 已 completed 的窗口 (running.flag 已删)
//         10 分钟无活动 (COMPLETED_INACTIVE_MS) 就清, 因为它没理由继续占资源.
// 多轮重入安全: scanning 模块级锁保证同一时刻只有一轮.
async function scanOnce() {
  // 互斥锁: 定时器叠加 / 手动触发可能让上一轮还没结束就触发新一轮, 直接跳过,
  // 避免对同一 window 重复 terminateSession / 重复写清理消息.
  if (scanning) {
    appendLog(`[${nowIso()}] (skip) 上一轮清理尚未结束, 跳过本轮\n`);
    return;
  }
  // 拿锁 + 记起始时间, 最后算 cost=耗时写心跳.
  scanning = true;
  const startedAt = Date.now();
  // 五个统计计数器, 只用于心跳日志, 让运维确认巡检在跑 + 估算覆盖率.
  let totalWindows = 0;        // 所有 backend 的 windows 总数 (含 _root 占位窗)
  let skippedRoot = 0;          // 跳过的 _root 占位窗 (tmux hub 自带的初始窗, 不属于任何 session)
  let unknownActivity = 0;      // 拿不到任何活动时间源的窗, 无法判定过期, 只能跳过
  let completedFlagWindows = 0; // flag 状态显示"已完成"的窗 (running.flag 已删), 走更短阈值
  const candidates = [];        // 命中清理阈值的窗, 等主循环结束后统一处理

  try {
    // 一次性查所有 DB session, 后续按 sid 在内存里对照 (window↔DB 双向都可能缺失).
    const dbSessions = loadDbSessionsById();
    // 多 backend 遍历: codex / claude_code 各自维护独立的 tmux hub 和 windows 列表.
    for (const backendName of backendNames()) {
      // 单 backend 加载失败不能拖垮其它 backend 的清理, 仅记一行日志跳过.
      let backend;
      try { backend = agents.get(backendName); }
      catch (e) {
        appendLog(`[${nowIso()}] backend=${backendName} unavailable: ${e.message}\n`);
        continue;
      }

      // listSessions 失败同理: 单 backend 列举失败不影响其它 backend.
      let windows = [];
      try { windows = backend.listSessions(); }
      catch (e) {
        appendLog(`[${nowIso()}] backend=${backendName} listSessions failed: ${e.message}\n`);
        continue;
      }

      // 逐 window 判断是否进入候选清理集.
      for (const w of windows) {
        totalWindows++;
        const sid = w.sessionId;
        // _root 是 hub session 自带的初始占位窗, 不属于任何业务 session, 永不清理.
        if (!sid || sid === '_root') { skippedRoot++; continue; }

        // DB 可能没这个 session 的记录 (例如 DB 被手动清过但 tmux 还活着), 用 null 兜底.
        const dbSession = dbSessions.get(sid) || null;
        // 综合多个时间源 (tmux window_activity / runtime.startedAt / jsonl mtime / DB 时间)
        // 取最新一个, 作为"最后一次活动时间". 任何一个时间源缺失都不影响综合判断.
        const activity = activityForWindow(backend, w, dbSession);
        // 所有时间源都拿不到 → 无法判过期, 只能跳过 (不能误清, 留给下一轮).
        if (!activity.latest) { unknownActivity++; continue; }

        // age = 现在 - 最后活动. 越大越该清.
        const ageMs = Date.now() - activity.latest.ms;
        // 通过 flag 文件判断是否"已完成": running.flag 不存在视为已完成.
        // 已完成的窗用更短阈值清理, 因为它已经没理由占资源 (agent 任务结束了).
        const flagState = completionFlagState(sid, dbSession, activity.runtime);
        if (flagState.completed) completedFlagWindows++;
        // 命中条件二选一: 已完成 + 超 COMPLETED_INACTIVE_MS, 或 不论是否完成 + 超 INACTIVE_MS.
        const useCompletedThreshold = flagState.completed && ageMs >= COMPLETED_INACTIVE_MS;
        const useNormalThreshold = ageMs >= INACTIVE_MS;
        if (useCompletedThreshold || useNormalThreshold) {
          // isWorking 在候选阶段才查 (避免对每个 window 都调用 backend).
          // try/catch 降级成 'ERR:...', 防止单窗故障中断整轮; isWorking 不参与判定,
          // 只是写进诊断日志, 帮助事后判断"清的时候 agent 是否其实还在干".
          let isWorking = null;
          try { isWorking = backend.isWorking(sid); } catch (e) { isWorking = `ERR:${e.message}`; }
          // 推入候选集, 等主循环结束后统一处理. 这里只收集, 不立即清理,
          // 因为清理动作会改 backend 状态, 在 listSessions 遍历过程中改状态不安全.
          candidates.push({
            backendName,
            backend,
            windowInfo: w,
            dbSession,
            activity,
            ageMs,
            isWorking,
            flagState,
            // cleanupReason 区分两种触发路径, 写进日志方便统计哪类清理更多.
            cleanupReason: useCompletedThreshold ? 'completed_running_flag_missing' : 'inactive',
            thresholdMs: useCompletedThreshold ? COMPLETED_INACTIVE_MS : INACTIVE_MS,
          });
        }
      }
    }

    // 写一行心跳日志 (不论有无候选都写), 让运维确认巡检在跑 + 看清本轮覆盖率.
    const durMs = Date.now() - startedAt;
    appendLog(
      `[${nowIso()}] scan done: total_windows=${totalWindows} candidates=${candidates.length} ` +
      `completed_flag_windows=${completedFlagWindows} skipped_root=${skippedRoot} ` +
      `unknown_activity=${unknownActivity} inactive_threshold=${INACTIVE_MS}ms ` +
      `completed_threshold=${COMPLETED_INACTIVE_MS}ms cost=${durMs}ms\n`
    );

    // 逐个候选执行清理. 这里是真正会改 backend/DB/flag 的破坏性段, try/catch 包裹每个候选,
    // 单个失败只跳过它, 不影响其它候选.
    for (const f of candidates) {
      const sid = f.windowInfo.sessionId;
      const s = f.dbSession;
      // 把多个活动时间源拼成字符串, 写进日志方便回查"为什么认为这个窗过期了".
      const sources = f.activity.sources
        .map((x) => `${x.label}=${iso(x.ms)}`)
        .join(', ');
      // 人类可读的诊断块. 字段顺序: 身份 → DB/项目上下文 → 进程信息 → 时间/年龄 → 清理依据.
      appendLog([
        '──────── INACTIVE tmux agent cleanup ────────',
        `  time              : ${nowIso()}`,
        `  backend           : ${f.backendName}`,
        `  session_id        : ${sid}`,
        `  session_name      : ${s?.session_name || '(no db row)'}`,
        `  db.status         : ${s?.status || '(no db row)'}`,
        `  project           : ${s?.project_name || '(无)'}`,
        `  issue             : ${s?.issue_title || '(无)'}`,
        `  research          : ${s?.research_title || '(无)'}`,
        `  pid               : ${f.windowInfo.pid || '(unknown)'}`,
        `  tmux_window_index : ${f.windowInfo.index}`,
        `  last_activity     : ${iso(f.activity.latest.ms)} (${f.activity.latest.label})`,
        `  inactive_age      : ${ageText(f.ageMs)} (${Math.round(f.ageMs / 1000)}s)`,
        `  cleanup_reason    : ${f.cleanupReason}`,
        `  cleanup_threshold : ${f.thresholdMs}ms`,
        `  completed_flag    : ${f.flagState?.completed ? 'yes' : 'no'}${f.flagState?.root ? ` (${f.flagState.root})` : ''}`,
        `  backend.isWorking : ${f.isWorking}`,
        `  activity_sources  : ${sources || '(none)'}`,
      ].join('\n') + '\n');

      // 真正执行 kill tmux window. terminateSession 内部会 kill-window + 清 backend runtime.
      // 失败时写一行 FAIL 后 continue, 不让单个失败拖垮其它候选的清理.
      let result = null;
      try {
        result = await f.backend.terminateSession(sid);
      } catch (e) {
        appendLog(`  cleanup=FAIL (terminateSession: ${e.message})\n────────────────────────────────────────\n\n`);
        continue;
      }

      // tmux window 杀掉后, 同步清掉磁盘上的 flag 目录 (.imac/flags/<sid>/),
      // 否则下一次 forgotten-flag-scanner 会误以为是"被遗忘 flag"发提醒.
      const flagRemoved = cleanupFlagDir(sid, s, f.activity.runtime);
      // 只在 DB 有这个 session 时才标 idle + 写清理消息;
      // 没有 DB 行说明它本就是孤儿窗 (DB 已删但 tmux 残留), 不需要再写消息.
      if (s) {
        markDbIdle(sid);
        writeCleanupMessage(
          sid,
          f.backendName,
          f.windowInfo,
          f.activity.latest,
          f.ageMs,
          f.cleanupReason,
          f.thresholdMs,
        );
      }

      // 成功收尾日志, killed/wasWorking 帮助事后统计清理了多少活窗 vs 死窗.
      appendLog(
        `  cleanup=OK killed=${!!result?.killed} wasWorking=${!!result?.wasWorking} flag_dir_removed=${flagRemoved}\n` +
        '────────────────────────────────────────\n\n'
      );
    }
  } catch (e) {
    // 顶层兜底: 扫描本身出 bug 时只写日志, 不让 timer 链路被异常打断下一轮.
    appendLog(`[${nowIso()}] (error) 清理扫描异常: ${e && e.stack ? e.stack : e}\n`);
  } finally {
    // 无论本轮成功失败都释放互斥锁, 保证下一轮定时器能进入.
    scanning = false;
  }
}

function startInactiveTmuxCleaner() {
  if (timer) return timer;
  appendLog(
    `\n[${nowIso()}] ===== inactive-tmux-cleaner 启动 ` +
    `(inactive=${INACTIVE_MS}ms, completed_inactive=${COMPLETED_INACTIVE_MS}ms, ` +
    `interval=${SCAN_INTERVAL_MS}ms, first_run_in=${FIRST_RUN_DELAY_MS}ms) =====\n` +
    `[${nowIso()}] log_file=${LOG_FILE}\n`
  );
  const safeScan = () => {
    Promise.resolve().then(scanOnce).catch(
      (e) => appendLog(`[${nowIso()}] (error) scanOnce 异常: ${e && e.stack ? e.stack : e}\n`)
    );
  };
  setTimeout(() => {
    safeScan();
    timer = setInterval(safeScan, SCAN_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
  console.log(
    `[inactive-tmux-cleaner] 已启动, 每 ${Math.round(SCAN_INTERVAL_MS / 1000)}s 扫描一次, ` +
    `清理 completed ${Math.round(COMPLETED_INACTIVE_MS / 60000)}m / inactive ${Math.round(INACTIVE_MS / 3600000)}h ` +
    `无活动 agent window → ${LOG_FILE}`
  );
  return timer;
}

module.exports = {
  startInactiveTmuxCleaner,
  scanOnce,
  LOG_FILE,
  INACTIVE_MS,
  COMPLETED_INACTIVE_MS,
  SCAN_INTERVAL_MS,
};
