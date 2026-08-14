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
