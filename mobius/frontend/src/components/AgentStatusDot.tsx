/**
 * AgentStatusDot — session 旁的小圆点, 颜色**只由 agent_status 决定**.
 *
 * agent_status 是单一真相源: 由后端 agent-status-syncer 周期重算写入
 * (与 GET /api/sessions/:id/status 共用判定逻辑). 前端不再二次判定
 * job_accomplished / job_failed, 改色只改这一处.
 *
 *   failed    红        bg-red-500/70
 *   running   脉冲绿    pulse-green
 *   completed 暗绿      bg-green-500/60
 *   waiting   脉冲琥珀  pulse-amber  (进程在但等输入)
 *   idle      蓝        bg-blue-400/60  (默认)
 */
import React from 'react';

export function AgentStatusDot({
  agentStatus,
  className,
}: {
  agentStatus?: string | null;
  className?: string;
}) {
  const s = agentStatus || 'idle';
  const extra = className ? ` ${className}` : '';
  if (s === 'failed') return <div className={`w-2 h-2 rounded-full bg-red-500/70${extra}`} />;
  if (s === 'running') return <div className={`pulse-green${extra}`} />;
  if (s === 'completed') return <div className={`w-2 h-2 rounded-full bg-green-500/60${extra}`} />;
  if (s === 'waiting') return <div className={`pulse-amber${extra}`} />;
  return <div className={`w-2 h-2 rounded-full bg-blue-400/60${extra}`} />;
}

export default AgentStatusDot;
