import fs from 'fs';
import path from 'path';
import { PORT, TEST_ROOT } from '../config';
import { db } from '../../db';
import { externalSessionContext } from './trust-boundary';
import { mintHarnessNodeToken } from './harness-token';
import { parseHarnessMemberSnapshot, parseHarnessTaskContract, parseJsonColumn } from './harness-schema';

type AnyRow = Record<string, any>;

function readSystemSkill(name: string): string {
  const skillPath = path.join(TEST_ROOT, 'skills', name, 'SKILL.md');
  return fs.readFileSync(skillPath, 'utf8').trim();
}

function apiBase(): string {
  return `http://127.0.0.1:${PORT}/api/harness-internal`;
}

function componentEnabled(name: string): boolean {
  const raw = process.env[name];
  return raw === undefined || ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function contextRows(nodeId: string): { run: AnyRow; node: AnyRow; member: AnyRow; members: AnyRow[]; issue: AnyRow; project: AnyRow } {
  const node = db.prepare('SELECT * FROM harness_nodes WHERE id = ?').get(nodeId) as AnyRow | undefined;
  if (!node) throw new Error(`Harness Node 不存在: ${nodeId}`);
  const run = db.prepare('SELECT * FROM harness_runs WHERE id = ?').get(node.run_id) as AnyRow;
  const member = db.prepare('SELECT * FROM harness_run_members WHERE id = ? AND run_id = ?').get(node.assignee_member_id, node.run_id) as AnyRow;
  const members = db.prepare('SELECT * FROM harness_run_members WHERE run_id = ? ORDER BY selection_order').all(node.run_id) as AnyRow[];
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(run.issue_id) as AnyRow;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(run.project_id) as AnyRow;
  return { run, node, member, members, issue, project };
}

function profileSnapshot(member: AnyRow): AnyRow {
  return parseJsonColumn(member.config_snapshot_json, 'harness_run_members.config_snapshot_json', parseHarnessMemberSnapshot);
}

function curlCommand(input: { method?: 'GET' | 'POST'; path: string; body?: unknown }): string[] {
  const command = [
    `curl --silent --show-error --fail-with-body --request ${input.method || 'GET'} \\`,
    '  --header "Authorization: Bearer ${MOBIUS_HARNESS_TOKEN}" \\',
  ];
  if (input.body !== undefined) {
    command.push("  --header 'Content-Type: application/json' \\", '  --data-binary @- \\');
  }
  command.push(`  '${apiBase()}${input.path}'${input.body === undefined ? '' : " <<'MOBIUS_JSON'"}`);
  if (input.body !== undefined) {
    command.push(JSON.stringify(input.body, null, 2), 'MOBIUS_JSON');
  }
  return command;
}

function actionProtocol(input: {
  run: AnyRow;
  node: AnyRow;
  member: AnyRow;
  members: AnyRow[];
  contract: AnyRow;
}): string[] {
  const { run, node, member, members, contract } = input;
  const requestSuffix = '<new-unique-id>';
  const result = {
    schema_version: '1.1',
    status: 'succeeded',
    summary: 'Replace with the verified read-only result.',
    acceptance_results: contract.acceptance_criteria.map((criterion: AnyRow) => ({
      criterion_id: criterion.id,
      score: 1,
      evidence_artifact_ids: [],
      detail: 'Replace with concrete evidence for this criterion.',
    })),
    artifact_ids: [],
    tests: [],
    risks: [],
    unresolved: [],
    recommended_followups: [],
  };
  const lines = [
    '## Exact internal action protocol',
    '',
    'Run these requests only against the localhost endpoint shown below. Replace every <new-unique-id> before each POST; never reuse a request_id for a different business action. Do not place the token in a URL, event, result, log, or user-facing response.',
    '',
    '### Report progress',
    '```bash',
    ...curlCommand({
      method: 'POST',
      path: `/nodes/${node.id}/progress`,
      body: { request_id: `progress-${requestSuffix}`, message: 'Replace with concrete progress.', percent: 50, detail: {} },
    }),
    '```',
    '',
    '### Complete this node',
    'Completion is a terminal action. Call this endpoint exactly once, only after the full result is ready. Never probe or test this endpoint with a minimal payload. The criterion_id values below exactly match this node Task Contract. Change scores when evidence does not justify success. For status=succeeded, unresolved must be []; any unresolved entry is an acceptance blocker and the server will fail the node. Put non-blocking limitations in risks and future improvements in recommended_followups.',
    '```bash',
    ...curlCommand({
      method: 'POST',
      path: `/nodes/${node.id}/complete`,
      body: { request_id: `complete-${requestSuffix}`, result },
    }),
    '```',
    '',
    '### Fail this node',
    '```bash',
    ...curlCommand({
      method: 'POST',
      path: `/nodes/${node.id}/fail`,
      body: { request_id: `fail-${requestSuffix}`, reason: 'Replace with the concrete blocking reason.', category: 'contract', retryable: false },
    }),
    '```',
  ];
  if (member.role === 'main') {
    const firstSub = members.find((item) => item.role !== 'main');
    lines.push(
      '',
      '### Read the locked roster',
      '```bash',
      ...curlCommand({ path: `/runs/${run.id}/members` }),
      '```',
      '',
      '### Read structured events with a cursor and long poll',
      'Set after_seq to the largest seq already processed. The server waits at most 30 seconds and returns an empty events array on timeout.',
      '```bash',
      ...curlCommand({ path: `/runs/${run.id}/events?after_seq=0&wait_ms=30000` }),
      '```',
    );
    if (run.execution_mode === 'multi' && firstSub) {
      lines.push(
        '',
        '### Create the first read-only Sub task',
        'Use only a member_id from the locked roster. For a later pipeline node, replace dependencies with exactly the preceding Sub node id returned by this action.',
        '```bash',
        ...curlCommand({
          method: 'POST',
          path: `/runs/${run.id}/nodes`,
          body: {
            request_id: `assign-${requestSuffix}`,
            assignee_member_id: firstSub.id,
            task_contract: {
              schema_version: '1.1',
              objective: 'Inspect the supplied Issue and return a bounded, verifiable read-only report.',
              risk_level: 'low',
              acceptance_criteria: [{ id: 'read-only-findings', description: 'Findings answer the delegated objective and cite concrete evidence.', verification: 'parent_review', required: true, threshold: 1 }],
              inputs: [],
              deliverables: [{ kind: 'report', name: 'findings', required: true }],
              dependencies: [],
              workspace: { mode: 'read_only' },
              tools: { profile: 'research', capability_tags: [] },
              budget: { timeout_seconds: 300, max_cost_usd: 1 },
              communication: { parent_only: true, progress_interval_seconds: 30 },
            },
          },
        }),
        '```',
      );
    }
  }
  return lines;
}

export function buildHarnessContext(nodeId: string): { prompt: string; token: string } {
  const { run, node, member, members, issue, project } = contextRows(nodeId);
  const role = member.role as 'main' | 'worker' | 'evaluator';
  const allowedMemberIds = role === 'main' ? members.map((item) => item.id) : [member.id];
  const token = mintHarnessNodeToken({ runId: run.id, nodeId: node.id, memberId: member.id, role, allowedMemberIds });
  const contract = parseJsonColumn(node.task_contract_json, 'harness_nodes.task_contract_json', parseHarnessTaskContract);
  const selectedSkill = role === 'main' ? 'harness-main-agent' : role === 'evaluator' ? 'harness-evaluator-agent' : 'harness-sub-agent';
  const base = [
    '# Mobius Main/Sub Harness Context',
    '',
    `- Run: ${run.id}`,
    `- Node: ${node.id}`,
    `- Path: ${node.path}`,
    `- Role: ${role}`,
    `- Collaboration shape: pipeline`,
    `- Workspace enforcement: prompt_enforced read_only (Phase 1 does not provide an OS sandbox)`,
    '',
    `Project: ${project?.name || run.project_id}`,
    `Issue: ${issue?.title || run.issue_id}`,
    `User goal: ${run.goal}`,
    '',
    '## Internal API',
    `Endpoint: ${apiBase()}`,
    'Authorization: read MOBIUS_HARNESS_TOKEN from the process environment; never copy a bearer token from this prompt.',
    'Every POST must include a unique request_id. Replaying it returns the original result.',
    '',
  ];
  if (role === 'main') {
    const roster = members.map((item) => {
      const snapshot = profileSnapshot(item);
      return { member_id: item.id, member_key: snapshot.member_key, role: item.role, profile_id: snapshot.profile_id, name: item.display_name, capabilities: snapshot.definition.capabilities };
    });
    base.push('## Locked Roster', JSON.stringify(roster, null, 2), '',
      'You may delegate only to the member_id values above. You cannot add profiles, change Main, or start another Harness Run.',
      'POST /runs/' + run.id + '/nodes implements create_task_for_member.',
      'GET /runs/' + run.id + '/events returns structured child progress. Do not infer state from prose.', '');
  } else {
    base.push(`Parent node: ${node.parent_node_id || 'none'}`, 'You cannot access siblings or finalize the Run.', '');
  }
  if (componentEnabled('HARNESS_CONTEXT_PROTOCOL_ENABLED')) {
    base.push(...actionProtocol({ run, node, member, members, contract }), '');
  }
  base.push('## Task Contract', JSON.stringify(contract, null, 2));
  if (componentEnabled('HARNESS_SYSTEM_SKILLS_ENABLED')) {
    base.push('', '## Forced System Skill', readSystemSkill(selectedSkill));
  }
  const dataOnlyInputs = contract.inputs.filter((input) => input.trust === 'data_only');
  if (dataOnlyInputs.length) {
    base.push('', '## Untrusted data-only inputs', externalSessionContext(JSON.stringify(dataOnlyInputs, null, 2)));
  }
  return { prompt: base.join('\n'), token };
}
