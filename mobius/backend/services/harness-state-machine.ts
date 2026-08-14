export type HarnessNodeState =
  | 'created' | 'queued' | 'starting' | 'running' | 'waiting_input'
  | 'submitted' | 'verifying' | 'succeeded' | 'failed' | 'timed_out'
  | 'interrupted' | 'orphaned' | 'cancelling' | 'cancelled';

export type HarnessRunState =
  | 'created' | 'planning' | 'running' | 'waiting_input' | 'verifying'
  | 'synthesizing' | 'completed' | 'failed' | 'cancelling' | 'cancelled';

export type HarnessTransitionActor =
  | 'orchestrator' | 'lease_holder' | 'agent' | 'user' | 'main'
  | 'recovery' | 'cascade' | 'timeout' | 'system';

export interface HarnessTransitionRequest<S extends string> {
  from: S;
  to: S;
  actor: HarnessTransitionActor;
  /** Additional state-machine facts, supplied by the service layer. */
  context?: Record<string, unknown>;
}

export interface HarnessTransitionAccepted<S extends string> {
  accepted: true;
  from: S;
  to: S;
}

export interface HarnessTransitionRejected<S extends string> {
  accepted: false;
  from: S;
  to: S;
  reason: string;
  code: string;
}

export type HarnessTransitionResult<S extends string> =
  | HarnessTransitionAccepted<S>
  | HarnessTransitionRejected<S>;

const NODE_RULES: Readonly<Record<HarnessNodeState, ReadonlySet<HarnessNodeState>>> = {
  created: new Set(['queued', 'cancelled']),
  queued: new Set(['starting', 'cancelling']),
  starting: new Set(['running', 'orphaned', 'failed', 'cancelling']),
  running: new Set(['waiting_input', 'submitted', 'failed', 'timed_out', 'interrupted', 'orphaned', 'cancelling']),
  waiting_input: new Set(['queued', 'cancelled', 'failed', 'cancelling']),
  submitted: new Set(['verifying', 'failed', 'cancelling']),
  verifying: new Set(['succeeded', 'queued', 'failed', 'cancelling']),
  succeeded: new Set([]),
  failed: new Set(['queued', 'cancelling']),
  timed_out: new Set(['queued', 'cancelling']),
  interrupted: new Set(['queued', 'cancelling']),
  orphaned: new Set(['queued', 'failed', 'cancelling']),
  cancelling: new Set(['cancelled']),
  cancelled: new Set([]),
};

const RUN_RULES: Readonly<Record<HarnessRunState, ReadonlySet<HarnessRunState>>> = {
  created: new Set(['planning', 'cancelling']),
  planning: new Set(['running', 'waiting_input', 'failed', 'cancelling']),
  running: new Set(['waiting_input', 'verifying', 'synthesizing', 'failed', 'cancelling']),
  waiting_input: new Set(['planning', 'running', 'failed', 'cancelling']),
  verifying: new Set(['synthesizing', 'running', 'failed', 'cancelling']),
  synthesizing: new Set(['completed', 'running', 'failed', 'cancelling']),
  completed: new Set([]),
  failed: new Set(['planning', 'running', 'cancelling']),
  cancelling: new Set(['cancelled']),
  cancelled: new Set([]),
};

const ACTIVE_NODE_STATES = new Set<HarnessNodeState>([
  'queued', 'starting', 'running', 'waiting_input', 'submitted', 'verifying',
]);

function reject<S extends string>(request: HarnessTransitionRequest<S>, code: string, reason: string): HarnessTransitionRejected<S> {
  return { accepted: false, from: request.from, to: request.to, code, reason };
}

function accept<S extends string>(request: HarnessTransitionRequest<S>): HarnessTransitionAccepted<S> {
  return { accepted: true, from: request.from, to: request.to };
}

