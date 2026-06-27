import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
const multer = require('multer') as any;
import { v4 as uuid } from 'uuid';
import { auth } from '../middleware/auth';
import { Projects } from '../repositories/projects';
import { Issues } from '../repositories/issues';
import { Sessions } from '../repositories/sessions';
import { Messages } from '../repositories/messages';
// @ts-ignore — bridge instance 仍是 .js
import { bridge } from '../bridge/instance';
// @ts-ignore — agents 仍是 .js
import agents from '../agents';
// @ts-ignore — service 仍是 .js
import modelRegistry from '../services/model-registry';
// @ts-ignore — service 仍是 .js
import modelPromptLimits from '../services/model-prompt-limits';
// @ts-ignore — service 仍是 .js
import {
  buildIssueContextPreview,
  buildSessionContext,
  buildSessionSelectionSnapshot,
  wrapUserMessage,
} from '../services/session-context';
// @ts-ignore — service 仍是 .js
import { syncSkillsToWorkspace } from '../services/session-skills-sync';
// @ts-ignore — service 仍是 .js
import {
  ASSISTANT_SESSION_KEY_PREFIX,
  assistantSessionKeyLike,
  isAssistantSession,
} from '../services/assistant-session';
import { safeRemoveRunningFlag, safeWriteFailedFlag, readJobFlagState } from '../utils/session-flags';
import { APP_DIR, CORE_DATA_PATH } from '../config';
// @ts-ignore — service 仍是 .js
import { AsrError, transcribeBrowserAudio } from '../services/doubao-asr';
// @ts-ignore — service 仍是 .js
import { DEFAULT_VOICE, TtsError, getTtsVoices, synthesizeSpeech } from '../services/doubao-tts';
// @ts-ignore — service 仍是 .js
import {
  normalizeSessionAttachments,
  sessionContentWithAttachments,
} from '../services/session-attachments';
import { db } from '../../db';

const router = express.Router();
const assistantVoiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 25 * 1024 * 1024,
  },
}).single('audio');

const ASSISTANT_PROJECT_DESCRIPTION = '系统自动创建的小莫助理项目。小莫会在这里保存该用户的独立对话 Session 和预设配置。';
const LEGACY_ASSISTANT_PROJECT_DESCRIPTION = '系统自动创建的小莫项目。小莫会在这里保存该用户的独立对话 Session。';
const ASSISTANT_ISSUE_TITLE = '小莫对话';
const ASSISTANT_ISSUE_DESCRIPTION = '小莫轻量助手的对话任务单。首次提问创建 Session，后续追问沿用已有 Session。';
const ASSISTANT_REQUIRED_BUILTIN_SKILL_ID = 'builtin:mobius-assistant';
const MAIN_ASSISTANT_SESSION_NAME = '我的主小莫';
const ASSISTANT_CLONE_SESSION_PREFIX = '分身小莫 #';
const DEFAULT_HISTORY_LIMIT = 20;
const ASSISTANT_PRESET_DIR = path.join(CORE_DATA_PATH, 'assistant-presets');
const DEFAULT_ASSISTANT_PRESET_NAME = '小莫助理';
const LEGACY_DEFAULT_ASSISTANT_PRESET_DESCRIPTION = [
  '你是小莫，莫比乌斯工作台里的项目助理。',
  '优先用中文直接回答用户问题。需要给操作建议时，按项目、任务单、执行会话这三层说明清楚。',
  '不要在用户没有明确要求时替用户创建项目、任务单或执行会话。',
].join('\n');
const DEFAULT_ASSISTANT_PRESET_DESCRIPTION = '你是小莫，莫比乌斯AI的项目助理。先读取skills/mobius-assistant/SKILL.md获取你的服务指南，再执行任务';
const DEFAULT_ASSISTANT_PERSONALITY = 'balanced';
const ASSISTANT_PERSONALITY_OPTIONS = [
  {
    key: 'balanced',
    label: '默认小莫',
    description: '友好、清楚、自然，延续当前小莫体验。',
    prompt: '保持友好、清楚、自然。需要行动时先讲清楚下一步，不过度发挥。',
  },
  {
    key: 'serious',
    label: '严肃的小莫',
    description: '克制、准确、结构化，适合工作任务。',
    prompt: '表达克制、准确、结构化。避免玩笑和过度拟人化，优先给出可执行结论、依据、风险和下一步。',
  },
  {
    key: 'playful',
    label: '调皮的小莫',
    description: '轻快一点，但关键操作仍然严谨。',
    prompt: '语气可以轻快一点，允许少量俏皮表达，但不要影响专业判断。涉及确认、权限、删除、启动执行和风险时必须恢复严谨。',
  },
  {
    key: 'proactive',
    label: '热情主动的小莫',
    description: '主动补全方案，推动模糊需求落地。',
    prompt: '更主动地识别用户真实目标，补全合理方案并推荐下一步。不要反复询问开放性问题，但涉及越权操作前必须确认。',
  },
  {
    key: 'gentle',
    label: '温和耐心的小莫',
    description: '解释更充分，适合新用户和引导场景。',
    prompt: '语气温和、耐心，解释复杂流程时拆成小步。减少术语堆叠，帮助用户理解系统，但不要啰嗦。',
  },
  {
    key: 'concise',
    label: '干练的小莫',
    description: '结论先行，少铺垫，适合熟练用户。',
    prompt: '结论先行，减少铺垫和寒暄。除非必要，不展开长背景，优先使用短段落和明确动作项。',
  },
];
const ASSISTANT_PERSONALITY_MAP = new Map(
  ASSISTANT_PERSONALITY_OPTIONS.map((option) => [option.key, option]),
);

function assistantSessionKey(userId: string, sessionId: string): string {
  return `${ASSISTANT_SESSION_KEY_PREFIX}:${userId}:${sessionId}`;
}

function isMainAssistantSessionName(name: unknown): boolean {
  return String(name || '').trim() === MAIN_ASSISTANT_SESSION_NAME;
}

function isAssistantCloneSessionName(name: unknown): boolean {
  return String(name || '').trim().startsWith(ASSISTANT_CLONE_SESSION_PREFIX);
}

function assistantSessionRole(session: any): string {
  if (isMainAssistantSessionName(session?.name)) return 'main';
  if (isAssistantCloneSessionName(session?.name)) return 'clone';
  return isAssistantSession(session) ? 'main' : 'clone';
}

function isAssistantCloneSession(session: any, user: any): boolean {
  if (!session || !user?.id || session.user_id !== user.id) return false;
  if (!isAssistantCloneSessionName(session.name)) return false;
  const project = findAssistantProject(user);
  if (!project || session.project_id !== project.id) return false;
  const issue = Issues.findByProjectAndTitle(project.id, ASSISTANT_ISSUE_TITLE);
  return !!issue && session.issue_id === issue.id;
}

