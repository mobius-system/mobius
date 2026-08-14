import crypto from 'crypto';
import { db } from '../../db';
import type {
  HarnessCreateRunRequestV1,
  HarnessEstimateRequestV1,
  HarnessMemberRole,
  HarnessProfileDefinitionV1,
  HarnessRunPolicyV1,
  HarnessTaskContractV1,
} from '../types/harness';
import {
  assertNoLethalTrifecta,
  parseHarnessMemberSnapshot,
  parseHarnessNodeResult,
  parseHarnessProfile,
  parseHarnessRecord,
  parseHarnessRunPolicy,
  parseHarnessTaskContract,
  parseHarnessToolPolicy,
  parseJsonColumn,
} from '../services/harness-schema';
import { evaluateNodeTransition, evaluateRunTransition } from '../services/harness-state-machine';
import { normalizedPhase1Policy, verifyHarnessEstimate } from '../services/harness-estimator';
import * as modelRegistry from '../services/model-registry';

type AnyRow = Record<string, any>;

export interface ResolvedHarnessProfile {
  id: string;
  scope: string;
  project_id: string | null;
  owner_user_id: string | null;
  name: string;
  description: string;
  backend: string;
  default_model: string;
  version: number;
  definition: HarnessProfileDefinitionV1;
}

export interface ResolvedHarnessMember {
  member_key: string;
  profile: ResolvedHarnessProfile;
  role: HarnessMemberRole;
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function deterministicRunId(userId: string, requestId: string): string {
  return `hr_${crypto.createHash('sha256').update(`${userId}\0${requestId}`).digest('hex').slice(0, 26)}`;
}

function nextSeq(runId: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM harness_events WHERE run_id = ?').get(runId) as { seq: number };
  return Number(row.seq);
}

export function appendHarnessEvent(input: {
  runId: string;
  type: string;
  payload: unknown;
  fromNodeId?: string | null;
  toNodeId?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
}): string {
  const eventId = shortId('he');
  db.prepare(`INSERT INTO harness_events
    (seq, event_id, run_id, from_node_id, to_node_id, type, correlation_id, causation_id, request_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(nextSeq(input.runId), eventId, input.runId, input.fromNodeId || null, input.toNodeId || null,
      input.type, input.correlationId || null, input.causationId || null, input.requestId || null, JSON.stringify(input.payload));
  return eventId;
}

function profileFromRow(row: AnyRow): ResolvedHarnessProfile {
  const definition = parseJsonColumn(row.definition_json, 'harness_profiles.definition_json', parseHarnessProfile);
  if (definition.backend !== row.backend || definition.model !== row.default_model) {
    throw new Error(`Profile ${row.id} 的结构化定义与索引列不一致`);
  }
  return { ...row, definition } as ResolvedHarnessProfile;
}

export function listVisibleHarnessProfiles(userId: string, projectId: string): ResolvedHarnessProfile[] {
  syncAvailableDeepSeekHarnessProfiles();
  const rows = db.prepare(`SELECT * FROM harness_profiles
    WHERE is_enabled = 1 AND (
      scope = 'system' OR (scope = 'project' AND project_id = ?) OR (scope = 'user' AND owner_user_id = ?)
    ) ORDER BY CASE scope WHEN 'system' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, name ASC`).all(projectId, userId) as AnyRow[];
  return rows.map(profileFromRow);
}

function syncAvailableDeepSeekHarnessProfiles(): void {
  const options = modelRegistry.listSessionModelOptions()
    .filter((option: AnyRow) => option.backend === 'deepseek-harness');
  const insert = db.prepare(`INSERT OR IGNORE INTO harness_profiles
    (id, scope, name, description, backend, default_model, capabilities_json, definition_json, version)
    VALUES (?, 'system', ?, 'Configured DeepSeek Harness read-only profile', 'deepseek-harness', ?, ?, ?, 1)`);
  for (const option of options) {
    const capabilities = {
      can_main: true,
      can_work: true,
      can_evaluate: true,
      supports_write: false,
      supports_network: false,
      supports_runtime_verification: false,
      max_concurrency: 1,
    };
    const model = String(option.value || option.key);
    const profileId = `system-deepseek-${crypto.createHash('sha256').update(model).digest('hex').slice(0, 16)}-v1`;
    insert.run(
      profileId,
      String(option.label || 'DeepSeek Harness Read-only'),
      model,
      JSON.stringify(capabilities),
      JSON.stringify({
        schema_version: '1.1',
        backend: 'deepseek-harness',
        model,
        capabilities,
        model_traits: {
          needs_context_reset: false,
          context_window_tokens: 0,
          supports_auto_compaction: false,
          calibrated: false,
        },
        skills: [],
        tools: { allow: [], deny: [], capability_tags: [] },
        cost_profile: { relative_cost_factor: 0.8 },
        default_context_policy: {},
        default_tool_policy: { workspace_mode: 'read_only' },
      }),
    );
  }
}

export function resolveRoster(userId: string, projectId: string, request: HarnessEstimateRequestV1): ResolvedHarnessMember[] {
  const visible = new Map(listVisibleHarnessProfiles(userId, projectId).map((profile) => [profile.id, profile]));
  const keys = new Set<string>();
  const profileIds = new Set<string>();
  if (request.execution_mode === 'single' && request.roster.members.length !== 1) throw inputError('单 Harness 模式必须恰好选择一个成员', 'single_roster_invalid');
  if (request.execution_mode === 'multi' && request.roster.members.length < 2) throw inputError('多 Harness 模式至少选择两个成员', 'multi_roster_invalid');
  const members = request.roster.members.map((member) => {
    if (keys.has(member.member_key)) throw inputError(`Roster member_key 重复: ${member.member_key}`, 'duplicate_member_key');
    if (profileIds.has(member.profile_id)) throw inputError(`同一 Run 不能重复选择 Profile: ${member.profile_id}`, 'duplicate_profile');
    keys.add(member.member_key);
    profileIds.add(member.profile_id);
    const profile = visible.get(member.profile_id);
    if (!profile) throw inputError(`Profile 不存在、未启用或不可见: ${member.profile_id}`, 'profile_not_visible');
    const role: HarnessMemberRole = member.member_key === request.roster.main_member_key ? 'main' : (member.purpose || 'worker');
    if (role === 'main' && !profile.definition.capabilities.can_main) throw inputError(`Profile ${profile.name} 不能担任 Main`, 'profile_cannot_main');
    if (role === 'worker' && !profile.definition.capabilities.can_work) throw inputError(`Profile ${profile.name} 不能执行 Worker 任务`, 'profile_cannot_work');
    if (role === 'evaluator' && !profile.definition.capabilities.can_evaluate) throw inputError(`Profile ${profile.name} 不能担任 Evaluator`, 'profile_cannot_evaluate');
    if (profile.definition.capabilities.supports_write) throw inputError(`Phase 1 只允许只读 Profile: ${profile.name}`, 'write_profile_forbidden');
    assertNoLethalTrifecta(profile.definition.tools.capability_tags);
    return { member_key: member.member_key, profile, role };
  });
  if (members.filter((member) => member.role === 'main').length !== 1) throw inputError('Roster 必须指定唯一 Main', 'unique_main_required');
  if (request.execution_mode === 'single' && members[0].role !== 'main') throw inputError('单 Harness 成员必须同时是 Main', 'single_main_required');
  return members;
}

function inputError(message: string, code: string): Error {
  return Object.assign(new Error(message), { status: 400, code });
}

function rootContract(goal: string, profile: ResolvedHarnessProfile, policy: HarnessRunPolicyV1): HarnessTaskContractV1 {
  const contract: HarnessTaskContractV1 = {
    schema_version: '1.1', objective: goal.trim(), risk_level: 'low',
    acceptance_criteria: [{ id: 'root-delivery', description: '向用户交付完整且可执行的最终结果', verification: 'parent_review', required: true }],
    inputs: [], deliverables: [{ kind: 'report', name: '最终结果', required: true }], dependencies: [],
    workspace: { mode: 'read_only' },
    tools: { profile: 'custom', allow: profile.definition.tools.allow, deny: profile.definition.tools.deny, capability_tags: profile.definition.tools.capability_tags },
    budget: { timeout_seconds: policy.default_timeout_seconds, max_cost_usd: policy.cost_hard_limit_usd },
    communication: { parent_only: true },
  };
  assertNoLethalTrifecta(contract.tools.capability_tags);
  return parseHarnessTaskContract(contract);
}

export function createHarnessRun(userId: string, projectId: string, request: HarnessCreateRunRequestV1): AnyRow {
  const runId = deterministicRunId(userId, request.request_id);
  const existing = db.prepare('SELECT * FROM harness_runs WHERE id = ?').get(runId) as AnyRow | undefined;
  if (existing) return getHarnessRunSnapshot(runId)!;
  const policy = normalizedPhase1Policy(request);
  const members = resolveRoster(userId, projectId, request);
  let acknowledgedEstimate: { cost_range: [number, number]; duration_range: [number, number]; relative_to_single: number } | null = null;
  if (request.execution_mode === 'multi') {
    if (!request.acknowledged_estimate) throw Object.assign(new Error('多 Harness 模式必须先查看并确认成本预估'), { status: 409, code: 'estimate_required' });
    acknowledgedEstimate = verifyHarnessEstimate(userId, request, policy, request.acknowledged_estimate.estimate_id, request.acknowledged_estimate.shown_cost_usd_range);
  }
  const issue = db.prepare('SELECT id, project_id FROM issues WHERE id = ?').get(request.issue_id) as AnyRow | undefined;
  if (!issue || issue.project_id !== projectId) throw inputError('Issue 不存在或不属于当前项目', 'issue_project_mismatch');
  const memberRows = members.map((member, index) => ({ ...member, id: shortId('hm'), order: index }));
  const main = memberRows.find((member) => member.role === 'main')!;
  const rootNodeId = shortId('hn');
  const dispatchId = shortId('hd');
  const marker = `MOBIUS_HARNESS_DISPATCH[${dispatchId}]`;
  const transaction = db.transaction(() => {
    db.prepare(`INSERT INTO harness_runs
      (id, owner_user_id, project_id, anchor_type, issue_id, goal, execution_mode, policy_json)
      VALUES (?, ?, ?, 'issue', ?, ?, ?, ?)`)
      .run(runId, userId, projectId, request.issue_id, request.goal.trim(), request.execution_mode, JSON.stringify(policy));
    const insertMember = db.prepare(`INSERT INTO harness_run_members
      (id, run_id, profile_id, role, display_name, selection_order, config_snapshot_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const member of memberRows) {
      insertMember.run(member.id, runId, member.profile.id, member.role, member.profile.name, member.order,
        JSON.stringify({ member_key: member.member_key, profile_id: member.profile.id, profile_version: member.profile.version, definition: member.profile.definition }));
    }
    const contract = rootContract(request.goal, main.profile, policy);
    db.prepare(`INSERT INTO harness_nodes
      (id, run_id, assignee_member_id, path, node_type, status, depth, model, task_contract_json,
       context_policy_json, tool_policy_json, workspace_mode, max_attempts)
      VALUES (?, ?, ?, 'root', 'root', 'created', 0, ?, ?, ?, ?, 'read_only', 1)`)
      .run(rootNodeId, runId, main.id, main.profile.default_model, JSON.stringify(contract),
        JSON.stringify({ mode: 'main', system_skill: 'harness-main-agent' }), JSON.stringify(contract.tools));
    const nodeTransition = evaluateNodeTransition({ from: 'created', to: 'queued', actor: 'orchestrator' });
    const runTransition = evaluateRunTransition({ from: 'created', to: 'planning', actor: 'orchestrator' });
    if (!nodeTransition.accepted || !runTransition.accepted) throw new Error('Harness 初始状态转换表拒绝合法创建');
    db.prepare("UPDATE harness_nodes SET status='queued', version=version+1 WHERE id=? AND status='created'").run(rootNodeId);
    db.prepare("UPDATE harness_runs SET status='planning', version=version+1 WHERE id=? AND status='created'").run(runId);
    const eventId = appendHarnessEvent({
      runId,
      type: 'run.created',
      payload: { execution_mode: request.execution_mode, policy, acknowledged_estimate: acknowledgedEstimate },
      requestId: request.request_id,
    });
    appendHarnessEvent({ runId, type: 'run.roster_locked', payload: { main_member_id: main.id, members: memberRows.map((member) => ({ id: member.id, member_key: member.member_key, role: member.role, profile_id: member.profile.id })) } });
    appendHarnessEvent({ runId, type: 'node.queued', fromNodeId: rootNodeId, payload: { path: 'root' } });
    db.prepare(`INSERT INTO harness_dispatches
      (id, run_id, node_id, event_id, kind, status, request_id, receipt_marker)
      VALUES (?, ?, ?, ?, 'start', 'queued', ?, ?)`)
      .run(dispatchId, runId, rootNodeId, eventId, `dispatch:${runId}:${rootNodeId}:start:0`, marker);
    appendHarnessEvent({ runId, type: 'dispatch.queued', fromNodeId: rootNodeId, payload: { dispatch_id: dispatchId, kind: 'start' } });
  });
  transaction.immediate();
  return getHarnessRunSnapshot(runId)!;
}

