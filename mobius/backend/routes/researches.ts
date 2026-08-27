import express from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { auth, downloadAuth } from '../middleware/auth';
import { Researches } from '../repositories/researches';
import { Projects } from '../repositories/projects';
import { Sessions } from '../repositories/sessions';
import { Messages } from '../repositories/messages';
import { Users } from '../repositories/users';
import { db } from '../../db';
import { PORT } from '../config';
import { SessionPendingMentions } from '../repositories/session-pending-mentions';
// @ts-ignore — service 仍是 .js
import modelRegistry from '../services/model-registry';
// @ts-ignore — service 仍是 .js
import modelPromptLimits from '../services/model-prompt-limits';
// @ts-ignore — service 仍是 .js
import { audit } from '../repositories/audit';
// @ts-ignore — service 仍是 .js
import { writeSessionTransferBundle } from '../services/session-transfer';
// @ts-ignore — service 仍是 .js
import { runSessionMessage } from '../services/session-message-runner';
import {
  safeRemoveRunningFlag,
} from '../utils/session-flags';
import {
  findSessionOperable,
  sessionJsonlPath,
  terminateBackgroundSession,
  type AnySession,
} from './sessions';
// @ts-ignore — service 仍是 .js
import {
  buildResearchContextPreview,
  buildResearchSelectionDefaults,
  buildResearchSessionSelectionSnapshot,
  stripContextItemBodies,
} from '../services/session-context';
// @ts-ignore — service 仍是 .js
import { appendBlackboardRecord, normalizeWriteInput, readBlackboard } from '../services/research-blackboard';
// @ts-ignore — service 仍是 .js
import { readGraph, resolveGraphImage } from '../services/research-graph';
// @ts-ignore — service 仍是 .js
import { withSessionProxyState } from '../services/session-proxy-state';
// @ts-ignore — util 仍是 .js
import { flagDirOf, runningFlagPathOf, failedFlagPathOf } from '../utils/session-flags';
// @ts-ignore — service 仍是 .js
import {
  accessPayload,
  canCreateIssue,
  canCreateSessionForResearch,
  canManageResearch,
  canReadProject,
  canReadResearch,
  canReadSession,
  normalizeVisibility,
  setResourcePolicy,
  uniqStringList,
} from '../services/access-control';
// @ts-ignore — service 仍是 .js
import { recordAdminAuditIfCrossUser } from '../services/admin-audit';
import {
  RESEARCH_SESSION_TOKEN_HEADER,
  TEAM_TOKEN_HEADER,
  createChiefTeamToken,
  findActionByRequest,
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
} from '../services/research-team';

const router = express.Router();
const projectScoped = express.Router({ mergeParams: true });
const researchScoped = express.Router({ mergeParams: true });
const blackboardRouter = express.Router();
const graphRouter = express.Router();

function readJobFlagState(root: string, sessionId: string) {
  const hasFlagDir = fs.existsSync(flagDirOf(root, sessionId));
  return {
    accomplished: hasFlagDir ? !fs.existsSync(runningFlagPathOf(root, sessionId)) : false,
    failed: hasFlagDir ? fs.existsSync(failedFlagPathOf(root, sessionId)) : false,
  };
}

function sanitizeIds(arr: unknown): string[] {
  return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.length > 0) : [];
}

function requiredText(value: any, label: string, minLength = 1): string {
  const text = String(value || '').trim();
  if (text.length < minLength) {
    const err: any = new Error(`${label}不能为空${minLength > 1 ? `，至少 ${minLength} 个字符` : ''}`);
    err.status = 400;
    err.code = 'invalid_team_agent_config';
    throw err;
  }
  return text;
}

function explicitResearchSelection(
  user: any,
  researchId: string,
  draft: any,
  skillIdsInput: any,
  memoryIdsInput: any,
  memorySelectionConfirmed: any,
): { excludedSkillIds: string[]; excludedMemoryIds: string[]; selectedSkills: any[]; selectedMemories: any[] } {
  if (!Array.isArray(skillIdsInput) || skillIdsInput.length === 0) {
    throw Object.assign(new Error('必须明确选择至少一个 Skill'), { status: 400, code: 'skill_selection_required' });
  }
  if (!Array.isArray(memoryIdsInput) || memorySelectionConfirmed !== true) {
    throw Object.assign(new Error('必须明确确认 Memory 选择；允许显式选择无 Memory'), { status: 400, code: 'memory_selection_required' });
  }
  const preview: any = buildResearchContextPreview(user, researchId, draft, [], [], draft?.language === 'en' ? 'en' : 'zh', { includeBody: false });
  const skills = Array.isArray(preview?.sources?.skills) ? preview.sources.skills : [];
  const memories = Array.isArray(preview?.sources?.memories) ? preview.sources.memories : [];
  const requestedSkills = new Set(skillIdsInput.map((id: any) => String(id || '').trim()).filter(Boolean));
  const requestedMemories = new Set(memoryIdsInput.map((id: any) => String(id || '').trim()).filter(Boolean));
  const selectedSkills = skills.filter((item: any) => requestedSkills.has(String(item.id)) || requestedSkills.has(String(item.name)));
  const selectedMemories = memories.filter((item: any) => requestedMemories.has(String(item.id)) || requestedMemories.has(String(item.name)));
  if (selectedSkills.length !== requestedSkills.size) {
    throw Object.assign(new Error('包含不可用的 Skill'), { status: 400, code: 'invalid_skill_selection' });
  }
  if (selectedMemories.length !== requestedMemories.size) {
    throw Object.assign(new Error('包含不可用的 Memory'), { status: 400, code: 'invalid_memory_selection' });
  }
  return {
    excludedSkillIds: skills.filter((item: any) => !selectedSkills.some((chosen: any) => chosen.id === item.id)).map((item: any) => item.id),
    excludedMemoryIds: memories.filter((item: any) => !selectedMemories.some((chosen: any) => chosen.id === item.id)).map((item: any) => item.id),
    selectedSkills,
    selectedMemories,
  };
}

