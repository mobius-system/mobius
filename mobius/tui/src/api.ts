/**
 * Mobius HTTP API client (Node fetch + Bearer auth).
 *
 * Endpoint map + payload shapes mirror the mobius web frontend's `api()` helper
 * (frontend/src/store.ts) and the backend routes (backend/routes/*). Auth is a
 * bearer token (header `Authorization: Bearer <jwt>`); there is no cookie auth.
 */
import type {
  AuthConfig,
  Issue,
  LoginResponse,
  Memory,
  Project,
  Session,
  SessionModelOption,
  SessionRuntimeStatus,
  Skill,
  User,
} from './types.js'

export class ApiError extends Error {
  status: number
  body: any
  constructor(message: string, status: number, body: any) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

/** POST /api/auth/login — passwordless when ENABLE_PASSWORD_LOGIN=false. */
export async function login(server: string, username: string, password?: string): Promise<LoginResponse> {
  const res = await fetch(`${trimSlash(server)}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(password ? { username, password } : { username }),
  })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data?.error || `登录失败 (${res.status})`, res.status, data)
  const token: string | undefined = data.token || data.jwt || data.access_token
  if (!token) throw new ApiError('登录响应缺少 token', res.status, data)
  return { token, user: data.user as User }
}

/** GET /api/auth/config → { password_required }. */
export async function getAuthConfig(server: string): Promise<AuthConfig> {
  const res = await fetch(`${trimSlash(server)}/api/auth/config`)
  const data: any = await res.json().catch(() => ({}))
  return { password_required: data?.password_required ?? true }
}

/** GET /api/auth/me → current user (validates the token). */
export async function getMe(server: string, token: string): Promise<User> {
  const res = await fetch(`${trimSlash(server)}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data?.error || `HTTP ${res.status}`, res.status, data)
  return data as User
}

export class MobiusClient {
  server: string
  token: string
  constructor(server: string, token: string) {
    this.server = trimSlash(server)
    this.token = token
  }

  setToken(token: string): void {
    this.token = token
  }

  private async request<T>(p: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.server}${p}`, {
      ...init,
      headers: {
        ...(init?.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
        Authorization: `Bearer ${this.token}`,
        ...init?.headers,
      },
    })
    const text = await res.text()
    let data: any = null
    if (text) { try { data = JSON.parse(text) } catch { data = text } }
    if (!res.ok) {
      throw new ApiError((data && (data.error || data.message)) || `HTTP ${res.status}`, res.status, data)
    }
    return data as T
  }

  // ── projects ──────────────────────────────────────────────────────────────
  async listProjects(): Promise<Project[]> {
    const r = await this.request<any>('/api/projects?all=true')
    return Array.isArray(r) ? r : (r.projects ?? [])
  }

  async createProject(body: {
    name: string
    description?: string
    bindPath?: string
    bindPathManual?: boolean
    defaultUseWorktree?: boolean
    visibility?: string
  }): Promise<Project> {
    return this.request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(body) })
  }

  // ── issues (tasks) ────────────────────────────────────────────────────────
  async listIssues(projectId: string, status?: 'active' | 'completed'): Promise<Issue[]> {
    const q = status ? `?status=${status}` : ''
    const r = await this.request<any>(`/api/projects/${projectId}/issues${q}`)
    return Array.isArray(r) ? r : (r.issues ?? [])
  }

  async createIssue(projectId: string, body: {
    title: string
    description?: string
    use_worktree?: boolean
  }): Promise<Issue> {
    return this.request<Issue>(`/api/projects/${projectId}/issues`, { method: 'POST', body: JSON.stringify(body) })
  }

  // ── sessions ──────────────────────────────────────────────────────────────
  async listSessions(issueId: string): Promise<Session[]> {
    const r = await this.request<any>(`/api/issues/${issueId}/sessions`)
    return Array.isArray(r) ? r : (r.sessions ?? [])
  }

  async createSession(issueId: string, body: {
    name: string
    description?: string
    model?: string
    language?: 'zh' | 'en'
    excluded_skill_ids?: string[]
    excluded_memory_ids?: string[]
    continue_from_session_id?: string
  }): Promise<Session> {
    return this.request<Session>(`/api/issues/${issueId}/sessions`, { method: 'POST', body: JSON.stringify(body) })
  }

  async sendMessage(sessionId: string, content: string, requestId?: string): Promise<{ ok: boolean; session_id: string; turn_number: number }> {
    return this.request(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, request_id: requestId }),
    })
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.request(`/api/sessions/${sessionId}/stop`, { method: 'POST', body: '{}' })
  }

  /** The backend source of truth for the live agent process and work state. */
  async sessionStatus(sessionId: string, signal?: AbortSignal): Promise<SessionRuntimeStatus> {
    return this.request<SessionRuntimeStatus>(`/api/sessions/${encodeURIComponent(sessionId)}/status`, { signal })
  }

  // ── preference lookups ────────────────────────────────────────────────────
  async modelOptions(): Promise<SessionModelOption[]> {
    const r = await this.request<any>('/api/sessions/model-options')
    return Array.isArray(r) ? r : (r.options ?? [])
  }

  async defaultModel(): Promise<{ model: string | null }> {
    return this.request('/api/sessions/default-model')
  }

  async listSkills(projectId: string): Promise<Skill[]> {
    const r = await this.request<any>(`/api/projects/${projectId}/skills`)
    return Array.isArray(r) ? r : (r.skills ?? [])
  }

  async listMemories(projectId: string): Promise<Memory[]> {
    const r = await this.request<any>(`/api/projects/${projectId}/memories`)
    return Array.isArray(r) ? r : (r.memories ?? [])
  }

  /**
   * Recent sessions across a whole project (for /resume). The backend has no
   * single clean project-scoped sessions list route, so we aggregate over the
   * project's issues, flatten, sort by last_active DESC, and cap at `limit`.
   */
  async listProjectSessions(projectId: string, limit = 32): Promise<Session[]> {
    const issues = await this.listIssues(projectId)
    const all: Session[] = []
    // Fetch sessions for each issue in parallel.
    await Promise.all(issues.map(async (iss) => {
      try {
        const ss = await this.listSessions(iss.id)
        for (const s of ss) {
          if (!s.project_id) s.project_id = projectId
          if (!s.issue_id) s.issue_id = iss.id
          if (!s.issue_title) s.issue_title = iss.title
        }
        all.push(...ss)
      } catch { /* ignore per-issue failures */ }
    }))
    all.sort((a, b) => (b.last_active || '').localeCompare(a.last_active || ''))
    return all.slice(0, limit)
  }
}