function isAssistantVisibleSession(session: any, user: any): boolean {
  return isAssistantSession(session, user) || isAssistantCloneSession(session, user);
}

function normalizeLimit(value: unknown, fallback: number = DEFAULT_HISTORY_LIMIT, max: number = 80): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function stableAssistantProjectId(userId: string): string {
  const hash = crypto.createHash('sha1').update(String(userId || '')).digest('hex').slice(0, 10);
  return `xm-${hash}`;
}

function assistantProjectName(user: any): string {
  const base = String(user?.display_name || user?.id || '').trim() || '用户';
  return `${base}的小莫助理`;
}

function assistantWorkDir(): string {
  const dir = path.resolve(APP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function findAssistantProject(user: any): any {
  const stableId = stableAssistantProjectId(user.id);
  const byId = Projects.findById(stableId, user.id);
  if (byId && byId.created_by === user.id) return byId;
  const row = db.prepare(`
    SELECT id
    FROM projects
    WHERE created_by = ?
      AND description IN (?, ?)
    ORDER BY created_at ASC
    LIMIT 1
  `).get(user.id, ASSISTANT_PROJECT_DESCRIPTION, LEGACY_ASSISTANT_PROJECT_DESCRIPTION) as { id?: string } | undefined;
  return row?.id ? Projects.findById(row.id, user.id) : null;
}

function safeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeAssistantPersonality(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : '';
  return ASSISTANT_PERSONALITY_MAP.has(key) ? key : DEFAULT_ASSISTANT_PERSONALITY;
}

function assistantPersonalityOption(value: unknown): typeof ASSISTANT_PERSONALITY_OPTIONS[number] {
  return ASSISTANT_PERSONALITY_MAP.get(normalizeAssistantPersonality(value))
    || ASSISTANT_PERSONALITY_MAP.get(DEFAULT_ASSISTANT_PERSONALITY)!;
}

function parseStoredIdList(raw: unknown): string[] {
  if (!raw) return [];
  try {
    return safeIdList(JSON.parse(raw as string));
  } catch {
    return [];
  }
}

function sameIdSet(a: unknown, b: unknown): boolean {
  const left = safeIdList(a).slice().sort();
  const right = safeIdList(b).slice().sort();
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseStoredJson(raw: unknown): any {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function assistantSessionPersonality(session: any): string {
  const snapshot = parseStoredJson(session?.session_selection_snapshot);
  return normalizeAssistantPersonality(
    snapshot?.assistant?.personality
      || snapshot?.assistant_preset?.personality
      || snapshot?.assistant_personality,
  );
}

function isAssistantRequiredSkillId(id: unknown): boolean {
  const normalized = String(id || '').replace(/_/g, '-');
  return normalized === ASSISTANT_REQUIRED_BUILTIN_SKILL_ID
    || normalized.endsWith(':mobius-assistant');
}

function sanitizeAssistantExcludedSkillIds(value: unknown): string[] {
  return safeIdList(value).filter((id) => !isAssistantRequiredSkillId(id));
}

function prefersMinimaxM3(option: any): boolean {
  const haystack = [
    option?.key,
    option?.value,
    option?.model,
    option?.label,
    option?.title,
    option?.sub,
  ].filter(Boolean).join(' ').toLowerCase();
  const compact = haystack.replace(/[\s._-]+/g, '');
  return compact.includes('minimaxm3') || compact.includes('minimax03');
}

function preferredAssistantModelKey(): string {
  let options: any[] = [];
  try { options = modelRegistry.listSessionModelOptions(); } catch { /* ignore */ }
  const minimaxM3 = options.find(prefersMinimaxM3);
  if (minimaxM3?.key) return minimaxM3.key;
  // Fall back to the first available (configured) model, then the default key.
  if (options.length > 0) return options[0].key;
  return modelRegistry.DEFAULT_MODEL_KEY || 'codex';
}

function availableModelKeys(): Set<string> {
  try {
    return new Set(modelRegistry.listSessionModelOptions().map((option: any) => option.key).filter(Boolean));
  } catch {
    return new Set(['codex']);
  }
}

function assistantDefaultSelectionExclusions(user: any, issueId: string | null): { excluded_skill_ids: string[]; excluded_memory_ids: string[] } {
  if (!issueId) return { excluded_skill_ids: [], excluded_memory_ids: [] };
  try {
    const ctx = buildIssueContextPreview(user, issueId, null, [], [], 'zh');
    const skills = Array.isArray(ctx.sources?.skills) ? ctx.sources.skills : [];
    const memories = Array.isArray(ctx.sources?.memories) ? ctx.sources.memories : [];
    return {
      excluded_skill_ids: skills
        .map((skill: any) => skill?.id)
        .filter((id: any) => id && !isAssistantRequiredSkillId(id)),
      excluded_memory_ids: memories
        .map((memory: any) => memory?.id)
        .filter(Boolean),
    };
  } catch {
    return { excluded_skill_ids: [], excluded_memory_ids: [] };
  }
}

interface AssistantPresetNormalized {
  name: string;
  description: string;
  personality: string;
  model: string;
  role: 'chief_researcher' | 'research_assistant';
  language: 'zh' | 'en';
  existing_session_action: string;
  excluded_skill_ids: string[];
  excluded_memory_ids: string[];
  required_skill_ids: string[];
  saved_at?: string;
}

function normalizeAssistantPreset(input: any = {}, defaultExclusions: { excluded_skill_ids?: string[]; excluded_memory_ids?: string[] } = {}): AssistantPresetNormalized {
  const src = input && typeof input === 'object' ? input : {};
  const modelKeys = availableModelKeys();
  const preferredModel = preferredAssistantModelKey();
  const model = typeof src.model === 'string' && modelKeys.has(src.model)
    ? src.model
    : preferredModel;
  const hasSkillExclusions = Array.isArray(src.excluded_skill_ids);
  const hasMemoryExclusions = Array.isArray(src.excluded_memory_ids);
  const rawDescription = typeof src.description === 'string' && src.description.trim()
    ? src.description.trim()
    : DEFAULT_ASSISTANT_PRESET_DESCRIPTION;
  const description = rawDescription === LEGACY_DEFAULT_ASSISTANT_PRESET_DESCRIPTION
    ? DEFAULT_ASSISTANT_PRESET_DESCRIPTION
    : rawDescription;
  return {
    name: typeof src.name === 'string' && src.name.trim()
      ? src.name.trim()
      : DEFAULT_ASSISTANT_PRESET_NAME,
    description,
    personality: normalizeAssistantPersonality(src.personality),
    model,
    role: src.role === 'chief_researcher' ? 'chief_researcher' : 'research_assistant',
    language: src.language === 'en' ? 'en' : 'zh',
    existing_session_action: 'ignore',
    excluded_skill_ids: sanitizeAssistantExcludedSkillIds(
      hasSkillExclusions ? src.excluded_skill_ids : defaultExclusions.excluded_skill_ids,
    ),
    excluded_memory_ids: safeIdList(
      hasMemoryExclusions ? src.excluded_memory_ids : defaultExclusions.excluded_memory_ids,
    ),
    required_skill_ids: Array.from(new Set([
      ...safeIdList(src.required_skill_ids),
      ASSISTANT_REQUIRED_BUILTIN_SKILL_ID,
    ])),
    saved_at: typeof src.saved_at === 'string' ? src.saved_at : undefined,
  };
}

function assistantPresetFile(userId: string): string {
  const hash = crypto.createHash('sha1').update(String(userId || '')).digest('hex');
  return path.join(ASSISTANT_PRESET_DIR, `${hash}.json`);
}

function readStoredAssistantPreset(user: any): any {
  try {
    const file = assistantPresetFile(user.id);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed.preset || parsed : null;
  } catch {
    return null;
  }
}

function readAssistantPreset(user: any, issueId: string | null = null): AssistantPresetNormalized {
  return normalizeAssistantPreset(
    readStoredAssistantPreset(user) || {},
    assistantDefaultSelectionExclusions(user, issueId),
  );
}

function writeAssistantPreset(user: any, preset: any, defaultExclusions: { excluded_skill_ids?: string[]; excluded_memory_ids?: string[] } = {}): AssistantPresetNormalized {
  fs.mkdirSync(ASSISTANT_PRESET_DIR, { recursive: true });
  const normalized = normalizeAssistantPreset({
    ...preset,
    saved_at: new Date().toISOString(),
  }, defaultExclusions);
  const file = assistantPresetFile(user.id);
  fs.writeFileSync(file, `${JSON.stringify({
    user_id: user.id,
    preset: normalized,
    updated_at: normalized.saved_at,
  }, null, 2)}\n`, 'utf8');
  return normalized;
}

function canonicalAssistantPreset(preset: any) {
  const normalized = normalizeAssistantPreset(preset);
  return {
    name: normalized.name,
    description: normalized.description,
    personality: normalized.personality,
    model: normalized.model,
    language: normalized.language,
    excluded_skill_ids: normalized.excluded_skill_ids.slice().sort(),
    excluded_memory_ids: normalized.excluded_memory_ids.slice().sort(),
    required_skill_ids: normalized.required_skill_ids.slice().sort(),
  };
}

function assistantPresetChanged(before: any, after: any): boolean {
  return JSON.stringify(canonicalAssistantPreset(before)) !== JSON.stringify(canonicalAssistantPreset(after));
}

function sessionSelectionIncludesRequiredAssistantSkill(session: any): boolean {
  try {
    const snapshot = JSON.parse(session?.session_selection_snapshot || '{}');
    const skills = [
      ...(Array.isArray(snapshot.skills) ? snapshot.skills : []),
      ...(Array.isArray(snapshot.all_skills) ? snapshot.all_skills : []),
    ];
    return skills.some((skill: any) => isAssistantRequiredSkillId(skill?.id));
  } catch {
    return false;
  }
}

function assistantSessionMatchesPreset(session: any, preset: any): boolean {
  if (!session) return true;
  const normalized = normalizeAssistantPreset(preset);
  const resolved = modelRegistry.resolveSessionModel(session.model);
  const sessionModelKey = resolved?.key || session.model;
  return sessionModelKey === normalized.model
    && (session.language || 'zh') === normalized.language
    && String(session.description || '') === normalized.description
    && assistantSessionPersonality(session) === normalized.personality
    && sessionSelectionIncludesRequiredAssistantSkill(session)
    && sameIdSet(parseStoredIdList(session.session_excluded_skills), normalized.excluded_skill_ids)
    && sameIdSet(parseStoredIdList(session.session_excluded_memories), normalized.excluded_memory_ids);
}

function ensureAssistantProject(user: any): any {
  const bindPath = assistantWorkDir();
  const name = assistantProjectName(user);
  const existing = findAssistantProject(user);
  if (existing) {
    if (path.resolve(existing.bind_path || '') !== bindPath) {
      Projects.updateBindPath(existing.id, bindPath, true);
    }
    if (existing.name !== name) Projects.updateName(existing.id, name);
    if (existing.description !== ASSISTANT_PROJECT_DESCRIPTION) Projects.updateDescription(existing.id, ASSISTANT_PROJECT_DESCRIPTION);
    if (existing.default_use_worktree) Projects.updateDefaultUseWorktree(existing.id, false);
    return Projects.findById(existing.id, user.id);
  }

  const id = stableAssistantProjectId(user.id);
  Projects.insert({
    id,
    name,
    description: ASSISTANT_PROJECT_DESCRIPTION,
    createdBy: user.id,
    bindPath,
    bindPathManual: true,
    gitRepos: [],
    defaultUseWorktree: false,
    researchEnabled: false,
  });
  return Projects.findById(id, user.id);
}

function ensureAssistantIssue(project: any, user: any): any {
  const existing = Issues.findByProjectAndTitle(project.id, ASSISTANT_ISSUE_TITLE);
  if (existing) return existing;
  const issueId = uuid().slice(0, 8);
  Issues.insert({
    id: issueId,
    project_id: project.id,
    title: ASSISTANT_ISSUE_TITLE,
    description: ASSISTANT_ISSUE_DESCRIPTION,
    created_by: user.id,
    use_worktree: false,
    worktree_branch: '',
  });
  return Issues.findById(issueId);
}

function backendForSession(session: any): any {
  return agents.get(modelRegistry.backendNameForSessionModel(session?.model));
}

function normalizeAssistantClientContext(raw: any, user: any, authorizationHeader: string = ''): any {
  const src = raw && typeof raw === 'object' ? raw : {};
  const auth = src.auth && typeof src.auth === 'object' ? src.auth : {};
  const token = typeof auth.token === 'string' ? auth.token : '';
  const authorization = typeof auth.authorization === 'string' && auth.authorization.trim()
    ? auth.authorization.trim()
    : (token ? `Bearer ${token}` : String(authorizationHeader || '').trim());
  return {
    current_url: typeof src.current_url === 'string' ? src.current_url : '',
    origin: typeof src.origin === 'string' ? src.origin : '',
    pathname: typeof src.pathname === 'string' ? src.pathname : '',
    search: typeof src.search === 'string' ? src.search : '',
    hash: typeof src.hash === 'string' ? src.hash : '',
    auth: {
      token,
      authorization,
      user_id: user?.id || '',
      display_name: user?.display_name || user?.id || '',
      role: user?.role || '',
    },
  };
}

function assistantClientContextText(clientContext: any): string {
  if (!clientContext || typeof clientContext !== 'object') return '';
  const lines: string[] = [];
  if (clientContext.current_url) lines.push(`- 当前浏览 URL: ${clientContext.current_url}`);
  if (clientContext.origin) lines.push(`- 当前站点 Origin: ${clientContext.origin}`);
  if (clientContext.pathname) lines.push(`- 当前路径: ${clientContext.pathname}`);
  if (clientContext.search) lines.push(`- URL 查询参数: ${clientContext.search}`);
  if (clientContext.hash) lines.push(`- URL Hash: ${clientContext.hash}`);
  const auth = clientContext.auth || {};
  if (auth.user_id || auth.display_name || auth.role) {
    lines.push(`- 当前用户: ${auth.display_name || auth.user_id}${auth.user_id ? ` (${auth.user_id})` : ''}${auth.role ? `, role=${auth.role}` : ''}`);
  }
  if (auth.authorization) lines.push(`- HTTP Authorization: ${auth.authorization}`);
  if (auth.token) lines.push(`- auth token: ${auth.token}`);
  return lines.join('\n');
}

function assistantPersonalityPromptLines(personality: unknown): string[] {
  const option = assistantPersonalityOption(personality);
  return [
    `当前小莫性格预设：${option.label}`,
    `表达风格要求：${option.prompt}`,
    '性格预设只影响表达方式，不改变小莫的服务边界、授权确认、API 调用规则和安全要求。',
  ];
}

function assistantPrompt(question: string, sessionId: string, clientContext: any = null, personality: unknown = DEFAULT_ASSISTANT_PERSONALITY): string {
  const text = String(question || '').trim();
  if (text.startsWith('/compact')) return text;
  const clientContextBlock = assistantClientContextText(clientContext);
  return [
    '你是小莫，莫比乌斯AI的项目助理。',
    '你是“主体小莫”。你的固定 Session 名称应为“我的主小莫”。',
    '主体小莫职责：理解用户意图、把彼此独立的工作拆给分身小莫、在分身完成后汇总结果，并用 `PushVoiceToUser("播报文本")` 播报需要提醒用户的收尾结论。',
    '当用户要求你同时处理多件彼此独立的事情时，你可以创建多个分身小莫并行处理。不要把主体小莫自己当作分身创建。',
    '创建分身小莫时，复用现有 HTTP API，不需要新接口：先用当前用户 Authorization 调用 `GET /api/assistant/workspace` 获得小莫项目和 Issue，再调用 `POST /api/issues/:issueId/sessions/` 创建 Session，名称格式为 `分身小莫 #N - <任务简述>`，description 使用分身模板，然后调用 `POST /api/sessions/:id/messages` 启动分身。',
    '分身 prompt 模板必须说明：你是分身小莫，只处理收到的单项任务；不能再创建分身；不能输出 `PushVoiceToUser(...)`；完成时给出可回传给主体小莫的简洁结果。',
    '分身结束后，前端会把结果回到主体小莫面板。你收到分身结果时，应总结用户需要知道的结论，并在需要时输出一行 `PushVoiceToUser("...")` 播报。',
    '请先遵循本 Session 注入的 mobius-assistant Skill 服务指南。',
    ...assistantPersonalityPromptLines(personality),
    '如果需要代替用户执行操作，使用当前用户浏览器上下文里的 URL 与 Authorization 调用 Mobius HTTP API。',
    '涉及创建、修改、删除或启动执行前，除非用户明确跳过授权，应先向用户确认。',
    '如果你希望前端语音播报某段精选回复，请在回复末尾单独输出一行 `PushVoiceToUser("要播报的文字")`。括号内应是适合朗读的纯文本，避免 Markdown、代码块、URL 和敏感信息；如果没有适合精选播报的内容，可以输出 `PushVoiceToUser("")`，此时前端会按用户当前播报模式处理。',
    '回答可以自然分成多段。前端只会摘取 jsonl 中 assistant response 的文本展示给用户。',
    `当前小莫 Session: ${sessionId}`,
    '',
    '用户问题：',
    text,
    clientContextBlock ? '\n追加的当前用户浏览器上下文与认证信息：' : '',
    clientContextBlock,
  ].join('\n');
}

function normalizeAssistantAttachments(raw: any, user: any, project: any): any[] {
  return normalizeSessionAttachments(raw, user, [project?.bind_path]);
}

function assistantQuestionWithAttachments(question: string, attachments: any[]): string {
  return sessionContentWithAttachments(question, attachments);
}

function contentBlocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block: any) => {
    if (!block || typeof block !== 'object') return String(block ?? '');
    if (block.type && block.type !== 'text' && block.type !== 'output_text') return '';
    if (typeof block.text === 'string') return block.text;
    if (typeof block.output_text === 'string') return block.output_text;
    return '';
  }).filter(Boolean).join('\n');
}

function assistantTextsFromEntry(entry: any): string[] {
  if (!entry || typeof entry !== 'object') return [];

  if (entry.type === 'assistant') {
    const message = entry.message || {};
    if (message.role && message.role !== 'assistant') return [];
    const text = contentBlocksText(message.content);
    return text.trim() ? [text.trim()] : [];
  }

  if (entry.type === 'response_item') {
    const payload = entry.payload || {};
    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = contentBlocksText(payload.content);
      return text.trim() ? [text.trim()] : [];
    }
    if ((payload.type === 'output_text' || payload.type === 'text') && typeof payload.text === 'string') {
      const text = payload.text.trim();
      return text ? [text] : [];
    }
  }

  if (entry.role === 'assistant' && typeof entry.content === 'string') {
    const text = entry.content.trim();
    return text ? [text] : [];
  }

  return [];
}

