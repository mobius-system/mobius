import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import type {
  HarnessCreateRunRequestV1,
  HarnessEstimateRequestV1,
  HarnessNodeResultV1,
  HarnessProfileDefinitionV1,
  HarnessRunCreatedEventPayloadV1,
  HarnessRunPolicyV1,
  HarnessTaskContractV1,
} from '../types/harness';

const ajv = new Ajv({ allErrors: true, strict: true });
const capabilityTag = { enum: ['private_data_read', 'untrusted_ingest', 'outbound_network'] } as const;
const stringArray = { type: 'array', items: { type: 'string' } } as const;

const profileSchema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'backend', 'model', 'capabilities', 'model_traits', 'skills', 'tools', 'cost_profile', 'default_context_policy', 'default_tool_policy'],
  properties: {
    schema_version: { const: '1.1' },
    backend: { enum: ['codex', 'claude-code', 'deepseek-harness'] },
    model: { type: 'string', minLength: 1 },
    capabilities: {
      type: 'object', additionalProperties: false,
      required: ['can_main', 'can_work', 'can_evaluate', 'supports_write', 'supports_network', 'supports_runtime_verification', 'max_concurrency'],
      properties: {
        can_main: { type: 'boolean' }, can_work: { type: 'boolean' }, can_evaluate: { type: 'boolean' },
        supports_write: { type: 'boolean' }, supports_network: { type: 'boolean' },
        supports_runtime_verification: { type: 'boolean' }, max_concurrency: { type: 'integer', minimum: 1, maximum: 64 },
      },
    },
    model_traits: {
      type: 'object', additionalProperties: false,
      required: ['needs_context_reset', 'context_window_tokens', 'supports_auto_compaction'],
      properties: {
        needs_context_reset: { type: 'boolean' }, context_window_tokens: { type: 'integer', minimum: 0 },
        supports_auto_compaction: { type: 'boolean' }, calibrated: { type: 'boolean' },
      },
    },
    skills: stringArray,
    tools: {
      type: 'object', additionalProperties: false, required: ['allow', 'deny', 'capability_tags'],
      properties: { allow: stringArray, deny: stringArray, capability_tags: { type: 'array', uniqueItems: true, items: capabilityTag } },
    },
    cost_profile: { type: 'object', additionalProperties: false, required: ['relative_cost_factor'], properties: { relative_cost_factor: { type: 'number', exclusiveMinimum: 0 } } },
    default_context_policy: { type: 'object' }, default_tool_policy: { type: 'object' },
  },
} as const;

const rosterMember = {
  type: 'object', additionalProperties: false, required: ['member_key', 'profile_id'],
  properties: {
    member_key: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
    profile_id: { type: 'string', minLength: 1, maxLength: 128 },
    purpose: { enum: ['worker', 'evaluator'] },
  },
} as const;

const estimateSchema = {
  type: 'object', additionalProperties: false,
  required: ['anchor_type', 'issue_id', 'goal', 'execution_mode', 'roster'],
  properties: {
    anchor_type: { const: 'issue' }, issue_id: { type: 'string', minLength: 1, maxLength: 128 },
    session_name: { type: 'string', minLength: 1, maxLength: 500 }, language: { enum: ['zh', 'en'] },
    goal: { type: 'string', minLength: 1, maxLength: 12000 }, execution_mode: { enum: ['single', 'multi'] },
    roster: {
      type: 'object', additionalProperties: false, required: ['main_member_key', 'members'],
      properties: {
        main_member_key: { type: 'string', minLength: 1, maxLength: 32 },
        members: { type: 'array', minItems: 1, maxItems: 3, items: rosterMember },
      },
    },
    policy: { type: 'object' },
  },
} as const;

const createSchema = {
  ...estimateSchema,
  required: [...estimateSchema.required, 'request_id'],
  properties: {
    ...estimateSchema.properties,
    request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    acknowledged_estimate: {
      type: 'object', additionalProperties: false, required: ['estimate_id', 'shown_cost_usd_range'],
      properties: {
        estimate_id: { type: 'string', minLength: 8, maxLength: 4096 },
        shown_cost_usd_range: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } },
      },
    },
  },
} as const;

const criterionSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'description', 'verification', 'required'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 }, description: { type: 'string', minLength: 1, maxLength: 2000 },
    verification: { enum: ['deterministic', 'runtime_check', 'evaluator', 'parent_review'] }, required: { type: 'boolean' },
    threshold: { type: 'number', minimum: 0, maximum: 1 }, weight: { type: 'number', exclusiveMinimum: 0 },
    check: {
      type: 'object', additionalProperties: false, minProperties: 1,
      properties: { command: { type: 'string', minLength: 1 }, expect_exit_code: { type: 'integer' }, expect_artifact_kind: { type: 'string', minLength: 1 } },
    },
  },
  allOf: [
    {
      if: { properties: { verification: { enum: ['deterministic', 'runtime_check'] } }, required: ['verification'] },
      then: { properties: { check: {} }, required: ['check'] },
    },
    {
      if: { properties: { verification: { enum: ['runtime_check', 'evaluator'] } }, required: ['verification'] },
      then: { properties: { threshold: {} }, required: ['threshold'] },
    },
  ],
} as const;

const taskContractSchema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'objective', 'risk_level', 'acceptance_criteria', 'inputs', 'deliverables', 'dependencies', 'workspace', 'tools', 'budget', 'communication'],
  properties: {
    schema_version: { const: '1.1' }, objective: { type: 'string', minLength: 1, maxLength: 12000 }, risk_level: { enum: ['low', 'medium', 'high'] },
    acceptance_criteria: { type: 'array', minItems: 1, items: criterionSchema },
    inputs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'ref', 'trust'], properties: { kind: { enum: ['artifact', 'file', 'session', 'research', 'url', 'text'] }, ref: { type: 'string' }, description: { type: 'string' }, trust: { enum: ['instruction', 'data_only'] } } } },
    deliverables: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'name', 'required'], properties: { kind: { enum: ['report', 'patch', 'commit', 'file', 'test_result', 'structured_data'] }, name: { type: 'string', minLength: 1 }, required: { type: 'boolean' } } } },
    dependencies: stringArray,
    workspace: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'read_only' }, allowed_paths: stringArray } },
    tools: { type: 'object', additionalProperties: false, required: ['profile', 'capability_tags'], properties: { profile: { enum: ['research', 'coding', 'review', 'custom'] }, allow: stringArray, deny: stringArray, capability_tags: { type: 'array', uniqueItems: true, items: capabilityTag } } },
    budget: { type: 'object', additionalProperties: false, required: ['timeout_seconds'], properties: { timeout_seconds: { type: 'integer', minimum: 30, maximum: 86400 }, max_turns: { type: 'integer', minimum: 1 }, max_cost_usd: { type: 'number', exclusiveMinimum: 0 } } },
    communication: { type: 'object', additionalProperties: false, required: ['parent_only'], properties: { parent_only: { const: true }, progress_interval_seconds: { type: 'integer', minimum: 5 } } },
  },
} as const;

const resultSchema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'status', 'summary', 'acceptance_results', 'artifact_ids', 'tests', 'risks', 'unresolved', 'recommended_followups'],
  properties: {
    schema_version: { const: '1.1' }, status: { enum: ['succeeded', 'failed', 'partial'] }, summary: { type: 'string', minLength: 1 },
    acceptance_results: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['criterion_id', 'score', 'evidence_artifact_ids'], properties: { criterion_id: { type: 'string', minLength: 1 }, score: { type: 'number', minimum: 0, maximum: 1 }, evidence_artifact_ids: stringArray, detail: { type: 'string' } } } },
    artifact_ids: stringArray,
    tests: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['status'], properties: { command: { type: 'string' }, status: { enum: ['passed', 'failed', 'not_run'] }, artifact_id: { type: 'string' }, detail: { type: 'string' } } } },
    risks: stringArray, unresolved: stringArray, recommended_followups: stringArray,
  },
} as const;

