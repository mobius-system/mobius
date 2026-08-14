const assert = require('assert')
const {
  HarnessSchemaError,
  assertNoLethalTrifecta,
  parseHarnessProfile,
  parseHarnessTaskContract,
} = require('../backend/services/harness-schema')
const { contract } = require('./harness/phase1-fixture')

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
console.log('harness Phase 1 schema tests passed')