function assistantResponsesFromEntries(entries: any[]): any[] {
  const responses: any[] = [];
  let previous = '';
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const texts = assistantTextsFromEntry(entry);
    for (const text of texts) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (!normalized || normalized === previous) continue;
      previous = normalized;
      responses.push({
        id: `${i}:${responses.length}`,
        content: text,
        created_at: entry?.timestamp || entry?.created_at || entry?.payload?.timestamp || null,
        source_type: entry?.type || 'assistant',
      });
    }
  }
  return responses;
}

function sessionStatus(session: any): { alive: boolean; working: boolean; failed: boolean; agent_status: string } {
  const backend = backendForSession(session);
  let alive = false;
  let working = false;
  let failed = false;
  try { alive = !!backend.isAlive(session.session_id); } catch { /* ignore */ }
  try { working = alive && !!backend.isWorking(session.session_id); } catch { /* ignore */ }
  try { failed = !!backend.isFailed(session.session_id); } catch { /* ignore */ }
  return {
    alive,
    working,
    failed,
    agent_status: working ? 'running' : 'idle',
  };
}

function readQuestion(sessionId: string): { content: string; created_at: string | null } {
  const row = db.prepare(`
    SELECT content, created_at
    FROM messages_v2
    WHERE task_id = ? AND role = 'user'
    ORDER BY id ASC
    LIMIT 1
  `).get(sessionId) as { content?: string; created_at?: string } | undefined;
  return {
    content: row?.content || '',
    created_at: row?.created_at || null,
  };
}

