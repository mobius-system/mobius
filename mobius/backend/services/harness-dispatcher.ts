import crypto from 'crypto';
import { db } from '../../db';
import { appendHarnessEvent } from '../repositories/harness';
import { buildHarnessContext } from './harness-context';
import type { HarnessDispatchOutcome, HarnessDispatchRow, HarnessExecutor } from './harness-executor';
import { HarnessExecutorRegistry } from './harness-executor';
import { evaluateNodeTransition, evaluateRunTransition } from './harness-state-machine';

type AnyRow = Record<string, any>;

export interface ClaimedHarnessDispatch {
  dispatch: AnyRow;
  run: AnyRow;
  node: AnyRow;
  member: AnyRow;
}

function shortId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function isoAfter(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function dependenciesSucceeded(runId: string, nodeId: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM harness_dependencies d
    JOIN harness_nodes n ON n.run_id=d.run_id AND n.id=d.depends_on_node_id
    WHERE d.run_id=? AND d.node_id=? AND n.status!='succeeded'`).get(runId, nodeId) as AnyRow;
  return Number(row.count) === 0;
}

function executorFor(registry: HarnessExecutorRegistry): HarnessExecutor {
  const executor = registry.get('mobius-session') || registry.list()[0];
  if (!executor) throw Object.assign(new Error('没有可用的 Harness Executor'), { code: 'harness_executor_missing' });
  return executor;
}

export function claimNextHarnessDispatch(owner: string): ClaimedHarnessDispatch | null {
  const transaction = db.transaction(() => {
    const candidates = db.prepare(`SELECT d.* FROM harness_dispatches d
      JOIN harness_nodes n ON n.id=d.node_id AND n.run_id=d.run_id
      JOIN harness_runs r ON r.id=d.run_id
      WHERE d.status='queued' AND n.status='queued'
        AND r.status IN ('planning','running')
      ORDER BY n.priority DESC, d.created_at ASC LIMIT 20`).all() as AnyRow[];
    for (const dispatch of candidates) {
      const node = db.prepare('SELECT * FROM harness_nodes WHERE id=? AND run_id=?').get(dispatch.node_id, dispatch.run_id) as AnyRow;
      const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(dispatch.run_id) as AnyRow;
      const member = db.prepare('SELECT * FROM harness_run_members WHERE id=? AND run_id=?').get(node.assignee_member_id, run.id) as AnyRow | undefined;
      if (!member || !dependenciesSucceeded(run.id, node.id)) continue;
      if (node.node_type !== 'root' && member.role === 'main') {
        db.prepare("UPDATE harness_dispatches SET status='failed', last_error='main-only member cannot run sub node' WHERE id=? AND status='queued'").run(dispatch.id);
        appendHarnessEvent({ runId: run.id, type: 'dispatch.failed', fromNodeId: node.id, payload: { dispatch_id: dispatch.id, code: 'main_only_member' } });
        continue;
      }
      if (node.node_type !== 'root') {
        const active = db.prepare(`SELECT COUNT(*) AS count FROM harness_nodes
          WHERE run_id=? AND node_type!='root' AND id!=? AND status IN ('starting','running','waiting_input','submitted','verifying')`)
          .get(run.id, node.id) as AnyRow;
        if (Number(active.count) >= 1) continue;
      }
      const transition = evaluateNodeTransition({ from: node.status, to: 'starting', actor: 'orchestrator' });
      if (!transition.accepted) {
        appendHarnessEvent({ runId: run.id, type: 'node.transition_rejected', fromNodeId: node.id,
          payload: { from: node.status, to: 'starting', actor: 'orchestrator', code: transition.code, reason: transition.reason } });
        continue;
      }
      try {
        const nodeUpdated = db.prepare(`UPDATE harness_nodes SET status='starting', attempt=attempt+1,
          lease_owner=?, lease_expires_at=?, version=version+1, started_at=COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          WHERE id=? AND status='queued' AND version=?`).run(owner, isoAfter(60), node.id, node.version);
        if (nodeUpdated.changes !== 1) continue;
      } catch (error: any) {
        if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
          appendHarnessEvent({ runId: run.id, type: 'member.slot_contended', fromNodeId: node.id,
            payload: { member_id: member.id, dispatch_id: dispatch.id } });
          continue;
        }
        throw error;
      }
      const dispatchUpdated = db.prepare(`UPDATE harness_dispatches SET status='leased', lease_owner=?,
        lease_expires_at=?, attempt=attempt+1 WHERE id=? AND status='queued'`).run(owner, isoAfter(60), dispatch.id);
      if (dispatchUpdated.changes !== 1) throw new Error('Dispatch claim version conflict');
      appendHarnessEvent({ runId: run.id, type: 'dispatch.leased', fromNodeId: node.id,
        payload: { dispatch_id: dispatch.id, lease_owner: owner } });
      return {
        dispatch: db.prepare('SELECT * FROM harness_dispatches WHERE id=?').get(dispatch.id),
        run,
        node: db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(node.id),
        member,
      } as ClaimedHarnessDispatch;
    }
    return null;
  });
  return transaction.immediate();
}

function finishDelivered(claim: ClaimedHarnessDispatch, executor: HarnessExecutor, sessionId: string, outcome: HarnessDispatchOutcome): void {
  const transaction = db.transaction(() => {
    const dispatch = db.prepare('SELECT * FROM harness_dispatches WHERE id=?').get(claim.dispatch.id) as AnyRow;
    const node = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(claim.node.id) as AnyRow;
    if (dispatch.status === 'delivered' && node.status === 'running') return;
    if (!['leased', 'dispatching'].includes(dispatch.status)) throw new Error(`Dispatch ${dispatch.id} 状态已变化: ${dispatch.status}`);
    const evidence = outcome.evidence === 'observed' ? 'observed' : 'inferred';
    db.prepare(`INSERT INTO harness_dispatch_receipts
      (dispatch_id, run_id, node_id, session_id, executor_kind, receipt_marker, evidence, evidence_detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dispatch_id) DO NOTHING`)
      .run(dispatch.id, dispatch.run_id, dispatch.node_id, sessionId, executor.kind, dispatch.receipt_marker, evidence, outcome.detail || null);
    db.prepare(`UPDATE harness_dispatches SET status='delivered', target_session_id=?, delivered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      lease_owner=NULL, lease_expires_at=NULL, last_error=NULL WHERE id=?`).run(sessionId, dispatch.id);
    if (node.status === 'starting') {
      const transition = evaluateNodeTransition({ from: 'starting', to: 'running', actor: 'lease_holder' });
      if (!transition.accepted) throw new Error(transition.reason);
      db.prepare(`UPDATE harness_nodes SET status='running', lease_owner=NULL, lease_expires_at=NULL,
        heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), version=version+1 WHERE id=? AND status='starting'`).run(node.id);
      appendHarnessEvent({ runId: dispatch.run_id, type: 'node.running', fromNodeId: node.id,
        payload: { node_id: node.id, session_id: sessionId } });
    }
    const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(dispatch.run_id) as AnyRow;
    if (node.node_type === 'root' && run.status === 'planning') {
      const runTransition = evaluateRunTransition({ from: 'planning', to: 'running', actor: 'orchestrator' });
      if (!runTransition.accepted) throw new Error(runTransition.reason);
      db.prepare("UPDATE harness_runs SET status='running', version=version+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='planning'").run(run.id);
      appendHarnessEvent({ runId: run.id, type: 'run.running', fromNodeId: node.id, payload: { root_node_id: node.id } });
    }
    appendHarnessEvent({ runId: dispatch.run_id, type: 'dispatch.delivered', fromNodeId: node.id,
      payload: { dispatch_id: dispatch.id, session_id: sessionId, evidence } });
  });
  transaction.immediate();
}

function failDispatch(claim: ClaimedHarnessDispatch, error: unknown, uncertain = false): void {
  const detail = error instanceof Error ? error.message : String(error);
  const failureCategory = uncertain ? 'uncertain_dispatch' : 'backend';
  const transaction = db.transaction(() => {
    const dispatch = db.prepare('SELECT * FROM harness_dispatches WHERE id=?').get(claim.dispatch.id) as AnyRow | undefined;
    const node = db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(claim.node.id) as AnyRow | undefined;
    if (!dispatch || !node || ['delivered', 'failed', 'uncertain'].includes(dispatch.status)) return;
    db.prepare(`UPDATE harness_dispatches SET status=?, last_error=?, lease_owner=NULL, lease_expires_at=NULL WHERE id=?`)
      .run(uncertain ? 'uncertain' : 'failed', detail, dispatch.id);
    if (node.status === 'starting') {
      const target = uncertain ? 'orphaned' : 'failed';
      const actor = uncertain ? 'recovery' : 'orchestrator';
      const transition = evaluateNodeTransition({ from: 'starting', to: target, actor });
      if (!transition.accepted) throw new Error(transition.reason);
      db.prepare(`UPDATE harness_nodes SET status=?, failure_json=?, lease_owner=NULL, lease_expires_at=NULL,
        completed_at=CASE WHEN ?='failed' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE completed_at END,
        version=version+1 WHERE id=? AND status='starting'`)
        .run(target, JSON.stringify({ category: failureCategory, reason: detail }), target, node.id);
      appendHarnessEvent({ runId: dispatch.run_id, type: `node.${target}`, fromNodeId: node.id,
        payload: { node_id: node.id, category: failureCategory, reason: detail } });
      if (node.node_type === 'root') {
        const run = db.prepare('SELECT * FROM harness_runs WHERE id=?').get(dispatch.run_id) as AnyRow;
        const runTransition = evaluateRunTransition({ from: run.status, to: 'failed', actor: 'system' });
        if (!runTransition.accepted) throw Object.assign(new Error(runTransition.reason), { code: runTransition.code });
        const runUpdated = db.prepare(`UPDATE harness_runs SET status='failed', failure_json=?, version=version+1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND version=?`)
          .run(JSON.stringify({ category: failureCategory, reason: detail }), run.id, run.version);
        if (runUpdated.changes !== 1) throw Object.assign(new Error('Run 版本冲突，无法记录根节点启动失败'), { code: 'version_conflict' });
        appendHarnessEvent({ runId: run.id, type: 'run.failed', fromNodeId: node.id,
          payload: { category: failureCategory, reason: detail } });
      }
    }
    appendHarnessEvent({ runId: dispatch.run_id, type: uncertain ? 'dispatch.uncertain' : 'dispatch.failed', fromNodeId: node.id,
      payload: { dispatch_id: dispatch.id, reason: detail } });
  });
  transaction.immediate();
}

export async function deliverClaimedHarnessDispatch(claim: ClaimedHarnessDispatch, registry: HarnessExecutorRegistry): Promise<void> {
  const executor = executorFor(registry);
  try {
    const session = await executor.startSession({
      runId: claim.run.id,
      nodeId: claim.node.id,
      memberId: claim.member.id,
      model: claim.node.model,
      workspacePath: claim.node.workspace_path,
    });
    const markDispatching = db.transaction(() => {
      const updated = db.prepare(`UPDATE harness_dispatches SET status='dispatching', target_session_id=?, lease_expires_at=?
        WHERE id=? AND status='leased' AND lease_owner=?`).run(session.sessionId, isoAfter(60), claim.dispatch.id, claim.node.lease_owner);
      if (updated.changes !== 1) throw new Error('Dispatch lease lost before delivery');
      appendHarnessEvent({ runId: claim.run.id, type: 'dispatch.dispatching', fromNodeId: claim.node.id,
        payload: { dispatch_id: claim.dispatch.id, session_id: session.sessionId } });
    });
    markDispatching.immediate();
    const context = buildHarnessContext(claim.node.id);
    const prompt = `${context.prompt}\n\nUse MOBIUS_HARNESS_TOKEN from the process environment for all Harness actions. Do not print or expose it.`;
    const outcome = await executor.dispatch({
      runId: claim.run.id,
      nodeId: claim.node.id,
      sessionId: session.sessionId,
      requestId: claim.dispatch.request_id,
      prompt,
      receiptMarker: claim.dispatch.receipt_marker,
      scopedToken: context.token,
    });
    if (!outcome.delivered || outcome.evidence === 'unknown' || outcome.evidence === 'absent') {
      failDispatch(claim, outcome.detail || 'Executor could not confirm delivery', true);
      return;
    }
    finishDelivered(claim, executor, session.sessionId, outcome);
  } catch (error) {
    failDispatch(claim, error, false);
  }
}

export async function reconcileExpiredHarnessDispatch(dispatch: AnyRow, registry: HarnessExecutorRegistry): Promise<void> {
  const executor = executorFor(registry);
  const existingReceipt = db.prepare('SELECT * FROM harness_dispatch_receipts WHERE dispatch_id=?').get(dispatch.id) as AnyRow | undefined;
  let evidence: 'observed' | 'inferred' | 'absent' | 'unknown' = existingReceipt?.evidence || 'unknown';
  if (!existingReceipt && executor.reconcile) {
    evidence = await executor.reconcile({
      id: dispatch.id,
      runId: dispatch.run_id,
      nodeId: dispatch.node_id,
      requestId: dispatch.request_id,
      receiptMarker: dispatch.receipt_marker,
      targetSessionId: dispatch.target_session_id,
    } as HarnessDispatchRow);
  }
  const claim = {
    dispatch,
    run: db.prepare('SELECT * FROM harness_runs WHERE id=?').get(dispatch.run_id),
    node: db.prepare('SELECT * FROM harness_nodes WHERE id=?').get(dispatch.node_id),
    member: db.prepare(`SELECT m.* FROM harness_run_members m JOIN harness_nodes n ON n.assignee_member_id=m.id
      WHERE n.id=? AND m.run_id=?`).get(dispatch.node_id, dispatch.run_id),
  } as ClaimedHarnessDispatch;
  if (evidence === 'observed' || evidence === 'inferred') {
    finishDelivered(claim, executor, dispatch.target_session_id, { delivered: true, evidence, detail: 'recovered from persisted delivery evidence' });
  } else {
    failDispatch(claim, evidence === 'absent' ? 'Expired dispatch has no persisted marker; Phase 1 will not resend automatically' : 'Expired dispatch delivery is uncertain', evidence !== 'absent');
  }
}

export function queueReadyHarnessNodes(runId: string): number {
  const transaction = db.transaction(() => {
    const active = db.prepare(`SELECT COUNT(*) AS count FROM harness_nodes
      WHERE run_id=? AND node_type!='root' AND status IN ('queued','starting','running','waiting_input','submitted','verifying')`).get(runId) as AnyRow;
    if (Number(active.count) > 0) return 0;
    const candidates = db.prepare(`SELECT * FROM harness_nodes n WHERE n.run_id=? AND n.status='created'
      AND NOT EXISTS (SELECT 1 FROM harness_dependencies d JOIN harness_nodes dep ON dep.id=d.depends_on_node_id AND dep.run_id=d.run_id
        WHERE d.run_id=n.run_id AND d.node_id=n.id AND dep.status!='succeeded')
      ORDER BY n.created_at LIMIT 1`).all(runId) as AnyRow[];
    const node = candidates[0];
    if (!node) return 0;
    const transition = evaluateNodeTransition({ from: 'created', to: 'queued', actor: 'orchestrator' });
    if (!transition.accepted) throw new Error(transition.reason);
    const updated = db.prepare("UPDATE harness_nodes SET status='queued', version=version+1 WHERE id=? AND status='created'").run(node.id);
    if (updated.changes !== 1) return 0;
    const queuedEvent = appendHarnessEvent({ runId, type: 'node.queued', fromNodeId: node.id, payload: { node_id: node.id, path: node.path } });
    const dispatchId = shortId('hd');
    db.prepare(`INSERT INTO harness_dispatches
      (id, run_id, node_id, event_id, kind, status, request_id, receipt_marker)
      VALUES (?, ?, ?, ?, 'start', 'queued', ?, ?)`)
      .run(dispatchId, runId, node.id, queuedEvent, `dispatch:${runId}:${node.id}:start:${node.attempt}`, `MOBIUS_HARNESS_DISPATCH[${dispatchId}]`);
    appendHarnessEvent({ runId, type: 'dispatch.queued', fromNodeId: node.id, payload: { dispatch_id: dispatchId, kind: 'start' } });
    return 1;
  });
  return transaction.immediate();
}