const runPolicySchema = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'collaboration_shape', 'max_concurrent_subharnesses', 'max_depth', 'max_nodes', 'default_timeout_seconds', 'workspace_policy', 'evaluator_policy', 'context_reset_policy', 'cost_soft_limit_usd', 'cost_hard_limit_usd'],
  properties: {
    schema_version: { const: '1.0' }, collaboration_shape: { const: 'pipeline' }, max_concurrent_subharnesses: { const: 1 },
    max_depth: { enum: [0, 1] }, max_nodes: { enum: [1, 2, 3] },
    default_timeout_seconds: { type: 'integer', minimum: 60, maximum: 3600 }, workspace_policy: { const: 'read_only' },
    evaluator_policy: { enum: ['by_risk', 'always', 'off'] }, context_reset_policy: { const: 'off' },
    cost_soft_limit_usd: { type: 'number', minimum: 0 }, cost_hard_limit_usd: { type: 'number', exclusiveMinimum: 0 },
  },
} as const;

const storedEstimateAcknowledgementSchema = {
  type: 'object', additionalProperties: false,
  required: ['cost_range', 'duration_range', 'relative_to_single'],
  properties: {
    cost_range: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } },
    duration_range: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0 } },
    relative_to_single: { type: 'number', exclusiveMinimum: 0 },
  },
} as const;

const runCreatedEventPayloadSchema = {
  type: 'object', additionalProperties: false,
  required: ['execution_mode', 'policy', 'acknowledged_estimate'],
  properties: {
    execution_mode: { enum: ['single', 'multi'] },
    policy: runPolicySchema,
    acknowledged_estimate: { anyOf: [{ type: 'null' }, storedEstimateAcknowledgementSchema] },
  },
} as const;

const memberSnapshotSchema = {
  type: 'object', additionalProperties: false,
  required: ['member_key', 'profile_id', 'profile_version', 'definition'],
  properties: {
    member_key: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
    profile_id: { type: 'string', minLength: 1, maxLength: 128 },
    profile_version: { type: 'integer', minimum: 1 },
    definition: profileSchema,
  },
} as const;

const recordSchema = { type: 'object' } as const;

const internalCreateTaskSchema = {
  type: 'object', additionalProperties: false, required: ['request_id', 'assignee_member_id', 'task_contract'],
  properties: {
    request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    assignee_member_id: { type: 'string', minLength: 1, maxLength: 128 },
    task_contract: taskContractSchema,
  },
} as const;

const internalProgressSchema = {
  type: 'object', additionalProperties: false, required: ['request_id', 'message'],
  properties: {
    request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    message: { type: 'string', minLength: 1, maxLength: 8000 },
    percent: { type: 'number', minimum: 0, maximum: 100 },
    detail: { type: 'object' },
  },
} as const;

const internalCompleteSchema = {
  type: 'object', additionalProperties: false, required: ['request_id', 'result'],
  properties: {
    request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    result: resultSchema,
  },
} as const;

const internalFailSchema = {
  type: 'object', additionalProperties: false, required: ['request_id', 'reason'],
  properties: {
    request_id: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    reason: { type: 'string', minLength: 1, maxLength: 8000 },
    category: { enum: ['business', 'permission', 'contract', 'backend', 'unknown'] },
    retryable: { type: 'boolean' },
  },
} as const;

const validators = {
  profile: ajv.compile(profileSchema), estimate: ajv.compile(estimateSchema), create: ajv.compile(createSchema),
  task: ajv.compile(taskContractSchema), result: ajv.compile(resultSchema),
  runPolicy: ajv.compile(runPolicySchema), memberSnapshot: ajv.compile(memberSnapshotSchema),
  runCreatedEventPayload: ajv.compile(runCreatedEventPayloadSchema),
  toolPolicy: ajv.compile(taskContractSchema.properties.tools), record: ajv.compile(recordSchema),
  internalCreateTask: ajv.compile(internalCreateTaskSchema), internalProgress: ajv.compile(internalProgressSchema),
  internalComplete: ajv.compile(internalCompleteSchema), internalFail: ajv.compile(internalFailSchema),
};