function readUserMessages(sessionId: string): any[] {
  return (db.prepare(`
    SELECT id, content, created_at, turn_number
    FROM messages_v2
    WHERE task_id = ? AND role = 'user'
    ORDER BY id ASC
  `).all(sessionId) as Array<{ id: string; content: string; created_at: string; turn_number: number }>).map((row) => ({
    id: `user:${row.id}`,
    role: 'user',
    content: row.content || '',
    created_at: row.created_at || null,
    turn_number: row.turn_number || null,
  }));
}

function conversationMessages(sessionId: string, responses: any[]): any[] {
  const users = readUserMessages(sessionId);
  const assistant = responses.map((response, index) => ({
    id: `assistant:${response.id}`,
    role: 'assistant',
    content: response.content,
    created_at: response.created_at || null,
    response_index: index,
  }));
  return users.concat(assistant).sort((a, b) => {
    const at = a.created_at ? Date.parse(a.created_at) : NaN;
    const bt = b.created_at ? Date.parse(b.created_at) : NaN;
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
    if (a.role !== b.role) return a.role === 'user' ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });
}

function safeSessionModelLabel(model: unknown): string {
  try {
    return modelRegistry.labelForSessionModel(model) || String(model || '');
  } catch {
    return String(model || '');
  }
}

function assistantSessionModelUnavailableReason(session: any): string | null {
  try {
    if (modelRegistry.resolveSessionModel(session?.model)) return null;
  } catch {
    // Treat registry failures as unavailable for read paths; launch still fails
    // with the original error when the user tries to run that exact session.
  }
  return `模型配置已失效: ${session?.model || modelRegistry.DEFAULT_MODEL_KEY || 'codex'}`;
}

