const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-harness-session-context-'))
process.env.DB_PATH = path.join(tempRoot, 'mobius.db')
process.env.MOBIUS_DATA_PATH = tempRoot
process.env.CORE_DATA_PATH = tempRoot
process.env.MODEL_ACCESS_PATH = path.join(tempRoot, 'model-access.json')

const { db } = require('../db')
const { setup, rosterRequest, cleanup } = require('./harness/phase1-fixture')
const { createHarnessRun, resolveRoster } = require('../backend/repositories/harness')
const { estimateHarnessRun } = require('../backend/services/harness-estimator')
const { MobiusSessionHarnessExecutor } = require('../backend/services/harness-executor-session')
const { runSessionMessage } = require('../backend/services/session-message-runner')
const { Sessions } = require('../backend/repositories/sessions')
const modelRegistry = require('../backend/services/model-registry').default
const agents = require('../backend/agents')
const { resolveClaudeProxyMode } = require('../backend/agents/tmux-claude-code')
const { runtimeEnvEntries } = require('../backend/agents/runtime-env')
const { redactEnvironmentArgs } = require('../backend/agents/tmux-operation-log')

async function main() {
  assert.deepEqual(resolveClaudeProxyMode(true, false), { forceNoProxy: false, useProxy: true })
  assert.deepEqual(resolveClaudeProxyMode(true, true), { forceNoProxy: true, useProxy: false })
  assert.deepEqual(resolveClaudeProxyMode(undefined, false, true), { forceNoProxy: false, useProxy: true })

  const fixture = setup(db, tempRoot, 'session_context')
  const captured = []
  const originalResolve = modelRegistry.resolveSessionModel
  const originalLaunch = modelRegistry.launchOptionsForSession
  const originalGetAgent = agents.get

  modelRegistry.resolveSessionModel = () => ({ backend: 'capture-backend', model: 'capture-model' })
  modelRegistry.launchOptionsForSession = () => ({ backend: 'capture-backend', model: 'capture-model' })
  agents.get = () => ({
    name: 'capture-backend',
    noPauseCurrentAndQueueQueryAtSession: async (options) => captured.push(options),
    listSessions: () => [],
  })

  try {
    const draft = {
      ...rosterRequest(fixture, 'single'),
      session_name: 'Named Harness session',
      language: 'en',
      excluded_skill_ids: ['skill-disabled'],
      excluded_memory_ids: ['memory-disabled'],
    }
    const roster = resolveRoster(fixture.userId, fixture.projectId, draft)
    const estimate = estimateHarnessRun(
      fixture.userId,
      draft,
      roster.map((member) => ({ id: member.profile.id, definition: member.profile.definition })),
    )
    const snapshot = createHarnessRun(fixture.userId, fixture.projectId, {
      ...draft,
      request_id: 'session-context-create',
      acknowledged_estimate: {
        estimate_id: estimate.estimate_id,
        shown_cost_usd_range: estimate.estimated_cost_usd_range,
      },
    })
    const root = snapshot.nodes.find((node) => node.node_type === 'root')
    const executor = new MobiusSessionHarnessExecutor()
    const session = await executor.startSession({
      runId: snapshot.run.id,
      nodeId: root.id,
      memberId: root.assignee_member_id,
    })
    const createdSession = Sessions.findById(session.sessionId)
    assert.equal(createdSession.name, draft.session_name)
    assert.equal(createdSession.language, 'en')
    assert.deepEqual(JSON.parse(createdSession.session_excluded_skills), draft.excluded_skill_ids)
    assert.deepEqual(JSON.parse(createdSession.session_excluded_memories), draft.excluded_memory_ids)
    assert.ok(createdSession.session_selection_snapshot)
    await executor.dispatch({
      runId: snapshot.run.id,
      nodeId: root.id,
      sessionId: session.sessionId,
      requestId: 'session-context-dispatch',
      prompt: 'HARNESS_ONLY_CONTEXT',
      receiptMarker: 'MOBIUS_HARNESS_DISPATCH[test-context]',
      scopedToken: 'TEST_SCOPED_TOKEN',
    })

    assert.equal(captured.length, 1)
    assert.match(captured[0].prompt, /HARNESS_ONLY_CONTEXT/)
    assert.match(captured[0].prompt, /Harness test issue/)
    assert.match(captured[0].prompt, /Dispatch receipt marker: MOBIUS_HARNESS_DISPATCH\[test-context\]/)
    assert.ok(!captured[0].prompt.includes('TEST_SCOPED_TOKEN'))
    assert.deepEqual(captured[0].runtimeEnv, { MOBIUS_HARNESS_TOKEN: 'TEST_SCOPED_TOKEN' })

    assert.deepEqual(runtimeEnvEntries({ MOBIUS_HARNESS_TOKEN: 'token-value' }), [['MOBIUS_HARNESS_TOKEN', 'token-value']])
    assert.throws(() => runtimeEnvEntries({ lower_case: 'value' }), /Invalid runtime environment key/)
    assert.throws(() => runtimeEnvEntries({ MOBIUS_HARNESS_TOKEN: 'bad\0value' }), /Invalid runtime environment value/)
    assert.throws(() => runtimeEnvEntries({ MOBIUS_HARNESS_TOKEN: 'x'.repeat(8193) }), /Invalid runtime environment value/)
    assert.deepEqual(
      redactEnvironmentArgs(
        ['new-window', '-e', 'MOBIUS_HARNESS_TOKEN=secret-value', '-e', 'MODEL_API_KEY=model-secret', '-n', 'test-window'],
        ['MOBIUS_HARNESS_TOKEN', 'MODEL_API_KEY'],
      ),
      ['new-window', '-e', 'MOBIUS_HARNESS_TOKEN=***', '-e', 'MODEL_API_KEY=***', '-n', 'test-window'],
    )

    Sessions.insert({
      session_id: 'ordinary-session-context-test',
      issue_id: fixture.issueId,
      project_id: fixture.projectId,
      scope_type: 'issue',
      user_id: fixture.userId,
      name: 'Ordinary session',
      description: 'Normal first-turn context behavior',
      session_key: 'ordinary-session-context-test',
      model: 'capture-model',
      language: 'zh',
    })
    await runSessionMessage({
      user: fixture.user,
      sessionId: 'ordinary-session-context-test',
      content: 'NORMAL_USER_TASK',
      requestId: 'normal-session-message',
      source: 'http.session.messages',
    })
    assert.equal(captured.length, 2)
    assert.match(captured[1].prompt, /NORMAL_USER_TASK/)
    assert.match(captured[1].prompt, /Harness test issue/)
    assert.notEqual(captured[1].prompt, 'NORMAL_USER_TASK')

    await assert.rejects(
      runSessionMessage({
        user: fixture.user,
        sessionId: 'ordinary-session-context-test',
        content: 'BYPASS_ATTEMPT',
        source: 'http.session.messages',
        initialContextMode: 'provided',
      }),
      (error) => error.status === 403 && error.category === 'initial_context_mode_forbidden',
    )

    await assert.rejects(
      runSessionMessage({
        user: fixture.user,
        sessionId: 'ordinary-session-context-test',
        content: 'RUNTIME_ENV_BYPASS_ATTEMPT',
        source: 'http.session.messages',
        runtimeEnv: { MOBIUS_HARNESS_TOKEN: 'forbidden' },
      }),
      (error) => error.status === 403 && error.category === 'runtime_env_forbidden',
    )

    console.log('harness session context isolation tests passed')
  } finally {
    modelRegistry.resolveSessionModel = originalResolve
    modelRegistry.launchOptionsForSession = originalLaunch
    agents.get = originalGetAgent
  }
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => cleanup(fs, db, tempRoot))