async function createStartedResearchSession(input: {
  user: any;
  research: any;
  role: 'chief_researcher' | 'research_assistant';
  config: any;
  requestId: string;
}): Promise<any> {
  const { user, research, role, config, requestId } = input;
  const name = requiredText(config?.name, 'Agent 名称');
  const purpose = requiredText(config?.purpose ?? config?.description, 'Agent 职责');
  const initialPrompt = requiredText(config?.initial_prompt, '初始 Prompt');
  const model = requiredText(config?.model, '模型');
  const language = config?.language === 'en' ? 'en' : 'zh';
  const selection = explicitResearchSelection(
    user,
    research.id,
    { name, description: purpose, role, language },
    config?.skill_ids,
    config?.memory_ids,
    config?.memory_selection_confirmed,
  );
  if (role === 'chief_researcher' && !selection.selectedSkills.some((item: any) => item.name === 'research-chief-agent')) {
    throw Object.assign(new Error('Chief 必须启用 research-chief-agent Skill'), { status: 400, code: 'chief_skill_required' });
  }
  const resolvedModel = modelRegistry.resolveSessionModelForCreate(model) as any;
  const limitCheck = modelPromptLimits.checkCreateAllowed(user.id, resolvedModel.key);
  if (!limitCheck.allowed) {
    throw Object.assign(new Error(limitCheck.error), { status: limitCheck.status, code: limitCheck.code, usage: limitCheck.usage });
  }
  const sessionId = uuid().slice(0, 8);
  const selectionSnapshot = buildResearchSessionSelectionSnapshot(
    user,
    research.id,
    selection.excludedSkillIds,
    selection.excludedMemoryIds,
    { pc_client_metadata: config?.pc_client_metadata },
  );
  Sessions.insert({
    session_id: sessionId,
    issue_id: null,
    project_id: research.project_id,
    scope_type: 'research',
    research_id: research.id,
    research_role: role,
    user_id: user.id,
    name,
    description: purpose,
    session_key: `web:${user.id}:${sessionId}`,
    excluded_skill_ids: selection.excludedSkillIds,
    excluded_memory_ids: selection.excludedMemoryIds,
    selection_snapshot: selectionSnapshot,
    model: resolvedModel.sessionModelValue,
    language,
    pc_client_metadata: config?.pc_client_metadata,
    name_human_edited: 1,
  });
  try {
    await runSessionMessage({
      user,
      sessionId,
      content: initialPrompt,
      inputText: initialPrompt,
      hasInputText: true,
      requestId,
      source: 'http.research_team.provision',
      logger: console,
    } as any);
  } catch (error) {
    try { Sessions.permanentDelete(sessionId); } catch {}
    throw error;
  }
  return Sessions.findById(sessionId);
}

function requireChiefCapability(req: express.Request, researchId: string): any {
  const token = req.header(TEAM_TOKEN_HEADER) || req.header('x-research-team-token');
  const verified = verifyChiefTeamToken(token, researchId);
  if (!verified) throw Object.assign(new Error('Chief 团队能力 token 无效'), { status: 401, code: 'invalid_chief_capability' });
  const chief = Sessions.findById(verified.chiefSessionId) as any;
  if (!chief || chief.scope_type !== 'research' || chief.research_id !== researchId || chief.research_role !== 'chief_researcher') {
    throw Object.assign(new Error('Chief Session 不存在或不属于当前 Research'), { status: 403, code: 'chief_capability_scope_mismatch' });
  }
  return chief;
}

function researchBlackboardAccess(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const researchId = String(req.params.researchId);
  const token = req.header(RESEARCH_SESSION_TOKEN_HEADER);
  const verified = token ? verifyResearchSessionToken(token, researchId) : null;
  if (verified) {
    const session = Sessions.findById(verified.sessionId) as any;
    if (session && session.scope_type === 'research' && session.research_id === researchId) {
      (req as any).researchSession = session;
      next();
      return;
    }
  }
  auth(req, res, next);
}

function toIdList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string' && v.length > 0) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function maybeList(body: any, snakeKey: string, camelKey: string): any {
  if (!body || (!Object.prototype.hasOwnProperty.call(body, snakeKey) && !Object.prototype.hasOwnProperty.call(body, camelKey))) {
    return undefined;
  }
  return uniqStringList(body[snakeKey] ?? body[camelKey]);
}

function researchAccessBody(body: any = {}) {
  return {
    visibility: body.visibility,
    allowUserIds: maybeList(body, 'allow_user_ids', 'allowUserIds'),
    allowGroupIds: maybeList(body, 'allow_group_ids', 'allowGroupIds'),
  };
}

function shapeResearchForUser(research: any, user: any): any {
  if (!research) return research;
  const visibility = normalizeVisibility(research.visibility, 'inherit', true);
  return {
    ...research,
    visibility,
    access: accessPayload('research', research.id, visibility),
    can_manage: canManageResearch(user, research),
  };
}

function auditResearchAccess(user: any, action: string, research: any): void {
  if (!research) return;
  const project = Projects.findById(research.project_id);
  recordAdminAuditIfCrossUser(
    user,
    action,
    'research',
    research.id,
    research.created_by || project?.created_by,
  );
}

projectScoped.get('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const project = Projects.findById(String(req.params.projectId));
  if (!project) { res.status(404).json({ error: '未找到' }); return; }
  if (!canReadProject(user, project)) { res.status(404).json({ error: '未找到' }); return; }
  if (!project.research_enabled) { res.json([]); return; }
  const researches = Researches.listForProject(String(req.params.projectId), req.query.status as any)
    .filter((research: any) => canReadResearch(user, research));
  if (user?.role === 'admin' && project.created_by !== user.id) {
    recordAdminAuditIfCrossUser(user, 'list_researches', 'project', project.id, project.created_by);
  }
  res.json(researches.map((research: any) => shapeResearchForUser(research, user)));
});

