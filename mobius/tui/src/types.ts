/**
 * Domain + protocol types for the Mobius terminal client.
 *
 * The domain interfaces (User / Project / Issue / Session / Message /
 * SessionModelOption) are copied verbatim from the mobius web frontend
 * (frontend/src/store.ts, frontend/src/components/session-model-picker.tsx).
 * The jsonl entry / render-block types are copied verbatim from
 * frontend/src/components/viewer/types.ts. Keeping them identical lets the TUI
 * consume the backend's JSON payloads without translation and lets us reuse the
 * frontend's entry-classification logic (see lib/entry-view.ts).
 */

// ── Auth / user ──────────────────────────────────────────────────────────────
export interface User {
  id: string
  display_name: string
  role: string
  work_dir?: string
}

export interface LoginResponse {
  token: string
  user: User
}

export interface AuthConfig {
  password_required: boolean
}

// ── Projects ─────────────────────────────────────────────────────────────────
export interface GitRepo {
  url: string
  name?: string
}

export interface Project {
  id: string
  name: string
  description?: string
  created_by?: string
  created_at?: string
  last_active?: string
  issue_count?: number
  starred?: boolean
  bind_path?: string
  bind_path_manual?: boolean
  git_repos?: GitRepo[]
  default_use_worktree?: boolean
  research_enabled?: boolean
  visibility?: string
  access?: ResourceAccess
  can_manage?: boolean
  can_create_issue?: boolean
  can_create_session?: boolean
  can_run_session?: boolean
  kind?: 'normal' | 'extension'
  disabled?: boolean
  hidden?: boolean
  is_self_develop?: boolean
  default_model?: string
}

// ── Issues (tasks) ───────────────────────────────────────────────────────────
export interface Issue {
  id: string
  project_id: string
  title: string
  description?: string
  status?: string
  created_by?: string
  pinned?: boolean
  created_at?: string
  last_active?: string
  message_count?: number
  session_count?: number
  visibility?: string
  access?: ResourceAccess
  can_manage?: boolean
  use_worktree?: boolean
  worktree_branch?: string
}

// ── Sessions ─────────────────────────────────────────────────────────────────
export interface PcClientMetadata {
  work_mode: 'hub' | 'pc' | 'dual'
  aimux_id: string
  local_path?: string
  is_tui: boolean
  add_remote_aimux_mcp?: boolean
}

// NOTE: the identifier field is `session_id`, not `id`.
export interface Session {
  session_id: string
  issue_id?: string
  project_id?: string
  scope_type?: 'issue' | 'research'
  research_id?: string
  research_role?: string
  user_id: string
  name: string
  description?: string
  session_key?: string
  status?: string
  agent_status?: string
  model?: string
  model_label?: string
  use_proxy?: boolean | number
  language?: 'zh' | 'en'
  risk_level?: string
  message_count?: number
  turn_count?: number
  raw_entry_count?: number
  created_at?: string
  last_active?: string
  pc_client_metadata?: PcClientMetadata | string | null
  issue_title?: string
  project_name?: string
  user_display_name?: string
}

/**
 * Live execution state returned by GET /api/sessions/:id/status.
 * This endpoint, rather than the persisted Session.agent_status field or an
 * SSE typing event, is the backend's source of truth for whether an agent is
 * currently doing work.
 */
export interface SessionRuntimeStatus {
  session_id: string
  alive: boolean
  working: boolean
  job_accomplished?: boolean
  failed?: boolean
  failed_reason?: string | null
  failed_at?: string | null
  pid?: number | null
  agent_backend?: string
  real_time_info?: string
  model_available?: boolean
}

// ── Preferences lookups ──────────────────────────────────────────────────────
export interface SessionModelOption {
  key: string
  value?: string
  model?: string
  label: string
  title: string
  sub: string
  backend: string
  imported?: boolean
  use_proxy?: 0 | 1 | boolean | null
}

// Skills / Memories have no TS interface in the web frontend (typed any[]);
// these are reconstructed from observed fields so the TUI pickers are typed.
export interface Skill {
  id: string
  scope: 'user' | 'project' | 'builtin'
  owner_id?: string
  name: string
  description?: string
  research_role?: string
  body?: string
  created_by?: string
  created_at?: string
  updated_at?: string
}

export interface Memory {
  id: string
  scope: 'user' | 'project'
  owner_id?: string
  name: string
  description?: string
  body?: string
  managed_kind?: string
  created_by?: string
  created_at?: string
  updated_at?: string
}

// ── Shared resource visibility ───────────────────────────────────────────────
export type ResourceVisibility = 'inherit' | 'private' | 'team' | 'public' | 'allowlist'
export interface ResourceAccess {
  visibility?: ResourceVisibility
  allow_user_ids?: string[]
  allow_group_ids?: string[]
}

// ════════════════════════════════════════════════════════════════════════════
// JSONL streaming entry types — copied from frontend/src/components/viewer/types.ts
// ════════════════════════════════════════════════════════════════════════════
export type AnyEntry = Record<string, any>

// ── SSE envelope events (GET /api/sessions/:id/events) ───────────────────────
// Each SSE frame's data is a JSON object with an `event` discriminator.
export type SseEvent =
  | { event: 'subscribed'; session: Session }
  | { event: 'history'; messages: any[]; total?: number }
  | { event: 'jsonl_meta'; session_id: string; total?: number; total_approximate?: number; tail_count?: number; jsonl_path?: string }
  | { event: 'jsonl_history'; reset?: boolean; done?: boolean; chunk_index?: number; count?: number; entries: AnyEntry[] }
  | { event: 'jsonl_entry'; session_id: string; entry: AnyEntry }
  | { event: 'typing'; active: boolean }
  | { event: 'error'; message?: string; category?: string }
  | { event: 'server_error'; message?: string }
  | { event: string; [k: string]: any }

// Claude SDK content blocks found inside entry.message.content[]
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'thinking'; thinking?: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: any; is_error?: boolean }
  | { type: string; [k: string]: any }
