const assert = require('assert')
const {
  HarnessSchemaError,
  assertNoLethalTrifecta,
  parseHarnessCreateRunRequest,
  parseHarnessInternalComplete,
  parseHarnessInternalCreateTask,
  parseHarnessInternalFail,
  parseHarnessInternalProgress,
  parseHarnessProfile,
  parseHarnessTaskContract,
} = require('../backend/services/harness-schema')
const { contract, result } = require('./harness/phase1-fixture')

function assertRequestIdValidation(parser, validValue) {
  assert.doesNotThrow(() => parser(validValue))
  const missing = { ...validValue }
  delete missing.request_id
  assert.throws(() => parser(missing), HarnessSchemaError)
  assert.throws(() => parser({ ...validValue, request_id: 'short' }), HarnessSchemaError)
  assert.throws(() => parser({ ...validValue, request_id: 'invalid request id' }), HarnessSchemaError)
}

const deepseek = parseHarnessProfile({
  schema_version: '1.1',
  backend: 'deepseek-harness',
  model: 'deepseek-harness:test',
  capabilities: {
    can_main: true, can_work: true, can_evaluate: true, supports_write: false,
    supports_network: false, supports_runtime_verification: false, max_concurrency: 1,
  },
  model_traits: { needs_context_reset: false, context_window_tokens: 64000, supports_auto_compaction: false },
  skills: [],
  tools: { allow: [], deny: [], capability_tags: [] },
  cost_profile: { relative_cost_factor: 0.8 },
  default_context_policy: {},
  default_tool_policy: {},
})
assert.equal(deepseek.backend, 'deepseek-harness')
assert.equal(parseHarnessTaskContract(contract()).workspace.mode, 'read_only')
assert.throws(() => parseHarnessTaskContract({ ...contract(), workspace: { mode: 'isolated_worktree' } }), HarnessSchemaError)
assert.doesNotThrow(() => assertNoLethalTrifecta(['private_data_read', 'untrusted_ingest']))
assert.throws(
  () => assertNoLethalTrifecta(['private_data_read', 'untrusted_ingest', 'outbound_network']),
  /不能同时拥有/,
)
assertRequestIdValidation(parseHarnessCreateRunRequest, {
  anchor_type: 'issue',
  issue_id: 'issue-schema',
  goal: 'Validate request ids',
  execution_mode: 'single',
  roster: {
    main_member_key: 'main',
    members: [{ member_key: 'main', profile_id: 'system-codex-readonly-v1' }],
  },
  request_id: 'schema-create-request',
})
assertRequestIdValidation(parseHarnessInternalCreateTask, {
  request_id: 'schema-task-request',
  assignee_member_id: 'member-schema',
  task_contract: contract(),
})
assertRequestIdValidation(parseHarnessInternalProgress, {
  request_id: 'schema-progress-request',
  message: 'Validated progress',
})
assertRequestIdValidation(parseHarnessInternalComplete, {
  request_id: 'schema-complete-request',
  result: result(),
})
assertRequestIdValidation(parseHarnessInternalFail, {
  request_id: 'schema-failure-request',
  reason: 'Validated failure',
})
console.log('harness Phase 1 schema tests passed')
