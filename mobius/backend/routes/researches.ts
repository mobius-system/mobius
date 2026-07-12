import express from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { auth, downloadAuth } from '../middleware/auth';
import { Researches } from '../repositories/researches';
import { Projects } from '../repositories/projects';
import { Sessions } from '../repositories/sessions';
import { Messages } from '../repositories/messages';
// @ts-ignore — service 仍是 .js
import modelRegistry from '../services/model-registry';
// @ts-ignore — service 仍是 .js
import modelPromptLimits from '../services/model-prompt-limits';
// @ts-ignore — service 仍是 .js
import { audit } from '../repositories/audit';
// @ts-ignore — service 仍是 .js
import { writeSessionTransferDocument } from '../services/session-transfer';
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

projectScoped.post('/', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const project = Projects.findById(String(req.params.projectId));
  if (!project) { res.status(404).json({ error: '未找到' }); return; }
  if (!canCreateIssue(user, project)) { res.status(403).json({ error: '无权在此项目创建 Research' }); return; }
  if (!project.research_enabled) { res.status(400).json({ error: '当前项目未启用 Research 系统' }); return; }
  const { title, description } = (req.body || {}) as { title?: string; description?: string };
  if (!title) { res.status(400).json({ error: '请填写 Research 标题' }); return; }
  if (!description) { res.status(400).json({ error: '请填写 Research 描述' }); return; }
  const researchId = uuid().slice(0, 8);
  Researches.insert({
    id: researchId,
    project_id: String(req.params.projectId),
    title,
    description,
    created_by: user.id,
    visibility: normalizeVisibility(req.body?.visibility, 'inherit', true) as any,
  });
  recordAdminAuditIfCrossUser(user, 'create_research', 'project', project.id, project.created_by);
  if (req.body?.visibility !== undefined
    || req.body?.allow_user_ids !== undefined || req.body?.allowUserIds !== undefined
    || req.body?.allow_group_ids !== undefined || req.body?.allowGroupIds !== undefined) {
    setResourcePolicy('research', researchId, { ...researchAccessBody(req.body), createdBy: user.id });
  }
  res.json(shapeResearchForUser(Researches.findById(researchId), user));
});

router.get('/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const research = Researches.findById(String(req.params.id));
  if (!research) { res.status(404).json({ error: '未找到' }); return; }
  if (!canReadResearch(user, research)) { res.status(404).json({ error: '未找到' }); return; }
  auditResearchAccess(user, 'read_research', research);
  res.json(shapeResearchForUser(research, user));
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
  const suppressJoinNotice = req.body?.suppress_join_notice === true || req.body?.suppressJoinNotice === true;
  const continueFromSessionId = typeof req.body?.continue_from_session_id === 'string'
    ? req.body.continue_from_session_id.trim()
    : '';
  if (!name) { res.status(400).json({ error: '请填写会话名称' }); return; }
  if (!['chief_researcher', 'research_assistant'].includes(role as string)) {
    res.status(400).json({ error: 'Research Session role 非法' });
    return;
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
  const selectionSnapshot = buildResearchSessionSelectionSnapshot(
    user,
    String(req.params.researchId),
    excludedSkillIds,
    excludedMemoryIds,
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
      transferResult = writeSessionTransferDocument({
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
      pc_client_metadata: req.body?.pc_client_metadata,
    });
  } catch (e) {
    if (String((e as Error).message || '').includes('idx_sessions_v2_one_chief_per_research')) {
      res.status(409).json({ error: '当前 Research 已存在 chief_researcher' });
      return;
    }
    throw e;
  }

  const displayRole = role === 'chief_researcher' ? 'chief_researcher' : 'research_assistant';
  if (!suppressJoinNotice) {
    const blackboardResult = appendBlackboardRecord({
      researchId: String(req.params.researchId),
      author: 'HR',
      content: `新的 ${displayRole} 已加入研究环境: session_id=${sessionId}, name=${name}`,
      metadata: { event: 'session_joined', session_id: sessionId, role: displayRole, name },
    });
    if ((blackboardResult as any).error) { res.status(500).json({ error: (blackboardResult as any).error }); return; }
  }
  if (sourceSession && transferResult?.filePath) {
    try {
      Messages.insertSystem(
        sessionId,
        JSON.stringify({
          type: 'session_transfer',
          from_session_id: sourceSession.session_id,
          path: transferResult.filePath,
          section_count: transferResult.sectionCount,
          entry_count: transferResult.entryCount,
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
        `${closed.message}\n已创建更换模型继续的转接文档: ${transferResult.filePath}`,
        null as any,
        '修改模型并继续',
      );
    } catch {}
    audit(user.id, 'session.continue_with_model', 'session', sessionId,
      JSON.stringify({
        from_session_id: sourceSession.session_id,
        transfer_path: transferResult.filePath,
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
          source: 'http.research_session.continue_with_model',
          logger: console,
        } as any);
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
    transfer_path: transferResult?.filePath || null,
  });
});

function handleContextPreview(req: express.Request, res: express.Response): void {
  const user = (req as any).user;
  const research = Researches.findById(String(req.params.id));
  if (!research) { res.status(404).json({ error: '未找到' }); return; }
  if (!canReadResearch(user, research)) { res.status(404).json({ error: '未找到' }); return; }
  auditResearchAccess(user, 'read_research_context_preview', research);
  const src: any = (req.method === 'POST' && req.body && typeof req.body === 'object') ? req.body : req.query;
  const ctx = buildResearchContextPreview(
    user,
    String(req.params.id),
    {
      name: typeof src.name === 'string' ? src.name : '',
      description: typeof src.description === 'string' ? src.description : '',
      role: typeof src.role === 'string' ? src.role : 'research_assistant',
      pc_client_metadata: src.pc_client_metadata ?? null,
    },
    toIdList(src.excluded_skill_ids),
    toIdList(src.excluded_memory_ids),
    src.language === 'en' ? 'en' : 'zh',
  );
  res.json({ body: ctx.body, sources: ctx.sources });
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
  const preview = buildResearchContextPreview(user, String(req.params.id), null, [], [], 'zh');
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

blackboardRouter.get('/:researchId', (req: express.Request, res: express.Response) => {
  const result: any = readBlackboard(String(req.params.researchId));
  if (result.error) { res.status(404).type('text/plain').send(result.error); return; }
  res.type('application/x-ndjson; charset=utf-8').send(result.content || '');
});

blackboardRouter.post('/:researchId', async (req: express.Request, res: express.Response) => {
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