projectScoped.post('/', auth, async (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const project = Projects.findById(String(req.params.projectId));
  if (!project) { res.status(404).json({ error: '未找到' }); return; }
  if (!canCreateIssue(user, project)) { res.status(403).json({ error: '无权在此项目创建 Research' }); return; }
  if (!project.research_enabled) { res.status(400).json({ error: '当前项目未启用 Research 系统' }); return; }
  const { title, description } = (req.body || {}) as { title?: string; description?: string };
  if (!title) { res.status(400).json({ error: '请填写 Research 标题' }); return; }
  if (!description) { res.status(400).json({ error: '请填写 Research 描述' }); return; }
  let mode: 'custom' | 'chief_led';
  let assistantLimit: number;
  try {
    mode = normalizeResearchMode(req.body?.mode);
    assistantLimit = normalizeAssistantLimit(req.body?.assistant_limit);
  } catch (e) {
    const err = e as any;
    res.status(err.status || 400).json({ error: err.message, code: err.code });
    return;
  }
  if (!req.body?.chief || typeof req.body.chief !== 'object') {
    // Research 本身默认不创建任何 Agent; Chief (Leader) 可在此立即创建, 也可稍后从团队入口补建.
    const researchId = uuid().slice(0, 8);
    Researches.insert({
      id: researchId,
      project_id: String(req.params.projectId),
      title,
      description,
      created_by: user.id,
      mode,
      assistant_limit: assistantLimit,
      visibility: normalizeVisibility(req.body?.visibility, 'inherit', true) as any,
    });
    recordAdminAuditIfCrossUser(user, 'create_research', 'project', project.id, project.created_by);
    if (req.body?.visibility !== undefined
      || req.body?.allow_user_ids !== undefined || req.body?.allowUserIds !== undefined
      || req.body?.allow_group_ids !== undefined || req.body?.allowGroupIds !== undefined) {
      setResourcePolicy('research', researchId, { ...researchAccessBody(req.body), createdBy: user.id });
    }
    res.json({
      ...shapeResearchForUser(Researches.findById(researchId), user),
      chief_session: null,
    });
    return;
  }
  const researchId = uuid().slice(0, 8);
  Researches.insert({
    id: researchId,
    project_id: String(req.params.projectId),
    title,
    description,
    created_by: user.id,
    mode,
    assistant_limit: assistantLimit,
    visibility: normalizeVisibility(req.body?.visibility, 'inherit', true) as any,
  });
  recordAdminAuditIfCrossUser(user, 'create_research', 'project', project.id, project.created_by);
  if (req.body?.visibility !== undefined
    || req.body?.allow_user_ids !== undefined || req.body?.allowUserIds !== undefined
    || req.body?.allow_group_ids !== undefined || req.body?.allowGroupIds !== undefined) {
    setResourcePolicy('research', researchId, { ...researchAccessBody(req.body), createdBy: user.id });
  }
  let chiefSession: any = null;
  {
    try {
      const research = Researches.findById(researchId) as any;
      chiefSession = await createStartedResearchSession({
        user,
        research,
        role: 'chief_researcher',
        config: req.body.chief,
        requestId: `chief-init-${researchId}`,
      });
      appendBlackboardRecord({
        researchId,
        author: 'HR',
        content: `Chief 已加入并启动: session_id=${chiefSession.session_id}, name=${chiefSession.name}`,
        metadata: {
          event: 'session_joined',
          session_id: chiefSession.session_id,
          role: 'chief_researcher',
          name: chiefSession.name,
          source: 'research_creation',
        },
      });
    } catch (e) {
      try { db.prepare('DELETE FROM researches WHERE id = ?').run(researchId); } catch {}
      const err = e as any;
      res.status(err.status || 500).json({ error: err.message || 'Chief 创建或启动失败', code: err.code, usage: err.usage });
      return;
    }
  }
  res.json({
    ...shapeResearchForUser(Researches.findById(researchId), user),
    chief_session: chiefSession ? withSessionProxyState(chiefSession) : null,
  });
});

router.get('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const research = Researches.findById(String(req.params.id));
  if (!research) { res.status(404).json({ error: '未找到' }); return; }
  if (!canReadResearch(user, research)) { res.status(404).json({ error: '未找到' }); return; }
  auditResearchAccess(user, 'read_research', research);
  res.json(shapeResearchForUser(research, user));
});

router.get('/:id/team', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const research = Researches.findById(String(req.params.id));
  if (!research || !canReadResearch(user, research)) { res.status(404).json({ error: '未找到' }); return; }
  const state = teamState(String(req.params.id));
  res.json(state);
});

// 为已存在的 Research 补建唯一 Leader (Chief): "AI-Leader 自动组队"路径的起点.
// Research 创建本身不建 Agent; 用户从这里 (或创建 Research 时的"立即创建 Leader") 装配 Leader.
router.post('/:id/leader', auth, async (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const researchId = String(req.params.id);
  const research = Researches.findById(researchId) as any;
  if (!research || !canManageResearch(user, research)) { res.status(404).json({ error: '未找到' }); return; }
  if (Sessions.findChiefForResearch(researchId)) {
    res.status(409).json({ error: '当前 Research 已存在 Leader (Chief)', code: 'leader_exists' });
    return;
  }
  if (!req.body || typeof req.body !== 'object' || !req.body.initial_prompt) {
    res.status(400).json({ error: '创建 Leader 必须提供初始 Prompt', code: 'leader_config_required' });
    return;
  }
  try {
    // mode 必须在会话启动【之前】置为 chief_led: Leader 的首条 bootstrap 上下文
    // (buildSessionContext → Chief 团队管理能力段) 是在 createStartedResearchSession
    // 内部构建的, 那时读到的还是旧 mode. 先改 mode, 创建失败再回滚.
    const previousMode = normalizeResearchMode(research.mode);
    Researches.updateMode(researchId, 'chief_led');
    let leaderSession: any;
    try {
      leaderSession = await createStartedResearchSession({
        user,
        research,
        role: 'chief_researcher',
        config: req.body,
        requestId: `leader-init-${researchId}`,
      });
    } catch (e) {
      Researches.updateMode(researchId, previousMode);
      throw e;
    }
    appendBlackboardRecord({
      researchId,
      author: 'HR',
      content: `Leader 已加入并启动: session_id=${leaderSession.session_id}, name=${leaderSession.name}`,
      metadata: {
        event: 'session_joined',
        session_id: leaderSession.session_id,
        role: 'chief_researcher',
        name: leaderSession.name,
        source: 'leader_provision',
      },
    });
    res.json({
      ok: true,
      leader_session: withSessionProxyState(leaderSession),
      research: shapeResearchForUser(Researches.findById(researchId), user),
    });
  } catch (e) {
    const err = e as any;
    res.status(err.status || 500).json({ error: err.message || 'Leader 创建或启动失败', code: err.code, usage: err.usage });
  }
});