function unavailableAssistantSnapshot(session: any, reason: string): any {
  const question = readQuestion(session.session_id);
  return {
    session: {
      session_id: session.session_id,
      name: session.name,
      project_id: session.project_id || null,
      issue_id: session.issue_id || null,
      assistant_role: assistantSessionRole(session),
      model: session.model,
      model_label: safeSessionModelLabel(session.model),
      model_available: false,
      model_error: reason,
      created_at: session.created_at,
      last_active: session.last_active,
    },
    question,
    messages: conversationMessages(session.session_id, []),
    responses: [],
    status: {
      alive: false,
      working: false,
      failed: true,
      agent_status: 'failed',
      model_unavailable: true,
    },
    job_accomplished: null,
    unavailable_reason: reason,
    jsonl: {
      total: 0,
      total_approximate: false,
      truncated: false,
      response_count: 0,
    },
  };
}

function readAssistantSnapshot(user: any, sessionId: string): any {
  const session = Sessions.findByIdForUser(sessionId, user.id);
  if (!isAssistantVisibleSession(session, user)) {
    const err = new Error('未找到当前用户的小莫 Session') as Error & { status: number };
    err.status = 404;
    throw err;
  }

  const backend = backendForSession(session);
  const history = backend.getHistory(sessionId);
  const entries = Array.isArray(history?.entries) ? history.entries : [];
  const responses = assistantResponsesFromEntries(entries);
  const question = readQuestion(sessionId);
  const messages = conversationMessages(sessionId, responses);
  const status = sessionStatus(session);
  const modelUnavailableReason = assistantSessionModelUnavailableReason(session);
  // 与 /api/sessions/:id/status 一致:优先看项目 bind_path 仓库根下的 flag 目录。
  // 没 bind_path 则给 null,前端回退到 status.agent_status 显示。
  let job_accomplished: boolean | null = null;
  const proj = (session as any)?.project_id ? Projects.findById((session as any).project_id) : null;
  const root = (proj && proj.bind_path) ? path.resolve(proj.bind_path) : null;
  if (root) {
    try { job_accomplished = readJobFlagState(root, sessionId).accomplished; }
    catch { job_accomplished = backend.isJobGoalAccomplished(sessionId); }
  } else {
    job_accomplished = backend.isJobGoalAccomplished(sessionId);
  }
  return {
    session: {
      session_id: (session as any).session_id,
      name: (session as any).name,
      project_id: (session as any).project_id || null,
      issue_id: (session as any).issue_id || null,
      assistant_role: assistantSessionRole(session as any),
      model: (session as any).model,
      model_label: safeSessionModelLabel((session as any).model),
      model_available: !modelUnavailableReason,
      model_error: modelUnavailableReason,
      created_at: (session as any).created_at,
      last_active: (session as any).last_active,
    },
    question,
    messages,
    responses,
    status: modelUnavailableReason
      ? { ...status, model_unavailable: true }
      : status,
    job_accomplished,
    unavailable_reason: modelUnavailableReason,
    jsonl: {
      total: history?.total ?? entries.length,
      total_approximate: !!history?.totalApproximate,
      truncated: !!history?.truncated,
      response_count: responses.length,
    },
  };
}

function listAssistantSessions(user: any, limit: number): any[] {
  const assistantProject = findAssistantProject(user);
  const assistantProjectId = assistantProject?.id || stableAssistantProjectId(user.id);
  // 分身通过 POST /api/issues/:issueId/sessions/ 创建，其 session_key 为 `web:<uid>:<sid>`，
  // 不匹配 assistant-question 前缀（条件 A），只能靠条件 B（issue + name 前缀）进入列表。
  // 但 name 是用户可自定义的（前端「分身名称」输入框），一旦不以「分身小莫 #」开头，
  // 分身便会创建成功却从列表永久消失（移动端/Web 都看不到）。小莫对话 issue 下的所有
  // active session 都属于该用户的小莫会话/分身，故条件 B 只看 issue、不再强制 name 前缀。
  return db.prepare(`
    SELECT *
    FROM sessions_v2
    WHERE user_id = ?
      AND (
        session_key LIKE ?
        OR issue_id IN (
          SELECT id
          FROM issues
          WHERE project_id = ?
            AND title = ?
        )
      )
      AND status = 'active'
    ORDER BY
      CASE
        WHEN name = ? THEN 0
        WHEN name LIKE ? THEN 1
        ELSE 2
      END,
      created_at ASC
    LIMIT ?
  `).all(
    user.id,
    assistantSessionKeyLike(user.id),
    assistantProjectId,
    ASSISTANT_ISSUE_TITLE,
    MAIN_ASSISTANT_SESSION_NAME,
    `${ASSISTANT_CLONE_SESSION_PREFIX}%`,
    limit,
  ) as any[];
}