function parseRunRow(row: AnyRow): AnyRow {
  return {
    ...row,
    policy: parseJsonColumn(row.policy_json, 'harness_runs.policy_json', parseHarnessRunPolicy),
    final_result: row.final_result_json ? parseJsonColumn(row.final_result_json, 'harness_runs.final_result_json', parseHarnessNodeResult) : null,
    failure: row.failure_json ? parseJsonColumn(row.failure_json, 'harness_runs.failure_json', parseHarnessRecord) : null,
  };
}

function parseMemberRow(row: AnyRow): AnyRow {
  const snapshot = parseJsonColumn(row.config_snapshot_json, 'harness_run_members.config_snapshot_json', parseHarnessMemberSnapshot);
  return { ...row, config_snapshot: snapshot };
}

function parseNodeRow(row: AnyRow): AnyRow {
  return {
    ...row,
    task_contract: parseJsonColumn(row.task_contract_json, 'harness_nodes.task_contract_json', parseHarnessTaskContract),
    result: row.result_json ? parseJsonColumn(row.result_json, 'harness_nodes.result_json', parseHarnessNodeResult) : null,
    context_policy: parseJsonColumn(row.context_policy_json, 'harness_nodes.context_policy_json', parseHarnessRecord),
    tool_policy: parseJsonColumn(row.tool_policy_json, 'harness_nodes.tool_policy_json', parseHarnessToolPolicy),
  };
}