router.post('/:id/team/authorize', auth, async (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const research = Researches.findById(String(req.params.id)) as any;
  if (!research) { res.status(404).json({ error: '未找到' }); return; }
  if (!canManageResearch(user, research)) { res.status(403).json({ error: '只有 Research 管理者可以授权 Chief 创建团队' }); return; }
  if (normalizeResearchMode(research.mode) !== 'chief_led') {
    res.status(400).json({ error: '只有 Chief 主导模式需要创建团队授权', code: 'not_chief_led' });
    return;
  }
  const chief = Sessions.findChiefForResearch(research.id) as any;
  if (!chief) { res.status(409).json({ error: '当前 Research 尚未创建 Chief', code: 'chief_missing' }); return; }
  const requestId = typeof req.body?.request_id === 'string' && req.body.request_id.trim()
    ? req.body.request_id.trim()
    : `authorize-${uuid().slice(0, 12)}`;
  let action = findActionByRequest(research.id, requestId);
  if (!action) {
    action = recordTeamAction({
      researchId: research.id,
      actorSessionId: chief.session_id,
      actionType: 'authorize',
      requestId,
      status: 'authorized',
      payload: { source: 'user_button', authorized_by: user.id },
    });
  }
  const capabilityToken = createChiefTeamToken(research.id, chief.session_id);
  const instruction = [
    '[Research 团队创建授权]',
    `authorization_id: ${action.id}`,
    '用户已确认，请按你们讨论的方案现在创建团队。',
    '你可以先判断方案是否成熟；如果仍有未定项，应先向用户说明，不要勉强创建。',
    `创建 Assistant 时调用 POST http://localhost:${PORT}/api/researches/${research.id}/team/agents`,
    `请求头 ${TEAM_TOKEN_HEADER}: ${capabilityToken}`,
    '每个 Agent 必须同时提供 name、purpose、model、skill_ids、memory_ids、memory_selection_confirmed=true、initial_prompt、recruit_reason、request_id 和 authorization_id。',
    `当前团队 limit=${normalizeAssistantLimit(research.assistant_limit)}，Chief 不占名额。`,
  ].join('\n');
  try {
    await queueResearchTeamSystemPrompt(chief, user, instruction, 'Research 团队创建授权');
    appendBlackboardRecord({
      researchId: research.id,
      author: 'HR',
      content: '用户已授权 Chief 按讨论方案创建团队。Chief 可以继续确认方案，或开始招募 Assistant。',
      metadata: { event: 'team_authorized', authorization_id: action.id, chief_session_id: chief.session_id },
    });
    res.json({ ok: true, authorization_id: action.id, chief_session_id: chief.session_id });
  } catch (e) {
    const err = e as any;
    updateTeamAction(research.id, requestId, { status: 'failed', error: err.message });
    res.status(err.status || 500).json({ error: err.message || '授权消息投递失败', code: err.code });
  }
});

router.post('/:id/team/manual-agents', auth, async (req: express.Request, res: express.Response) => {
  const researchId = String(req.params.id);
  const user = (req as any).user;
  const research = Researches.findById(researchId) as any;
  if (!research || !canReadResearch(user, research)) { res.status(404).json({ error: '未找到' }); return; }
  // 人类直接创建不区分模式: chief_led 下用户同样是团队的主人, 可直接补建 Assistant.
  // limit / 建删震荡守卫只对 Chief 能力路径硬性执行, 人类路径只提醒.
  try {
    const requestId = requiredText(req.body?.request_id, 'request_id');
    const payload = {
      name: requiredText(req.body?.name, 'Agent 名称'),
      purpose: requiredText(req.body?.purpose, 'Agent 职责'),
      model: requiredText(req.body?.model, '模型'),
      skill_ids: req.body?.skill_ids,
      memory_ids: req.body?.memory_ids,
      memory_selection_confirmed: req.body?.memory_selection_confirmed,
      initial_prompt: requiredText(req.body?.initial_prompt, '初始 Prompt'),
      recruit_reason: requiredText(req.body?.recruit_reason || '用户明确创建该 Agent，当前任务需要其专长', '创建理由', 10),
      expected_outcome: requiredText(req.body?.expected_outcome || req.body?.purpose, '预期产出'),
      replacement_of: req.body?.replacement_of ? String(req.body.replacement_of) : null,
      language: req.body?.language === 'en' ? 'en' : 'zh',
    };
    const actorSessionId = Sessions.findChiefForResearch(researchId)?.session_id || `user:${user.id}`;
    const reserved: any = reserveRecruitment({ researchId, actorSessionId, requestId, payload, enforceLimit: false, enforceGuard: false });
    if (reserved.existing) {
      const existingSession = reserved.action.target_session_id ? Sessions.findById(reserved.action.target_session_id) : null;
      res.json({ ok: reserved.action.status === 'completed', idempotent: true, action: reserved.action, session: existingSession });
      return;
    }
    let created: any = null;
    try {
      created = await createStartedResearchSession({
        user,
        research,
        role: 'research_assistant',
        config: payload,
        requestId: `manual-team-start-${requestId}`,
      });
      updateTeamAction(researchId, requestId, { status: 'starting', targetSessionId: created.session_id });
      const hr = appendBlackboardRecord({
        researchId,
        author: 'HR',
        content: [
          `新的 research_assistant 已由用户创建并收到初始任务: session_id=${created.session_id}, name=${created.name}`,
          reserved.overLimit
            ? `提醒: 当前存活 Assistant (${reserved.assistantCount}/${reserved.assistantLimit}) 已超过团队 limit；本条为用户指定创建，不受硬性限制。`
            : '',
        ].filter(Boolean).join('\n'),
        metadata: {
          event: 'session_joined', source: 'custom_team_provision', session_id: created.session_id,
          role: 'research_assistant', name: created.name, request_id: requestId,
          initial_prompt: payload.initial_prompt, recruit_reason: payload.recruit_reason,
          over_limit: reserved.overLimit === true,
        },
      });
      if ((hr as any).error) throw new Error((hr as any).error);
      const action = updateTeamAction(researchId, requestId, { status: 'completed', targetSessionId: created.session_id });
      res.json({ ok: true, action, session: withSessionProxyState(created), team: teamState(researchId) });
    } catch (e) {
      if (created) {
        try { await terminateBackgroundSession(created, created.session_id); } catch {}
        try { Sessions.permanentDelete(created.session_id); } catch {}
      }
      const err = e as any;
      const action = updateTeamAction(researchId, requestId, { status: 'failed', error: err.message || '创建或启动失败' });
      appendBlackboardRecord({
        researchId, author: 'HR', content: `自定义 Agent 创建或启动失败: name=${payload.name}, reason=${err.message || '未知错误'}`,
        metadata: { event: 'agent_start_failed', request_id: requestId, name: payload.name, error: err.message || '未知错误' },
      });
      res.status(err.status || 500).json({ error: err.message || 'Agent 创建或启动失败', code: err.code, action });
    }
  } catch (e) {
    const err = e as any;
    res.status(err.status || 500).json({ error: err.message || 'Agent 创建失败', code: err.code });
  }
});