function readAssistantSnapshotForList(user: any, session: any): any | null {
  try {
    return readAssistantSnapshot(user, session.session_id);
  } catch (e) {
    const reason = (e as Error).message || '读取小莫 Session 失败';
    console.warn(`[assistant/sessions:list] degraded snapshot ${session?.session_id || ''}: ${reason}`);
    if (!isAssistantVisibleSession(session, user)) return null;
    return unavailableAssistantSnapshot(session, reason);
  }
}

function readAssistantSnapshotOrUnavailable(user: any, sessionId: string): any {
  try {
    return readAssistantSnapshot(user, sessionId);
  } catch (e) {
    const session = Sessions.findByIdForUser(sessionId, user.id);
    if (!isAssistantVisibleSession(session, user)) throw e;
    return unavailableAssistantSnapshot(session, (e as Error).message || '读取小莫 Session 失败');
  }
}

function findReusableAssistantSession(user: any): any {
  return db.prepare(`
    SELECT *
    FROM sessions_v2
    WHERE user_id = ?
      AND session_key LIKE ?
      AND status = 'active'
    ORDER BY
      CASE WHEN name = ? THEN 0 ELSE 1 END,
      last_active DESC,
      created_at DESC
    LIMIT 1
  `).get(user.id, assistantSessionKeyLike(user.id), MAIN_ASSISTANT_SESSION_NAME) as any;
}

function shapeAssistantSessionSummary(session: any): any {
  if (!session) return null;
  return {
    session_id: session.session_id,
    name: session.name,
    project_id: session.project_id || null,
    issue_id: session.issue_id || null,
    assistant_role: assistantSessionRole(session),
    model: session.model,
    model_label: modelRegistry.labelForSessionModel(session.model),
    created_at: session.created_at,
    last_active: session.last_active,
  };
}

function currentAssistantPresetPayload(user: any): any {
  const project = ensureAssistantProject(user);
  const issue = ensureAssistantIssue(project, user);
  const preset = readAssistantPreset(user, issue.id);
  const currentSession = findReusableAssistantSession(user);
  return {
    project,
    issue,
    preset,
    personality_options: ASSISTANT_PERSONALITY_OPTIONS,
    model_label: modelRegistry.labelForSessionModel(preset.model),
    current_session: shapeAssistantSessionSummary(currentSession),
  };
}

async function deleteReusableAssistantSession(user: any): Promise<any> {
  const session = findReusableAssistantSession(user);
  if (!session) return null;

  let wasAlive = false;
  let wasWorking = false;
  let terminated = false;
  try {
    const backend = backendForSession(session);
    wasAlive = !!backend.isAlive(session.session_id);
    wasWorking = wasAlive && !!backend.isWorking(session.session_id);
  } catch { /* ignore */ }

  try {
    const result = await bridge.closeSessionAsync(session.session_key || session.session_id, session.model);
    terminated = !!result?.killed;
  } catch (e) {
    console.warn(`[assistant/preset] 删除当前小莫 Session 前关闭后台失败 (${session.session_id}): ${(e as Error).message}`);
  }

  try { safeRemoveRunningFlag(assistantWorkDir(), session.session_id, 'assistant/preset'); } catch { /* ignore */ }
  Sessions.permanentDelete(session.session_id);
  return {
    ...shapeAssistantSessionSummary(session),
    background_was_alive: wasAlive,
    background_was_working: wasWorking,
    background_terminated: terminated,
  };
}

function handleAssistantPresetContextPreview(req: express.Request, res: express.Response): void {
  const user = (req as any).user;
  const project = ensureAssistantProject(user);
  const issue = ensureAssistantIssue(project, user);
  const src = (req.method === 'POST' && req.body && typeof req.body === 'object')
    ? req.body
    : req.query;
  const draftSession = {
    name: typeof src.name === 'string' ? src.name : '',
    description: typeof src.description === 'string' ? src.description : '',
  };
  const excludedSkillIds = sanitizeAssistantExcludedSkillIds(src.excluded_skill_ids);
  const excludedMemoryIds = safeIdList(src.excluded_memory_ids);
  const language = src.language === 'en' ? 'en' : 'zh';
  const ctx = buildIssueContextPreview(
    user,
    issue.id,
    draftSession,
    excludedSkillIds,
    excludedMemoryIds,
    language,
  );
  res.json({ body: ctx.body, sources: ctx.sources });
}

