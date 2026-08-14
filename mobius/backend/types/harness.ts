export type HarnessBackend = 'codex' | 'claude-code' | 'deepseek-harness';
export type HarnessCapabilityTag = 'private_data_read' | 'untrusted_ingest' | 'outbound_network';

export interface HarnessProfileDefinitionV1 {
  schema_version: '1.1';
  backend: HarnessBackend;
  model: string;
  capabilities: {
    can_main: boolean;
    can_work: boolean;
    can_evaluate: boolean;
    supports_write: boolean;
    supports_network: boolean;
    supports_runtime_verification: boolean;
    max_concurrency: number;
  };
  model_traits: {
    needs_context_reset: boolean;
    context_window_tokens: number;
    supports_auto_compaction: boolean;
    calibrated?: boolean;
  };
  skills: string[];
  tools: {
    allow: string[];
    deny: string[];
    capability_tags: HarnessCapabilityTag[];
  };
  cost_profile: { relative_cost_factor: number };
  default_context_policy: Record<string, unknown>;
  default_tool_policy: Record<string, unknown>;
}

export type HarnessExecutionMode = 'single' | 'multi';
export type HarnessMemberRole = 'main' | 'worker' | 'evaluator';
export type HarnessRiskLevel = 'low' | 'medium' | 'high';

export interface HarnessRunPolicyV1 {
  schema_version: '1.0';
  collaboration_shape: 'pipeline';
  max_concurrent_subharnesses: 1;
  max_depth: 0 | 1;
  max_nodes: 1 | 2 | 3;
  default_timeout_seconds: number;
  workspace_policy: 'read_only';
  evaluator_policy: 'by_risk' | 'always' | 'off';
  context_reset_policy: 'off';
  cost_soft_limit_usd: number;
  cost_hard_limit_usd: number;
}

export interface HarnessRosterDraftMemberV1 {
  member_key: string;
  profile_id: string;
  purpose?: 'worker' | 'evaluator';
}

export interface HarnessEstimateRequestV1 {
  anchor_type: 'issue';
  issue_id: string;
  goal: string;
  execution_mode: HarnessExecutionMode;
  roster: {
    main_member_key: string;
    members: HarnessRosterDraftMemberV1[];
  };
  policy?: Partial<HarnessRunPolicyV1>;
}

export interface HarnessEstimateAcknowledgementV1 {
  estimate_id: string;
  shown_cost_usd_range: [number, number];
}

export interface HarnessCreateRunRequestV1 extends HarnessEstimateRequestV1 {
  request_id: string;
  acknowledged_estimate?: HarnessEstimateAcknowledgementV1;
}

export interface HarnessAcceptanceCriterionV1 {
  id: string;
  description: string;
  verification: 'deterministic' | 'runtime_check' | 'evaluator' | 'parent_review';
  required: boolean;
  threshold?: number;
  weight?: number;
  check?: { command?: string; expect_exit_code?: number; expect_artifact_kind?: string };
}

export interface HarnessTaskContractV1 {
  schema_version: '1.1';
  objective: string;
  risk_level: HarnessRiskLevel;
  acceptance_criteria: HarnessAcceptanceCriterionV1[];
  inputs: Array<{
    kind: 'artifact' | 'file' | 'session' | 'research' | 'url' | 'text';
    ref: string;
    description?: string;
    trust: 'instruction' | 'data_only';
  }>;
  deliverables: Array<{
    kind: 'report' | 'patch' | 'commit' | 'file' | 'test_result' | 'structured_data';
    name: string;
    required: boolean;
  }>;
  dependencies: string[];
  workspace: { mode: 'read_only'; allowed_paths?: string[] };
  tools: {
    profile: 'research' | 'coding' | 'review' | 'custom';
    allow?: string[];
    deny?: string[];
    capability_tags: HarnessCapabilityTag[];
  };
  budget: { timeout_seconds: number; max_turns?: number; max_cost_usd?: number };
  communication: { parent_only: true; progress_interval_seconds?: number };
}

export interface HarnessNodeResultV1 {
  schema_version: '1.1';
  status: 'succeeded' | 'failed' | 'partial';
  summary: string;
  acceptance_results: Array<{
    criterion_id: string;
    score: number;
    evidence_artifact_ids: string[];
    detail?: string;
  }>;
  artifact_ids: string[];
  tests: Array<{
    command?: string;
    status: 'passed' | 'failed' | 'not_run';
    artifact_id?: string;
    detail?: string;
  }>;
  risks: string[];
  unresolved: string[];
  recommended_followups: string[];
}

export interface HarnessInternalTokenPayload {
  kind: 'harness-node';
  run_id: string;
  node_id: string;
  member_id: string;
  role: HarnessMemberRole;
  allowed_member_ids: string[];
  actions: string[];
  iat?: number;
  exp?: number;
}