router.post('/:id/team/agents', async (req: express.Request, res: express.Response) => {
  const researchId = String(req.params.id);
  try {
    const chief = requireChiefCapability(req, researchId);
    const research = Researches.findById(researchId) as any;
    if (!research) throw Object.assign(new Error('Research 未找到'), { status: 404 });
    const user = Users.findById(chief.user_id) as any;
    if (!user) throw Object.assign(new Error('Chief 所属用户不存在'), { status: 403 });
    const requestId = requiredText(req.body?.request_id, 'request_id');
    const recruitReason = requiredText(req.body?.recruit_reason, '招募理由', 10);
    const authorizationId = String(req.body?.authorization_id || '').trim();
    const authorizationSource = req.body?.authorization_source === 'natural_language' ? 'natural_language' : 'button';
    if (authorizationSource === 'button') {
      const authorization: any = db.prepare(`
        SELECT * FROM research_team_actions
        WHERE id = ? AND research_id = ? AND action_type = 'authorize' AND status = 'authorized'
      `).get(authorizationId, researchId);
      if (!authorization) throw Object.assign(new Error('缺少有效的用户团队创建授权'), { status: 403, code: 'team_authorization_required' });
    } else {
      requiredText(req.body?.authorization_quote, '用户自然语言授权原文', 4);
    }
    const payload = {
      name: requiredText(req.body?.name, 'Agent 名称'),
      purpose: requiredText(req.body?.purpose, 'Agent 职责'),
      model: requiredText(req.body?.model, '模型'),
      skill_ids: req.body?.skill_ids,
      memory_ids: req.body?.memory_ids,
      memory_selection_confirmed: req.body?.memory_selection_confirmed,
      initial_prompt: requiredText(req.body?.initial_prompt, '初始 Prompt'),
      recruit_reason: recruitReason,
      expected_outcome: requiredText(req.body?.expected_outcome || req.body?.purpose, '预期产出'),
      replacement_of: req.body?.replacement_of ? String(req.body.replacement_of) : null,
      authorization_id: authorizationId || null,
      authorization_source: authorizationSource,
      authorization_quote: authorizationSource === 'natural_language' ? String(req.body.authorization_quote) : null,
      language: req.body?.language === 'en' ? 'en' : 'zh',
    };
    const reserved: any = reserveRecruitment({
      researchId,
      actorSessionId: chief.session_id,
      requestId,
      payload,
    });
    if (reserved.existing) {
      const state = reserved.action.status === 'completed' && reserved.action.target_session_id
        ? Sessions.findById(reserved.action.target_session_id)
        : null;
      res.json({ ok: reserved.action.status === 'completed', idempotent: true, action: reserved.action, session: state });
      return;
    }
    let created: any = null;
    try {
      created = await createStartedResearchSession({
        user,
        research,
        role: 'research_assistant',
        config: payload,
        requestId: `team-start-${requestId}`,
      });
      updateTeamAction(researchId, requestId, { status: 'starting', targetSessionId: created.session_id });
      const hr = appendBlackboardRecord({
        researchId,
        author: 'HR',
        content: `新的 research_assistant 已加入并收到初始任务: session_id=${created.session_id}, name=${created.name}\n招募理由: ${recruitReason}`,
        metadata: {
          event: 'session_joined',
          source: 'chief_team_provision',
          session_id: created.session_id,
          role: 'research_assistant',
          name: created.name,
          request_id: requestId,
          authorization_id: authorizationId || null,
          initial_prompt: payload.initial_prompt,
          recruit_reason: recruitReason,
          expected_outcome: payload.expected_outcome,
        },
      });
      if ((hr as any).error) throw new Error((hr as any).error);
      const action = updateTeamAction(researchId, requestId, { status: 'completed', targetSessionId: created.session_id });
      res.json({ ok: true, action, session: withSessionProxyState(created), team: teamState(researchId) });
    } catch (e) {
      if (created) {
        try { await terminateBackgroundSession(created, created.session_id); } catch {}
        try { Sessions.permanentDelete(created.session_id); } catch {}
      }
      const err = e as any;
      const action = updateTeamAction(researchId, requestId, { status: 'failed', error: err.message || '创建或启动失败' });
      appendBlackboardRecord({
        researchId,
        author: 'HR',
        content: `Assistant 创建或启动失败: name=${payload.name}, reason=${err.message || '未知错误'}`,
        metadata: { event: 'agent_start_failed', request_id: requestId, name: payload.name, error: err.message || '未知错误' },
      });
      res.status(err.status || 500).json({ error: err.message || 'Agent 创建或启动失败', code: err.code, action });
    }
  } catch (e) {
    const err = e as any;
    res.status(err.status || 500).json({ error: err.message || '团队创建失败', code: err.code, removed_session_id: err.removed_session_id });
  }
});

router.delete('/:id/team/agents/:sessionId', async (req: express.Request, res: express.Response) => {
  const researchId = String(req.params.id);
  try {
    const chief = requireChiefCapability(req, researchId);
    const target = Sessions.findById(String(req.params.sessionId)) as any;
    if (!target || target.research_id !== researchId || target.scope_type !== 'research') {
      throw Object.assign(new Error('目标 Research Agent 不存在'), { status: 404 });
    }
    if (target.research_role === 'chief_researcher') {
      throw Object.assign(new Error('Chief 不能通过团队管理能力创建或删除'), { status: 409, code: 'chief_lifecycle_protected' });
    }
    const requestId = requiredText(req.body?.request_id, 'request_id');
    const removeReason = requiredText(req.body?.remove_reason, '删除理由', 10);
    const handoffSummary = requiredText(req.body?.handoff_summary, '未完成任务交接', target.agent_status === 'running' ? 10 : 1);
    const handoffTarget = String(req.body?.handoff_target || chief.session_id).trim();
    const handoffSession = Sessions.findById(handoffTarget) as any;
    if (!handoffSession || handoffSession.research_id !== researchId || handoffSession.session_id === target.session_id) {
      throw Object.assign(new Error('handoff_target 必须是当前 Research 中接手任务的其他 Agent'), { status: 400, code: 'invalid_handoff_target' });
    }
    const recruitAction: any = db.prepare(`
      SELECT * FROM research_team_actions
      WHERE research_id = ? AND target_session_id = ? AND action_type = 'recruit'
      ORDER BY created_at DESC LIMIT 1
    `).get(researchId, target.session_id);
    let recruitPayload: any = {};
    try { recruitPayload = JSON.parse(recruitAction?.payload_json || '{}'); } catch {}
    const payload = {
      remove_reason: removeReason,
      handoff_summary: handoffSummary,
      handoff_target: handoffTarget,
      was_running: target.agent_status === 'running',
      fingerprint: teamFingerprint(Object.keys(recruitPayload).length > 0 ? recruitPayload : {
        purpose: target.description,
        model: target.model,
        initial_prompt: target.description,
        skill_ids: [],
      }),
    };
    const reserved: any = reserveRemoval({
      researchId,
      actorSessionId: chief.session_id,
      targetSessionId: target.session_id,
      requestId,
      payload,
    });
    if (reserved.existing) {
      res.json({ ok: reserved.action.status === 'completed', idempotent: true, action: reserved.action });
      return;
    }
    try {
      const requested = appendBlackboardRecord({
        researchId,
        author: 'HR',
        content: `Research Agent「${target.name}」即将离开团队。\n删除理由: ${removeReason}\n未完成任务与交接: ${handoffSummary}`,
        metadata: {
          event: 'agent_removal_requested',
          session_id: target.session_id,
          role: 'research_assistant',
          request_id: requestId,
          ...payload,
        },
      });
      if ((requested as any).error) throw new Error((requested as any).error);
      const closed = await terminateBackgroundSession(target, target.session_id);
      Sessions.permanentDelete(target.session_id);
      const left = appendBlackboardRecord({
        researchId,
        author: 'HR',
        content: `Research Agent「${target.name}」已离开团队，名额已经释放。\n交接: ${handoffSummary}`,
        metadata: {
          event: 'session_left',
          session_id: target.session_id,
          role: 'research_assistant',
          request_id: requestId,
          remove_reason: removeReason,
          handoff_summary: handoffSummary,
          background_was_working: closed.wasWorking,
        },
      });
      if ((left as any).error) throw new Error((left as any).error);
      const action = updateTeamAction(researchId, requestId, { status: 'completed' });
      res.json({ ok: true, action, team: teamState(researchId) });
    } catch (e) {
      const err = e as any;
      const action = updateTeamAction(researchId, requestId, { status: 'failed', error: err.message || '删除失败' });
      res.status(err.status || 500).json({ error: err.message || '删除失败', code: err.code, action });
    }
  } catch (e) {
    const err = e as any;
    res.status(err.status || 500).json({ error: err.message || '团队删除失败', code: err.code });
  }
});