async function startAssistantSession(req: express.Request, session: any, questionText: string, requestId: string, workDir: string, clientContext: any = null, attachments: any[] = [], userContent: string = ''): Promise<void> {
  const user = (req as any).user;
  const launch = modelRegistry.launchOptionsForSession(session);
  const backend = agents.get(launch.backend);
  const isCompactCommand = String(questionText || '').trim().startsWith('/compact');
  const personality = assistantSessionPersonality(session);
  const promptQuestion = isCompactCommand ? questionText : assistantQuestionWithAttachments(questionText, attachments);
  let finalPrompt = assistantPrompt(promptQuestion, session.session_id, clientContext, personality);
  const turnNumber = (Messages.maxTurnFor(session.session_id) || 0) + 1;
  const displayContent = String(userContent || '').trim() || promptQuestion;

  Messages.insertUser(session.session_id, displayContent, turnNumber);
  Sessions.touchActive(session.session_id);

  const mobiusJsonl = {
    source: 'assistant.question',
    kind: String(questionText || '').trim().startsWith('/compact') ? 'compact' : 'user_input',
    content: displayContent,
    inputText: questionText,
    attachments,
    requestId,
    turnNumber,
    userId: user.id,
    timestamp: new Date().toISOString(),
  };

  if (!isCompactCommand && Messages.countUserMessagesFor(session.session_id) <= 1) {
    const ctx = buildSessionContext(user, session.session_id);
    if (workDir && (ctx as any).sources?.skills?.length > 0) {
      try { syncSkillsToWorkspace(workDir, (ctx as any).sources.skills); }
      catch (e) { console.warn(`[assistant/messages] sync skills failed: ${(e as Error).message}`); }
    }
    if (ctx.body) {
      try {
        Sessions.writeContextSnapshot(session.session_id, ctx.body as any, (ctx.sources ? JSON.stringify(ctx.sources) : null) as any);
      } catch (e) {
        console.warn(`[assistant/messages] writeContextSnapshot failed (${session.session_id}): ${(e as Error).message}`);
      }
      finalPrompt = wrapUserMessage(ctx.body, finalPrompt, ctx.language);
    }
  }

  try {
    await backend.noPauseCurrentAndQueueQueryAtSession({
      sessionId: session.session_id,
      prompt: finalPrompt,
      cwd: workDir,
      flagRoot: workDir,
      model: launch.model || undefined,
      settingsPath: launch.settingsPath,
      forceNoProxy: launch.forceNoProxy,
      useProxy: launch.forceNoProxy ? false : launch.useProxy === true,
      codexProfileKey: launch.codexProfileKey || undefined,
      codexChannel: launch.codexChannel || undefined,
      codexConfigPath: launch.codexConfigPath || undefined,
      codexSecretEnvKey: launch.codexSecretEnvKey || undefined,
      codexSecretValue: launch.codexSecretValue || undefined,
      displayName: session.name,
      agentSessionId: session.claude_session_id || undefined,
      mobiusJsonl,
    });

    const runtimeInfo = backend.listSessions().find((item: any) => item.sessionId === session.session_id);
    const newAgentSid = runtimeInfo?.agentSessionId || null;
    if (newAgentSid && newAgentSid !== session.claude_session_id) {
      db.prepare('UPDATE sessions_v2 SET claude_session_id=? WHERE session_id=?').run(newAgentSid, session.session_id);
    }
  } catch (e) {
    safeRemoveRunningFlag(workDir, session.session_id, 'assistant/messages');
    safeWriteFailedFlag(workDir, session.session_id, { backend: backend.name, reason: (e as Error).message || String(e) }, 'assistant/messages');
    try { Sessions.setIdle(session.session_id, user.id); } catch { /* ignore */ }
    try { Messages.insertSystem(session.session_id, (e as Error).message || '小莫 Session 启动失败', turnNumber, '启动失败'); } catch { /* ignore */ }
    throw e;
  }
}

router.get('/sessions', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  try {
    const limit = normalizeLimit(req.query.limit);
    const sessions = listAssistantSessions(user, limit);
    res.json({
      sessions: sessions
        .map((session) => readAssistantSnapshotForList(user, session))
        .filter(Boolean),
    });
  } catch (e) {
    console.error('[assistant/sessions:list] error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message || '读取小莫 Session 失败' });
  }
});

router.get('/workspace', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  try {
    const project = ensureAssistantProject(user);
    const issue = ensureAssistantIssue(project, user);
    res.json({ project, issue });
  } catch (e) {
    console.error('[assistant/workspace] error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message || '初始化小莫项目失败' });
  }
});

router.get('/preset', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  try {
    res.json(currentAssistantPresetPayload(user));
  } catch (e) {
    console.error('[assistant/preset:get] error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message || '读取小莫预设失败' });
  }
});

