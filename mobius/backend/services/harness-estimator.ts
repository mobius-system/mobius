import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import type { HarnessEstimateRequestV1, HarnessProfileDefinitionV1, HarnessRunPolicyV1 } from '../types/harness';

export interface HarnessEstimateProfile {
  id: string;
  definition: HarnessProfileDefinitionV1;
}

export interface HarnessEstimateV1 {
  estimate_id: string;
  expires_at: string;
  estimated_duration_seconds_range: [number, number];
  estimated_cost_usd_range: [number, number];
  relative_to_single: number;
  assumptions: string[];
}

interface EstimateTokenPayload {
  kind: 'harness-estimate';
  user_id: string;
  digest: string;
  cost_range: [number, number];
  duration_range: [number, number];
  relative_to_single: number;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function normalizedPhase1Policy(request: HarnessEstimateRequestV1): HarnessRunPolicyV1 {
  const memberCount = request.roster.members.length;
  return {
    schema_version: '1.0',
    collaboration_shape: 'pipeline',
    max_concurrent_subharnesses: 1,
    max_depth: request.execution_mode === 'single' ? 0 : 1,
    max_nodes: Math.max(1, Math.min(3, memberCount)) as 1 | 2 | 3,
    default_timeout_seconds: Math.max(60, Math.min(3600, Number(request.policy?.default_timeout_seconds) || 1800)),
    workspace_policy: 'read_only',
    evaluator_policy: ['always', 'off'].includes(String(request.policy?.evaluator_policy))
      ? request.policy!.evaluator_policy as 'always' | 'off'
      : 'by_risk',
    context_reset_policy: 'off',
    cost_soft_limit_usd: 2,
    cost_hard_limit_usd: 5,
  };
}

export function estimateDigest(request: HarnessEstimateRequestV1, policy: HarnessRunPolicyV1): string {
  return crypto.createHash('sha256').update(stable({
    anchor_type: request.anchor_type,
    issue_id: request.issue_id,
    session_name: request.session_name?.trim() || null,
    language: request.language || 'zh',
    excluded_skill_ids: request.excluded_skill_ids || [],
    excluded_memory_ids: request.excluded_memory_ids || [],
    goal: request.goal.trim(),
    execution_mode: request.execution_mode,
    roster: request.roster,
    policy,
  })).digest('hex');
}

export function estimateHarnessRun(userId: string, request: HarnessEstimateRequestV1, profiles: HarnessEstimateProfile[]): HarnessEstimateV1 {
  const policy = normalizedPhase1Policy(request);
  const factors = profiles.map((profile) => profile.definition.cost_profile.relative_cost_factor);
  const totalFactor = factors.reduce((sum, factor) => sum + factor, 0);
  const baselineFactor = factors[0] || 1;
  const relative = Number((totalFactor / baselineFactor).toFixed(2));
  const lowerCost = Number((0.08 * totalFactor).toFixed(2));
  const upperCost = Number((0.35 * totalFactor).toFixed(2));
  const durationBase = Math.max(240, Math.min(policy.default_timeout_seconds, 1200));
  const costRange: [number, number] = [lowerCost, upperCost];
  const durationRange: [number, number] = [durationBase, durationBase * request.roster.members.length];
  const token = jwt.sign({
    kind: 'harness-estimate',
    user_id: userId,
    digest: estimateDigest(request, policy),
    cost_range: costRange,
    duration_range: durationRange,
    relative_to_single: relative,
  } satisfies EstimateTokenPayload, JWT_SECRET, { expiresIn: '15m', audience: 'mobius-harness-create' });
  const decoded = jwt.decode(token) as { exp?: number } | null;
  return {
    estimate_id: token,
    expires_at: new Date((decoded?.exp || Math.floor(Date.now() / 1000) + 900) * 1000).toISOString(),
    estimated_duration_seconds_range: durationRange,
    estimated_cost_usd_range: costRange,
    relative_to_single: relative,
    assumptions: [
      'Phase 1 仅运行只读流水线，Sub Harness 串行执行',
      '估算按 Profile 相对成本系数计算，实际成本会记录用于后续校准',
    ],
  };
}

export function verifyHarnessEstimate(
  userId: string,
  request: HarnessEstimateRequestV1,
  policy: HarnessRunPolicyV1,
  estimateId: string,
  shownRange: [number, number],
): Pick<EstimateTokenPayload, 'cost_range' | 'duration_range' | 'relative_to_single'> {
  let payload: EstimateTokenPayload;
  try {
    payload = jwt.verify(estimateId, JWT_SECRET, { audience: 'mobius-harness-create' }) as EstimateTokenPayload;
  } catch {
    throw Object.assign(new Error('成本预估已失效，请重新查看并确认'), { code: 'estimate_expired', status: 409 });
  }
  const digest = estimateDigest(request, policy);
  if (payload.kind !== 'harness-estimate' || payload.user_id !== userId || payload.digest !== digest) {
    throw Object.assign(new Error('Roster 或运行策略已变化，请重新确认成本预估'), { code: 'estimate_mismatch', status: 409 });
  }
  if (!Array.isArray(payload.cost_range) || payload.cost_range.length !== 2
    || payload.cost_range[0] !== shownRange[0] || payload.cost_range[1] !== shownRange[1]) {
    throw Object.assign(new Error('提交的成本区间与已展示预估不一致'), { code: 'estimate_range_mismatch', status: 409 });
  }
  if (!Array.isArray(payload.duration_range) || payload.duration_range.length !== 2
    || !payload.duration_range.every((value) => Number.isFinite(value) && value >= 0)
    || !Number.isFinite(payload.relative_to_single) || payload.relative_to_single <= 0) {
    throw Object.assign(new Error('成本预估内容不完整，请重新查看并确认'), { code: 'estimate_payload_invalid', status: 409 });
  }
  return {
    cost_range: payload.cost_range,
    duration_range: payload.duration_range,
    relative_to_single: payload.relative_to_single,
  };
}