export function getHarnessRunSnapshot(runId: string): AnyRow | null {
  const run = db.prepare('SELECT * FROM harness_runs WHERE id = ?').get(runId) as AnyRow | undefined;
  if (!run) return null;
  const members = (db.prepare('SELECT * FROM harness_run_members WHERE run_id = ? ORDER BY selection_order, created_at').all(runId) as AnyRow[]).map(parseMemberRow);
  const costRows = db.prepare(`SELECT h.node_id, COUNT(*) AS session_count,
      COALESCE(SUM(s.total_cost_usd), 0) AS actual_cost_usd
    FROM harness_node_sessions h
    JOIN harness_nodes n ON n.id=h.node_id AND n.run_id=?
    JOIN sessions_v2 s ON s.session_id=h.session_id
    GROUP BY h.node_id`).all(runId) as AnyRow[];
  const costByNode = new Map(costRows.map((row) => [row.node_id, {
    session_count: Number(row.session_count),
    actual_cost_usd: Number(row.actual_cost_usd),
  }]));
  const nodes = (db.prepare('SELECT * FROM harness_nodes WHERE run_id = ? ORDER BY depth, created_at').all(runId) as AnyRow[])
    .map(parseNodeRow)
    .map((node) => {
      const telemetry = costByNode.get(node.id) || { session_count: 0, actual_cost_usd: 0 };
      return {
        ...node,
        ...telemetry,
        cost_telemetry_status: telemetry.session_count === 0 ? 'not_started' : telemetry.actual_cost_usd > 0 ? 'reported' : 'zero_or_unreported',
      };
    });
  const dependencies = db.prepare('SELECT * FROM harness_dependencies WHERE run_id = ? ORDER BY created_at').all(runId);
  const dispatches = db.prepare('SELECT id, run_id, node_id, kind, status, attempt, created_at, delivered_at, last_error FROM harness_dispatches WHERE run_id = ? ORDER BY created_at').all(runId);
  const events: AnyRow[] = (db.prepare('SELECT * FROM harness_events WHERE run_id = ? ORDER BY seq DESC LIMIT 100').all(runId) as AnyRow[]).reverse()
    .map((event) => ({ ...event, payload: parseJsonColumn(event.payload_json, 'harness_events.payload_json', parseHarnessRecord) }));
  const createdEvent = events.find((event) => event.type === 'run.created');
  const parsedRun = parseRunRow(run);
  parsedRun.actual_cost_usd = Number(nodes.reduce((sum, node) => sum + Number(node.actual_cost_usd || 0), 0).toFixed(6));
  parsedRun.cost_telemetry_status = nodes.some((node) => node.cost_telemetry_status === 'reported')
    ? 'reported'
    : nodes.some((node) => node.cost_telemetry_status === 'zero_or_unreported') ? 'zero_or_unreported' : 'not_started';
  parsedRun.acknowledged_estimate = createdEvent?.payload?.acknowledged_estimate || null;
  return { run: parsedRun, members, nodes, dependencies, dispatches, events };
}

export function listHarnessRunsForIssue(issueId: string): AnyRow[] {
  return (db.prepare(`SELECT r.*,
    (SELECT COUNT(*) FROM harness_nodes n WHERE n.run_id=r.id) AS node_count,
    (SELECT COUNT(*) FROM harness_nodes n WHERE n.run_id=r.id AND n.status='succeeded') AS succeeded_node_count
    FROM harness_runs r WHERE r.anchor_type='issue' AND r.issue_id=? ORDER BY r.created_at DESC`).all(issueId) as AnyRow[]).map(parseRunRow);
}

export function findRunOwner(runId: string): AnyRow | null {
  return db.prepare('SELECT * FROM harness_runs WHERE id = ?').get(runId) as AnyRow || null;
}

export function memberDefinition(memberRow: AnyRow): HarnessProfileDefinitionV1 {
  return parseJsonColumn(memberRow.config_snapshot_json, 'harness_run_members.config_snapshot_json', parseHarnessMemberSnapshot).definition;
}
