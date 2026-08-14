import crypto from 'crypto';
import { db } from '../../db';
import { appendHarnessEvent } from '../repositories/harness';
import { parseHarnessNodeResult, parseHarnessTaskContract, parseJsonColumn } from './harness-schema';
import { HarnessExecutorRegistry } from './harness-executor';
import { MobiusSessionHarnessExecutor } from './harness-executor-session';
import {
  claimNextHarnessDispatch,
  deliverClaimedHarnessDispatch,
  queueReadyHarnessNodes,
  reconcileExpiredHarnessDispatch,
} from './harness-dispatcher';
import { evaluateNodeTransition, evaluateRunTransition } from './harness-state-machine';

type AnyRow = Record<string, any>;

const ACTIVE_RUN_STATES = "'planning','running','waiting_input','verifying','synthesizing'";
const owner = `harness-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const registry = new HarnessExecutorRegistry();
registry.register(new MobiusSessionHarnessExecutor());

let scanning = false;
let scanRequested = false;
let timer: NodeJS.Timeout | null = null;
let started = false;

function enabled(name: string, fallback = true): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function verificationDecision(node: AnyRow): { accepted: boolean; reasons: string[]; result: AnyRow } {
  const contract = parseJsonColumn(node.task_contract_json, 'harness_nodes.task_contract_json', parseHarnessTaskContract);
  const result = parseJsonColumn(node.result_json, 'harness_nodes.result_json', parseHarnessNodeResult);
  const reasons: string[] = [];
  const byCriterion = new Map<string, AnyRow>();
  for (const item of result.acceptance_results) {
    if (byCriterion.has(item.criterion_id)) reasons.push(`验收项重复: ${item.criterion_id}`);
    byCriterion.set(item.criterion_id, item);
  }
  for (const criterion of contract.acceptance_criteria) {
    const item = byCriterion.get(criterion.id);
    if (!item && criterion.required) {
      reasons.push(`缺少必需验收项: ${criterion.id}`);
      continue;
    }
    if (item && criterion.required && Number(item.score) < Number(criterion.threshold ?? 1)) {
      reasons.push(`验收项未达到阈值: ${criterion.id}`);
    }
    if (criterion.check?.expect_artifact_kind) reasons.push(`Phase 1 不支持 Artifact 验收: ${criterion.id}`);
  }
  const known = new Set(contract.acceptance_criteria.map((criterion) => criterion.id));
  for (const criterionId of byCriterion.keys()) {
    if (!known.has(criterionId)) reasons.push(`结果包含合同外验收项: ${criterionId}`);
  }
  if (result.status !== 'succeeded') reasons.push(`节点自报结果不是 succeeded: ${result.status}`);
  if (result.unresolved.length > 0) reasons.push('节点仍有未解决事项');
  if (result.artifact_ids.length > 0 || result.acceptance_results.some((item) => item.evidence_artifact_ids.length > 0)) {
    reasons.push('Phase 1 不接受未注册的 Artifact 引用');
  }
  const unsupportedDeliverable = contract.deliverables.find((item) => item.required && !['report', 'structured_data'].includes(item.kind));
  if (unsupportedDeliverable) reasons.push(`Phase 1 不支持必需交付物类型: ${unsupportedDeliverable.kind}`);
  if (contract.risk_level !== 'low') reasons.push('Phase 1 只验证 low risk 只读节点');
  return { accepted: reasons.length === 0, reasons, result };
}

function finalizeGate(run: AnyRow, rootNode: AnyRow, result: AnyRow): string[] {
  const reasons: string[] = [];
  const requiredNodes = db.prepare('SELECT * FROM harness_nodes WHERE run_id=? AND required=1 AND id!=?').all(run.id, rootNode.id) as AnyRow[];
  for (const node of requiredNodes) {
    const waived = ['failed', 'cancelled'].includes(node.status) && node.waived_at && node.waiver_reason;
    if (node.status !== 'succeeded' && !waived) reasons.push(`必需节点 ${node.id} 尚未成功且没有 waiver`);
  }
  const approval = db.prepare("SELECT id FROM harness_approvals WHERE run_id=? AND status='pending' LIMIT 1").get(run.id) as AnyRow | undefined;
  if (approval) reasons.push(`仍有待审批项 ${approval.id}`);
  const pendingDispatch = db.prepare(`SELECT id, status FROM harness_dispatches WHERE run_id=?
    AND status IN ('queued','leased','dispatching','uncertain') LIMIT 1`).get(run.id) as AnyRow | undefined;
  if (pendingDispatch) reasons.push(`Dispatch ${pendingDispatch.id} 仍处于 ${pendingDispatch.status}`);
  if (result.artifact_ids.length > 0) {
    const placeholders = result.artifact_ids.map(() => '?').join(',');
    const owned = db.prepare(`SELECT COUNT(*) AS count FROM harness_artifacts WHERE run_id=? AND id IN (${placeholders})`)
      .get(run.id, ...result.artifact_ids) as AnyRow;
    if (Number(owned.count) !== result.artifact_ids.length) reasons.push('最终结果引用了不属于本 Run 的 Artifact');
  }
  const highRisk = db.prepare("SELECT id FROM harness_nodes WHERE run_id=? AND risk_level='high' LIMIT 1").get(run.id) as AnyRow | undefined;
  if (highRisk) reasons.push(`Phase 1 无法满足高风险节点 ${highRisk.id} 的验收层级`);
  return reasons;
}

export function verifySubmittedHarnessNode(nodeId: string): void {
  const transaction = db.transaction(() => {
    const node = db.prepare("SELECT * FROM harness_nodes WHERE id=? AND status='submitted'").get(nodeId) as AnyRow | undefined;
    if (!node) return;
    const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(node.run_id) as AnyRow;
    let decision: ReturnType<typeof verificationDecision>;
    try {
      decision = verificationDecision(node);
    } catch (error) {
      decision = { accepted: false, reasons: [error instanceof Error ? error.message : String(error)], result: null as any };
    }
    const begin = evaluateNodeTransition({ from: 'submitted', to: 'verifying', actor: 'orchestrator' });
    if (!begin.accepted) throw new Error(begin.reason);
    db.prepare("UPDATE harness_nodes SET status='verifying', version=version+1 WHERE id=? AND status='submitted'").run(node.id);
    appendHarnessEvent({ runId: run.id, type: 'node.verifying', fromNodeId: node.id, payload: { node_id: node.id } });

    if (node.node_type === 'root' && decision.accepted) {
      decision.reasons.push(...finalizeGate(run, node, decision.result));
      decision.accepted = decision.reasons.length === 0;
    }
    const target = decision.accepted ? 'succeeded' : 'failed';
    const finish = evaluateNodeTransition({ from: 'verifying', to: target, actor: 'orchestrator' });
    if (!finish.accepted) throw new Error(finish.reason);
    db.prepare(`UPDATE harness_nodes SET status=?, failure_json=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      version=version+1 WHERE id=? AND status='verifying'`)
      .run(target, decision.accepted ? null : JSON.stringify({ category: 'verification', reasons: decision.reasons }), node.id);
    appendHarnessEvent({ runId: run.id, type: decision.accepted ? 'node.succeeded' : 'node.failed', fromNodeId: node.id,
      payload: { node_id: node.id, verification: { accepted: decision.accepted, reasons: decision.reasons } } });

    if (node.node_type !== 'root') {
      const root = db.prepare("SELECT id FROM harness_nodes WHERE run_id=? AND node_type='root'").get(run.id) as AnyRow;
      appendHarnessEvent({ runId: run.id, type: decision.accepted ? 'member.task_completed' : 'member.task_failed',
        fromNodeId: node.id, toNodeId: root.id, payload: { node_id: node.id, result: decision.result, reasons: decision.reasons } });
      return;
    }
    if (!decision.accepted) {
      const failRun = evaluateRunTransition({ from: run.status, to: 'failed', actor: 'system' });
      if (failRun.accepted) {
        db.prepare(`UPDATE harness_runs SET status='failed', failure_json=?, version=version+1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?`)
          .run(JSON.stringify({ category: 'verification', reasons: decision.reasons }), run.id, run.version);
        appendHarnessEvent({ runId: run.id, type: 'run.failed', fromNodeId: node.id, payload: { reasons: decision.reasons } });
      }
      return;
    }
    const toVerifying = evaluateRunTransition({ from: run.status, to: 'verifying', actor: 'orchestrator' });
    if (!toVerifying.accepted) throw new Error(toVerifying.reason);
    const toSynthesizing = evaluateRunTransition({ from: 'verifying', to: 'synthesizing', actor: 'orchestrator' });
    const toCompleted = evaluateRunTransition({ from: 'synthesizing', to: 'completed', actor: 'orchestrator' });
    if (!toSynthesizing.accepted || !toCompleted.accepted) throw new Error('Run finalize 状态机拒绝合法转换');
    const verifyingUpdate = db.prepare(`UPDATE harness_runs SET status='verifying', version=version+1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?`).run(run.id, run.version);
    if (verifyingUpdate.changes !== 1) throw Object.assign(new Error('Run finalize 进入 verifying 时发生版本冲突'), { code: 'version_conflict' });
    appendHarnessEvent({ runId: run.id, type: 'run.verifying', fromNodeId: node.id, payload: {} });
    const synthesizingUpdate = db.prepare(`UPDATE harness_runs SET status='synthesizing', version=version+1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?`).run(run.id, run.version + 1);
    if (synthesizingUpdate.changes !== 1) throw Object.assign(new Error('Run finalize 进入 synthesizing 时发生版本冲突'), { code: 'version_conflict' });
    appendHarnessEvent({ runId: run.id, type: 'run.synthesizing', fromNodeId: node.id, payload: {} });
    const completedUpdate = db.prepare(`UPDATE harness_runs SET status='completed', final_result_json=?,
      completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      version=version+1 WHERE id=? AND version=?`).run(JSON.stringify(decision.result), run.id, run.version + 2);
    if (completedUpdate.changes !== 1) throw Object.assign(new Error('Run finalize 进入 completed 时发生版本冲突'), { code: 'version_conflict' });
    appendHarnessEvent({ runId: run.id, type: 'run.completed', fromNodeId: node.id, payload: { final_result: decision.result } });
  });
  transaction.immediate();
  const runId = (db.prepare('SELECT run_id FROM harness_nodes WHERE id=?').get(nodeId) as AnyRow | undefined)?.run_id;
  if (runId) queueReadyHarnessNodes(runId);
}

async function recoverExpiredDispatches(): Promise<void> {
  const rows = db.prepare(`SELECT * FROM harness_dispatches
    WHERE status IN ('leased','dispatching') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
    ORDER BY created_at LIMIT 20`).all(new Date().toISOString()) as AnyRow[];
  for (const row of rows) await reconcileExpiredHarnessDispatch(row, registry);
}

export async function runHarnessScanOnce(): Promise<{ active: boolean }> {
  const active = Number((db.prepare(`SELECT COUNT(*) AS count FROM harness_runs WHERE status IN (${ACTIVE_RUN_STATES})`).get() as AnyRow).count) > 0;
  if (!active || !enabled('HARNESS_ORCHESTRATOR_ENABLED')) return { active };
  await recoverExpiredDispatches();
  if (enabled('HARNESS_VERIFICATION_ENABLED')) {
    const submitted = db.prepare("SELECT id FROM harness_nodes WHERE status='submitted' ORDER BY submitted_at LIMIT 20").all() as AnyRow[];
    for (const node of submitted) verifySubmittedHarnessNode(node.id);
  }
  const runs = db.prepare(`SELECT id FROM harness_runs WHERE status IN (${ACTIVE_RUN_STATES}) ORDER BY updated_at`).all() as AnyRow[];
  for (const run of runs) queueReadyHarnessNodes(run.id);
  if (enabled('HARNESS_DISPATCH_ENABLED')) {
    for (let index = 0; index < 3; index += 1) {
      const claim = claimNextHarnessDispatch(owner);
      if (!claim) break;
      await deliverClaimedHarnessDispatch(claim, registry);
    }
  }
  return { active: true };
}

async function scan(): Promise<void> {
  if (scanning) {
    scanRequested = true;
    return;
  }
  scanning = true;
  try {
    do {
      scanRequested = false;
      await runHarnessScanOnce();
    } while (scanRequested);
  } catch (error) {
    console.error('[harness-orchestrator] scan failed:', error);
  } finally {
    scanning = false;
  }
}

function schedule(): void {
  if (!started) return;
  const active = Number((db.prepare(`SELECT COUNT(*) AS count FROM harness_runs WHERE status IN (${ACTIVE_RUN_STATES})`).get() as AnyRow).count) > 0;
  timer = setTimeout(async () => {
    await scan();
    schedule();
  }, active ? 2_000 : 10_000);
  timer.unref();
}

export function requestHarnessScan(): void {
  if (!enabled('HARNESS_ORCHESTRATOR_ENABLED')) return;
  scanRequested = true;
  const immediate = setImmediate(() => { void scan(); });
  immediate.unref();
}

export function startHarnessOrchestrator(): void {
  if (started || !enabled('HARNESS_ORCHESTRATOR_ENABLED')) return;
  started = true;
  requestHarnessScan();
  schedule();
}

export function stopHarnessOrchestrator(): void {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

export function harnessExecutorRegistry(): HarnessExecutorRegistry {
  return registry;
}
