const path = require('path')

function setup(db, tempRoot, suffix = 'p1') {
  const userId = `owner_${suffix}`
  const projectId = `project_${suffix}`
  const issueId = `issue_${suffix}`
  db.prepare(`INSERT INTO users (id, display_name, password_hash, role, work_dir)
    VALUES (?, ?, '', 'admin', ?)`).run(userId, `Owner ${suffix}`, tempRoot)
  db.prepare(`INSERT INTO projects (id, name, created_by, bind_path, can_run_session)
    VALUES (?, ?, ?, ?, 1)`).run(projectId, `Project ${suffix}`, userId, tempRoot)
  db.prepare(`INSERT INTO issues (id, project_id, title, description, created_by)
    VALUES (?, ?, ?, 'Harness test issue', ?)`).run(issueId, projectId, `Issue ${suffix}`, userId)
  return {
    user: { id: userId, role: 'admin', display_name: `Owner ${suffix}`, work_dir: tempRoot },
    userId,
    projectId,
    issueId,
  }
}

function rosterRequest(fixture, mode = 'multi') {
  const members = mode === 'single'
    ? [{ member_key: 'main', profile_id: 'system-codex-readonly-v1' }]
    : [
        { member_key: 'main', profile_id: 'system-codex-readonly-v1' },
        { member_key: 'worker', profile_id: 'system-claude-readonly-v1', purpose: 'worker' },
      ]
  return {
    anchor_type: 'issue',
    issue_id: fixture.issueId,
    goal: 'Read the supplied project facts and produce a concise, verifiable report.',
    execution_mode: mode,
    roster: { main_member_key: 'main', members },
  }
}

function contract(objective = 'Inspect the facts and report findings', dependencies = []) {
  return {
    schema_version: '1.1',
    objective,
    risk_level: 'low',
    acceptance_criteria: [
      { id: 'facts', description: 'Report covers the requested facts', verification: 'parent_review', required: true, threshold: 1 },
    ],
    inputs: [],
    deliverables: [{ kind: 'report', name: 'findings', required: true }],
    dependencies,
    workspace: { mode: 'read_only' },
    tools: { profile: 'research', capability_tags: [] },
    budget: { timeout_seconds: 300, max_cost_usd: 1 },
    communication: { parent_only: true },
  }
}

function result(criterionId = 'facts', summary = 'Verified findings') {
  return {
    schema_version: '1.1',
    status: 'succeeded',
    summary,
    acceptance_results: [{ criterion_id: criterionId, score: 1, evidence_artifact_ids: [] }],
    artifact_ids: [],
    tests: [],
    risks: [],
    unresolved: [],
    recommended_followups: [],
  }
}

function cleanup(fs, db, tempRoot) {
  try { db.close() } catch {}
  fs.rmSync(tempRoot, { recursive: true, force: true })
}

module.exports = { setup, rosterRequest, contract, result, cleanup }
