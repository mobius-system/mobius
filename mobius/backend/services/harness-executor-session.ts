import crypto from 'crypto';
import { db } from '../../db';
import { Sessions } from '../repositories/sessions';
import { Users } from '../repositories/users';
import { parseHarnessMemberSnapshot, parseJsonColumn } from './harness-schema';
import { runSessionMessage } from './session-message-runner';
import { buildSessionSelectionSnapshot } from './session-context';
import type {
  HarnessDispatchInput,
  HarnessDispatchOutcome,
  HarnessDispatchRow,
  HarnessExecutor,
  HarnessSessionSpec,
} from './harness-executor';

type AnyRow = Record<string, any>;

function deterministicSessionId(nodeId: string): string {
  return `hs_${crypto.createHash('sha256').update(nodeId).digest('hex').slice(0, 20)}`;
}

function storedIdList(value: unknown): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  } catch {
    return [];
  }
}

function nodeExecutionRows(nodeId: string): { run: AnyRow; node: AnyRow; member: AnyRow } {
  const node = db.prepare('SELECT * FROM harness_nodes WHERE id = ?').get(nodeId) as AnyRow | undefined;
  if (!node) throw Object.assign(new Error(`Harness Node 不存在: ${nodeId}`), { code: 'harness_node_missing' });
  const run = db.prepare('SELECT * FROM harness_runs WHERE id = ?').get(node.run_id) as AnyRow | undefined;
  const member = db.prepare('SELECT * FROM harness_run_members WHERE id = ? AND run_id = ?')
    .get(node.assignee_member_id, node.run_id) as AnyRow | undefined;
  if (!run || !member) throw Object.assign(new Error('Harness Node 的 Run 或 Member 已失效'), { code: 'harness_identity_invalid' });
  return { run, node, member };
}

/**
 * Phase 1 adapter for the existing Mobius Session/TUI execution path.
 * This channel has no protocol-level acknowledgement. A successful call is
 * therefore recorded as inferred evidence, and recovery checks the persisted
 * user message for the dispatch marker before changing control-plane state.
 */
export class MobiusSessionHarnessExecutor implements HarnessExecutor {
  readonly kind = 'mobius-session';
  readonly providesDeliveryConfirmation = false;
  readonly supportsThreadFork = false;
  readonly supportsInlineApproval = false;

  async startSession(spec: HarnessSessionSpec): Promise<{ sessionId: string }> {
    const existing = db.prepare(`SELECT session_id FROM harness_node_sessions
      WHERE node_id = ? AND status = 'active' ORDER BY generation DESC LIMIT 1`).get(spec.nodeId) as AnyRow | undefined;
    if (existing) return { sessionId: existing.session_id };

    const { run, node, member } = nodeExecutionRows(spec.nodeId);
    if (run.id !== spec.runId || member.id !== spec.memberId) {
      throw Object.assign(new Error('Session 启动参数与锁定的 Run/Member 不一致'), { code: 'harness_scope_violation' });
    }
    const profile = parseJsonColumn(member.config_snapshot_json, 'harness_run_members.config_snapshot_json', parseHarnessMemberSnapshot).definition;
    const sessionId = deterministicSessionId(node.id);
    const currentSession = Sessions.findById(sessionId);
    if (!currentSession) {
      const owner = Users.findAuthById(run.owner_user_id);
      if (!owner) throw Object.assign(new Error('Harness Run 所有者不可用'), { code: 'harness_owner_missing' });
      const excludedSkillIds = storedIdList(run.excluded_skill_ids);
      const excludedMemoryIds = storedIdList(run.excluded_memory_ids);
      Sessions.insert({
        session_id: sessionId,
        issue_id: run.issue_id,
        project_id: run.project_id,
        scope_type: 'issue',
        user_id: run.owner_user_id,
        name: node.node_type === 'root' && run.session_name
          ? run.session_name
          : `${run.session_name || 'Harness'} · ${node.path} - ${member.display_name}`,
        description: `Main/Sub Harness node ${node.id}`,
        session_key: `harness:${run.id}:${node.id}:0`,
        excluded_skill_ids: excludedSkillIds,
        excluded_memory_ids: excludedMemoryIds,
        selection_snapshot: buildSessionSelectionSnapshot(
          owner,
          run.issue_id,
          excludedSkillIds,
          excludedMemoryIds,
        ),
        model: profile.model,
        language: run.language || 'zh',
      });
    }
    db.prepare(`INSERT OR IGNORE INTO harness_node_sessions
      (node_id, session_id, generation, status) VALUES (?, ?, 0, 'active')`).run(node.id, sessionId);
    const bound = db.prepare(`SELECT session_id FROM harness_node_sessions
      WHERE node_id = ? AND status = 'active' ORDER BY generation DESC LIMIT 1`).get(node.id) as AnyRow | undefined;
    if (!bound) throw new Error('Harness Node Session 绑定失败');
    return { sessionId: bound.session_id };
  }

  async dispatch(input: HarnessDispatchInput): Promise<HarnessDispatchOutcome> {
    const { run } = nodeExecutionRows(input.nodeId);
    const user = Users.findAuthById(run.owner_user_id);
    if (!user) throw Object.assign(new Error('Harness Run 所有者不可用'), { code: 'harness_owner_missing' });
    const prompt = `${input.prompt}\n\nDispatch receipt marker: ${input.receiptMarker}`;
    await runSessionMessage({
      user,
      sessionId: input.sessionId,
      content: prompt,
      requestId: input.requestId,
      source: 'harness.dispatch',
      initialContextMode: 'session',
      runtimeEnv: { MOBIUS_HARNESS_TOKEN: input.scopedToken },
    });
    return {
      delivered: true,
      evidence: 'inferred',
      sessionId: input.sessionId,
      detail: 'runSessionMessage returned after persisting and queueing the marked prompt',
    };
  }

  async interrupt(_sessionId: string): Promise<void> {
    throw Object.assign(new Error('Phase 1 不开放 Harness 节点中断'), { code: 'harness_interrupt_unavailable' });
  }

  async reconcile(dispatch: HarnessDispatchRow): Promise<'inferred' | 'absent' | 'unknown'> {
    const sessionId = dispatch.targetSessionId;
    if (!sessionId) return 'absent';
    const session = Sessions.findById(sessionId);
    if (!session) return 'absent';
    const message = db.prepare(`SELECT 1 FROM messages_v2
      WHERE task_id = ? AND role = 'user' AND instr(content, ?) > 0 LIMIT 1`)
      .get(sessionId, dispatch.receiptMarker);
    return message ? 'inferred' : 'absent';
  }
}