export function evaluateNodeTransition(request: HarnessTransitionRequest<HarnessNodeState>): HarnessTransitionResult<HarnessNodeState> {
  const allowed = NODE_RULES[request.from]?.has(request.to);
  if (!allowed) return reject(request, 'illegal_transition', `节点不允许从 ${request.from} 转换为 ${request.to}`);
  const context = request.context || {};
  if (request.to === 'cancelling' && request.actor !== 'user' && request.actor !== 'cascade') {
    return reject(request, 'actor_not_allowed', '只有用户或级联取消流程可以把节点置为 cancelling');
  }
  if (request.from === 'cancelling' && request.to === 'cancelled' && request.actor !== 'orchestrator') {
    return reject(request, 'actor_not_allowed', '只有 Orchestrator 可以在清理完成后取消节点');
  }
  if (request.from === 'created' && request.to === 'queued' && request.actor !== 'orchestrator') {
    return reject(request, 'actor_not_allowed', '只有 Orchestrator 可以把 created 节点置为 queued');
  }
  if (request.from === 'created' && request.to === 'cancelled' && request.actor !== 'user' && request.actor !== 'cascade') {
    return reject(request, 'actor_not_allowed', '只有用户或级联取消流程可以取消未开始节点');
  }
  if (request.from === 'queued' && request.to === 'starting' && request.actor !== 'orchestrator') {
    return reject(request, 'actor_not_allowed', '只有 Orchestrator 可以把 queued 节点置为 starting');
  }
  if (request.from === 'starting' && request.to === 'running' && request.actor !== 'lease_holder') {
    return reject(request, 'actor_not_allowed', '只有有效租约持有者可以把 starting 节点置为 running');
  }
  if (request.from === 'starting' && request.to === 'orphaned' && request.actor !== 'recovery') {
    return reject(request, 'actor_not_allowed', '只有恢复扫描可以把 starting 节点置为 orphaned');
  }
  if (request.from === 'starting' && request.to === 'failed' && request.actor !== 'orchestrator') {
    return reject(request, 'actor_not_allowed', '只有 Orchestrator 可以裁决节点启动失败');
  }
  if (request.from === 'running' && request.to === 'submitted' && request.actor !== 'agent') {
    return reject(request, 'actor_not_allowed', '只有 Agent 可以提交 running 节点');
  }
  if (request.from === 'submitted' && request.to !== 'cancelling' && request.actor !== 'orchestrator') {
    return reject(request, 'actor_not_allowed', '只有 Orchestrator 可以处理 submitted 节点');
  }
  if (request.from === 'verifying' && request.to !== 'cancelling' && request.actor !== 'orchestrator') {
    return reject(request, 'actor_not_allowed', '只有 Orchestrator 可以裁决 verifying 节点');
  }
  if (request.from === 'waiting_input' && request.to === 'queued' && request.actor !== 'user' && request.actor !== 'main') {
    return reject(request, 'actor_not_allowed', '只有用户或 Main 可以在输入就绪后重新排队节点');
  }
  if (request.from === 'waiting_input' && (request.to === 'cancelled' || request.to === 'failed')
    && request.actor !== 'user' && request.actor !== 'timeout') {
    return reject(request, 'actor_not_allowed', '只有用户或超时策略可以终止 waiting_input 节点');
  }
  if (['failed', 'timed_out', 'interrupted'].includes(request.from) && request.to === 'queued'
    && request.actor !== 'user' && request.actor !== 'main' && request.actor !== 'orchestrator') {
    return reject(request, 'actor_not_allowed', '只有用户、Main 或自动重试流程可以重新排队节点');
  }
  if (request.from === 'orphaned' && request.to !== 'cancelling' && request.actor !== 'recovery') {
    return reject(request, 'actor_not_allowed', '只有恢复流程可以处理 orphaned 节点');
  }
  if (request.from === 'verifying' && request.to === 'queued' && context.attempts_exhausted === true) {
    return reject(request, 'attempts_exhausted', '验收失败且已达到最大尝试次数，不能重新入队');
  }
  if (['failed', 'timed_out', 'interrupted'].includes(request.from) && request.to === 'queued' && context.attempts_exhausted === true) {
    return reject(request, 'attempts_exhausted', '节点已达到最大尝试次数，不能重新入队');
  }
  if (request.from === 'orphaned' && request.to === 'queued' && context.has_handoff_artifact !== true) {
    return reject(request, 'handoff_required', 'orphaned 节点恢复入队前必须存在可靠 handoff Artifact');
  }
  if (request.from === 'orphaned' && request.to === 'failed' && context.has_handoff_artifact === true) {
    return reject(request, 'handoff_available', '存在可靠 handoff Artifact 时应恢复入队，不应直接失败');
  }
  return accept(request);
}

export function evaluateRunTransition(request: HarnessTransitionRequest<HarnessRunState>): HarnessTransitionResult<HarnessRunState> {
  if (!RUN_RULES[request.from]?.has(request.to)) {
    return reject(request, 'illegal_transition', `Run 不允许从 ${request.from} 转换为 ${request.to}`);
  }
  if (request.to === 'completed' && request.actor !== 'orchestrator' && request.actor !== 'system') {
    return reject(request, 'actor_not_allowed', '只有服务端 Orchestrator 可以正式完成 Run');
  }
  if (request.to === 'cancelling' && request.actor !== 'user' && request.actor !== 'cascade') {
    return reject(request, 'actor_not_allowed', '只有用户或级联取消流程可以把 Run 置为 cancelling');
  }
  if (request.from === 'cancelling' && request.to === 'cancelled' && request.actor !== 'orchestrator') {
    return reject(request, 'actor_not_allowed', '只有 Orchestrator 可以在清理完成后取消 Run');
  }
  if (request.from === 'failed' && (request.to === 'planning' || request.to === 'running')) {
    const context = request.context || {};
    if (context.has_retryable_node !== true || context.failure_retryable !== true) {
      return reject(request, 'retry_not_allowed', 'Run 重试需要可重试节点和可重试失败类别');
    }
  }
  return accept(request);
}

export interface HarnessTransitionRejectedEvent {
  type: 'node.transition_rejected';
  payload: {
    from: HarnessNodeState;
    to: HarnessNodeState;
    actor: HarnessTransitionActor;
    code: string;
    reason: string;
  };
}

export function toNodeTransitionRejectedEvent(
  request: HarnessTransitionRequest<HarnessNodeState>,
  result: HarnessTransitionRejected<HarnessNodeState>,
): HarnessTransitionRejectedEvent {
  return {
    type: 'node.transition_rejected',
    payload: {
      from: request.from,
      to: request.to,
      actor: request.actor,
      code: result.code,
      reason: result.reason,
    },
  };
}

export function isNodeTerminal(state: HarnessNodeState): boolean {
  return state === 'succeeded' || state === 'cancelled';
}

export function isNodeActive(state: HarnessNodeState): boolean {
  return ACTIVE_NODE_STATES.has(state);
}

export function nodeTransitionTable(): Readonly<Record<HarnessNodeState, ReadonlySet<HarnessNodeState>>> {
  return NODE_RULES;
}
