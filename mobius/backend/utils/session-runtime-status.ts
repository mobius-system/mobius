// session-runtime-status.ts — 运行时状态判定的唯一真相源, /status 接口与 agent-status-syncer 共用.
import { db } from '../../db';
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

// 刻意不包 try/catch (与原 /status handler 行为一致); 调用方自行按单 session 兜错.
export function computeSessionRuntimeStatus(
  session: { session_id: string; model?: string | null },
  bindPath: string | null | undefined,
): RuntimeStatus {
  const backend = agents.get(modelRegistry.backendNameForSessionModel(session?.model));
  const id = session.session_id;

  const alive = !!backend.isAlive(id);
  // ⭐ 最贵的探测 (jsonl 尾读 / tmux 抓屏); 上一行 alive 只是它的前置开关.
  // working: 进程活的前提下, 是否还在 turn 中. alive && !working = "alive 待命".
  const working = alive && !!backend.isWorking(id);

  // 任务标记位: 优先读 flag 文件, 失败或无 bindPath 才回退 backend 方法.
  let jobAccomplished: boolean;
  let jobFailed: boolean;
  let failedReason = '';
  let failedAt: string | null = null;

  if (bindPath) {
    try {
      // ⭐ 任务成败的真相源: 直接读 flag 文件; catch/else 里的 backend 方法全是它的备胎.
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

// RuntimeStatus → agent_status 枚举, 与前端小圆点颜色一一对应.
export type AgentStatusValue = 'idle' | 'running' | 'waiting' | 'completed' | 'failed';

export function runtimeStatusToAgentStatus(st: RuntimeStatus): AgentStatusValue {
  // ⭐ 顺序即优先级: failed > running > completed > waiting > idle, 排前面的赢.
  if (st.failed) return 'failed';
  if (st.working) return 'running';
  if (st.jobAccomplished) return 'completed';
  if (st.alive) return 'waiting';
  return 'idle';
}

// 判定结果写回 sessions_v2.agent_status, 变了才写; /status 高频调用顺便把被查看的 session 近实时刷进 DB.
export function syncAgentStatusIfChanged(
  sessionId: string,
  currentAgentStatus: string | null | undefined,
  st: RuntimeStatus,
): { changed: boolean; next: AgentStatusValue } {
  const next = runtimeStatusToAgentStatus(st);
  if (next === currentAgentStatus) return { changed: false, next };
  try {
    // ⭐ 真正写库的一句; 前面的同值短路和这层 try-catch 都是围着它转.
    db.prepare(
      "UPDATE sessions_v2 SET agent_status = ?, last_agent_event = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE session_id = ?"
    ).run(next, sessionId);
  } catch {
    return { changed: false, next };
  }
  return { changed: true, next };
}
