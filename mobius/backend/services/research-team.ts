import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { db } from '../../db';
import { JWT_SECRET } from '../config';
import { Messages } from '../repositories/messages';
import { resolveSessionWorkspace } from './workspace';
// @ts-ignore — service 仍是 .js
import modelRegistry from './model-registry';
import agents from '../agents';

const MAX_RESEARCH_ASSISTANTS = 12;
const DEFAULT_RESEARCH_ASSISTANT_LIMIT = 3;
const TEAM_TOKEN_HEADER = 'x-mobius-research-team-token';
const RESEARCH_SESSION_TOKEN_HEADER = 'x-mobius-research-session-token';
const ACTIVE_MUTATION_STATES = ['reserved', 'starting', 'removing'];
const RECREATE_GUARD_MS = 30 * 60 * 1000;

function normalizeResearchMode(value: any): 'custom' | 'chief_led' {
  return value === 'chief_led' ? 'chief_led' : 'custom';
}

function normalizeAssistantLimit(value: any): number {
  if (value === undefined || value === null || value === '') return DEFAULT_RESEARCH_ASSISTANT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_RESEARCH_ASSISTANTS) {
    const err: any = new Error(`Assistant limit 必须是 1-${MAX_RESEARCH_ASSISTANTS} 的整数`);
    err.status = 400;
    err.code = 'invalid_assistant_limit';
    throw err;
  }
  return parsed;
}

function encodeTeamTokenPayload(payload: any): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function signTeamTokenPayload(encoded: string): string {
  return crypto.createHmac('sha256', JWT_SECRET).update(`research-team:${encoded}`).digest('base64url');
}

function createChiefTeamToken(researchId: string, chiefSessionId: string): string {
  const encoded = encodeTeamTokenPayload({ v: 1, scope: 'team', research_id: researchId, chief_session_id: chiefSessionId });
  return `${encoded}.${signTeamTokenPayload(encoded)}`;
}

function verifyChiefTeamToken(token: any, expectedResearchId: string): { researchId: string; chiefSessionId: string } | null {
  const raw = String(token || '').trim();
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = signTeamTokenPayload(encoded);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload?.v !== 1 || payload?.scope !== 'team' || payload?.research_id !== expectedResearchId || !payload?.chief_session_id) return null;
    return { researchId: payload.research_id, chiefSessionId: payload.chief_session_id };
  } catch {
    return null;
  }
}

function createResearchSessionToken(researchId: string, sessionId: string): string {
  const encoded = encodeTeamTokenPayload({ v: 1, scope: 'blackboard', research_id: researchId, session_id: sessionId });
  return `${encoded}.${signTeamTokenPayload(encoded)}`;
}

function verifyResearchSessionToken(token: any, expectedResearchId: string): { researchId: string; sessionId: string } | null {
  const raw = String(token || '').trim();
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = signTeamTokenPayload(encoded);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (payload?.v !== 1 || payload?.scope !== 'blackboard' || payload?.research_id !== expectedResearchId || !payload?.session_id) return null;
    return { researchId: payload.research_id, sessionId: payload.session_id };
  } catch {
    return null;
  }
}

function parseAction(row: any): any {
  if (!row) return row;
  let payload = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch {}
  return { ...row, payload };
}