router.post('/preset', auth, async (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  try {
    const project = ensureAssistantProject(user);
    const issue = ensureAssistantIssue(project, user);
    const defaultExclusions = assistantDefaultSelectionExclusions(user, issue.id);
    const before = readAssistantPreset(user, issue.id);
    const next = normalizeAssistantPreset((req.body as any)?.preset || req.body || {}, defaultExclusions);
    const changed = assistantPresetChanged(before, next);
    const currentSession = findReusableAssistantSession(user);
    const sessionOutdated = currentSession ? !assistantSessionMatchesPreset(currentSession, next) : false;
    const requiresSessionDelete = !!currentSession && (changed || sessionOutdated);
    if (requiresSessionDelete && (req.body as any)?.delete_current_session !== true) {
      res.status(409).json({
        error: '保存小莫预设需要删除当前用户的小莫助理 Session。确认后系统会关闭后台执行并永久删除该 Session。',
        code: 'ASSISTANT_PRESET_REQUIRES_SESSION_DELETE',
        current_session: shapeAssistantSessionSummary(currentSession),
        session_outdated: sessionOutdated,
      });
      return;
    }

    const deletedSession = requiresSessionDelete
      ? await deleteReusableAssistantSession(user)
      : null;
    const preset = writeAssistantPreset(user, next, defaultExclusions);
    res.json({
      ok: true,
      changed,
      session_outdated: sessionOutdated,
      deleted_session: deletedSession,
      ...currentAssistantPresetPayload(user),
      preset,
      model_label: modelRegistry.labelForSessionModel(preset.model),
    });
  } catch (e) {
    console.error('[assistant/preset:save] error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message || '保存小莫预设失败' });
  }
});

router.get('/preset/context-preview', auth, handleAssistantPresetContextPreview as express.RequestHandler);
router.post('/preset/context-preview', auth, handleAssistantPresetContextPreview as express.RequestHandler);

router.get('/preset/session-selection-defaults', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  try {
    const project = ensureAssistantProject(user);
    const issue = ensureAssistantIssue(project, user);
    res.json({
      inherited: false,
      source_session: null,
      ...assistantDefaultSelectionExclusions(user, issue.id),
    });
  } catch (e) {
    console.error('[assistant/preset:selection-defaults] error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message || '读取小莫预设默认资料失败' });
  }
});

router.get('/sessions/:id', auth, (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  try {
    res.json(readAssistantSnapshotOrUnavailable(user, String(req.params.id)));
  } catch (e) {
    const status = (e as any).status;
    res.status(status && status >= 400 && status < 500 ? status : 500).json({
      error: (e as Error).message || '读取小莫 Session 失败',
    });
  }
});

function publicAsrError(error: unknown): { status: number; body: any } {
  if (error instanceof AsrError) {
    return {
      status: (error as any).status || 500,
      body: {
        ok: false,
        code: (error as any).code,
        error: (error as any).message,
        ...((error as any).logId ? { provider_log_id: (error as any).logId } : {}),
      },
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      code: 'ASR_FAILED',
      error: '语音转写失败，请稍后重试。',
    },
  };
}

function publicTtsError(error: unknown): { status: number; body: any } {
  if (error instanceof TtsError) {
    return {
      status: (error as any).status || 500,
      body: {
        ok: false,
        code: (error as any).code,
        error: (error as any).message,
        ...((error as any).logId ? { provider_log_id: (error as any).logId } : {}),
      },
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      code: 'TTS_FAILED',
      error: '语音合成失败，请稍后重试。',
    },
  };
}

router.post('/transcribe', auth, (req: express.Request, res: express.Response) => {
  assistantVoiceUpload(req, res, (uploadError: any) => {
    if (uploadError) {
      res.status(400).json({
        ok: false,
        code: 'ASR_UPLOAD_INVALID',
        error: uploadError.code === 'LIMIT_FILE_SIZE'
          ? '录音文件过大，请缩短录音后重试。'
          : '录音上传失败，请重新录制。',
      });
      return;
    }
    if (!(req as any).file || !(req as any).file.buffer || (req as any).file.buffer.length === 0) {
      res.status(400).json({
        ok: false,
        code: 'ASR_AUDIO_EMPTY',
        error: '录音内容为空，请重新录制一段清晰语音。',
      });
      return;
    }

    (async () => {
      try {
        const result = await transcribeBrowserAudio({ file: (req as any).file } as any);
        res.json({
          ok: true,
          text: result.text,
          alternatives: result.alternatives || [],
          request_id: result.request_id,
          ...((result as any).provider_log_id ? { provider_log_id: (result as any).provider_log_id } : {}),
        });
      } catch (error) {
        const { status, body } = publicAsrError(error);
        const code = body.code || 'ASR_FAILED';
        const providerLog = body.provider_log_id ? ` provider_log_id=${body.provider_log_id}` : '';
        console.warn(`[assistant/transcribe] ${code}${providerLog}`);
        res.status(status).json(body);
      }
    })();
  });
});

router.get('/tts/voices', auth, (_req: express.Request, res: express.Response) => {
  res.json({
    ok: true,
    default_voice: DEFAULT_VOICE,
    voices: getTtsVoices(),
  });
});

router.post('/speak', auth, async (req: express.Request, res: express.Response) => {
  const text = typeof (req.body as any)?.text === 'string' ? (req.body as any).text.trim() : '';
  const voice = typeof (req.body as any)?.voice === 'string' ? (req.body as any).voice.trim() : undefined;
  if (!text) {
    res.status(400).json({
      ok: false,
      code: 'TTS_TEXT_EMPTY',
      error: '播报文本为空。',
    });
    return;
  }

  try {
    const result = await synthesizeSpeech({ text, voice } as any);
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Mobius-TTS-Request-Id', result.request_id);
    res.setHeader('X-Mobius-TTS-Cache', result.cache_hit ? 'hit' : 'miss');
    if (result.provider_log_id) res.setHeader('X-Mobius-TTS-Provider-Log-Id', result.provider_log_id);
    res.send(result.audio);
  } catch (error) {
    const { status, body } = publicTtsError(error);
    const code = body.code || 'TTS_FAILED';
    const providerLog = body.provider_log_id ? ` provider_log_id=${body.provider_log_id}` : '';
    console.warn(`[assistant/speak] ${code}${providerLog}`);
    res.status(status).json(body);
  }
});

router.post('/messages', auth, async (req: express.Request, res: express.Response) => {
  const user = (req as any).user;
  const body = (req.body || {}) as any;
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const inputText = typeof body.input_text === 'string' ? body.input_text.trim() : '';
  const clientContext = normalizeAssistantClientContext(body.client_context, user, req.get('authorization') || '');

  const requestId = typeof body.request_id === 'string' && body.request_id
    ? body.request_id
    : `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const project = ensureAssistantProject(user);
    const issue = ensureAssistantIssue(project, user);
    const attachments = normalizeAssistantAttachments(body.attachments, user, project);
    const question = inputText || content;
    if (!question && attachments.length === 0) {
      res.status(400).json({ error: 'content 不能为空' });
      return;
    }
    const preset = readAssistantPreset(user, issue.id);
    let session = findReusableAssistantSession(user);
    let created = false;
    if (!session) {
      const resolvedModel = modelRegistry.resolveSessionModelForCreate(body.model || preset.model);
      if (!resolvedModel) {
        res.status(503).json({ error: '没有可用的模型，请先在管理后台配置模型（或检查 ~/.claude/mobiusdefault.settings.json 是否存在）' });
        return;
      }
      const limitCheck = modelPromptLimits.checkCreateAllowed(user.id, resolvedModel.key);
      if (!limitCheck.allowed) {
        res.status(limitCheck.status as any).json({
          error: limitCheck.error,
          code: limitCheck.code,
          usage: limitCheck.usage,
        });
        return;
      }
      const sessionId = uuid().slice(0, 8);
      const excludedSkillIds = safeIdList(preset.excluded_skill_ids);
      const excludedMemoryIds = safeIdList(preset.excluded_memory_ids);
      const selectionSnapshot = buildSessionSelectionSnapshot(user, issue.id, excludedSkillIds, excludedMemoryIds);
      (selectionSnapshot as any).assistant = {
        ...((selectionSnapshot as any).assistant && typeof (selectionSnapshot as any).assistant === 'object' ? (selectionSnapshot as any).assistant : {}),
        personality: normalizeAssistantPersonality(preset.personality),
      };
      const sessionName = MAIN_ASSISTANT_SESSION_NAME;
      Sessions.insert({
        session_id: sessionId,
        issue_id: issue.id,
        project_id: project.id,
        user_id: user.id,
        name: sessionName,
        description: preset.description || DEFAULT_ASSISTANT_PRESET_DESCRIPTION,
        session_key: assistantSessionKey(user.id, sessionId),
        excluded_skill_ids: excludedSkillIds,
        excluded_memory_ids: excludedMemoryIds,
        selection_snapshot: selectionSnapshot,
        model: resolvedModel.sessionModelValue,
        language: preset.language || 'zh',
      } as any);
      Issues.touchActiveAndIncrement(issue.id);
      session = Sessions.findById(sessionId);
      created = true;
    } else if (session.project_id !== project.id || session.issue_id !== issue.id) {
      db.prepare(`
        UPDATE sessions_v2
        SET project_id = ?, issue_id = ?
        WHERE session_id = ? AND user_id = ?
      `).run(project.id, issue.id, session.session_id, user.id);
      session = Sessions.findById(session.session_id);
    }

    await startAssistantSession(req, session, question, requestId, project.bind_path, clientContext, attachments, content || question);
    res.json({
      ok: true,
      created,
      request_id: requestId,
      project,
      issue,
      ...readAssistantSnapshot(user, session.session_id),
    });
  } catch (e) {
    console.error('[assistant/messages:create] error:', (e as Error).message);
    res.status(500).json({ error: (e as Error).message || '创建小莫 Session 失败' });
  }
});

export = router;
