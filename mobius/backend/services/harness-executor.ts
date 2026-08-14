export interface HarnessSessionSpec {
  runId: string;
  nodeId: string;
  memberId: string;
  model?: string | null;
  workspacePath?: string | null;
}

export interface HarnessDispatchInput {
  runId: string;
  nodeId: string;
  sessionId: string;
  requestId: string;
  prompt: string;
  receiptMarker: string;
  scopedToken: string;
}

export type HarnessDeliveryEvidence = 'observed' | 'inferred' | 'absent' | 'unknown';

export interface HarnessDispatchOutcome {
  delivered: boolean;
  evidence: HarnessDeliveryEvidence;
  sessionId?: string;
  detail?: string;
}

export interface HarnessDispatchRow {
  id: string;
  runId: string;
  nodeId: string;
  requestId: string;
  receiptMarker: string;
  targetSessionId?: string | null;
}

export interface HarnessExecutor {
  readonly kind: string;
  readonly providesDeliveryConfirmation: boolean;
  readonly supportsThreadFork: boolean;
  readonly supportsInlineApproval: boolean;
  startSession(spec: HarnessSessionSpec): Promise<{ sessionId: string }>;
  dispatch(input: HarnessDispatchInput): Promise<HarnessDispatchOutcome>;
  interrupt(sessionId: string): Promise<void>;
  reconcile?(dispatch: HarnessDispatchRow): Promise<HarnessDeliveryEvidence>;
}

export class HarnessExecutorRegistry {
  private readonly executors = new Map<string, HarnessExecutor>();

  register(executor: HarnessExecutor): void {
    if (!executor.kind || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(executor.kind)) {
      throw new Error('executor kind must be a lowercase identifier');
    }
    if (this.executors.has(executor.kind)) throw new Error(`executor already registered: ${executor.kind}`);
    this.executors.set(executor.kind, executor);
  }

  get(kind: string): HarnessExecutor | undefined {
    return this.executors.get(kind);
  }

  list(): HarnessExecutor[] {
    return [...this.executors.values()];
  }
}
