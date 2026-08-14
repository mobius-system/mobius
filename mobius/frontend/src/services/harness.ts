import { api } from '../store'

export type HarnessExecutionMode = 'single' | 'multi'
export type HarnessMemberRole = 'main' | 'worker' | 'evaluator'

export interface HarnessProfile {
  id: string
  name: string
  description: string
  backend: 'codex' | 'claude-code' | 'deepseek-harness'
  default_model: string
  version: number
  definition: {
    capabilities: {
      can_main: boolean
      can_work: boolean
      can_evaluate: boolean
      supports_write: boolean
      supports_network: boolean
      supports_runtime_verification: boolean
    }
    cost_profile: { relative_cost_factor: number }
  }
}

export interface HarnessRosterMemberDraft {
  member_key: string
  profile_id: string
  purpose?: 'worker' | 'evaluator'
}

export interface HarnessRunDraft {
  anchor_type: 'issue'
  issue_id: string
  goal: string
  execution_mode: HarnessExecutionMode
  roster: {
    main_member_key: string
    members: HarnessRosterMemberDraft[]
  }
}

export interface HarnessEstimate {
  estimate_id: string
  expires_at: string
  estimated_duration_seconds_range: [number, number]
  estimated_cost_usd_range: [number, number]
  relative_to_single: number
  assumptions: string[]
}

export interface HarnessRunRecord {
  id: string
  goal: string
  execution_mode: HarnessExecutionMode
  status: string
  node_count?: number
  succeeded_node_count?: number
  created_at: string
  started_at?: string | null
  completed_at?: string | null
  updated_at: string
  policy: Record<string, unknown>
  final_result?: HarnessNodeResult | null
  failure?: { reason?: string } | null
  actual_cost_usd?: number
  cost_telemetry_status?: 'not_started' | 'reported' | 'zero_or_unreported'
  acknowledged_estimate?: {
    cost_range: [number, number]
    duration_range: [number, number]
    relative_to_single: number
  } | null
}

export interface HarnessMemberSnapshot {
  id: string
  role: HarnessMemberRole
  display_name: string
  selection_order: number
  config_snapshot: {
    member_key: string
    profile_id: string
    profile_version: number
  }
}

export interface HarnessNodeResult {
  status: 'succeeded' | 'failed' | 'partial'
  summary: string
  risks: string[]
  unresolved: string[]
  recommended_followups: string[]
}

export interface HarnessNodeSnapshot {
  id: string
  parent_node_id?: string | null
  assignee_member_id: string
  path: string
  node_type: 'root' | 'worker' | 'evaluator'
  status: string
  model: string
  created_at: string
  started_at?: string | null
  completed_at?: string | null
  task_contract: { objective: string; workspace: { mode: 'read_only' } }
  result?: HarnessNodeResult | null
  failure_json?: string | null
  actual_cost_usd?: number
  cost_telemetry_status?: 'not_started' | 'reported' | 'zero_or_unreported'
}

export interface HarnessEvent {
  event_id: string
  seq: number
  type: string
  from_node_id?: string | null
  to_node_id?: string | null
  created_at: string
  payload: Record<string, unknown>
}

export interface HarnessDispatchSnapshot {
  id: string
  node_id: string
  kind: string
  status: string
  attempt: number
  last_error?: string | null
}

export interface HarnessRunSnapshot {
  run: HarnessRunRecord
  members: HarnessMemberSnapshot[]
  nodes: HarnessNodeSnapshot[]
  dependencies: Array<{ node_id: string; depends_on_node_id: string }>
  dispatches: HarnessDispatchSnapshot[]
  events: HarnessEvent[]
}

export function listHarnessProfiles(projectId: string, signal?: AbortSignal): Promise<HarnessProfile[]> {
  return api(`/api/harness-profiles?project_id=${encodeURIComponent(projectId)}`, { signal })
}

export function estimateHarnessRun(draft: HarnessRunDraft, signal?: AbortSignal): Promise<HarnessEstimate> {
  return api('/api/harness-runs/estimate', {
    method: 'POST',
    body: JSON.stringify(draft),
    signal,
  })
}

export function createHarnessRun(
  draft: HarnessRunDraft,
  estimate?: HarnessEstimate,
): Promise<HarnessRunSnapshot> {
  return api('/api/harness-runs', {
    method: 'POST',
    body: JSON.stringify({
      ...draft,
      request_id: `ui:${crypto.randomUUID()}`,
      ...(estimate ? {
        acknowledged_estimate: {
          estimate_id: estimate.estimate_id,
          shown_cost_usd_range: estimate.estimated_cost_usd_range,
        },
      } : {}),
    }),
  })
}

export function listHarnessRuns(issueId: string, signal?: AbortSignal): Promise<HarnessRunRecord[]> {
  return api(`/api/harness-runs?issue_id=${encodeURIComponent(issueId)}`, { signal })
}

export function getHarnessRun(runId: string, signal?: AbortSignal): Promise<HarnessRunSnapshot> {
  return api(`/api/harness-runs/${encodeURIComponent(runId)}`, { signal })
}

export function isHarnessRunTerminal(status: string): boolean {
  return ['completed', 'failed', 'cancelled'].includes(status)
}