export class HarnessSchemaError extends Error {
  readonly code = 'invalid_harness_schema';
  constructor(readonly schemaName: string, readonly details: string[]) {
    super(`${schemaName} 校验失败: ${details.join('; ')}`);
  }
}

function errorDetails(errors: ErrorObject[] | null | undefined): string[] {
  return (errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'invalid'}`);
}

function parse<T>(value: unknown, name: string, validate: ValidateFunction): T {
  if (!validate(value)) throw new HarnessSchemaError(name, errorDetails(validate.errors));
  return value as T;
}

export const parseHarnessProfile = (value: unknown) => parse<HarnessProfileDefinitionV1>(value, 'HarnessProfileDefinitionV1', validators.profile);
export const parseHarnessEstimateRequest = (value: unknown) => parse<HarnessEstimateRequestV1>(value, 'HarnessEstimateRequestV1', validators.estimate);
export const parseHarnessCreateRunRequest = (value: unknown) => parse<HarnessCreateRunRequestV1>(value, 'HarnessCreateRunRequestV1', validators.create);
export const parseHarnessTaskContract = (value: unknown) => parse<HarnessTaskContractV1>(value, 'HarnessTaskContractV1', validators.task);
export const parseHarnessNodeResult = (value: unknown) => parse<HarnessNodeResultV1>(value, 'HarnessNodeResultV1', validators.result);
export const parseHarnessRunPolicy = (value: unknown) => parse<HarnessRunPolicyV1>(value, 'HarnessRunPolicyV1', validators.runPolicy);
export const parseHarnessRunCreatedEventPayload = (value: unknown) => parse<HarnessRunCreatedEventPayloadV1>(value, 'HarnessRunCreatedEventPayloadV1', validators.runCreatedEventPayload);
export const parseHarnessMemberSnapshot = (value: unknown) => parse<{ member_key: string; profile_id: string; profile_version: number; definition: HarnessProfileDefinitionV1 }>(value, 'HarnessMemberSnapshot', validators.memberSnapshot);
export const parseHarnessToolPolicy = (value: unknown) => parse<HarnessTaskContractV1['tools']>(value, 'HarnessToolPolicy', validators.toolPolicy);
export const parseHarnessRecord = (value: unknown) => parse<Record<string, unknown>>(value, 'HarnessRecord', validators.record);
export const parseHarnessInternalCreateTask = (value: unknown) => parse<{ request_id: string; assignee_member_id: string; task_contract: HarnessTaskContractV1 }>(value, 'HarnessInternalCreateTask', validators.internalCreateTask);
export const parseHarnessInternalProgress = (value: unknown) => parse<{ request_id: string; message: string; percent?: number; detail?: Record<string, unknown> }>(value, 'HarnessInternalProgress', validators.internalProgress);
export const parseHarnessInternalComplete = (value: unknown) => parse<{ request_id: string; result: HarnessNodeResultV1 }>(value, 'HarnessInternalComplete', validators.internalComplete);
export const parseHarnessInternalFail = (value: unknown) => parse<{ request_id: string; reason: string; category?: string; retryable?: boolean }>(value, 'HarnessInternalFail', validators.internalFail);

export function parseJsonColumn<T>(raw: unknown, name: string, parser: (value: unknown) => T): T {
  let value: unknown;
  try { value = JSON.parse(String(raw)); } catch { throw new HarnessSchemaError(name, ['数据库 JSON 不是合法 JSON']); }
  return parser(value);
}

export function assertNoLethalTrifecta(tags: string[]): void {
  const granted = new Set(tags);
  if (['private_data_read', 'untrusted_ingest', 'outbound_network'].every((tag) => granted.has(tag))) {
    throw new HarnessSchemaError('tool_policy', ['节点不能同时拥有 private_data_read、untrusted_ingest 和 outbound_network；请移除联网、私有数据读取或不可信输入中的至少一项']);
  }
}
