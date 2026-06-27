/**
 * session-runtime-status.ts — session 运行时状态判定的唯一真相源.
 *
 * 与 `GET /api/sessions/:id/status` (routes/sessions.ts) 和后台巡检
 * `agent-status-syncer.ts` 共用本函数, 保证 `sessions_v2.agent_status` 字段
 * 与实时 /status 接口返回的结果始终一致 (谁改了判定逻辑, 改这一处即可).
 *
 * 设计: 纯判定, 无副作用. error_scan 这种会写 .mobius.jsonl 的副作用仍留在
 * /status handler (那是会话内实时职责), 这里只算 alive/working/accomplished/failed.
 *
 * 入参:
 *   session  - sessions_v2 行 (至少含 session_id 和用于选 backend 的 model)
 *   bindPath - 已 resolve 的项目 bind_path 仓库根 (真相源优先, flag 文件判定);
 *              null/空 则回退到 backend 抽象方法 (isJobGoalAccomplished / isFailed)
 */
import * as agents from '../agents';
import * as modelRegistry from '../services/model-registry';
import { readJobFlagState } from './session-flags';

export interface RuntimeStatus {
  alive: boolean;
  working: boolean;
  jobAccomplished: boolean;
  failed: boolean;
  failedReason: string;
  failedAt: string | null;
}

// 注意: 本函数刻意不包 try/catch (除了 flag 文件读取), 以保持与原 /status handler
// 完全一致的行为. 调用方 (service 巡检) 自行对单个 session 包 try/catch, 避免单点
// 故障拖垮整轮.
export function computeSessionRuntimeStatus(
  session: { session_id: string; model?: string | null },
  bindPath: string | null | undefined,
): RuntimeStatus {
  const backend = agents.get(modelRegistry.backendNameForSessionModel(session?.model));
  const id = session.session_id;

  const alive = !!backend.isAlive(id);
  // working: 进程活的前提下, 是否还在 turn 中. alive && !working = "alive 待命".
  const working = alive && !!backend.isWorking(id);

  // 任务标记位: running.flag 在 → 未完成; 删除且无 failed.flag → 已结束(成功);
  // failed.flag 在 → 失败. 有 bind_path 优先看 flag 文件 (运行时无关, 比 backend
  // 抽象方法更可靠); 否则回退到 backend.isJobGoalAccomplished / isFailed.
  let jobAccomplished: boolean;
  let jobFailed: boolean;
  let failedReason = '';
  let failedAt: string | null = null;

  if (bindPath) {
    try {
      const st = readJobFlagState(bindPath, id);
      jobAccomplished = st.accomplished;
      jobFailed = st.failed;
      failedReason = st.failedReason;
      failedAt = st.failedAt || null;
    } catch {
      jobAccomplished = !!backend.isJobGoalAccomplished(id);
      jobFailed = !!backend.isFailed(id);
    }
  } else {
    jobAccomplished = !!backend.isJobGoalAccomplished(id);
    jobFailed = !!backend.isFailed(id);
  }

  return { alive, working, jobAccomplished, failed: jobFailed, failedReason, failedAt };
}

// 把 RuntimeStatus 映射成 agent_status 枚举值. 优先级: failed > running > completed
// > waiting > idle. 与前端小圆点颜色一一对应.
//   failed    → failed.flag 在
//   running   → alive && working
//   completed → job_accomplished (running.flag 已被 agent 自删)
//   waiting   → alive 但不在 turn 中 (等输入)
//   idle      → 其余 (进程不在 / 新建 / 已收工)
export type AgentStatusValue = 'idle' | 'running' | 'waiting' | 'completed' | 'failed';

export function runtimeStatusToAgentStatus(st: RuntimeStatus): AgentStatusValue {
  if (st.failed) return 'failed';
  if (st.working) return 'running';
  if (st.jobAccomplished) return 'completed';
  if (st.alive) return 'waiting';
  return 'idle';
}