router.patch('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const research = Researches.findById(String(req.params.id));
  if (!research) { res.status(404).json({ error: '未找到' }); return; }
  if (!canManageResearch(user, research)) { res.status(403).json({ error: '无权修改此 Research' }); return; }
  auditResearchAccess(user, 'write_research', research);
  const { title, description, status, pinned, visibility } = (req.body || {}) as {
    title?: string;
    description?: string;
    status?: string;
    pinned?: boolean;
    visibility?: string;
  };
  if (title) Researches.updateTitle(String(req.params.id), title);
  if (description !== undefined) Researches.updateDescription(String(req.params.id), description);
  if (status && ['active', 'completed'].includes(status)) Researches.updateStatus(String(req.params.id), status as any);
  if (typeof pinned === 'boolean') Researches.updatePinned(String(req.params.id), pinned);
  if (req.body?.assistant_limit !== undefined) {
    try {
      Researches.updateAssistantLimit(String(req.params.id), normalizeAssistantLimit(req.body.assistant_limit));
    } catch (e) {
      const err = e as any;
      res.status(err.status || 400).json({ error: err.message, code: err.code });
      return;
    }
  }
  // 组队方式可后置切换: "AI-Leader 自动组队"(chief_led) / "人工自定义组队"(custom).
  if (req.body?.mode !== undefined) {
    Researches.updateMode(String(req.params.id), normalizeResearchMode(req.body.mode));
  }
  if (visibility !== undefined) {
    const nextVisibility = normalizeVisibility(visibility, 'inherit', true);
    Researches.updateVisibility(String(req.params.id), nextVisibility as any);
    setResourcePolicy('research', String(req.params.id), { ...researchAccessBody(req.body), visibility: nextVisibility, createdBy: research.created_by });
  } else if (req.body?.allow_user_ids !== undefined || req.body?.allowUserIds !== undefined
    || req.body?.allow_group_ids !== undefined || req.body?.allowGroupIds !== undefined) {
    setResourcePolicy('research', String(req.params.id), { ...researchAccessBody(req.body), createdBy: research.created_by });
  }
  res.json(shapeResearchForUser(Researches.findById(String(req.params.id)), user));
});

researchScoped.get('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const research = Researches.findByIdWithProject(String(req.params.researchId));
  if (!research) { res.status(404).json({ error: '未找到' }); return; }
  if (!canReadResearch(user, research)) { res.status(404).json({ error: '未找到' }); return; }
  auditResearchAccess(user, 'list_research_sessions', research);
  const list = Sessions.listForResearch(String(req.params.researchId)).filter((session: any) => canReadSession(user, session));
  const root = (research.bind_path || '').trim() ? path.resolve(research.bind_path as string) : null;
  const enriched = list.map((s: any) => {
    let job_accomplished = null;
    let job_failed = null;
    if (root) {
      try {
        const st = readJobFlagState(root, s.session_id);
        job_accomplished = st.accomplished;
        job_failed = st.failed;
      } catch {}
    }
    return { ...withSessionProxyState(s), job_accomplished, job_failed };
  });
  res.json(enriched);
});