function teamFingerprint(input: any): string {
  const normalized = {
    purpose: String(input?.purpose || '').trim().toLowerCase(),
    model: String(input?.model || '').trim(),
    skill_ids: Array.from(new Set((Array.isArray(input?.skill_ids) ? input.skill_ids : []).map(String))).sort(),
    initial_prompt: String(input?.initial_prompt || '').trim().toLowerCase(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function listTeamActions(researchId: string, limit = 80): any[] {
  return db.prepare(`
    SELECT * FROM research_team_actions
    WHERE research_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(researchId, Math.max(1, Math.min(Number(limit) || 80, 300))).map(parseAction);
}

function findActionByRequest(researchId: string, requestId: string): any {
  return parseAction(db.prepare('SELECT * FROM research_team_actions WHERE research_id = ? AND request_id = ?').get(researchId, requestId));
}

function recordTeamAction(input: {
  researchId: string;
  actorSessionId?: string | null;
  actionType: string;
  targetSessionId?: string | null;
  requestId: string;
  status: string;
  payload?: any;
  error?: string | null;
}): any {
  const id = uuid().slice(0, 12);
  db.prepare(`
    INSERT INTO research_team_actions(
      id, research_id, actor_session_id, action_type, target_session_id,
      request_id, status, payload_json, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.researchId,
    input.actorSessionId || null,
    input.actionType,
    input.targetSessionId || null,
    input.requestId,
    input.status,
    JSON.stringify(input.payload || {}),
    input.error || null,
  );
  return findActionByRequest(input.researchId, input.requestId);
}

function updateTeamAction(researchId: string, requestId: string, patch: {
  status?: string;
  targetSessionId?: string | null;
  payload?: any;
  error?: string | null;
}): any {
  const current = findActionByRequest(researchId, requestId);
  if (!current) return null;
  db.prepare(`
    UPDATE research_team_actions
    SET status = ?, target_session_id = ?, payload_json = ?, error = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE research_id = ? AND request_id = ?
  `).run(
    patch.status ?? current.status,
    patch.targetSessionId === undefined ? current.target_session_id : patch.targetSessionId,
    JSON.stringify(patch.payload === undefined ? current.payload : patch.payload),
    patch.error === undefined ? current.error : patch.error,
    researchId,
    requestId,
  );
  return findActionByRequest(researchId, requestId);
}

function activeAssistantCount(researchId: string): number {
  const row: any = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sessions_v2
    WHERE research_id = ? AND scope_type = 'research'
      AND research_role = 'research_assistant'
      AND status != 'archived' AND deleted_at IS NULL
  `).get(researchId);
  return Number(row?.count || 0);
}

function teamState(researchId: string): any {
  const research: any = db.prepare('SELECT * FROM researches WHERE id = ?').get(researchId);
  if (!research) return null;
  const members = db.prepare(`
    SELECT session_id, research_role, name, description, model, status, agent_status,
           created_at, last_active, message_count, session_selection_snapshot
    FROM sessions_v2
    WHERE research_id = ? AND scope_type = 'research'
      AND status != 'archived' AND deleted_at IS NULL
    ORDER BY CASE research_role WHEN 'chief_researcher' THEN 0 ELSE 1 END, created_at ASC
  `).all(researchId).map((row: any) => {
    let selection: any = null;
    try { selection = JSON.parse(row.session_selection_snapshot || 'null'); } catch {}
    return {
      ...row,
      session_selection_snapshot: undefined,
      skills: Array.isArray(selection?.skills) ? selection.skills.map((item: any) => ({ id: item.id, name: item.name })) : [],
      memories: Array.isArray(selection?.memories) ? selection.memories.map((item: any) => ({ id: item.id, name: item.name })) : [],
    };
  });
  const actions = listTeamActions(researchId, 80);
  return {
    mode: normalizeResearchMode(research.mode),
    assistant_limit: normalizeAssistantLimit(research.assistant_limit),
    hard_cap: MAX_RESEARCH_ASSISTANTS,
    active_assistant_count: members.filter((m: any) => m.research_role === 'research_assistant').length,
    chief: members.find((m: any) => m.research_role === 'chief_researcher') || null,
    members,
    actions,
    mutation_in_progress: actions.find((action: any) => ACTIVE_MUTATION_STATES.includes(action.status)) || null,
  };
}

async function queueResearchTeamSystemPrompt(session: any, user: any, prompt: string, summary: string): Promise<void> {
  const launch = modelRegistry.launchOptionsForSession(session);
  const backend = agents.get(launch.backend);
  const workspace = resolveSessionWorkspace(user, session.session_id);
  if (workspace.error) throw Object.assign(new Error(workspace.error), { status: 400, code: 'workspace' });
  await backend.noPauseCurrentAndQueueQueryAtSession({
    sessionId: session.session_id,
    prompt,
    cwd: workspace.workDir,
    flagRoot: workspace.projectRoot || workspace.workDir,
    model: launch.model || undefined,
    settingsPath: launch.settingsPath,
    forceNoProxy: launch.forceNoProxy,
    useProxy: launch.forceNoProxy ? false : launch.useProxy === true,
    codexProfileKey: launch.codexProfileKey || undefined,
    codexChannel: launch.codexChannel || undefined,
    codexConfigPath: launch.codexConfigPath || undefined,
    codexSecretEnvKey: launch.codexSecretEnvKey || undefined,
    codexSecretValue: launch.codexSecretValue || undefined,
    harnessProvider: launch.harnessProvider || undefined,
    harnessBaseUrl: launch.harnessBaseUrl || undefined,
    harnessSecretValue: launch.harnessSecretValue || undefined,
    harnessMaxTokens: launch.harnessMaxTokens || undefined,
    harnessRuntimeVersion: launch.harnessRuntimeVersion || undefined,
    displayName: session.name || undefined,
    agentSessionId: session.claude_session_id || undefined,
  });
  const turn = (Messages.maxTurnFor(session.session_id) || 0) + 1;
  Messages.insertSystem(session.session_id, prompt, turn, summary);
}

const reserveRecruitment = db.transaction((input: {
  researchId: string;
  actorSessionId: string;
  requestId: string;
  payload: any;
  // 人类直接指定创建时不硬性执行 limit/建删震荡守卫 (只提醒); Chief 能力路径保持硬性执行.
  enforceLimit?: boolean;
  enforceGuard?: boolean;
}) => {
  const enforceLimit = input.enforceLimit !== false;
  const enforceGuard = input.enforceGuard !== false;
  const existing = findActionByRequest(input.researchId, input.requestId);
  if (existing) return { existing: true, action: existing };
  const research: any = db.prepare('SELECT assistant_limit FROM researches WHERE id = ?').get(input.researchId);
  if (!research) throw Object.assign(new Error('Research 未找到'), { status: 404, code: 'research_not_found' });
  const busy: any = db.prepare(`
    SELECT request_id FROM research_team_actions
    WHERE research_id = ? AND status IN ('reserved','starting','removing')
    LIMIT 1
  `).get(input.researchId);
  if (busy) throw Object.assign(new Error('团队正在执行另一项变更，请等待完成'), { status: 409, code: 'team_mutation_in_progress' });
  const count = activeAssistantCount(input.researchId);
  const limit = normalizeAssistantLimit(research.assistant_limit);
  let overLimit = false;
  if (count >= limit) {
    if (enforceLimit) {
      throw Object.assign(new Error(`当前存活 Assistant 已达到团队 limit (${count}/${limit})`), { status: 409, code: 'assistant_limit_reached' });
    }
    overLimit = true;
  }
  const fingerprint = teamFingerprint(input.payload);
  if (enforceGuard) {
    const recentRemoval: any = db.prepare(`
      SELECT * FROM research_team_actions
      WHERE research_id = ? AND action_type = 'remove' AND status = 'completed'
        AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes')
      ORDER BY created_at DESC LIMIT 20
    `).all(input.researchId).map(parseAction).find((action: any) => action.payload?.fingerprint === fingerprint);
    if (recentRemoval && input.payload?.replacement_of !== recentRemoval.target_session_id) {
      throw Object.assign(new Error('检测到刚移除的相同职责/任务配置；请提供 replacement_of 和新的替代理由，避免无效建删震荡'), {
        status: 409,
        code: 'team_change_guarded',
        removed_session_id: recentRemoval.target_session_id,
      });
    }
  }
  return {
    existing: false,
    overLimit,
    assistantCount: count,
    assistantLimit: limit,
    action: recordTeamAction({
      researchId: input.researchId,
      actorSessionId: input.actorSessionId,
      actionType: 'recruit',
      requestId: input.requestId,
      status: 'reserved',
      payload: {
        ...input.payload,
        fingerprint,
        ...(overLimit ? { over_limit: true, assistant_count: count, assistant_limit: limit } : {}),
      },
    }),
  };
});

const reserveRemoval = db.transaction((input: {
  researchId: string;
  actorSessionId: string;
  targetSessionId: string;
  requestId: string;
  payload: any;
}) => {
  const existing = findActionByRequest(input.researchId, input.requestId);
  if (existing) return { existing: true, action: existing };
  const busy: any = db.prepare(`
    SELECT request_id FROM research_team_actions
    WHERE research_id = ? AND status IN ('reserved','starting','removing')
    LIMIT 1
  `).get(input.researchId);
  if (busy) throw Object.assign(new Error('团队正在执行另一项变更，请等待完成'), { status: 409, code: 'team_mutation_in_progress' });
  return {
    existing: false,
    action: recordTeamAction({
      researchId: input.researchId,
      actorSessionId: input.actorSessionId,
      actionType: 'remove',
      targetSessionId: input.targetSessionId,
      requestId: input.requestId,
      status: 'removing',
      payload: input.payload,
    }),
  };
});

export {
  ACTIVE_MUTATION_STATES,
  DEFAULT_RESEARCH_ASSISTANT_LIMIT,
  MAX_RESEARCH_ASSISTANTS,
  RECREATE_GUARD_MS,
  TEAM_TOKEN_HEADER,
  RESEARCH_SESSION_TOKEN_HEADER,
  activeAssistantCount,
  createChiefTeamToken,
  createResearchSessionToken,
  findActionByRequest,
  listTeamActions,
  normalizeAssistantLimit,
  normalizeResearchMode,
  queueResearchTeamSystemPrompt,
  recordTeamAction,
  reserveRecruitment,
  reserveRemoval,
  teamFingerprint,
  teamState,
  updateTeamAction,
  verifyChiefTeamToken,
  verifyResearchSessionToken,
};
