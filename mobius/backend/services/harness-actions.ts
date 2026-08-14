import crypto from 'crypto';
import { db } from '../../db';
import type { HarnessInternalTokenPayload, HarnessTaskContractV1 } from '../types/harness';
import {
  assertNoLethalTrifecta,
  parseHarnessInternalComplete,
  parseHarnessInternalCreateTask,
  parseHarnessInternalFail,
  parseHarnessInternalProgress,
  parseHarnessMemberSnapshot,
  parseHarnessRecord,
  parseHarnessRunPolicy,
  parseJsonColumn,
} from './harness-schema';
import { appendHarnessEvent, getHarnessRunSnapshot } from '../repositories/harness';
import { evaluateNodeTransition, evaluateRunTransition, toNodeTransitionRejectedEvent, type HarnessNodeState } from './harness-state-machine';

type AnyRow = Record<string, any>;

export interface HarnessActionResult {
  ok: boolean;
  replayed?: boolean;
  rejected?: { code: string; reason: string; from?: string; to?: string };
  data?: AnyRow;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function eventForRequest(runId: string, requestId: string): AnyRow | null {
  const row = db.prepare('SELECT * FROM harness_events WHERE run_id = ? AND request_id = ?').get(runId, requestId) as AnyRow | undefined;
  return row ? { ...row, payload: parseJsonColumn(row.payload_json, 'harness_events.payload_json', parseHarnessRecord) } : null;
}

function rejectTransition(runId: string, node: AnyRow, to: HarnessNodeState, actor: any, requestId: string): HarnessActionResult | null {
  const request = { from: node.status as HarnessNodeState, to, actor };
  const result = evaluateNodeTransition(request);
  if (result.accepted) return null;
  const event = toNodeTransitionRejectedEvent(request, result);
  appendHarnessEvent({ runId, type: event.type, fromNodeId: node.id, requestId, payload: event.payload });
  return { ok: false, rejected: { code: result.code, reason: result.reason, from: result.from, to: result.to } };
}

function assertTokenNode(payload: HarnessInternalTokenPayload, runId: string, nodeId?: string): { run: AnyRow; node: AnyRow; member: AnyRow } {
  if (payload.run_id !== runId || (nodeId && payload.node_id !== nodeId)) {
    throw Object.assign(new Error('Scoped token 不能访问其他 Run 或节点'), { status: 403, code: 'harness_scope_violation' });
  }
  const run = db.prepare('SELECT * FROM harness_runs WHERE id = ?').get(runId) as AnyRow | undefined;
  const node = db.prepare('SELECT * FROM harness_nodes WHERE id = ? AND run_id = ?').get(payload.node_id, runId) as AnyRow | undefined;
  const member = db.prepare('SELECT * FROM harness_run_members WHERE id = ? AND run_id = ?').get(payload.member_id, runId) as AnyRow | undefined;
  if (!run || !node || !member || node.assignee_member_id !== member.id) {
    throw Object.assign(new Error('Scoped token 对应的数据库身份已失效'), { status: 403, code: 'harness_identity_invalid' });
  }
  return { run, node, member };
}

function memberToolTags(member: AnyRow): string[] {
  return parseJsonColumn(member.config_snapshot_json, 'harness_run_members.config_snapshot_json', parseHarnessMemberSnapshot).definition.tools.capability_tags;
}

function rootOnly(payload: HarnessInternalTokenPayload, node: AnyRow, member: AnyRow): void {
  if (node.node_type !== 'root' || member.role !== 'main' || payload.role !== 'main') {
    throw Object.assign(new Error('只有 root Main 可以创建 Sub Harness 任务'), { status: 403, code: 'root_main_required' });
  }
}

export function createTaskForMember(payload: HarnessInternalTokenPayload, raw: unknown): HarnessActionResult {
  const input = parseHarnessInternalCreateTask(raw);
  const transaction = db.transaction(() => {
    const replay = eventForRequest(payload.run_id, input.request_id);
    if (replay) return { ok: true, replayed: true, data: replay.payload };
    const { run, node: callerNode, member: callerMember } = assertTokenNode(payload, payload.run_id);
    rootOnly(payload, callerNode, callerMember);
    if (run.execution_mode !== 'multi') throw Object.assign(new Error('单 Harness 模式不能创建 Sub Harness'), { status: 403, code: 'multi_harness_disabled' });
    if (!payload.allowed_member_ids.includes(input.assignee_member_id)) {
      throw Object.assign(new Error('Main 只能向 token 中固化的已选 Member 分派'), { status: 403, code: 'member_not_allowed' });
    }
    const assignee = db.prepare('SELECT * FROM harness_run_members WHERE id = ? AND run_id = ?').get(input.assignee_member_id, run.id) as AnyRow | undefined;
    if (!assignee) throw Object.assign(new Error('Member 不属于此 Run 的锁定 Roster'), { status: 403, code: 'member_not_in_roster' });
    if (assignee.role === 'main') throw Object.assign(new Error('Main 不能通过分派更换 Main 或给 Main 创建 Sub 节点'), { status: 403, code: 'main_reassignment_forbidden' });
    const policy = parseJsonColumn(run.policy_json, 'harness_runs.policy_json', parseHarnessRunPolicy);
    const nodeCount = Number((db.prepare('SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id = ?').get(run.id) as AnyRow).count);
    if (nodeCount >= Math.min(3, Number(policy.max_nodes) || 3)) throw Object.assign(new Error('Phase 1 每个 Run 最多 3 个节点'), { status: 409, code: 'max_nodes_reached' });
    const tags = memberToolTags(assignee);
    assertNoLethalTrifecta(tags);
    const contract: HarnessTaskContractV1 = {
      ...input.task_contract,
      workspace: { ...input.task_contract.workspace, mode: 'read_only' },
      tools: { ...input.task_contract.tools, capability_tags: tags as any },
      communication: { ...input.task_contract.communication, parent_only: true },
    };
    if (contract.risk_level !== 'low') {
      throw Object.assign(new Error('Phase 1 只允许 low risk 的只读 Sub 任务'), { status: 400, code: 'phase1_risk_forbidden' });
    }
    const unsupportedDeliverable = contract.deliverables.find((item) => item.required && !['report', 'structured_data'].includes(item.kind));
    if (unsupportedDeliverable) {
      throw Object.assign(new Error(`Phase 1 不支持必需交付物类型: ${unsupportedDeliverable.kind}`), { status: 400, code: 'phase1_deliverable_forbidden' });
    }
    const children = db.prepare("SELECT * FROM harness_nodes WHERE run_id = ? AND node_type != 'root' ORDER BY created_at").all(run.id) as AnyRow[];
    const dependencyIds = new Set(contract.dependencies);
    if (children.length === 0 && dependencyIds.size !== 0) throw Object.assign(new Error('流水线首个 Sub 节点不能依赖尚不存在的节点'), { status: 400, code: 'invalid_pipeline_dependency' });
    if (children.length > 0) {
      const previous = children[children.length - 1];
      if (dependencyIds.size !== 1 || !dependencyIds.has(previous.id)) {
        throw Object.assign(new Error(`流水线后续节点必须且只能依赖前一节点 ${previous.id}`), { status: 400, code: 'pipeline_dependency_required' });
      }
    }
    for (const dependencyId of dependencyIds) {
      const dependency = db.prepare('SELECT id FROM harness_nodes WHERE id = ? AND run_id = ?').get(dependencyId, run.id);
      if (!dependency) throw Object.assign(new Error(`依赖节点不属于此 Run: ${dependencyId}`), { status: 400, code: 'cross_run_dependency' });
    }
    const nodeId = id('hn');
    const pathValue = `root/${children.length + 1}`;
    const nodeType = assignee.role === 'evaluator' ? 'evaluator' : 'worker';
    db.prepare(`INSERT INTO harness_nodes
      (id, run_id, parent_node_id, assignee_member_id, path, node_type, risk_level, status, depth, model,
       task_contract_json, context_policy_json, tool_policy_json, workspace_mode, max_attempts)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'created', 1, ?, ?, ?, ?, 'read_only', 1)`)
      .run(nodeId, run.id, callerNode.id, assignee.id, pathValue, nodeType, contract.risk_level,
        parseJsonColumn(assignee.config_snapshot_json, 'harness_run_members.config_snapshot_json', parseHarnessMemberSnapshot).definition.model, JSON.stringify(contract),
        JSON.stringify({ mode: assignee.role, system_skill: assignee.role === 'evaluator' ? 'harness-evaluator-agent' : 'harness-sub-agent' }),
        JSON.stringify(contract.tools));
    for (const dependencyId of dependencyIds) {
      db.prepare('INSERT INTO harness_dependencies (run_id, node_id, depends_on_node_id) VALUES (?, ?, ?)').run(run.id, nodeId, dependencyId);
    }
    const dependenciesReady = [...dependencyIds].every((dependencyId) => {
      const row = db.prepare('SELECT status FROM harness_nodes WHERE id = ?').get(dependencyId) as AnyRow;
      return row.status === 'succeeded';
    });
    const activeSubs = Number((db.prepare("SELECT COUNT(*) AS count FROM harness_nodes WHERE run_id=? AND node_type!='root' AND status IN ('queued','starting','running','waiting_input','submitted','verifying')").get(run.id) as AnyRow).count);
    let queued = false;
    let dispatchId: string | null = null;
    if (dependenciesReady && activeSubs < 1) {
      const transition = evaluateNodeTransition({ from: 'created', to: 'queued', actor: 'orchestrator' });
      if (!transition.accepted) throw new Error(transition.reason);
      db.prepare("UPDATE harness_nodes SET status='queued', version=version+1 WHERE id=? AND status='created'").run(nodeId);
      queued = true;
    }
    const eventId = appendHarnessEvent({ runId: run.id, type: 'node.created', fromNodeId: callerNode.id, toNodeId: nodeId, requestId: input.request_id,
      payload: { node_id: nodeId, assignee_member_id: assignee.id, path: pathValue, queued } });
    appendHarnessEvent({ runId: run.id, type: 'member.task_assigned', fromNodeId: callerNode.id, toNodeId: nodeId, payload: { member_id: assignee.id, node_id: nodeId } });
    if (queued) {
      dispatchId = id('hd');
      db.prepare(`INSERT INTO harness_dispatches
        (id, run_id, node_id, event_id, kind, status, request_id, receipt_marker)
        VALUES (?, ?, ?, ?, 'start', 'queued', ?, ?)`)
        .run(dispatchId, run.id, nodeId, eventId, `dispatch:${run.id}:${nodeId}:start:0`, `MOBIUS_HARNESS_DISPATCH[${dispatchId}]`);
      appendHarnessEvent({ runId: run.id, type: 'dispatch.queued', fromNodeId: nodeId, payload: { dispatch_id: dispatchId, kind: 'start' } });
    }
    return { node_id: nodeId, dispatch_id: dispatchId, queued };
  });
  const result = transaction.immediate();
  return result && typeof result === 'object' && 'ok' in result ? result as HarnessActionResult : { ok: true, data: result };
}

export function reportHarnessProgress(payload: HarnessInternalTokenPayload, nodeId: string, raw: unknown): HarnessActionResult {
  const input = parseHarnessInternalProgress(raw);
  const transaction = db.transaction(() => {
    const replay = eventForRequest(payload.run_id, input.request_id);
    if (replay) return { ok: true, replayed: true, data: replay.payload };
    const { node } = assertTokenNode(payload, payload.run_id, nodeId);
    if (!['running', 'waiting_input'].includes(node.status)) {
      const rejected = rejectTransition(payload.run_id, node, 'waiting_input', 'agent', input.request_id);
      return rejected || { ok: false, rejected: { code: 'progress_state_invalid', reason: `节点处于 ${node.status}，不能上报进度` } };
    }
    const eventPayload = { message: input.message, percent: input.percent ?? null, detail: input.detail || null };
    appendHarnessEvent({ runId: payload.run_id, type: 'node.progress', fromNodeId: node.id, requestId: input.request_id, payload: eventPayload });
    return { ok: true, data: eventPayload };
  });
  return transaction.immediate();
}

export function completeHarnessNode(payload: HarnessInternalTokenPayload, nodeId: string, raw: unknown): HarnessActionResult {
  const input = parseHarnessInternalComplete(raw);
  const transaction = db.transaction(() => {
    const replay = eventForRequest(payload.run_id, input.request_id);
    if (replay) return { ok: true, replayed: true, data: replay.payload };
    const { node } = assertTokenNode(payload, payload.run_id, nodeId);
    const rejected = rejectTransition(payload.run_id, node, 'submitted', 'agent', input.request_id);
    if (rejected) return rejected;
    const updated = db.prepare("UPDATE harness_nodes SET status='submitted', result_json=?, submitted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), version=version+1 WHERE id=? AND version=?")
      .run(JSON.stringify(input.result), node.id, node.version);
    if (updated.changes !== 1) throw Object.assign(new Error('节点版本冲突，请读取最新状态后重试'), { status: 409, code: 'version_conflict' });
    const data = { node_id: node.id, status: 'submitted' };
    appendHarnessEvent({ runId: payload.run_id, type: 'node.submitted', fromNodeId: node.id, requestId: input.request_id, payload: data });
    return { ok: true, data };
  });
  return transaction.immediate();
}

export function failHarnessNode(payload: HarnessInternalTokenPayload, nodeId: string, raw: unknown): HarnessActionResult {
  const input = parseHarnessInternalFail(raw);
  const transaction = db.transaction(() => {
    const replay = eventForRequest(payload.run_id, input.request_id);
    if (replay) return { ok: true, replayed: true, data: replay.payload };
    const { run, node } = assertTokenNode(payload, payload.run_id, nodeId);
    const rejected = rejectTransition(payload.run_id, node, 'failed', 'agent', input.request_id);
    if (rejected) return rejected;
    const failure = { reason: input.reason, category: input.category || 'business', retryable: input.retryable === true };
    const updated = db.prepare("UPDATE harness_nodes SET status='failed', failure_json=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), version=version+1 WHERE id=? AND version=?")
      .run(JSON.stringify(failure), node.id, node.version);
    if (updated.changes !== 1) throw Object.assign(new Error('节点版本冲突，请读取最新状态后重试'), { status: 409, code: 'version_conflict' });
    appendHarnessEvent({ runId: payload.run_id, type: 'node.failed', fromNodeId: node.id, requestId: input.request_id, payload: { node_id: node.id, failure } });
    if (node.node_type === 'root') {
      const transition = evaluateRunTransition({ from: run.status, to: 'failed', actor: 'system' });
      if (transition.accepted) {
        db.prepare("UPDATE harness_runs SET status='failed', failure_json=?, version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?")
          .run(JSON.stringify(failure), run.id, run.version);
        appendHarnessEvent({ runId: run.id, type: 'run.failed', fromNodeId: node.id, payload: failure });
      }
    }
    return { ok: true, data: { node_id: node.id, status: 'failed' } };
  });
  return transaction.immediate();
}

export function internalRunEvents(payload: HarnessInternalTokenPayload, runId: string, afterSeq: number): AnyRow[] {
  assertTokenNode(payload, runId);
  return (db.prepare('SELECT * FROM harness_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 200').all(runId, Math.max(0, afterSeq)) as AnyRow[])
    .map((event) => ({ ...event, payload: parseJsonColumn(event.payload_json, 'harness_events.payload_json', parseHarnessRecord) }));
}

export async function waitForInternalRunEvents(
  payload: HarnessInternalTokenPayload,
  runId: string,
  afterSeq: number,
  waitMs: number,
): Promise<AnyRow[]> {
  const boundedWaitMs = Math.min(30_000, Math.max(0, waitMs));
  const initial = internalRunEvents(payload, runId, afterSeq);
  if (initial.length > 0 || boundedWaitMs === 0) return initial;
  const deadline = Date.now() + boundedWaitMs;
  return new Promise((resolve) => {
    const poll = () => {
      const events = internalRunEvents(payload, runId, afterSeq);
      if (events.length > 0 || Date.now() >= deadline) {
        resolve(events);
        return;
      }
      const timer = setTimeout(poll, Math.min(250, deadline - Date.now()));
      timer.unref();
    };
    poll();
  });
}

export function internalRoster(payload: HarnessInternalTokenPayload, runId: string): AnyRow[] {
  const { node, member } = assertTokenNode(payload, runId);
  rootOnly(payload, node, member);
  return (getHarnessRunSnapshot(runId)?.members || []).map((item: AnyRow) => ({
    id: item.id, role: item.role, display_name: item.display_name, member_key: item.config_snapshot.member_key,
    profile_id: item.config_snapshot.profile_id, capabilities: item.config_snapshot.definition.capabilities,
  }));
}
