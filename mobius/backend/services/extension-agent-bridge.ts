/**
 * extension-agent-bridge.ts
 *
 * Shared helper for extensions that need to create a normal Mobius
 * Project -> Issue -> Session workspace for agent analysis.
 */
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import { Users } from '../repositories/users';
import { Projects } from '../repositories/projects';
import { Issues } from '../repositories/issues';
import { Sessions } from '../repositories/sessions';
import { Skills } from '../repositories/skills';
import { parseSkillId } from './skills-fs';
import { buildSessionSelectionSnapshot, buildIssueSelectionDefaults } from './session-context';
import modelRegistry from './model-registry';
import modelPromptLimits from './model-prompt-limits';

const DEFAULT_MODEL = 'codex';
const DEFAULT_LANGUAGE = 'zh';
const WORKSPACE_ROOT_NAME = '_mobius_extension_workspaces';

function trimText(value: any, max: number = 200): string {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function sanitizeSlug(value: any, fallback = 'extension'): string {
  const s = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

function resolveUnder(root: any, ...parts: any[]): string {
  const base = path.resolve(root);
  const abs = path.resolve(base, ...parts);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('extension workspace path escapes user work_dir');
  }
  return abs;
}

function loadUser(userId: any): any {
  const user = Users.findAuthById(userId);
  if (!user) {
    const err = new Error('用户不存在或不可用') as Error & { status?: number };
    err.status = 404;
    throw err;
  }
  if (!user.work_dir) {
    const err = new Error('用户工作目录不可用') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  return user;
}

function findExistingWorkspaceProject(user: any, projectName: string, bindPath: string): any {
  const normalizedBind = path.resolve(bindPath);
  return Projects.listAll(user.id).find((p: any) => {
    if (!p || p.kind === 'extension' || p.disabled) return false;
    if (p.created_by !== user.id) return false;
    if (p.name !== projectName) return false;
    return path.resolve(p.bind_path || '') === normalizedBind;
  }) || null;
}

function ensureWorkspaceProject({ user, extensionName, extensionDisplayName, description }: {
  user: any;
  extensionName: string;
  extensionDisplayName?: string;
  description?: any;
}): any {
  const safeName = sanitizeSlug(extensionName);
  const projectName = trimText(`${extensionDisplayName || extensionName} 工作区`, 80);
  const bindPath = resolveUnder(user.work_dir, WORKSPACE_ROOT_NAME, safeName);
  fs.mkdirSync(bindPath, { recursive: true });

  const existing = findExistingWorkspaceProject(user, projectName, bindPath);
  if (existing) return existing;

  const projectId = uuid().slice(0, 8);
  Projects.insert({
    id: projectId,
    name: projectName,
    description: description || `由拓展 ${extensionDisplayName || extensionName} 自动创建的 agent 分析工作区。`,
    createdBy: user.id,
    bindPath,
    bindPathManual: true,
    gitRepos: [],
    defaultUseWorktree: false,
    researchEnabled: false,
  });
  return Projects.findById(projectId, user.id) || Projects.findById(projectId);
}

function ensureIssue({ user, project, title, description }: {
  user: any;
  project: any;
  title?: any;
  description?: any;
}): any {
  const issueTitle = trimText(title || '拓展分析任务', 120);
  const existing = Issues.findByProjectAndTitle(project.id, issueTitle);
  if (existing) return existing;

  const issueId = uuid().slice(0, 8);
  Issues.insert({
    id: issueId,
    project_id: project.id,
    title: issueTitle,
    description: description || issueTitle,
    created_by: user.id,
    use_worktree: false,
    worktree_branch: '',
  });
  return Issues.findById(issueId);
}

function compactSkillForSnapshot(skill: any): any {
  if (!skill || !skill.id) return null;
  const parsed = parseSkillId(skill.id);
  return {
    id: skill.id,
    scope: skill.scope,
    name: skill.name,
    description: skill.description || '',
    research_role: skill.research_role || '',
    dirName: skill.dirName || (parsed ? parsed.dirName : null),
    body: skill.body || '',
  };
}

function forceEnabledSkills(snapshot: any, skillIds: any): any {
  const out = snapshot && typeof snapshot === 'object'
    ? JSON.parse(JSON.stringify(snapshot))
    : { version: 1, skills: [], memories: [], all_skills: [], all_memories: [], totals: { skills: 0, memories: 0 }, excluded_skill_ids: [], excluded_memory_ids: [] };

  out.skills = Array.isArray(out.skills) ? out.skills : [];
  out.memories = Array.isArray(out.memories) ? out.memories : [];
  out.all_skills = Array.isArray(out.all_skills) ? out.all_skills : [];
  out.all_memories = Array.isArray(out.all_memories) ? out.all_memories : [];
  out.excluded_skill_ids = Array.isArray(out.excluded_skill_ids) ? out.excluded_skill_ids : [];
  out.excluded_memory_ids = Array.isArray(out.excluded_memory_ids) ? out.excluded_memory_ids : [];

  for (const id of Array.isArray(skillIds) ? skillIds : []) {
    const skill = Skills.findById(id);
    const compact = compactSkillForSnapshot(skill);
    if (!compact) continue;
    if (!out.skills.some((sk: any) => sk.id === compact.id)) out.skills.push(compact);
    const existing = out.all_skills.find((sk: any) => sk.id === compact.id);
    if (existing) existing.enabled = true;
    else out.all_skills.push({ ...compact, enabled: true });
    out.excluded_skill_ids = out.excluded_skill_ids.filter((excludedId: any) => excludedId !== compact.id);
  }

  out.totals = {
    skills: out.all_skills.length,
    memories: out.all_memories.length,
  };
  return out;
}

function normalizeIdList(value: any): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(value) ? value : []) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function shapeProject(project: any): any {
  return project ? {
    id: project.id,
    name: project.name,
    bind_path: project.bind_path || '',
  } : null;
}

function shapeIssue(issue: any): any {
  return issue ? {
    id: issue.id,
    project_id: issue.project_id,
    title: issue.title,
    description: issue.description || '',
    status: issue.status,
  } : null;
}

function shapeSession(session: any): any {
  return session ? {
    session_id: session.session_id,
    issue_id: session.issue_id,
    project_id: session.project_id,
    name: session.name,
    description: session.description || '',
    status: session.status,
    model: session.model,
    language: session.language,
  } : null;
}

function createExtensionAnalysisSession(input: any = {}): any {
  const user = input.user || loadUser(input.userId || input.username);
  const extensionName = sanitizeSlug(input.extensionName || input.extension_name, 'extension');
  const extensionDisplayName = trimText(input.extensionDisplayName || input.extension_display_name || extensionName, 80);

  const project = ensureWorkspaceProject({
    user,
    extensionName,
    extensionDisplayName,
    description: input.projectDescription,
  });
  const issue = ensureIssue({
    user,
    project,
    title: input.issueTitle || `${extensionDisplayName} 分析`,
    description: input.issueDescription || `${extensionDisplayName} 自动创建的分析 Issue。`,
  });

  const resolvedModel = modelRegistry.resolveSessionModelForCreate(input.model || DEFAULT_MODEL);
  const limitCheck = modelPromptLimits.checkCreateAllowed(user.id, resolvedModel.key);
  if (!limitCheck.allowed) {
    const err = new Error(limitCheck.error) as Error & { status?: any; code?: any; usage?: any };
    err.status = limitCheck.status || 429;
    err.code = limitCheck.code;
    err.usage = limitCheck.usage;
    throw err;
  }

  const defaults = buildIssueSelectionDefaults(user, issue.id);
  const forcedSkillIds = normalizeIdList(input.forceSkillIds || input.force_skill_ids);
  const excludedSkillIds = Object.prototype.hasOwnProperty.call(input, 'excludedSkillIds')
    ? normalizeIdList(input.excludedSkillIds)
    : normalizeIdList(defaults.excluded_skill_ids).filter((id) => !forcedSkillIds.includes(id));
  const excludedMemoryIds = Object.prototype.hasOwnProperty.call(input, 'excludedMemoryIds')
    ? normalizeIdList(input.excludedMemoryIds)
    : normalizeIdList(defaults.excluded_memory_ids);

  const sessionId = uuid().slice(0, 8);
  const sessionName = trimText(input.sessionName || `${extensionDisplayName} 分析 ${new Date().toISOString().slice(0, 16)}`, 100);
  const sessionDescription = String(input.sessionDescription || input.description || sessionName).trim();
  const selectionSnapshot = forceEnabledSkills(
    buildSessionSelectionSnapshot(user, issue.id, excludedSkillIds, excludedMemoryIds),
    forcedSkillIds,
  );

  Sessions.insert({
    session_id: sessionId,
    issue_id: issue.id,
    project_id: project.id,
    user_id: user.id,
    name: sessionName,
    description: sessionDescription,
    session_key: `extension:${extensionName}:${user.id}:${sessionId}`,
    excluded_skill_ids: selectionSnapshot.excluded_skill_ids || excludedSkillIds,
    excluded_memory_ids: selectionSnapshot.excluded_memory_ids || excludedMemoryIds,
    selection_snapshot: selectionSnapshot,
    model: resolvedModel.sessionModelValue,
    language: input.language === 'en' ? 'en' : DEFAULT_LANGUAGE,
  });
  Issues.touchActiveAndIncrement(issue.id);

  return {
    project: shapeProject(project),
    issue: shapeIssue(issue),
    session: shapeSession(Sessions.findById(sessionId)),
  };
}

export {
  createExtensionAnalysisSession,
  loadUser,
};