researchScoped.post('/', auth, async (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const research = Researches.findByIdWithProject(String(req.params.researchId));
  if (!research) { res.status(404).json({ error: '未找到' }); return; }
  if (!canCreateSessionForResearch(user, research)) { res.status(403).json({ error: '无权加入此 Research' }); return; }
  if (!research.research_enabled) { res.status(400).json({ error: '当前项目未启用 Research 系统' }); return; }
  auditResearchAccess(user, 'create_research_session', research);

  const { name, description, role, excluded_skill_ids, excluded_memory_ids, model, language } = (req.body || {}) as {
    name?: string;
    description?: string;
    role?: string;
    excluded_skill_ids?: any;
    excluded_memory_ids?: any;
    model?: string;
    language?: string;
  };
  const continueFromSessionId = typeof req.body?.continue_from_session_id === 'string'
    ? req.body.continue_from_session_id.trim()
    : '';
  if (!name) { res.status(400).json({ error: '请填写会话名称' }); return; }
  if (!['chief_researcher', 'research_assistant'].includes(role as string)) {
    res.status(400).json({ error: 'Research Session role 非法' });
    return;
  }
  if (role === 'research_assistant') {
    // Research Agent 的正式创建必须经过统一团队链路，以便原子完成
    // limit 预留、初始 Prompt 启动、HR 通告和团队动作台账。保留
    // continue_from_session_id 作为旧 Session 转接的兼容路径。
    if (!continueFromSessionId) {
      res.status(410).json({
        error: 'Research Assistant 必须通过 /team/manual-agents 创建并立即启动',
        code: 'research_team_provision_required',
      });
      return;
    }
  }
  if (role === 'chief_researcher' && Sessions.findChiefForResearch(String(req.params.researchId))) {
    res.status(409).json({ error: '当前 Research 已存在 chief_researcher' });
    return;
  }

  const resolvedModel = modelRegistry.resolveSessionModelForCreate(model) as any;
  const limitCheck = modelPromptLimits.checkCreateAllowed(user.id, resolvedModel.key);
  if (!limitCheck.allowed) {
    res.status(limitCheck.status as number).json({
      error: limitCheck.error,
      code: limitCheck.code,
      usage: limitCheck.usage,
    });
    return;
  }
  const sessionLanguage = language === 'en' ? 'en' : 'zh';
  const sessionId = uuid().slice(0, 8);
  const sessionKey = `web:${user.id}:${sessionId}`;
  const excludedSkillIds = sanitizeIds(excluded_skill_ids);
  const excludedMemoryIds = sanitizeIds(excluded_memory_ids);
  const pcClientMetadata = req.body?.pc_client_metadata;
  const selectionSnapshot = buildResearchSessionSelectionSnapshot(
    user,
    String(req.params.researchId),
    excludedSkillIds,
    excludedMemoryIds,
    { pc_client_metadata: pcClientMetadata },
  );

  let sourceSession: AnySession | null = null;
  let transferResult: any = null;
  if (continueFromSessionId) {
    sourceSession = findSessionOperable(continueFromSessionId, user);
    if (!sourceSession) { res.status(404).json({ error: '旧 Session 不存在或无权操作' }); return; }
    if (
      String(sourceSession.research_id || '') !== String(req.params.researchId)
      || sourceSession.scope_type !== 'research'
    ) {
      res.status(400).json({ error: '只能从当前 Research 下的旧 Session 继续' });
      return;
    }
    const project = Projects.findById(research.project_id) as any;
    const bindPath = (project?.bind_path || '').trim();
    if (!bindPath) { res.status(400).json({ error: '当前项目未绑定路径, 无法创建 Session 转接文档' }); return; }
    const jsonlPath = sessionJsonlPath(sourceSession, continueFromSessionId);
    if (!jsonlPath) { res.status(400).json({ error: '旧 Session 没有可读取的 JSONL 记录' }); return; }
    try {
      transferResult = writeSessionTransferBundle({
        bindPath,
        sourceSession,
        targetSessionId: sessionId,
        jsonlPath,
      });
    } catch (e) {
      console.warn(`[researches] create transfer document failed (${continueFromSessionId}): ${(e as Error).message}`);
      res.status(500).json({ error: (e as Error).message || '创建 Session 转接文档失败' });
      return;
    }
  }

  try {
    Sessions.insert({
      session_id: sessionId,
      issue_id: null,
      project_id: research.project_id,
      scope_type: 'research',
      research_id: String(req.params.researchId),
      research_role: role as any,
      user_id: user.id,
      name,
      description,
      session_key: sessionKey,
      excluded_skill_ids: excludedSkillIds,
      excluded_memory_ids: excludedMemoryIds,
      selection_snapshot: selectionSnapshot,
      model: resolvedModel.sessionModelValue,
      language: sessionLanguage,
      pc_client_metadata: pcClientMetadata,
    });
  } catch (e) {
    if (String((e as Error).message || '').includes('idx_sessions_v2_one_chief_per_research')) {
      res.status(409).json({ error: '当前 Research 已存在 chief_researcher' });
      return;
    }
    throw e;
  }
  const pendingMentions = SessionPendingMentions.save(sessionId, req.body?.mentions);

  const displayRole = role === 'chief_researcher' ? 'chief_researcher' : 'research_assistant';
  const blackboardResult = appendBlackboardRecord({
    researchId: String(req.params.researchId),
    author: 'HR',
    content: `新的 ${displayRole} 已加入研究环境: session_id=${sessionId}, name=${name}`,
    metadata: { event: 'session_joined', session_id: sessionId, role: displayRole, name },
  });
  if ((blackboardResult as any).error) {
    try { Sessions.permanentDelete(sessionId); } catch {}
    res.status(500).json({ error: (blackboardResult as any).error });
    return;
  }
  if (sourceSession && transferResult?.paths?.full) {
    try {
      Messages.insertSystem(
        sessionId,
        JSON.stringify({
          type: 'session_transfer',
          format_version: 2,
          delivery_mode: 'file_references',
          from_session_id: sourceSession.session_id,
          path: transferResult.paths.full,
          paths: {
            full: transferResult.paths.full,
            user_messages: transferResult.paths.user_messages,
            metadata: transferResult.paths.metadata,
          },
          section_count: transferResult.sectionCount,
          entry_count: transferResult.entryCount,
          user_message_count: transferResult.userMessageCount,
          cards_omitted: transferResult.cardsOmitted,
          individual_cards_truncated: transferResult.individualCardsTruncated,
          truncated: transferResult.truncated,
        }),
        null as any,
        'session_transfer',
      );
    } catch (e) {
      console.warn(`[researches] save transfer marker failed (${sessionId}): ${(e as Error).message}`);
    }
    const closed = await terminateBackgroundSession(sourceSession, sourceSession.session_id);
    try {
      const project = Projects.findById(research.project_id) as any;
      if (project?.bind_path) safeRemoveRunningFlag(path.resolve(project.bind_path), sourceSession.session_id, 'session-transfer');
    } catch {}
    try { Sessions.setIdle(sourceSession.session_id, sourceSession.user_id || user.id); } catch {}
    try {
      Messages.insertSystem(
        sourceSession.session_id,
        [
          closed.message,
          '已创建更换模型继续的转接文件:',
          `- 完整记录: ${transferResult.paths.full}`,
          `- 仅用户消息: ${transferResult.paths.user_messages}`,
          `- Session 元数据: ${transferResult.paths.metadata}`,
        ].join('\n'),
        null as any,
        '修改模型并继续',
      );
    } catch {}
    audit(user.id, 'session.continue_with_model', 'session', sessionId,
      JSON.stringify({
        from_session_id: sourceSession.session_id,
        transfer_path: transferResult.paths.full,
        transfer_paths: transferResult.paths,
        background_was_alive: closed.wasAlive,
        background_was_working: closed.wasWorking,
        background_terminated: closed.terminated,
      }));
    const startContent = [name, description].map((part) => String(part || '').trim()).filter(Boolean).join('\n\n');
    if (startContent) {
      try {
        await runSessionMessage({
          user,
          sessionId,
          content: startContent,
          inputText: startContent,
          hasInputText: true,
          requestId: `continue-${sourceSession.session_id}-${Date.now()}` as any,
          mentions: pendingMentions,
          source: 'http.research_session.continue_with_model',
          logger: console,
        } as any);
        if (pendingMentions.length > 0) SessionPendingMentions.clear(sessionId);
      } catch (e) {
        const err = e as any;
        console.warn(`[researches] auto start continued session failed (${sessionId}): ${(e as Error).message}`);
        res.status(err.status || 500).json({ error: err.message || '启动新 Session 失败', category: err.category || undefined });
        return;
      }
    }
  }
  res.json({
    ...(withSessionProxyState(Sessions.findById(sessionId)) as any),
    continue_from_session_id: sourceSession?.session_id || null,
    transfer_path: transferResult?.paths?.full || null,
    transfer_paths: transferResult?.paths || null,
  });
});

