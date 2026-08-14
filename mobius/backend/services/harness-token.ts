import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';
import type { HarnessInternalTokenPayload, HarnessMemberRole } from '../types/harness';

const ACTIONS_BY_ROLE: Record<HarnessMemberRole, string[]> = {
  main: ['create_task_for_member', 'progress', 'complete', 'fail', 'read_roster', 'read_events'],
  worker: ['progress', 'complete', 'fail'],
  evaluator: ['progress', 'complete', 'fail'],
};

export function mintHarnessNodeToken(input: {
  runId: string;
  nodeId: string;
  memberId: string;
  role: HarnessMemberRole;
  allowedMemberIds: string[];
}): string {
  const payload: HarnessInternalTokenPayload = {
    kind: 'harness-node', run_id: input.runId, node_id: input.nodeId, member_id: input.memberId,
    role: input.role,
    // This list is an authorization claim, not a prompt hint. Internal routes
    // check it again against the immutable DB roster on every delegation.
    allowed_member_ids: [...new Set(input.allowedMemberIds)],
    actions: ACTIONS_BY_ROLE[input.role],
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h', audience: 'mobius-harness-internal' });
}

export function verifyHarnessNodeToken(token: string): HarnessInternalTokenPayload {
  const payload = jwt.verify(token, JWT_SECRET, { audience: 'mobius-harness-internal' }) as HarnessInternalTokenPayload;
  if (payload.kind !== 'harness-node' || !payload.run_id || !payload.node_id || !payload.member_id
    || !Array.isArray(payload.allowed_member_ids) || !Array.isArray(payload.actions)) {
    throw new Error('Invalid harness token claims');
  }
  return payload;
}

export function requireHarnessAction(payload: HarnessInternalTokenPayload, action: string): void {
  if (!payload.actions.includes(action)) {
    throw Object.assign(new Error(`当前 Harness 节点无权执行 ${action}`), { status: 403, code: 'harness_action_forbidden' });
  }
}