function handleContextPreview(req: express.Request, res: express.Response): void {
  const user = (req as any).user;
  const research = Researches.findById(String(req.params.id));
  if (!research) { res.status(404).json({ error: '未找到' }); return; }
  if (!canReadResearch(user, research)) { res.status(404).json({ error: '未找到' }); return; }
  auditResearchAccess(user, 'read_research_context_preview', research);
  const src: any = (req.method === 'POST' && req.body && typeof req.body === 'object') ? req.body : req.query;
  const boolFlag = (v: unknown): boolean => v === true || v === 'true' || v === '1' || v === 1;
  const falseFlag = (v: unknown): boolean => v === false || v === 'false' || v === '0' || v === 0;
  const excludedSkillIds = toIdList(src.excluded_skill_ids);
  const excludedMemoryIds = toIdList(src.excluded_memory_ids);
  const includeBody = !falseFlag(src.include_body);
  const includeItemBodies = !falseFlag(src.include_item_bodies);
  const ctx = buildResearchContextPreview(
    user,
    String(req.params.id),
    {
      name: typeof src.name === 'string' ? src.name : '',
      description: typeof src.description === 'string' ? src.description : '',
      role: typeof src.role === 'string' ? src.role : 'research_assistant',
      pc_client_metadata: src.pc_client_metadata ?? null,
    },
    excludedSkillIds,
    excludedMemoryIds,
    src.language === 'en' ? 'en' : 'zh',
    { includeBody },
  );
  const canReuseSourcesForDefaults = excludedSkillIds.length === 0 && excludedMemoryIds.length === 0;
  res.json({
    body: ctx.body,
    sources: includeItemBodies ? ctx.sources : stripContextItemBodies(ctx.sources),
    ...(boolFlag(src.include_defaults)
      ? { defaults: buildResearchSelectionDefaults(user, String(req.params.id), canReuseSourcesForDefaults ? ctx.sources : undefined) }
      : {}),
  });
}

router.get('/:id/context-preview', auth, handleContextPreview);
router.post('/:id/context-preview', auth, handleContextPreview);

router.get('/:id/session-selection-defaults', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const research = Researches.findById(String(req.params.id));
  if (!research) { res.status(404).json({ error: '未找到' }); return; }
  if (!canReadResearch(user, research)) { res.status(404).json({ error: '未找到' }); return; }
  auditResearchAccess(user, 'read_research_session_selection_defaults', research);
  res.json(buildResearchSelectionDefaults(user, String(req.params.id)));
});

// "research agent skill": 名字以 research- 开头、且 frontmatter 含 research_role 字段的 skill.
// 用 resolveEffectiveSkills 走与 Wizard 相同的 (用户级+项目级) 去重逻辑, 保证返回的 id
// 与第二步勾选列表里的 id 完全一致, 前端可据此锁定该 skill 必选.
router.get('/:id/research-agent-skills', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const research = Researches.findByIdWithProject(String(req.params.id));
  if (!research) { res.status(404).json({ error: '未找到' }); return; }
  if (!canReadResearch(user, research)) { res.status(404).json({ error: '未找到' }); return; }
  auditResearchAccess(user, 'read_research_agent_skills', research);
  const preview = buildResearchContextPreview(user, String(req.params.id), null, [], [], 'zh', { includeBody: false });
  const effective: any[] = Array.isArray(preview.sources?.skills) ? preview.sources.skills : [];
  const agentSkills = effective
    .filter((s) => typeof s.name === 'string' && s.name.startsWith('research-') && s.research_role)
    .map((s) => ({ id: s.id, name: s.name, description: s.description || '', research_role: s.research_role, scope: s.scope }));
  res.json(agentSkills);
});

router.post('/:id/complete', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const research = Researches.findById(String(req.params.id));
  if (!research) { res.status(404).json({ error: '未找到' }); return; }
  if (!canManageResearch(user, research)) { res.status(403).json({ error: '无权完成此 Research' }); return; }
  auditResearchAccess(user, 'complete_research', research);
  Researches.markCompleted(String(req.params.id));
  res.json(shapeResearchForUser(Researches.findById(String(req.params.id)), user));
});

blackboardRouter.get('/:researchId', researchBlackboardAccess, (req: express.Request, res: express.Response) => {
  const result: any = readBlackboard(String(req.params.researchId));
  if (result.error) { res.status(404).type('text/plain').send(result.error); return; }
  res.type('application/x-ndjson; charset=utf-8').send(result.content || '');
});

blackboardRouter.post('/:researchId', researchBlackboardAccess, async (req: express.Request, res: express.Response) => {
  const normalized: any = normalizeWriteInput(req.body || {});
  if (normalized.error) { res.status(400).json({ error: normalized.error }); return; }
  const result: any = appendBlackboardRecord({
    researchId: String(req.params.researchId),
    author: normalized.author,
    content: normalized.content,
    metadata: normalized.metadata,
  });
  if (result.error) { res.status(400).json({ error: result.error }); return; }
  res.json({ ok: true, record: result.record });
});

graphRouter.get('/:researchId', (req: express.Request, res: express.Response) => {
  const result: any = readGraph(String(req.params.researchId));
  if (result.error) { res.status(404).json({ error: result.error }); return; }
  res.json({
    exists: result.exists,
    nodes: result.nodes,
    edges: result.edges,
    file: result.file,
  });
});

graphRouter.get('/:researchId/image', downloadAuth, (req: express.Request, res: express.Response) => {
  const result: any = resolveGraphImage(String(req.params.researchId), req.query.path);
  if (result.error) { res.status(result.error.includes('不存在') ? 404 : 403).json({ error: result.error }); return; }
  res.sendFile(result.absPath);
});

export { router, projectScoped, researchScoped, blackboardRouter, graphRouter };
